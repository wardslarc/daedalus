import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  openDb,
  projects,
  providers,
  reviewAcks,
  runs,
  shapingState,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
import { GitError } from "@daedalus/git";
import {
  NotImplementedError,
  type TaskEvent,
  type TaskState,
  type Transition,
} from "@daedalus/core/task-state";
import {
  ackGate,
  approveTask,
  discardTask,
  getReview,
  listInReviewTasks,
  ReviewError,
  scanPatchAddedLinesForSecrets,
  sendBack,
} from "../src/review.js";
import { TaskRunner } from "../src/runner.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Review center (T6.1, SPEC#Review)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let projectRow: typeof projects.$inferSelect;
  let providerRow: typeof providers.$inferSelect;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-review-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));

    // Set up a real git repo
    repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "Test User");
    git(repoDir, "config", "user.email", "test@example.com");

    writeFileSync(join(repoDir, "README.md"), "# Project\ninitial content\n");
    writeFileSync(join(repoDir, "old.txt"), "obsolete line 1\nobsolete line 2\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit on main");

    // Create release branch daedalus/release-v1.0 from main
    git(repoDir, "branch", "daedalus/release-v1.0");

    // Insert project in DB
    const [p] = db
      .insert(projects)
      .values({
        name: "Test Project",
        localPath: repoDir,
        profile: "personal",
        defaultBranch: "main",
      })
      .returning()
      .all();
    projectRow = p!;

    // Seed provider in DB
    const [prov] = db
      .insert(providers)
      .values({
        name: "claude",
        kind: "acp",
        launchCommand: "claude-agent-acp",
        roles: ["coder"],
        allowedProfiles: ["personal"],
      })
      .returning()
      .all();
    providerRow = prov!;

    // Shaping state with active release branch
    db.insert(shapingState)
      .values({
        projectId: projectRow.id,
        activeMilestoneCode: "M1",
        activeMilestoneVersion: "v1.0",
        activeMilestoneBranch: "daedalus/release-v1.0",
        activeMilestoneFrozen: true,
      })
      .run();
  });

  afterEach(() => {
    try {
      db.$client.close();
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("diff and file statuses: accurately parses A, M, D and addition/deletion counts", async () => {
    // Branch from release branch
    git(repoDir, "checkout", "-b", "daedalus/t1.1", "daedalus/release-v1.0");

    // Added file (A)
    writeFileSync(join(repoDir, "src-new.ts"), "line 1\nline 2\nline 3\n");
    // Modified file (M)
    writeFileSync(join(repoDir, "README.md"), "# Project Updated\ninitial content modified\nadded line\n");
    // Deleted file (D)
    rmSync(join(repoDir, "old.txt"));

    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "task changes");

    // Switch main checkout back to main
    git(repoDir, "checkout", "main");

    // Insert task in DB
    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.1",
        title: "Diff Test Task",
        tag: "claude",
        status: "in-review",
        branch: "daedalus/t1.1",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .returning()
      .all();

    const review = await getReview(db, projectRow, "T1.1", {
      checkResult: { ok: true, exitCode: 0, output: "All tests pass." },
    });

    expect(review.task.id).toBe(t!.id);
    expect(review.releaseBranch).toBe("daedalus/release-v1.0");
    expect(review.diff.files.length).toBe(3);

    const added = review.diff.files.find((f) => f.path === "src-new.ts");
    expect(added).toBeDefined();
    expect(added?.status).toBe("A");
    expect(added?.additions).toBe(3);
    expect(added?.deletions).toBe(0);

    const modified = review.diff.files.find((f) => f.path === "README.md");
    expect(modified).toBeDefined();
    expect(modified?.status).toBe("M");
    expect(modified?.additions).toBeGreaterThan(0);

    const deleted = review.diff.files.find((f) => f.path === "old.txt");
    expect(deleted).toBeDefined();
    expect(deleted?.status).toBe("D");
    expect(deleted?.deletions).toBe(2);

    expect(review.diff.patch).toContain("diff --git");
  });

  it("a planted secret on an added line blocks (and secret text never appears in result)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.2", "daedalus/release-v1.0");

    const secretKey = "sk-ant-api03-plantedsecretkey1234567890abcdef";
    writeFileSync(join(repoDir, "api.ts"), `export const API_KEY = "${secretKey}";\n`);
    git(repoDir, "add", "api.ts");
    git(repoDir, "commit", "-m", "added secret");
    git(repoDir, "checkout", "main");

    const [t12] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.2",
        title: "Secret Task",
        status: "in-review",
        branch: "daedalus/t1.2",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t12!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const review = await getReview(db, projectRow, "T1.2", {
      checkResult: { ok: true, exitCode: 0, output: "ok" },
    });

    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate).toBeDefined();
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items.length).toBe(1);
    expect(secretGate?.items[0]).toBe("api.ts:1");

    // The secret text itself must NEVER appear anywhere in review data
    const jsonOutput = JSON.stringify(review);
    expect(jsonOutput).not.toContain(secretKey);
    expect(review.diff.patch).toContain("[REDACTED:anthropic]");

    // Approval should be blocked with 409
    await expect(approveTask(db, projectRow, "T1.2", { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'secrets' is blocked/i),
    });
  });

  it("a deleted test needs ack and blocks approve until acknowledged", async () => {
    // Add a test file to release branch first
    git(repoDir, "checkout", "daedalus/release-v1.0");
    mkdirSync(join(repoDir, "test"), { recursive: true });
    writeFileSync(join(repoDir, "test", "auth.test.ts"), "test('login', () => {});\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "add test");

    // Branch task and delete the test
    git(repoDir, "checkout", "-b", "daedalus/t1.3", "daedalus/release-v1.0");
    rmSync(join(repoDir, "test", "auth.test.ts"));
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "delete test");
    git(repoDir, "checkout", "main");

    const [t13] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.3",
        title: "Delete Test Task",
        status: "in-review",
        branch: "daedalus/t1.3",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t13!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const reviewBefore = await getReview(db, projectRow, "T1.3", {
      checkResult: { ok: true, exitCode: 0, output: "ok" },
    });
    const testGate = reviewBefore.gates.find((g) => g.id === "tests");
    expect(testGate?.status).toBe("needs-ack");
    expect(testGate?.items).toContain("test/auth.test.ts");
    expect(testGate?.ack).toBeNull();

    // Approve fails because unacked
    await expect(approveTask(db, projectRow, "T1.3", { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'tests' requires acknowledgement/i),
    });

    // Acknowledge the gate
    const ackRes = await ackGate(db, projectRow, "T1.3", "tests", "Obsolete auth test removed intentionally");
    expect(ackRes.gate).toBe("tests");
    expect(ackRes.note).toBe("Obsolete auth test removed intentionally");

    const reviewAfter = await getReview(db, projectRow, "T1.3", {
      checkResult: { ok: true, exitCode: 0, output: "ok" },
    });
    const testGateAfter = reviewAfter.gates.find((g) => g.id === "tests");
    expect(testGateAfter?.ack).not.toBeNull();
    expect(testGateAfter?.ack?.note).toBe("Obsolete auth test removed intentionally");
  });

  it("dependencies touched trigger needs-ack gate", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.4", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.1" }, null, 2));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "update dependencies");
    git(repoDir, "checkout", "main");

    const [t14] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.4",
        title: "Dependency Task",
        status: "in-review",
        branch: "daedalus/t1.4",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t14!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const review = await getReview(db, projectRow, "T1.4", {
      checkResult: { ok: true, exitCode: 0, output: "ok" },
    });

    const depGate = review.gates.find((g) => g.id === "dependencies");
    expect(depGate?.status).toBe("needs-ack");
    expect(depGate?.items).toContain("package.json");
    expect(depGate?.items).toContain("pnpm-lock.yaml");
  });

  it("approve merges into daedalus/release-v1.0 with main's sha unchanged and owner's checkout untouched", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.5", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "feature.txt"), "feature v1.0\n");
    git(repoDir, "add", "feature.txt");
    git(repoDir, "commit", "-m", "implement feature");

    // Owner checkout remains on main with an uncommitted local edit
    git(repoDir, "checkout", "main");
    const mainShaBefore = git(repoDir, "rev-parse", "main");
    writeFileSync(join(repoDir, "owner-scratch.txt"), "working on main\n");

    const [t15] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.5",
        title: "Feature Approve Task",
        status: "in-review",
        branch: "daedalus/t1.5",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t15!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "All tests passed",
        exitStatus: 0,
      })
      .run();

    // Mock check passed in runner
    const transitionTable: Record<string, Transition> = {
      "in-review:approve": { state: { status: "done", attempts: 1 }, inbox: null },
    };
    const mockTransition = (state: TaskState, event: TaskEvent): Transition => {
      const key = `${state.status}:${event.type}`;
      return transitionTable[key]!;
    };

    // Set recorded check result
    const { approveTask: approve } = await import("../src/review.js");
    const res = await approve(db, projectRow, "T1.5", {
      dataDir,
      transition: mockTransition,
    });

    // Check release branch has merge commit
    expect(res.sha).toBe(git(repoDir, "rev-parse", "daedalus/release-v1.0"));
    const releaseLog = git(repoDir, "log", "-1", "--format=%s", "daedalus/release-v1.0");
    expect(releaseLog).toContain("Merge task T1.5: Feature Approve Task");
    expect(git(repoDir, "show", "daedalus/release-v1.0:feature.txt")).toBe("feature v1.0");

    // main's sha is UNCHANGED
    expect(git(repoDir, "rev-parse", "main")).toBe(mainShaBefore);

    // Owner's checkout is untouched on main with their uncommitted file
    expect(git(repoDir, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repoDir, "owner-scratch.txt"), "utf8")).toBe("working on main\n");

    // Task branch is kept
    expect(git(repoDir, "branch", "--list", "daedalus/t1.5")).toContain("daedalus/t1.5");

    // DB task status is updated to done
    const updatedTask = db.select().from(tasks).where(eq(tasks.code, "T1.5")).get();
    expect(updatedTask?.status).toBe("done");
  });

  it("conflict leaves everything unchanged", async () => {
    // Conflict setup: change README.md on release branch, and conflicting change on task branch
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "README.md"), "# Conflict Release Version\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "edit README on release branch");
    const releaseShaBefore = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    git(repoDir, "checkout", "-b", "daedalus/t1.6", "daedalus/release-v1.0~1");
    writeFileSync(join(repoDir, "README.md"), "# Conflict Task Version\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "conflicting edit on task branch");

    git(repoDir, "checkout", "main");

    const [t16] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.6",
        title: "Conflict Task",
        status: "in-review",
        branch: "daedalus/t1.6",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t16!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "All tests passed",
        exitStatus: 0,
      })
      .run();

    await expect(
      approveTask(db, projectRow, "T1.6", {
        dataDir,
        transition: () => ({ state: { status: "done", attempts: 1 }, inbox: null }),
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/conflict in: README\.md/i),
    });

    // Release branch sha is completely unchanged
    expect(git(repoDir, "rev-parse", "daedalus/release-v1.0")).toBe(releaseShaBefore);
    // Task status is still in-review
    const taskAfter = db.select().from(tasks).where(eq(tasks.code, "T1.6")).get();
    expect(taskAfter?.status).toBe("in-review");
  });

  it("send back stores notes, deletes the branch and requeues", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.7", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "bug.txt"), "has bug\n");
    git(repoDir, "add", "bug.txt");
    git(repoDir, "commit", "-m", "has bug");
    git(repoDir, "checkout", "main");

    const [t17] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.7",
        title: "Send Back Task",
        status: "in-review",
        branch: "daedalus/t1.7",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t17!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "All tests passed",
        exitStatus: 0,
      })
      .run();

    const transitionTable: Record<string, Transition> = {
      "in-review:requeue": { state: { status: "queued", attempts: 1 }, inbox: null },
    };
    const mockTransition = (state: TaskState, event: TaskEvent): Transition => {
      const key = `${state.status}:${event.type}`;
      return transitionTable[key]!;
    };

    const res = await sendBack(db, projectRow, "T1.7", "Please fix the edge case in login", {
      dataDir,
      transition: mockTransition,
    });

    expect(res.status).toBe("queued");

    const updatedTask = db.select().from(tasks).where(eq(tasks.code, "T1.7")).get();
    expect(updatedTask?.status).toBe("queued");
    expect(updatedTask?.reviewNotes).toBe("Please fix the edge case in login");
    expect(updatedTask?.branch).toBeNull();

    // Branch daedalus/t1.7 must be deleted
    expect(git(repoDir, "branch", "--list", "daedalus/t1.7")).toBe("");
  });

  it("discard deletes branch, clears review notes, and requeues", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.8", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "bad.txt"), "discard me\n");
    git(repoDir, "add", "bad.txt");
    git(repoDir, "commit", "-m", "bad commit");
    git(repoDir, "checkout", "main");

    const [t18] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.8",
        title: "Discard Task",
        status: "in-review",
        branch: "daedalus/t1.8",
        reviewNotes: "previous notes",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t18!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "All tests passed",
        exitStatus: 0,
      })
      .run();

    const transitionTable: Record<string, Transition> = {
      "in-review:requeue": { state: { status: "queued", attempts: 1 }, inbox: null },
    };
    const mockTransition = (state: TaskState, event: TaskEvent): Transition => {
      const key = `${state.status}:${event.type}`;
      return transitionTable[key]!;
    };

    const res = await discardTask(db, projectRow, "T1.8", {
      dataDir,
      transition: mockTransition,
    });

    expect(res.status).toBe("queued");

    const updatedTask = db.select().from(tasks).where(eq(tasks.code, "T1.8")).get();
    expect(updatedTask?.status).toBe("queued");
    expect(updatedTask?.reviewNotes).toBeNull();
    expect(updatedTask?.branch).toBeNull();

    // Branch deleted
    expect(git(repoDir, "branch", "--list", "daedalus/t1.8")).toBe("");
  });

  it("transition throwing NotImplementedError returns 503 'Needs the task state machine (T5.2)'", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t1.9", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    git(repoDir, "add", "file.txt");
    git(repoDir, "commit", "-m", "changes");
    git(repoDir, "checkout", "main");

    const [t19] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.9",
        title: "State Machine Test",
        status: "in-review",
        branch: "daedalus/t1.9",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t19!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "All tests passed",
        exitStatus: 0,
      })
      .run();

    const throwingTransition = (): Transition => {
      throw new NotImplementedError("T5.2: the owner writes the task state machine");
    };

    await expect(
      approveTask(db, projectRow, "T1.9", {
        dataDir,
        transition: throwingTransition,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Needs the task state machine (T5.2)",
    });

    await expect(
      sendBack(db, projectRow, "T1.9", "notes", {
        dataDir,
        transition: throwingTransition,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Needs the task state machine (T5.2)",
    });

    await expect(
      discardTask(db, projectRow, "T1.9", {
        dataDir,
        transition: throwingTransition,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Needs the task state machine (T5.2)",
    });
  });

  it("listInReviewTasks returns in-review tasks for the project", async () => {
    db.insert(tasks)
      .values([
        {
          projectId: projectRow.id,
          code: "T2.1",
          title: "In Review 1",
          status: "in-review",
        },
        {
          projectId: projectRow.id,
          code: "T2.2",
          title: "Queued Task",
          status: "queued",
        },
        {
          projectId: projectRow.id,
          code: "T2.3",
          title: "In Review 2",
          status: "in-review",
        },
      ])
      .run();

    const inReview = listInReviewTasks(db, projectRow.id);
    expect(inReview.length).toBe(2);
    expect(inReview.map((t) => t.code).sort()).toEqual(["T2.1", "T2.3"]);
  });

  // --- Round 2 Findings Tests (S1, S2, S3, P1) ---

  it("S1: git ops stub whose diff throws -> gate blocked with 'diff unavailable', approve refused (409)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-s1", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "s1.txt"), "hello\n");
    git(repoDir, "add", "s1.txt");
    git(repoDir, "commit", "-m", "s1 commit");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-S1",
        title: "Diff Throw Task",
        status: "in-review",
        branch: "daedalus/t-s1",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const throwingGitOps = {
      execGit: async (args: string[]) => {
        if (args.includes("diff")) {
          throw new GitError("diff buffer overflow");
        }
        return { stdout: "", stderr: "" };
      },
    };

    const review = await getReview(db, projectRow, "T-S1", {
      gitOps: throwingGitOps,
    });
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items[0]).toContain("diff unavailable: diff buffer overflow");

    await expect(
      approveTask(db, projectRow, "T-S1", {
        dataDir,
        gitOps: throwingGitOps,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'secrets' is blocked/i),
    });
  });

  it("S2: secret scanner reports added line starting with '++' inside a hunk with the right line", () => {
    const rawPatch = [
      "diff --git a/app.ts b/app.ts",
      "index 0000000..1111111 100644",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -5,3 +5,4 @@",
      " const x = 1;",
      "+++ b/x sk-ant-api03-plantedsecretkey1234567890abcdef",
      " const y = 2;",
      " const z = 3;",
    ].join("\n");

    const hits = scanPatchAddedLinesForSecrets(rawPatch);
    expect(hits).toEqual(["app.ts:6"]);
  });

  it("S2 integration: task diff containing '+++ b/x sk-...' inside hunk blocks secrets gate", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-s2", "daedalus/release-v1.0");
    writeFileSync(
      join(repoDir, "app.ts"),
      "line1\n++ b/x sk-ant-api03-plantedsecretkey1234567890abcdef\nline3\n",
    );
    git(repoDir, "add", "app.ts");
    git(repoDir, "commit", "-m", "add line with ++ prefix");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-S2",
        title: "Secret Plus Plus Task",
        status: "in-review",
        branch: "daedalus/t-s2",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const review = await getReview(db, projectRow, "T-S2");
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items).toContain("app.ts:2");
  });

  it("S3: ackGate refuses with 409 when task status is not in-review", async () => {
    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-S3-QUEUED",
        title: "Queued Task Ack",
        status: "queued",
      })
      .run();

    await expect(
      ackGate(db, projectRow, "T-S3-QUEUED", "dependencies", "Ack attempt on queued task"),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/expected "in-review"/i),
    });
  });

  it("S3: ack is ignored when task branch head SHA changes", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-s3-sha", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "initial dep change");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-S3-SHA",
        title: "Ack Head SHA Task",
        status: "in-review",
        branch: "daedalus/t-s3-sha",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    // Verify gate needs-ack
    const r1 = await getReview(db, projectRow, "T-S3-SHA");
    const depGate1 = r1.gates.find((g) => g.id === "dependencies");
    expect(depGate1?.status).toBe("needs-ack");
    expect(depGate1?.ack).toBeNull();

    // Acknowledge the gate
    const ackRes = await ackGate(db, projectRow, "T-S3-SHA", "dependencies", "Verified v1.0.0");
    expect(ackRes.gate).toBe("dependencies");

    const r2 = await getReview(db, projectRow, "T-S3-SHA");
    const depGate2 = r2.gates.find((g) => g.id === "dependencies");
    expect(depGate2?.ack).not.toBeNull();
    expect(depGate2?.ack?.note).toBe("Verified v1.0.0");

    // Add a new commit to task branch
    git(repoDir, "checkout", "daedalus/t-s3-sha");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.1" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "new commit updating dep again");
    git(repoDir, "checkout", "main");

    // Review should now ignore the old ack because the head SHA changed
    const r3 = await getReview(db, projectRow, "T-S3-SHA");
    const depGate3 = r3.gates.find((g) => g.id === "dependencies");
    expect(depGate3?.status).toBe("needs-ack");
    expect(depGate3?.ack).toBeNull();

    // Approve must be refused because needs-ack gate is unacknowledged
    await expect(
      approveTask(db, projectRow, "T-S3-SHA", { dataDir }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'dependencies' requires acknowledgement/i),
    });
  });

  it("S3: ack -> send back -> re-run -> gate needs-ack again", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-s3-sb", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "2.0.0" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "dep v2");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-S3-SB",
        title: "Send Back Clears Ack Task",
        status: "in-review",
        branch: "daedalus/t-s3-sb",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    // Acknowledge the dependencies gate
    await ackGate(db, projectRow, "T-S3-SB", "dependencies", "Acked before send-back");

    const rBefore = await getReview(db, projectRow, "T-S3-SB");
    expect(rBefore.gates.find((g) => g.id === "dependencies")?.ack).not.toBeNull();

    // Send back
    await sendBack(db, projectRow, "T-S3-SB", "Need fix", {
      dataDir,
      transition: () => ({ state: { status: "queued", attempts: 1 }, inbox: null }),
    });

    // Check review_acks table has no rows for this task
    const remainingAcks = db.select().from(reviewAcks).where(eq(reviewAcks.taskId, t!.id)).all();
    expect(remainingAcks).toHaveLength(0);

    // Now re-run task to in-review
    git(repoDir, "checkout", "-b", "daedalus/t-s3-sb", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "2.0.1" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "dep v2.0.1 re-run");
    git(repoDir, "checkout", "main");

    db.update(tasks)
      .set({ status: "in-review", branch: "daedalus/t-s3-sb" })
      .where(eq(tasks.id, t!.id))
      .run();

    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    const rAfter = await getReview(db, projectRow, "T-S3-SB");
    const depGateAfter = rAfter.gates.find((g) => g.id === "dependencies");
    expect(depGateAfter?.status).toBe("needs-ack");
    expect(depGateAfter?.ack).toBeNull();
  });

  it("P1: run a task, create fresh services/runner, getReview still returns check output from DB", async () => {
    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-P1",
        title: "P1 Test Task",
        tag: "claude",
        checkCommand: "pnpm test:p1",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .returning()
      .all();

    const checkOutputText = "Test run passed! 42 tests executed.";

    class FakeSession {
      prompts: string[] = [];
      stopped = false;
      async start() {
        return {
          id: "fake-s1",
          startedAt: new Date().toISOString(),
          prompt: async (text: string) => {
            this.prompts.push(text);
            return "end_turn";
          },
          stop: async () => {
            this.stopped = true;
          },
        };
      }
      async stopAll() {
        this.stopped = true;
      }
      get() {
        return undefined;
      }
      list() {
        return [];
      }
    }

    const fakeSessions = new FakeSession();
    const runner1 = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      transition: () => ({ state: { status: "in-review", attempts: 1 }, inbox: null }),
      runCheck: async () => ({
        ok: true,
        exitCode: 0,
        timedOut: false,
        output: checkOutputText,
      }),
    });

    const runRes = await runner1.runTask(projectRow.id, "T-P1");
    expect(runRes.ok).toBe(true);
    expect(runRes.status).toBe("in-review");

    // Verify DB runs row has check_exit_code and check_output
    const runRow = db.select().from(runs).where(eq(runs.taskId, t!.id)).get();
    expect(runRow).toBeDefined();
    expect(runRow?.checkExitCode).toBe(0);
    expect(runRow?.checkOutput).toContain(checkOutputText);

    // Now instantiate a FRESH TaskRunner (simulating service restart / fresh instance)
    const freshSessions = new FakeSession();
    const freshRunner = new TaskRunner({
      db,
      dataDir,
      sessions: freshSessions,
    });
    expect(freshRunner.listRunning()).toHaveLength(0);

    // getReview reads ONLY from the database
    const review = await getReview(db, projectRow, "T-P1");
    expect(review.check).not.toBeNull();
    expect(review.check?.ok).toBe(true);
    expect(review.check?.exitCode).toBe(0);
    expect(review.check?.output).toContain(checkOutputText);

    const checkGate = review.gates.find((g) => g.id === "check");
    expect(checkGate?.status).toBe("pass");
  });
});
