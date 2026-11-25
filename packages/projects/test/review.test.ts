import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  inbox,
  openDb,
  projects,
  providers,
  reviewAcks,
  reviews,
  runs,
  shapingState,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
import { execGit, type ExecGitOptions, GitError, mergeCommitNoFf } from "@daedalus/git";
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

    const headSha12 = git(repoDir, "rev-parse", "daedalus/t1.2");
    // Approval should be blocked with 409
    await expect(approveTask(db, projectRow, "T1.2", headSha12, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'secrets' is blocked/i),
    });
  });

  it("task branch adding url with userinfo credential blocks secrets gate and patch does not contain secret", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-userinfo", "daedalus/release-v1.0");

    const secretUrl = 'url = "https://bob:s3cr3tT0ken9x@example.com/repo.git"';
    writeFileSync(join(repoDir, "config.ts"), `${secretUrl}\n`);
    git(repoDir, "add", "config.ts");
    git(repoDir, "commit", "-m", "added userinfo credential");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-USERINFO",
        title: "Userinfo Secret Task",
        status: "in-review",
        branch: "daedalus/t-userinfo",
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

    const review = await getReview(db, projectRow, "T-USERINFO", {
      checkResult: { ok: true, exitCode: 0, output: "ok" },
    });

    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate).toBeDefined();
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items.length).toBe(1);
    expect(secretGate?.items[0]).toBe("config.ts:1");

    // Patch must not contain the secret value
    expect(review.diff.patch).not.toContain("s3cr3tT0ken9x");
    expect(review.diff.patch).toContain("[REDACTED:userinfo]");

    // The secret text itself must never appear anywhere in review data
    const jsonOutput = JSON.stringify(review);
    expect(jsonOutput).not.toContain("s3cr3tT0ken9x");
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

    const headSha13 = git(repoDir, "rev-parse", "daedalus/t1.3");
    // Approve fails because unacked
    await expect(approveTask(db, projectRow, "T1.3", headSha13, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'tests' requires acknowledgement/i),
    });

    // Acknowledge the gate
    const ackRes = await ackGate(
      db,
      projectRow,
      "T1.3",
      "tests",
      "Obsolete auth test removed intentionally",
      reviewBefore.headSha!,
      testGate!.fingerprint,
    );
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

    // Acknowledge cross-review gate so task can be approved without running cross-review
    const r15 = await getReview(db, projectRow, "T1.5");
    const xrGate15 = r15.gates.find((g) => g.id === "cross-review");
    await ackGate(
      db,
      projectRow,
      "T1.5",
      "cross-review",
      "ack cross-review for test",
      r15.headSha!,
      xrGate15!.fingerprint,
    );

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
    const headSha15 = git(repoDir, "rev-parse", "daedalus/t1.5");
    const res = await approve(db, projectRow, "T1.5", headSha15, {
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

    // Acknowledge cross-review gate so task can reach git merge
    const r16 = await getReview(db, projectRow, "T1.6");
    const xrGate16 = r16.gates.find((g) => g.id === "cross-review");
    await ackGate(
      db,
      projectRow,
      "T1.6",
      "cross-review",
      "ack cross-review for test",
      r16.headSha!,
      xrGate16!.fingerprint,
    );

    const headSha16 = git(repoDir, "rev-parse", "daedalus/t1.6");
    await expect(
      approveTask(db, projectRow, "T1.6", headSha16, {
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

    const headSha17 = git(repoDir, "rev-parse", "daedalus/t1.7");
    const res = await sendBack(db, projectRow, "T1.7", "Please fix the edge case in login", headSha17, {
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

    const headSha18 = git(repoDir, "rev-parse", "daedalus/t1.8");
    const res = await discardTask(db, projectRow, "T1.8", headSha18, {
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

    // Acknowledge cross-review gate so task can reach transition
    const r19 = await getReview(db, projectRow, "T1.9");
    const xrGate19 = r19.gates.find((g) => g.id === "cross-review");
    await ackGate(
      db,
      projectRow,
      "T1.9",
      "cross-review",
      "ack cross-review for test",
      r19.headSha!,
      xrGate19!.fingerprint,
    );

    const throwingTransition = (): Transition => {
      throw new NotImplementedError("T5.2: the owner writes the task state machine");
    };

    const headSha19 = git(repoDir, "rev-parse", "daedalus/t1.9");
    await expect(
      approveTask(db, projectRow, "T1.9", headSha19, {
        dataDir,
        transition: throwingTransition,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Needs the task state machine (T5.2)",
    });

    await expect(
      sendBack(db, projectRow, "T1.9", "notes", headSha19, {
        dataDir,
        transition: throwingTransition,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Needs the task state machine (T5.2)",
    });

    await expect(
      discardTask(db, projectRow, "T1.9", headSha19, {
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
      execGit: async (args: string[], opts: ExecGitOptions) => {
        if (args.includes("diff")) {
          throw new GitError("diff buffer overflow");
        }
        return execGit(args, opts);
      },
    };

    const review = await getReview(db, projectRow, "T-S1", {
      gitOps: throwingGitOps,
    });
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items[0]).toContain("diff unavailable: diff buffer overflow");

    const headShaS1 = git(repoDir, "rev-parse", "daedalus/t-s1");
    await expect(
      approveTask(db, projectRow, "T-S1", headShaS1, {
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
      ackGate(
        db,
        projectRow,
        "T-S3-QUEUED",
        "dependencies",
        "Ack attempt on queued task",
        "0".repeat(40),
        "0".repeat(64),
      ),
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
    const ackRes = await ackGate(
      db,
      projectRow,
      "T-S3-SHA",
      "dependencies",
      "Verified v1.0.0",
      r1.headSha!,
      depGate1!.fingerprint,
    );
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

    const headShaS3 = git(repoDir, "rev-parse", "daedalus/t-s3-sha");
    // Approve must be refused because needs-ack gate is unacknowledged
    await expect(
      approveTask(db, projectRow, "T-S3-SHA", headShaS3, { dataDir }),
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
    const rBeforeSb = await getReview(db, projectRow, "T-S3-SB");
    const depGateSb = rBeforeSb.gates.find((g) => g.id === "dependencies");
    await ackGate(
      db,
      projectRow,
      "T-S3-SB",
      "dependencies",
      "Acked before send-back",
      rBeforeSb.headSha!,
      depGateSb!.fingerprint,
    );

    const rBefore = await getReview(db, projectRow, "T-S3-SB");
    expect(rBefore.gates.find((g) => g.id === "dependencies")?.ack).not.toBeNull();

    // Send back
    await sendBack(db, projectRow, "T-S3-SB", "Need fix", rBeforeSb.headSha!, {
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

  // --- Security Fix: Git config, gitattributes and renames bypass fixes ---

  it(".gitattributes 'secret.txt binary' + a secret in secret.txt -> secrets gate blocked (secret found) and the .gitattributes item listed as needs-ack", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-sec-gitattr", "daedalus/release-v1.0");

    const secretKey = "sk-ant-api03-plantedsecretkey1234567890abcdef";
    writeFileSync(join(repoDir, ".gitattributes"), "secret.txt binary\n");
    writeFileSync(join(repoDir, "secret.txt"), `export const API_KEY = "${secretKey}";\n`);
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "add secret with gitattributes");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-SEC-GA",
        title: "Gitattributes Secret Task",
        status: "in-review",
        branch: "daedalus/t-sec-gitattr",
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

    const review = await getReview(db, projectRow, "T-SEC-GA");
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate).toBeDefined();
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items).toContain("secret.txt:1");
    expect(secretGate?.items).toContain(".gitattributes: changes how git shows diffs");

    const headShaGa = git(repoDir, "rev-parse", "daedalus/t-sec-gitattr");
    await expect(approveTask(db, projectRow, "T-SEC-GA", headShaGa, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'secrets' is blocked/i),
    });
  });

  it("repo-local git config color.diff always and diff.noprefix true -> a secret on an added line is still found with the right file and line", async () => {
    git(repoDir, "config", "color.diff", "always");
    git(repoDir, "config", "diff.noprefix", "true");

    git(repoDir, "checkout", "-b", "daedalus/t-sec-cfg", "daedalus/release-v1.0");
    const secretKey = "sk-ant-api03-plantedsecretkey1234567890abcdef";
    writeFileSync(join(repoDir, "config-test.ts"), `const key = "${secretKey}";\n`);
    git(repoDir, "add", "config-test.ts");
    git(repoDir, "commit", "-m", "add secret under custom config");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-SEC-CFG",
        title: "Config Secret Task",
        status: "in-review",
        branch: "daedalus/t-sec-cfg",
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

    const review = await getReview(db, projectRow, "T-SEC-CFG");
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate).toBeDefined();
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items).toContain("config-test.ts:1");
  });

  it("a real binary file (bytes with NUL) added -> secrets gate lists it as not scanned (needs-ack), never pass", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-sec-bin", "daedalus/release-v1.0");
    const binBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0xaa]);
    writeFileSync(join(repoDir, "sample.bin"), binBuffer);
    git(repoDir, "add", "sample.bin");
    git(repoDir, "commit", "-m", "add binary file");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-SEC-BIN",
        title: "Binary File Task",
        status: "in-review",
        branch: "daedalus/t-sec-bin",
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

    const review = await getReview(db, projectRow, "T-SEC-BIN");
    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate).toBeDefined();
    expect(secretGate?.status).toBe("needs-ack");
    expect(secretGate?.items).toContain("sample.bin: binary or attribute change, not scanned");

    const headShaBin = git(repoDir, "rev-parse", "daedalus/t-sec-bin");
    // Approval fails because unacknowledged
    await expect(approveTask(db, projectRow, "T-SEC-BIN", headShaBin, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'secrets' requires acknowledgement/i),
    });

    // Acknowledge the gate
    await ackGate(
      db,
      projectRow,
      "T-SEC-BIN",
      "secrets",
      "Verified binary sample asset",
      review.headSha!,
      secretGate!.fingerprint,
    );
    const reviewAfterAck = await getReview(db, projectRow, "T-SEC-BIN");
    const secretGateAfter = reviewAfterAck.gates.find((g) => g.id === "secrets");
    expect(secretGateAfter?.ack?.note).toBe("Verified binary sample asset");
  });

  it("git mv test/a.test.ts src/a.ts -> tests gate needs-ack listing it; file entry has oldPath", async () => {
    git(repoDir, "checkout", "daedalus/release-v1.0");
    mkdirSync(join(repoDir, "test"), { recursive: true });
    writeFileSync(join(repoDir, "test", "a.test.ts"), "describe('a', () => {});\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "add a.test.ts on release branch");

    git(repoDir, "checkout", "-b", "daedalus/t-mv-test", "daedalus/release-v1.0");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    git(repoDir, "mv", "test/a.test.ts", "src/a.ts");
    git(repoDir, "commit", "-m", "move test to src");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-MV-TEST",
        title: "Move Test Task",
        status: "in-review",
        branch: "daedalus/t-mv-test",
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

    const review = await getReview(db, projectRow, "T-MV-TEST");
    const testGate = review.gates.find((g) => g.id === "tests");
    expect(testGate?.status).toBe("needs-ack");
    expect(testGate?.items).toContain("src/a.ts");

    const file = review.diff.files.find((f) => f.path === "src/a.ts");
    expect(file).toBeDefined();
    expect(file?.status).toBe("R");
    expect(file?.oldPath).toBe("test/a.test.ts");
  });

  it("git mv package.json pkg.json -> dependencies gate needs-ack", async () => {
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "add package.json on release branch");

    git(repoDir, "checkout", "-b", "daedalus/t-mv-dep", "daedalus/release-v1.0");
    git(repoDir, "mv", "package.json", "pkg.json");
    git(repoDir, "commit", "-m", "rename package.json away");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-MV-DEP",
        title: "Move Dep Task",
        status: "in-review",
        branch: "daedalus/t-mv-dep",
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

    const review = await getReview(db, projectRow, "T-MV-DEP");
    const depGate = review.gates.find((g) => g.id === "dependencies");
    expect(depGate?.status).toBe("needs-ack");
    expect(depGate?.items).toContain("pkg.json");

    const file = review.diff.files.find((f) => f.path === "pkg.json");
    expect(file).toBeDefined();
    expect(file?.status).toBe("R");
    expect(file?.oldPath).toBe("package.json");
  });

  it("a path containing a tab character -> parsed correctly (no crash, right path)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-tab-path", "daedalus/release-v1.0");
    const tabFileName = "tab\tfile.txt";
    writeFileSync(join(repoDir, tabFileName), "line 1\nline 2\n");
    git(repoDir, "add", tabFileName);
    git(repoDir, "commit", "-m", "add file with tab in path");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-TAB",
        title: "Tab Path Task",
        status: "in-review",
        branch: "daedalus/t-tab-path",
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

    const review = await getReview(db, projectRow, "T-TAB");
    const file = review.diff.files.find((f) => f.path === tabFileName);
    expect(file).toBeDefined();
    expect(file?.path).toBe(tabFileName);
    expect(file?.status).toBe("A");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  it("diff with a renamed file between two modified files, plus a third modified file -> every file has the right counts", async () => {
    git(repoDir, "checkout", "daedalus/release-v1.0");
    const baseContent = Array.from({ length: 10 }, (_, i) => `base line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(repoDir, "a-mod.txt"), "line 1\nline 2\nline 3\n");
    writeFileSync(join(repoDir, "m-old.txt"), baseContent);
    writeFileSync(join(repoDir, "s-mod.txt"), "s line 1\ns line 2\n");
    writeFileSync(join(repoDir, "z-mod.txt"), "z line 1\nz line 2\nz line 3\nz line 4\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "setup files for rename and modified test");

    git(repoDir, "checkout", "-b", "daedalus/t-rename-counts", "daedalus/release-v1.0");

    // Modified file 1: a-mod.txt (2 additions, 1 deletion)
    writeFileSync(join(repoDir, "a-mod.txt"), "line 1\nmodified line 2\nline 3\nadded line 4\n");

    // Renamed file between two modified files: m-old.txt -> m-renamed.txt (3 additions, 0 deletions)
    git(repoDir, "mv", "m-old.txt", "m-renamed.txt");
    writeFileSync(join(repoDir, "m-renamed.txt"), baseContent + "extra 1\nextra 2\nextra 3\n");

    // Modified file 2: s-mod.txt (1 addition, 0 deletions)
    writeFileSync(join(repoDir, "s-mod.txt"), "s line 1\ns line 2\ns line 3\n");

    // Modified file 3: z-mod.txt (0 additions, 2 deletions)
    writeFileSync(join(repoDir, "z-mod.txt"), "z line 1\nz line 2\n");

    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "task changes with rename and 3 modified files");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-RENAME-COUNTS",
        title: "Rename Counts Task",
        status: "in-review",
        branch: "daedalus/t-rename-counts",
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

    const review = await getReview(db, projectRow, "T-RENAME-COUNTS");
    expect(review.diff.files.length).toBe(4);

    const aFile = review.diff.files.find((f) => f.path === "a-mod.txt");
    expect(aFile).toBeDefined();
    expect(aFile?.status).toBe("M");
    expect(aFile?.additions).toBe(2);
    expect(aFile?.deletions).toBe(1);

    const mFile = review.diff.files.find((f) => f.path === "m-renamed.txt");
    expect(mFile).toBeDefined();
    expect(mFile?.status).toBe("R");
    expect(mFile?.oldPath).toBe("m-old.txt");
    expect(mFile?.additions).toBe(3);
    expect(mFile?.deletions).toBe(0);

    const sFile = review.diff.files.find((f) => f.path === "s-mod.txt");
    expect(sFile).toBeDefined();
    expect(sFile?.status).toBe("M");
    expect(sFile?.additions).toBe(1);
    expect(sFile?.deletions).toBe(0);

    const zFile = review.diff.files.find((f) => f.path === "z-mod.txt");
    expect(zFile).toBeDefined();
    expect(zFile?.status).toBe("M");
    expect(zFile?.additions).toBe(0);
    expect(zFile?.deletions).toBe(2);
  });

  it("truncated name-status record makes diff unreadable and blocks secrets gate", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-trunc-name", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "trunc.txt"), "line\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "commit trunc test");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-TRUNC-NAME",
        title: "Truncated Name Task",
        status: "in-review",
        branch: "daedalus/t-trunc-name",
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

    const truncatedGitOps = {
      execGit: async (args: string[], opts: ExecGitOptions) => {
        if (args.includes("--name-status")) {
          return { stdout: "R100\0only-old-path.txt\0", stderr: "" };
        }
        if (args.includes("--numstat")) {
          return { stdout: "0\t0\t\0only-old-path.txt\0dest.txt\0", stderr: "" };
        }
        return execGit(args, opts);
      },
    };

    const review = await getReview(db, projectRow, "T-TRUNC-NAME", {
      gitOps: truncatedGitOps,
    });

    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate?.status).toBe("blocked");
    expect(secretGate?.items[0]).toContain("diff unavailable: truncated name-status record");
    expect(review.diff.files.length).toBe(0);
  });

  it("name-status entry missing from numstat map is treated as binary/not scanned (needs-ack)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-missing-numstat", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "missing.txt"), "hello\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "commit missing numstat test");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-MISSING-NUMSTAT",
        title: "Missing Numstat Task",
        status: "in-review",
        branch: "daedalus/t-missing-numstat",
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

    const missingNumstatGitOps = {
      execGit: async (args: string[], opts: ExecGitOptions) => {
        if (args.includes("--name-status")) {
          return { stdout: "M\0missing.txt\0", stderr: "" };
        }
        if (args.includes("--numstat")) {
          return { stdout: "", stderr: "" };
        }
        return execGit(args, opts);
      },
    };

    const review = await getReview(db, projectRow, "T-MISSING-NUMSTAT", {
      gitOps: missingNumstatGitOps,
    });

    const secretGate = review.gates.find((g) => g.id === "secrets");
    expect(secretGate?.status).toBe("needs-ack");
    expect(secretGate?.items).toContain("missing.txt: binary or attribute change, not scanned");
    const file = review.diff.files.find((f) => f.path === "missing.txt");
    expect(file).toBeDefined();
    expect(file?.additions).toBe(0);
    expect(file?.deletions).toBe(0);
  });

  it("T6.2: cross-review gate appears in gates, is needs-ack when unreviewed, and blocks approve until acknowledged", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-xr-gate", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "xr-file.txt"), "hello world\n");
    git(repoDir, "add", "xr-file.txt");
    git(repoDir, "commit", "-m", "xr test commit");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-XR-GATE",
        title: "Cross Review Gate Task",
        status: "in-review",
        branch: "daedalus/t-xr-gate",
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

    // Verify cross-review gate is needs-ack when no review has run
    const review = await getReview(db, projectRow, "T-XR-GATE");
    const xrGate = review.gates.find((g) => g.id === "cross-review");
    expect(xrGate).toBeDefined();
    expect(xrGate?.status).toBe("needs-ack");
    expect(xrGate?.items).toContain("no cross-review for this commit");
    expect(xrGate?.ack).toBeNull();

    // approveTask is rejected because cross-review gate requires acknowledgement
    await expect(approveTask(db, projectRow, "T-XR-GATE", review.headSha!, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'cross-review' requires acknowledgement/i),
    });

    // Acknowledge the cross-review gate
    const ackRes = await ackGate(
      db,
      projectRow,
      "T-XR-GATE",
      "cross-review",
      "Acknowledged lack of cross-review for test",
      review.headSha!,
      xrGate!.fingerprint,
    );
    expect(ackRes.gate).toBe("cross-review");

    // Review now reflects the acknowledgement
    const reviewAfter = await getReview(db, projectRow, "T-XR-GATE");
    const xrGateAfter = reviewAfter.gates.find((g) => g.id === "cross-review");
    expect(xrGateAfter?.ack).not.toBeNull();
    expect(xrGateAfter?.ack?.note).toBe("Acknowledged lack of cross-review for test");
  });

  it("cross-review: review A failed -> owner acks -> review B on the same head finds a must-fix -> gate needs-ack again and Approve is refused (409) until a new ack", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-xr-reack", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "xr-code.ts"), "export const code = 1;\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "implement xr code");
    const headSha = git(repoDir, "rev-parse", "daedalus/t-xr-reack");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-XR-REACK",
        title: "Re-ack XR Task",
        status: "in-review",
        branch: "daedalus/t-xr-reack",
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

    // 1. Review A failed
    db.insert(reviews)
      .values({
        taskId: t!.id,
        reviewer: "antigravity",
        status: "failed",
        headSha,
        findings: "[]",
        error: "Agent crashed",
      })
      .run();

    const r1 = await getReview(db, projectRow, "T-XR-REACK");
    const gate1 = r1.gates.find((g) => g.id === "cross-review");
    expect(gate1?.status).toBe("needs-ack");
    expect(gate1?.ack).toBeNull();

    // 2. Owner acks failed review A
    await ackGate(
      db,
      projectRow,
      "T-XR-REACK",
      "cross-review",
      "Acknowledged failed review A",
      r1.headSha!,
      gate1!.fingerprint,
    );

    const r2 = await getReview(db, projectRow, "T-XR-REACK");
    const gate2 = r2.gates.find((g) => g.id === "cross-review");
    expect(gate2?.ack).not.toBeNull();
    expect(gate2?.ack?.note).toBe("Acknowledged failed review A");

    // 3. Review B runs on the SAME head and finds a must-fix
    db.insert(reviews)
      .values({
        taskId: t!.id,
        reviewer: "antigravity",
        status: "done",
        headSha,
        findings: JSON.stringify([
          { severity: "high", file: "xr-code.ts", line: 1, claim: "Critical vuln", proof: "Proof" },
        ]),
        claudeTriage: JSON.stringify([
          { index: 0, bucket: "must-fix", reason: "Must fix this critical issue" },
        ]),
      })
      .run();

    // 4. Gate needs-ack again, old ack does not count
    const r3 = await getReview(db, projectRow, "T-XR-REACK");
    const gate3 = r3.gates.find((g) => g.id === "cross-review");
    expect(gate3?.status).toBe("needs-ack");
    expect(gate3?.items.some((i) => i.includes("must-fix"))).toBe(true);
    expect(gate3?.ack).toBeNull();

    // 5. Approve is refused (409)
    await expect(approveTask(db, projectRow, "T-XR-REACK", r3.headSha!, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'cross-review' requires acknowledgement/i),
    });

    // 6. Owner acks again
    await ackGate(
      db,
      projectRow,
      "T-XR-REACK",
      "cross-review",
      "Acknowledged review B must-fix",
      r3.headSha!,
      gate3!.fingerprint,
    );

    const r4 = await getReview(db, projectRow, "T-XR-REACK");
    const gate4 = r4.gates.find((g) => g.id === "cross-review");
    expect(gate4?.ack).not.toBeNull();
    expect(gate4?.ack?.note).toBe("Acknowledged review B must-fix");
  });

  it("an ack row with head_sha null, or with items_sha256 null, doesn't count", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-ack-nulls", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "dep change");
    const headSha = git(repoDir, "rev-parse", "daedalus/t-ack-nulls");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-ACK-NULLS",
        title: "Ack Nulls Task",
        status: "in-review",
        branch: "daedalus/t-ack-nulls",
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

    // 1. Insert ack row with head_sha null
    db.insert(reviewAcks)
      .values({
        taskId: t!.id,
        gate: "dependencies",
        note: "Null headSha ack",
        headSha: null,
        itemsSha256: "dummy-hash",
      })
      .run();

    const r1 = await getReview(db, projectRow, "T-ACK-NULLS");
    expect(r1.gates.find((g) => g.id === "dependencies")?.ack).toBeNull();

    // 2. Update row with headSha set, but itemsSha256 null
    db.update(reviewAcks)
      .set({
        headSha,
        itemsSha256: null,
      })
      .where(eq(reviewAcks.taskId, t!.id))
      .run();

    const r2 = await getReview(db, projectRow, "T-ACK-NULLS");
    expect(r2.gates.find((g) => g.id === "dependencies")?.ack).toBeNull();

    // Approve refused with 409
    await expect(approveTask(db, projectRow, "T-ACK-NULLS", headSha, { dataDir })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/gate 'dependencies' requires acknowledgement/i),
    });
  });

  it("current head unknown (branch deleted) -> no ack counts, Approve refused", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-del-head", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    git(repoDir, "add", "package.json");
    git(repoDir, "commit", "-m", "dep change");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-DEL-HEAD",
        title: "Delete Head Task",
        status: "in-review",
        branch: "daedalus/t-del-head",
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

    // Acknowledge dependencies gate while branch exists
    const rInit = await getReview(db, projectRow, "T-DEL-HEAD");
    const depInit = rInit.gates.find((g) => g.id === "dependencies");
    await ackGate(
      db,
      projectRow,
      "T-DEL-HEAD",
      "dependencies",
      "Ack while branch exists",
      rInit.headSha!,
      depInit!.fingerprint,
    );
    const rBefore = await getReview(db, projectRow, "T-DEL-HEAD");
    expect(rBefore.gates.find((g) => g.id === "dependencies")?.ack).not.toBeNull();

    // Delete the task branch
    git(repoDir, "branch", "-D", "daedalus/t-del-head");

    // Review after branch deletion: no ack counts
    const rAfter = await getReview(db, projectRow, "T-DEL-HEAD");
    expect(rAfter.gates.every((g) => g.ack === null)).toBe(true);

    // Approve must be refused with 409
    await expect(approveTask(db, projectRow, "T-DEL-HEAD", rInit.headSha!, { dataDir })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("secrets gate: ack, then nothing changes -> ack still counts (no false invalidation)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-sec-nofalse", "daedalus/release-v1.0");
    const binBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    writeFileSync(join(repoDir, "asset.bin"), binBuffer);
    git(repoDir, "add", "asset.bin");
    git(repoDir, "commit", "-m", "add binary asset");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-SEC-NOFALSE",
        title: "Secrets No False Invalidation",
        status: "in-review",
        branch: "daedalus/t-sec-nofalse",
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

    const rBefore = await getReview(db, projectRow, "T-SEC-NOFALSE");
    const secBefore = rBefore.gates.find((g) => g.id === "secrets");
    expect(secBefore?.status).toBe("needs-ack");
    expect(secBefore?.ack).toBeNull();

    // Acknowledge secrets gate
    const ackRes = await ackGate(
      db,
      projectRow,
      "T-SEC-NOFALSE",
      "secrets",
      "Verified binary asset",
      rBefore.headSha!,
      secBefore!.fingerprint,
    );
    expect(ackRes.itemsSha256).toBeDefined();

    // Call getReview again when nothing has changed
    const rAfter = await getReview(db, projectRow, "T-SEC-NOFALSE");
    const secAfter = rAfter.gates.find((g) => g.id === "secrets");
    expect(secAfter?.status).toBe("needs-ack");
    expect(secAfter?.ack).not.toBeNull();
    expect(secAfter?.ack?.note).toBe("Verified binary asset");
  });

  it("ack with a fingerprint from before a new cross-review row -> 409, nothing stored", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-stale-fp", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "code.ts"), "export const a = 1;\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "implement code");
    const headSha = git(repoDir, "rev-parse", "daedalus/t-stale-fp");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-STALE-FP",
        title: "Stale Fingerprint Task",
        status: "in-review",
        branch: "daedalus/t-stale-fp",
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

    // GET review before cross-review row
    const r1 = await getReview(db, projectRow, "T-STALE-FP");
    const xrGate1 = r1.gates.find((g) => g.id === "cross-review");
    expect(xrGate1?.status).toBe("needs-ack");
    const staleFp = xrGate1!.fingerprint;

    // A new cross-review row lands
    db.insert(reviews)
      .values({
        taskId: t!.id,
        reviewer: "antigravity",
        status: "done",
        headSha,
        findings: JSON.stringify([
          { severity: "low", file: "code.ts", line: 1, claim: "Nit suggestion", proof: "Proof" },
        ]),
        claudeTriage: JSON.stringify([
          { index: 0, bucket: "nit", reason: "Minor nit" },
        ]),
      })
      .run();

    // Attempting to ack with the old fingerprint refuses with 409
    await expect(
      ackGate(db, projectRow, "T-STALE-FP", "cross-review", "Trying old ack", r1.headSha!, staleFp),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review changed since you opened it; reload.",
    });

    // Nothing stored
    const storedAcks = db.select().from(reviewAcks).where(eq(reviewAcks.taskId, t!.id)).all();
    expect(storedAcks).toHaveLength(0);
  });

  it("ack/approve with a stale headSha (commit added to the task branch after the GET) -> 409; release branch unchanged", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-stale-sha", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "first commit");
    git(repoDir, "checkout", "main");

    const releaseShaBefore = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-STALE-SHA",
        title: "Stale HeadSha Task",
        status: "in-review",
        branch: "daedalus/t-stale-sha",
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

    // GET review snapshot
    const r = await getReview(db, projectRow, "T-STALE-SHA");
    const staleHeadSha = r.headSha!;
    const depGate = r.gates.find((g) => g.id === "dependencies");
    expect(depGate?.status).toBe("needs-ack");
    const fp = depGate!.fingerprint;

    // A new commit lands on the task branch after the GET
    git(repoDir, "checkout", "daedalus/t-stale-sha");
    writeFileSync(join(repoDir, "extra.txt"), "extra\n");
    git(repoDir, "add", "extra.txt");
    git(repoDir, "commit", "-m", "commit added after GET");
    git(repoDir, "checkout", "main");

    // ack with stale headSha -> 409, nothing stored
    await expect(
      ackGate(db, projectRow, "T-STALE-SHA", "dependencies", "Acking with stale headSha", staleHeadSha, fp),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review changed since you opened it; reload.",
    });

    const storedAcks = db.select().from(reviewAcks).where(eq(reviewAcks.taskId, t!.id)).all();
    expect(storedAcks).toHaveLength(0);

    // approve with stale headSha -> 409, release branch unchanged
    await expect(
      approveTask(db, projectRow, "T-STALE-SHA", staleHeadSha, { dataDir }),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review changed since you opened it; reload.",
    });

    expect(git(repoDir, "rev-parse", "daedalus/release-v1.0")).toBe(releaseShaBefore);
  });

  it("approve merges exactly the reviewed SHA: add a commit to the task branch between getReview and the merge (inject via gitOps) -> the release branch contains the reviewed commit and not the new one; inbox item exists", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-merge-sha", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "reviewed-feature.txt"), "reviewed content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "reviewed commit");
    const reviewedSha = git(repoDir, "rev-parse", "daedalus/t-merge-sha");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-MERGE-SHA",
        title: "Merge Reviewed SHA Task",
        status: "in-review",
        branch: "daedalus/t-merge-sha",
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

    // Acknowledge cross-review gate on the reviewed commit
    const rInit = await getReview(db, projectRow, "T-MERGE-SHA");
    const xrGate = rInit.gates.find((g) => g.id === "cross-review");
    await ackGate(
      db,
      projectRow,
      "T-MERGE-SHA",
      "cross-review",
      "ack cross-review",
      reviewedSha,
      xrGate!.fingerprint,
    );

    // Injected gitOps: between getReview and mergeCommitNoFf, add a new commit to daedalus/t-merge-sha
    let unmergedSha = "";
    const realMerge = mergeCommitNoFf;
    const injectedGitOps = {
      mergeCommitNoFf: async (workDir: string, branchOrCommit: string, message: string) => {
        // Add a commit to task branch before merge happens
        git(repoDir, "checkout", "daedalus/t-merge-sha");
        writeFileSync(join(repoDir, "unreviewed-sneak.txt"), "sneaked in content\n");
        git(repoDir, "add", ".");
        git(repoDir, "commit", "-m", "sneaked in commit after review");
        unmergedSha = git(repoDir, "rev-parse", "daedalus/t-merge-sha");
        git(repoDir, "checkout", "main");

        return realMerge(workDir, branchOrCommit, message);
      },
    };

    const res = await approveTask(db, projectRow, "T-MERGE-SHA", reviewedSha, {
      dataDir,
      gitOps: injectedGitOps,
      transition: () => ({ state: { status: "done", attempts: 1 }, inbox: null }),
    });

    expect(res.sha).toBe(git(repoDir, "rev-parse", "daedalus/release-v1.0"));

    // Release branch contains the reviewed commit and NOT the new one
    expect(git(repoDir, "show", "daedalus/release-v1.0:reviewed-feature.txt")).toBe("reviewed content");
    expect(() => git(repoDir, "show", "daedalus/release-v1.0:unreviewed-sneak.txt")).toThrow();

    // Task branch still points at unmergedSha (moved) and was NOT deleted
    expect(git(repoDir, "branch", "--list", "daedalus/t-merge-sha")).toContain("daedalus/t-merge-sha");
    expect(git(repoDir, "rev-parse", "daedalus/t-merge-sha")).toBe(unmergedSha);

    // Task is marked done
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, t!.id)).get();
    expect(updatedTask?.status).toBe("done");

    // Inbox item exists
    const inboxItems = db
      .select()
      .from(inbox)
      .where(eq(inbox.projectId, projectRow.id))
      .all();
    expect(inboxItems.length).toBeGreaterThan(0);
    const item = inboxItems.find((i) => i.link.includes("T-MERGE-SHA"));
    expect(item).toBeDefined();
    expect(item?.kind).toBe("review");
  });

  it("the diff's file list and patch both come from the same SHA (commit between the calls via injected execGit -> still consistent)", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-diff-sha", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "initial-file.txt"), "initial content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit on task branch");
    const initialSha = git(repoDir, "rev-parse", "daedalus/t-diff-sha");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-DIFF-SHA",
        title: "Diff Consistency Task",
        status: "in-review",
        branch: "daedalus/t-diff-sha",
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

    // Injected execGit: after the first diff call (--name-status), add a new commit with a new file
    const injectedExecGit = async (args: string[], opts: ExecGitOptions) => {
      const res = await execGit(args, opts);
      if (args.includes("diff") && args.includes("--name-status")) {
        // Add a commit to daedalus/t-diff-sha before numstat and patch diff calls run
        git(repoDir, "checkout", "daedalus/t-diff-sha");
        writeFileSync(join(repoDir, "sneaked-file.txt"), "sneaked in diff file\n");
        git(repoDir, "add", ".");
        git(repoDir, "commit", "-m", "sneaked commit between diff calls");
        git(repoDir, "checkout", "main");
      }
      return res;
    };

    const review = await getReview(db, projectRow, "T-DIFF-SHA", {
      gitOps: { execGit: injectedExecGit },
    });

    expect(review.headSha).toBe(initialSha);

    // Both files list and patch diff reflect only initialSha
    expect(review.diff.files.map((f) => f.path)).toEqual(["initial-file.txt"]);
    expect(review.diff.patch).toContain("initial-file.txt");
    expect(review.diff.patch).not.toContain("sneaked-file.txt");
  });

  it("send-back with a stale headSha -> 409, branch and task status unchanged", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-sb-stale", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "sb-file.txt"), "content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "commit for send-back test");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-SB-STALE",
        title: "Send Back Stale Task",
        status: "in-review",
        branch: "daedalus/t-sb-stale",
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

    const review = await getReview(db, projectRow, "T-SB-STALE");
    const staleHeadSha = review.headSha!;

    // Commit added to branch after GET
    git(repoDir, "checkout", "daedalus/t-sb-stale");
    writeFileSync(join(repoDir, "sb-file2.txt"), "more\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "new commit after GET");
    git(repoDir, "checkout", "main");

    await expect(
      sendBack(db, projectRow, "T-SB-STALE", "needs work", staleHeadSha, { dataDir }),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review changed since you opened it; reload.",
    });

    // Task status and branch unchanged
    const taskAfter = db.select().from(tasks).where(eq(tasks.id, t!.id)).get();
    expect(taskAfter?.status).toBe("in-review");
    expect(taskAfter?.reviewNotes).toBeNull();
    expect(git(repoDir, "branch", "--list", "daedalus/t-sb-stale")).toContain("daedalus/t-sb-stale");
  });

  it("discard with a stale headSha -> 409, branch and task status unchanged", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-disc-stale", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "disc-file.txt"), "content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "commit for discard test");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-DISC-STALE",
        title: "Discard Stale Task",
        status: "in-review",
        branch: "daedalus/t-disc-stale",
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

    const review = await getReview(db, projectRow, "T-DISC-STALE");
    const staleHeadSha = review.headSha!;

    // Commit added to branch after GET
    git(repoDir, "checkout", "daedalus/t-disc-stale");
    writeFileSync(join(repoDir, "disc-file2.txt"), "more\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "new commit after GET");
    git(repoDir, "checkout", "main");

    await expect(
      discardTask(db, projectRow, "T-DISC-STALE", staleHeadSha, { dataDir }),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review changed since you opened it; reload.",
    });

    // Task status and branch unchanged
    const taskAfter = db.select().from(tasks).where(eq(tasks.id, t!.id)).get();
    expect(taskAfter?.status).toBe("in-review");
    expect(git(repoDir, "branch", "--list", "daedalus/t-disc-stale")).toContain("daedalus/t-disc-stale");
  });

  it("implement run with checkExitCode 1, then a newer review run with exitStatus 0 -> check gate blocked", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-check-role", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "check.txt"), "code\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "implement commit");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-CHECK-ROLE",
        title: "Check Role Task",
        status: "in-review",
        branch: "daedalus/t-check-role",
      })
      .returning()
      .all();

    // Older implement run with checkExitCode: 1 (failed)
    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: 1,
        checkOutput: "Check failed on tests",
        exitStatus: 0,
      })
      .run();

    // Newer review run with exitStatus: 0 (and checkExitCode: null)
    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "review",
        checkExitCode: null,
        checkOutput: null,
        exitStatus: 0,
      })
      .run();

    const review = await getReview(db, projectRow, "T-CHECK-ROLE");
    const checkGate = review.gates.find((g) => g.id === "check");
    expect(checkGate?.status).toBe("blocked");
    expect(checkGate?.items[0]).toContain("Last check failed with exit code 1");
    expect(review.check?.ok).toBe(false);
    expect(review.check?.exitCode).toBe(1);
  });

  it("implement run with checkExitCode null and exitStatus 0 -> check gate blocked with 'Check result missing'", async () => {
    git(repoDir, "checkout", "-b", "daedalus/t-check-null", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "check-null.txt"), "code\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "implement commit");
    git(repoDir, "checkout", "main");

    const [t] = db
      .insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T-CHECK-NULL",
        title: "Check Null Task",
        status: "in-review",
        branch: "daedalus/t-check-null",
      })
      .returning()
      .all();

    // Implement run timed out or never set checkExitCode (null), exitStatus 0
    db.insert(runs)
      .values({
        taskId: t!.id,
        providerId: providerRow.id,
        role: "implement",
        checkExitCode: null,
        checkOutput: null,
        exitStatus: 0,
      })
      .run();

    const review = await getReview(db, projectRow, "T-CHECK-NULL");
    expect(review.check).toBeNull();
    const checkGate = review.gates.find((g) => g.id === "check");
    expect(checkGate?.status).toBe("blocked");
    expect(checkGate?.items).toContain("Check result missing");
  });
});
