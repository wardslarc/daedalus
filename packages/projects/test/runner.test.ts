import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  inbox,
  openDb,
  projects,
  providers,
  runs,
  shapingState,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
import {
  type TaskEvent,
  type TaskState,
  type Transition,
} from "@daedalus/core/task-state";
import type { SessionProject } from "@daedalus/providers";
import { TaskRunner, TaskRunnerError, type TaskRunnerGitOps } from "../src/runner.js";
import type { CheckResult } from "../src/check-exec.js";

class FakeSessionManager {
  readonly startedSessions: Array<{
    project: SessionProject;
    providerId: string;
    prompts: string[];
    stopped: boolean;
  }> = [];

  async start(project: SessionProject, providerId: string) {
    const sessionRecord = {
      project,
      providerId,
      prompts: [] as string[],
      stopped: false,
    };
    this.startedSessions.push(sessionRecord);

    return {
      id: "fake-session-id",
      startedAt: new Date().toISOString(),
      prompt: async (text: string) => {
        sessionRecord.prompts.push(text);
        return "end_turn";
      },
      stop: async () => {
        sessionRecord.stopped = true;
      },
    };
  }

  async stopAll() {
    for (const s of this.startedSessions) {
      s.stopped = true;
    }
  }

  get() {
    return undefined;
  }
  list() {
    return [];
  }
}

