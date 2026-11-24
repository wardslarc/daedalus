import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  openDb,
  projects,
  reviewAcks,
  runs,
  shapingState,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
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
  sendBack,
} from "../src/review.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Review center (T6.1, SPEC#Review)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let projectRow: typeof projects.$inferSelect;

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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.2",
        title: "Secret Task",
        status: "in-review",
        branch: "daedalus/t1.2",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.3",
        title: "Delete Test Task",
        status: "in-review",
        branch: "daedalus/t1.3",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.4",
        title: "Dependency Task",
        status: "in-review",
        branch: "daedalus/t1.4",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.5",
        title: "Feature Approve Task",
        status: "in-review",
        branch: "daedalus/t1.5",
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
    expect(git(repoDir, "show", "daedalus/release-v1.0:feature.txt")).toBe("feature v1.0\n");

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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.6",
        title: "Conflict Task",
        status: "in-review",
        branch: "daedalus/t1.6",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.7",
        title: "Send Back Task",
        status: "in-review",
        branch: "daedalus/t1.7",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.8",
        title: "Discard Task",
        status: "in-review",
        branch: "daedalus/t1.8",
        reviewNotes: "previous notes",
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

    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.9",
        title: "State Machine Test",
        status: "in-review",
        branch: "daedalus/t1.9",
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
});