describe("TaskRunner (T5.3, ADR 0018)", () => {
  let testDir: string;
  let dataDir: string;
  let db: DaedalusDb;
  let projectId: number;
  let workProjectId: number;
  let fakeSessions: FakeSessionManager;

  const branchesCreated: string[] = [];
  const worktreesAdded: string[] = [];
  const committedMessages: string[] = [];
  const committedCalls: Array<{
    dir: string;
    msg: string;
    options?: { author?: string; noVerify?: boolean };
  }> = [];

  const fakeGitOps: TaskRunnerGitOps = {
    validateBranchName: async () => {},
    addWorktree: async (_repoDir, worktreeDir, opts) => {
      branchesCreated.push(opts.branch);
      worktreesAdded.push(worktreeDir);
    },
    removeWorktree: async (_repoDir, worktreeDir) => {
      const idx = worktreesAdded.indexOf(worktreeDir);
      if (idx !== -1) worktreesAdded.splice(idx, 1);
    },
    deleteBranch: async (_dir, name) => {
      const idx = branchesCreated.indexOf(name);
      if (idx !== -1) branchesCreated.splice(idx, 1);
    },
    commitAll: async (dir, msg, options) => {
      committedCalls.push({ dir, msg, options });
      committedMessages.push(msg);
      return "0123456789abcdef0123456789abcdef01234567";
    },
  };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-runner-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));
    fakeSessions = new FakeSessionManager();
    branchesCreated.length = 0;
    worktreesAdded.length = 0;
    committedMessages.length = 0;
    committedCalls.length = 0;

    // Seed providers table
    db.insert(providers)
      .values([
        {
          name: "claude",
          kind: "acp",
          launchCommand: "claude-agent-acp",
          roles: ["coder"],
          allowedProfiles: ["work", "client", "personal"],
        },
        {
          name: "antigravity",
          kind: "acp",
          launchCommand: "agy",
          roles: ["coder"],
          allowedProfiles: ["client", "personal"],
        },
      ])
      .run();

    // Seed Personal project
    const projLocal = join(testDir, "personal-project");
    mkdirSync(join(projLocal, "docs"), { recursive: true });
    writeFileSync(join(projLocal, "docs", "PLAN.md"), "# Plan\n## M1 — v1.0\n");

    const [proj] = db
      .insert(projects)
      .values({
        name: "Personal Project",
        localPath: projLocal,
        profile: "personal",
      })
      .returning()
      .all();
    projectId = proj!.id;

    // Active milestone in shaping_state
    db.insert(shapingState)
      .values({
        projectId,
        activeMilestoneCode: "M1",
        activeMilestoneVersion: "v1.0",
        activeMilestoneBranch: "daedalus/release-v1.0",
        activeMilestoneFrozen: true,
        activeMilestoneStartedAt: new Date().toISOString(),
      })
      .run();

    // Seed Work project
    const workLocal = join(testDir, "work-project");
    mkdirSync(join(workLocal, "docs"), { recursive: true });
    const [wProj] = db
      .insert(projects)
      .values({
        name: "Work Project",
        localPath: workLocal,
        profile: "work",
      })
      .returning()
      .all();
    workProjectId = wProj!.id;

    db.insert(shapingState)
      .values({
        projectId: workProjectId,
        activeMilestoneCode: "M1",
        activeMilestoneVersion: "v1.0",
        activeMilestoneBranch: "daedalus/release-v1.0",
        activeMilestoneFrozen: true,
      })
      .run();
  });

  afterEach(() => {
    db.$client.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("pass → commit + in-review", async () => {
    // Frozen task in DB
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.1",
        title: "Feature One",
        tag: "claude",
        checkCommand: "pnpm test:feature",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
        linkedSpecSections: ["FeatureOne"],
      })
      .run();

    const transitionTable: Record<string, Transition> = {
      "queued:start": { state: { status: "running", attempts: 1 }, inbox: null },
      "running:check-passed": { state: { status: "in-review", attempts: 1 }, inbox: null },
    };

    const checkExecutor = async (): Promise<CheckResult> => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: "Tests passed successfully!",
    });

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      transition: (state, event) => {
        const key = `${state.status}:${event.type}`;
        return transitionTable[key]!;
      },
      git: fakeGitOps,
      runCheck: checkExecutor,
    });

    const res = await runner.runTask(projectId, "T1.1");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("in-review");
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // DB state updated
    const updatedTask = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;
    expect(updatedTask.status).toBe("in-review");
    expect(updatedTask.attempts).toBe(1);
    expect(updatedTask.branch).toBe("daedalus/t1.1");

    // Commit created
    expect(committedMessages).toContain("T1.1: Feature One (Daedalus task run)");
    expect(committedCalls[0]?.options?.noVerify).toBe(true);

    // Runs row closed
    const runRows = db.select().from(runs).where(eq(runs.taskId, updatedTask.id)).all();
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.exitStatus).toBe(0);
    expect(runRows[0]?.end).not.toBeNull();

    // Session stopped
    expect(fakeSessions.startedSessions[0]?.stopped).toBe(true);
  });

  it("fail, fail → check-failed + one inbox row + exactly one follow-up prompt", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.2",
        title: "Failing Feature",
        tag: "claude",
        checkCommand: "pnpm test:failing",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    let checkCallCount = 0;
    const checkExecutor = async (): Promise<CheckResult> => {
      checkCallCount++;
      return {
        ok: false,
        exitCode: 1,
        timedOut: false,
        output: `Error encountered during test run #${checkCallCount}`,
      };
    };

    const transitionFn = (state: TaskState, event: TaskEvent): Transition => {
      if (state.status === "queued" && event.type === "start") {
        return { state: { status: "running", attempts: 1 }, inbox: null };
      }
      if (state.status === "running" && event.type === "check-failed" && state.attempts === 1) {
        return { state: { status: "running", attempts: 2 }, inbox: null };
      }
      if (state.status === "running" && event.type === "check-failed" && state.attempts === 2) {
        return { state: { status: "check-failed", attempts: 2 }, inbox: "failed_check" };
      }
      throw new Error(`Unexpected transition call: ${state.status}:${event.type}`);
    };

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      transition: transitionFn,
      git: fakeGitOps,
      runCheck: checkExecutor,
    });

    const res = await runner.runTask(projectId, "T1.2");
    expect(res.ok).toBe(false);
    expect(res.status).toBe("check-failed");

    // Check ran twice (initial + after follow-up prompt)
    expect(checkCallCount).toBe(2);

    // Agent received exactly 2 prompts (initial task prompt + exactly 1 follow-up)
    const prompts = fakeSessions.startedSessions[0]?.prompts ?? [];
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Error encountered during test run #1");

    // Task status is check-failed with attempts 2
    const taskRow = db.select().from(tasks).where(eq(tasks.code, "T1.2")).get()!;
    expect(taskRow.status).toBe("check-failed");
    expect(taskRow.attempts).toBe(2);

    // Exactly one inbox row created
    const inboxRows = db.select().from(inbox).where(eq(inbox.projectId, projectId)).all();
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.kind).toBe("failed_check");
    expect(inboxRows[0]?.link).toBe(`/projects/${projectId}/pipeline#T1.2`);

    // Runs row closed with non-zero exit status
    const runRows = db.select().from(runs).where(eq(runs.taskId, taskRow.id)).all();
    expect(runRows[0]?.exitStatus).toBe(1);
  });

  it("Work project [gemini] → 403 before any branch/worktree exists", async () => {
    db.insert(tasks)
      .values({
        projectId: workProjectId,
        code: "T1.3",
        title: "Work Gemini Task",
        tag: "gemini",
        checkCommand: "pnpm test",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
    });

    await expect(runner.runTask(workProjectId, "T1.3")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(403);
      return true;
    });

    // Guard failed before branch or worktree creation
    expect(branchesCreated).toHaveLength(0);
    expect(worktreesAdded).toHaveLength(0);
    expect(fakeSessions.startedSessions).toHaveLength(0);
  });

  it("third concurrent run → 409", async () => {
    // Insert two tasks that are already "running"
    db.insert(tasks)
      .values([
        {
          projectId,
          code: "T1.10",
          title: "Running 1",
          tag: "claude",
          checkCommand: "true",
          status: "running",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
        {
          projectId,
          code: "T1.11",
          title: "Running 2",
          tag: "claude",
          checkCommand: "true",
          status: "running",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
        {
          projectId,
          code: "T1.12",
          title: "Queued 3",
          tag: "claude",
          checkCommand: "true",
          status: "queued",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
      ])
      .run();

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
    });

    await expect(runner.runTask(projectId, "T1.12")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(409);
      expect((err as TaskRunnerError).message).toContain("2 tasks already running");
      return true;
    });
  });

  it("check command comes from the DB even when PLAN.md says otherwise", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.4",
        title: "Security Check",
        tag: "claude",
        checkCommand: "pnpm safe:check",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    // Adversarial command in PLAN.md
    const planPath = join(testDir, "personal-project", "docs", "PLAN.md");
    writeFileSync(
      planPath,
      `# Plan
## M1 — v1.0
- [ ] **T1.4 Security Check** \`[claude]\` — [[SPEC#Security]]
  check: rm -rf ~
`,
      "utf8",
    );

    let executedCommand = "";
    const checkExecutor = async (cmd: string): Promise<CheckResult> => {
      executedCommand = cmd;
      return { ok: true, exitCode: 0, timedOut: false, output: "ok" };
    };

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      transition: () => ({ state: { status: "in-review", attempts: 1 }, inbox: null }),
      git: fakeGitOps,
      runCheck: checkExecutor,
    });

    await runner.runTask(projectId, "T1.4");
    expect(executedCommand).toBe("pnpm safe:check");
    expect(executedCommand).not.toContain("rm -rf ~");
  });

  it("refuses frozen task with no check command (409) before branch/worktree/session exists", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.5",
        title: "No Check Task",
        tag: "claude",
        checkCommand: "",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
    });

    await expect(runner.runTask(projectId, "T1.5")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(409);
      expect((err as TaskRunnerError).message).toBe("Task has no check");
      return true;
    });

    expect(branchesCreated).toHaveLength(0);
    expect(worktreesAdded).toHaveLength(0);
    expect(fakeSessions.startedSessions).toHaveLength(0);
  });

  it("refuses frozen task with null check command (409)", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.6",
        title: "Null Check Task",
        tag: "claude",
        checkCommand: null,
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
    });

    await expect(runner.runTask(projectId, "T1.6")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(409);
      expect((err as TaskRunnerError).message).toBe("Task has no check");
      return true;
    });

    expect(branchesCreated).toHaveLength(0);
    expect(worktreesAdded).toHaveLength(0);
    expect(fakeSessions.startedSessions).toHaveLength(0);
  });

  it("concurrency slot race: reserves slot before await and releases in finally on refusal", async () => {
    // Insert 1 task already running in DB
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.20",
        title: "Running Task",
        tag: "claude",
        checkCommand: "true",
        status: "running",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    // Insert 2 queued tasks
    db.insert(tasks)
      .values([
        {
          projectId,
          code: "T1.21",
          title: "Task 21",
          tag: "claude",
          checkCommand: "pnpm test",
          status: "queued",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
        {
          projectId,
          code: "T1.22",
          title: "Task 22",
          tag: "claude",
          checkCommand: "pnpm test",
          status: "queued",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
      ])
      .run();

    let resolveValidation!: () => void;
    const validationPromise = new Promise<void>((r) => {
      resolveValidation = r;
    });

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: {
        ...fakeGitOps,
        validateBranchName: async (branch) => {
          if (branch.includes("t1.21")) {
            await validationPromise;
          }
        },
      },
      transition: () => ({ state: { status: "in-review", attempts: 1 }, inbox: null }),
      runCheck: async () => ({ ok: true, exitCode: 0, timedOut: false, output: "" }),
    });

    // Start T1.21 (takes 2nd slot synchronously)
    const run21Promise = runner.runTask(projectId, "T1.21");

    // Concurrently try to start T1.22 (should be rejected with 409 because 2 slots are taken)
    await expect(runner.runTask(projectId, "T1.22")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(409);
      expect((err as TaskRunnerError).message).toContain("2 tasks already running");
      return true;
    });

    // Let T1.21 finish
    resolveValidation();
    const res21 = await run21Promise;
    expect(res21.ok).toBe(true);
    expect(runner.listRunning()).toHaveLength(0);
  });

  it("refusal after reservation releases slot so subsequent runs succeed", async () => {
    db.insert(tasks)
      .values([
        {
          projectId: workProjectId,
          code: "T1.30",
          title: "Work Gemini Refusal",
          tag: "gemini",
          checkCommand: "pnpm test",
          status: "queued",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
        {
          projectId,
          code: "T1.31",
          title: "Allowed Claude Task",
          tag: "claude",
          checkCommand: "pnpm test",
          status: "queued",
          milestoneCode: "M1",
          frozenAt: new Date().toISOString(),
        },
      ])
      .run();

    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
      transition: () => ({ state: { status: "in-review", attempts: 1 }, inbox: null }),
      runCheck: async () => ({ ok: true, exitCode: 0, timedOut: false, output: "" }),
    });

    // T1.30 is refused with 403 (profile guard)
    await expect(runner.runTask(workProjectId, "T1.30")).rejects.toMatchObject({ status: 403 });
    // Slot must be released
    expect(runner.listRunning()).toHaveLength(0);

    // T1.31 can run immediately
    const res = await runner.runTask(projectId, "T1.31");
    expect(res.ok).toBe(true);
    expect(runner.listRunning()).toHaveLength(0);
  });

  it("with transition throwing NotImplementedError, runTask → 503, no branch, no worktree, no runs row, no inbox row, and second call gives 503", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.40",
        title: "Not Implemented Task",
        tag: "claude",
        checkCommand: "pnpm test",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    // Default transition throws NotImplementedError
    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: fakeGitOps,
    });

    // First call → 503
    await expect(runner.runTask(projectId, "T1.40")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(503);
      expect((err as TaskRunnerError).message).toBe("Needs the task state machine (T5.2)");
      return true;
    });

    const worktreeDir = join(dataDir, "worktrees", String(projectId), "t1.40");
    expect(existsSync(worktreeDir)).toBe(false);
    expect(branchesCreated).not.toContain("daedalus/t1.40");
    expect(worktreesAdded).not.toContain(worktreeDir);

    const taskRow = db.select().from(tasks).where(eq(tasks.code, "T1.40")).get()!;
    expect(taskRow.status).toBe("queued");
    expect(taskRow.branch).toBeNull();

    const runsRows = db.select().from(runs).where(eq(runs.taskId, taskRow.id)).all();
    expect(runsRows).toHaveLength(0);

    const inboxRows = db.select().from(inbox).where(eq(inbox.projectId, projectId)).all();
    expect(inboxRows).toHaveLength(0);

    // Second call gives the exact same 503 (not "already exists")
    await expect(runner.runTask(projectId, "T1.40")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(503);
      expect((err as TaskRunnerError).message).toBe("Needs the task state machine (T5.2)");
      return true;
    });
  });

  it("removes worktree and deletes branch if failure occurs after worktree creation but before run row exists", async () => {
    db.insert(tasks)
      .values({
        projectId,
        code: "T1.41",
        title: "Worktree Cleanup Task",
        tag: "claude",
        checkCommand: "pnpm test",
        status: "queued",
        milestoneCode: "M1",
        frozenAt: new Date().toISOString(),
      })
      .run();

    // Remove provider row so provRow lookup throws after worktree creation
    db.delete(providers).where(eq(providers.name, "claude")).run();

    let worktreeDirCreated = "";
    const runner = new TaskRunner({
      db,
      dataDir,
      sessions: fakeSessions,
      git: {
        ...fakeGitOps,
        addWorktree: async (_repoDir, worktreeDir, opts) => {
          worktreeDirCreated = worktreeDir;
          mkdirSync(worktreeDir, { recursive: true });
          branchesCreated.push(opts.branch);
          worktreesAdded.push(worktreeDir);
        },
      },
      transition: () => ({ state: { status: "running", attempts: 1 }, inbox: null }),
    });

    await expect(runner.runTask(projectId, "T1.41")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TaskRunnerError);
      expect((err as TaskRunnerError).status).toBe(502);
      expect((err as TaskRunnerError).message).toContain("Provider claude not found");
      return true;
    });

    // Worktree was removed and branch deleted
    expect(existsSync(worktreeDirCreated)).toBe(false);
    expect(branchesCreated).not.toContain("daedalus/t1.41");
    expect(worktreesAdded).not.toContain(worktreeDirCreated);

    const taskRow = db.select().from(tasks).where(eq(tasks.code, "T1.41")).get()!;
    expect(taskRow.branch).toBeNull();
    const runsRows = db.select().from(runs).where(eq(runs.taskId, taskRow.id)).all();
    expect(runsRows).toHaveLength(0);
    const inboxRows = db.select().from(inbox).where(eq(inbox.projectId, projectId)).all();
    expect(inboxRows).toHaveLength(0);
  });
});
