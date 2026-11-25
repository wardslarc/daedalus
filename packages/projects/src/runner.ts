import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  inbox,
  projects,
  providers as providersTable,
  reviewAcks,
  runs,
  shapingState,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
import {
  addWorktree,
  commitAll,
  deleteBranch,
  removeWorktree,
  validateBranchName,
} from "@daedalus/git";
import { assertProviderAllowed, ProfileRuleError } from "@daedalus/core/profiles";
import {
  NotImplementedError,
  transition as defaultTransition,
  type TaskEvent,
  type TaskState,
  type TaskStatus,
  type Transition,
} from "@daedalus/core/task-state";
import { redact, type AgentSession, type ProviderEntry, type SessionProject } from "@daedalus/providers";
import {
  killAllRunningChecks,
  runCheck as defaultRunCheck,
  type CheckResult,
} from "./check-exec.js";
import { parsePlanMarkdown } from "./pipeline.js";
import { readShapingDoc, SHAPING_DOCS } from "./shaping.js";

export class TaskRunnerError extends Error {
  override name = "TaskRunnerError";
  readonly status: number;
  constructor(messageOrStatus: string | number, statusOrMessage: number | string = 400) {
    if (typeof messageOrStatus === "number") {
      super(String(statusOrMessage));
      this.status = messageOrStatus;
    } else {
      super(messageOrStatus);
      this.status = typeof statusOrMessage === "number" ? statusOrMessage : 400;
    }
  }
}

export type TaskRunnerSession = Pick<AgentSession, "startedAt" | "prompt" | "stop"> & {
  id: string;
};

export type TaskRunnerSessions = {
  start: (
    project: SessionProject,
    providerId: string,
    opts?: { permissionPolicy?: "ask-owner" | "read-only" },
  ) => Promise<TaskRunnerSession>;
  stopAll: () => Promise<void>;
  get?: (id: string) => TaskRunnerSession | undefined;
  list?: () => readonly TaskRunnerSession[];
};

export type TaskRunnerGitOps = {
  validateBranchName: (name: string, dir?: string) => Promise<void>;
  addWorktree: (
    repoDir: string,
    worktreeDir: string,
    options: { branch: string; from: string },
  ) => Promise<void>;
  removeWorktree: (repoDir: string, worktreeDir: string) => Promise<void>;
  deleteBranch: (dir: string, name: string) => Promise<void>;
  commitAll: (
    dir: string,
    message: string,
    options?: { author?: string; noVerify?: boolean },
  ) => Promise<string | null>;
};

export type TaskRunnerOptions = {
  db: DaedalusDb;
  dataDir: string;
  sessions: TaskRunnerSessions;
  providers?: readonly ProviderEntry[];
  transition?: (state: TaskState, event: TaskEvent) => Transition;
  git?: TaskRunnerGitOps;
  checkTimeoutMs?: number;
  now?: () => string;
  templatePath?: string;
  runCheck?: typeof defaultRunCheck;
};

export type RunTaskResult = {
  ok: boolean;
  status: TaskStatus;
  runId: number;
  commitSha: string | null;
  checkResult: CheckResult;
};

const SIXTY_FOUR_KIB = 64 * 1024;

function formatCheckOutputForDb(output: string): string {
  let redacted = redact(output);
  if (Buffer.byteLength(redacted, "utf8") > SIXTY_FOUR_KIB) {
    const buf = Buffer.from(redacted, "utf8");
    redacted = buf.subarray(0, SIXTY_FOUR_KIB).toString("utf8");
  }
  return redacted;
}


const defaultGitOps: TaskRunnerGitOps = {
  validateBranchName,
  addWorktree,
  removeWorktree,
  deleteBranch,
  commitAll,
};

const DEFAULT_PROMPT_TEMPLATE = `<!-- Placeholder task prompt until the owner's M7 prompt builder exists. -->
# Task {{CODE}}: {{TITLE}}

## Description
{{DESCRIPTION}}

## Check Command
{{CHECK_COMMAND}}

## Linked Spec Sections
{{SPEC_LINKS}}

{{REVIEW_NOTES}}
Please implement this task in the workspace. Ensure all checks pass before finishing.
`;

function resolveDefaultTemplatePath(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const webPromptPath = resolve(thisDir, "../../../apps/web/src/runner/task-prompt.md");
    if (existsSync(webPromptPath)) {
      return webPromptPath;
    }
  } catch {
    // ignore
  }
  return "";
}

export class TaskRunner {
  private readonly db: DaedalusDb;
  private readonly dataDir: string;
  private readonly sessions: TaskRunnerSessions;
  private readonly transition: (state: TaskState, event: TaskEvent) => Transition;
  private readonly gitOps: TaskRunnerGitOps;
  private readonly checkTimeoutMs: number;
  private readonly now: () => string;
  private readonly templatePath: string;
  private readonly checkExecutor: typeof defaultRunCheck;

  private readonly activeRuns = new Map<
    string,
    { taskId: number; projectId: number; taskCode: string }
  >();
  private readonly lastCheckOutputs = new Map<string, string>();

  constructor(opts: TaskRunnerOptions) {
    this.db = opts.db;
    this.dataDir = opts.dataDir;
    this.sessions = opts.sessions;
    this.transition = opts.transition ?? defaultTransition;
    this.gitOps = opts.git ?? defaultGitOps;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.templatePath = opts.templatePath || resolveDefaultTemplatePath();
    this.checkExecutor = opts.runCheck ?? defaultRunCheck;
  }

  listRunning(): Array<{ projectId: number; taskCode: string; taskId: number }> {
    return Array.from(this.activeRuns.values());
  }

  getLastCheckOutput(projectId: number, taskCode: string): string | null {
    return this.lastCheckOutputs.get(`${projectId}:${taskCode}`) ?? null;
  }

  recoverOnStartup(): Array<typeof tasks.$inferSelect> {
    const leftRunning = this.db.select().from(tasks).where(eq(tasks.status, "running")).all();
    for (const t of leftRunning) {
      this.db
        .insert(inbox)
        .values({
          projectId: t.projectId,
          kind: "failed_check",
          link: `/projects/${t.projectId}/pipeline#${t.code}`,
        })
        .run();
    }
    return leftRunning;
  }

  async stopAll(): Promise<void> {
    await this.sessions.stopAll();
    killAllRunningChecks();
  }

  async runTask(projectId: number, taskCode: string): Promise<RunTaskResult> {
    // 1. Load project and task from DB
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      throw new TaskRunnerError(`Project with id ${projectId} not found`, 404);
    }

    const task = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .all()
      .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

    if (!task) {
      throw new TaskRunnerError(`Task ${taskCode} not found in project ${projectId}`, 404);
    }

    // Refusals (409)
    if (!task.frozenAt) {
      throw new TaskRunnerError(`Task ${task.code} is not frozen`, 409);
    }

    if (!task.checkCommand || task.checkCommand.trim() === "") {
      throw new TaskRunnerError("Task has no check", 409);
    }

    const shapingRow = this.db
      .select()
      .from(shapingState)
      .where(eq(shapingState.projectId, projectId))
      .get();

    if (!shapingRow || !shapingRow.activeMilestoneFrozen || !shapingRow.activeMilestoneBranch) {
      throw new TaskRunnerError("Milestone is not active or not frozen", 409);
    }

    const activeCode = shapingRow.activeMilestoneCode?.toLowerCase();
    const activeVer = shapingRow.activeMilestoneVersion?.toLowerCase();
    const taskMilestone = task.milestoneCode?.toLowerCase();

    const milestoneMatches =
      Boolean(taskMilestone) &&
      Boolean(
        (activeCode && taskMilestone === activeCode) ||
        (activeVer && taskMilestone === activeVer),
      );

    if (!milestoneMatches) {
      throw new TaskRunnerError(
        `Task milestone ${task.milestoneCode ?? "(none)"} does not match active milestone ${shapingRow.activeMilestoneCode ?? shapingRow.activeMilestoneVersion}`,
        409,
      );
    }

    if (task.tag === "you") {
      throw new TaskRunnerError("Owner task ([you]) cannot be run by an agent", 409);
    }

    if (task.status !== "queued") {
      throw new TaskRunnerError(
        `Task status is "${task.status}", expected "queued" to run`,
        409,
      );
    }

    const runningInDb = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "running"))
      .all();
    const activeTaskIds = new Set(runningInDb.map((t) => t.id));
    for (const active of this.activeRuns.values()) {
      activeTaskIds.add(active.taskId);
    }

    if (activeTaskIds.size >= 2 || this.activeRuns.has(`${projectId}:${task.code}`)) {
      throw new TaskRunnerError("2 tasks already running across all projects", 409);
    }

    // Synchronously reserve slot before any await
    const runKey = `${projectId}:${task.code}`;
    this.activeRuns.set(runKey, { taskId: task.id, projectId, taskCode: task.code });

    let runId: number | null = null;
    let worktreeCreated = false;
    let branch = "";
    let worktreeDir = "";
    let session: TaskRunnerSession | null = null;
    let checkRes!: CheckResult;
    let commitSha: string | null = null;
    let finalStatus!: TaskStatus;

    try {
      // 2. Provider from frozen tag
      let providerName: string;
      if (task.tag === "claude") {
        providerName = "claude";
      } else if (task.tag === "gemini") {
        providerName = "antigravity";
      } else {
        throw new TaskRunnerError(`Invalid provider tag "${task.tag}"`, 409);
      }

      try {
        assertProviderAllowed(project, providerName);
      } catch (err) {
        if (err instanceof ProfileRuleError) {
          throw new TaskRunnerError(err.message, 403);
        }
        throw err;
      }

      // Check transition(start) first, before creating branch or worktree (pure; persist after worktree exists)
      const startTrans = this.transition(
        { status: task.status as TaskStatus, attempts: task.attempts },
        { type: "start" },
      );

      // 3. Branch daedalus/<code lowercased>
      branch = `daedalus/${task.code.toLowerCase()}`;
      await this.gitOps.validateBranchName(branch, project.localPath);

      worktreeDir = resolve(
        this.dataDir,
        "worktrees",
        String(projectId),
        task.code.toLowerCase(),
      );

      if (existsSync(worktreeDir)) {
        throw new TaskRunnerError(`Worktree directory already exists: ${worktreeDir}`, 409);
      }

      mkdirSync(dirname(worktreeDir), { recursive: true });
      await this.gitOps.addWorktree(project.localPath, worktreeDir, {
        branch,
        from: shapingRow.activeMilestoneBranch,
      });
      worktreeCreated = true;

      this.db.update(tasks).set({ branch }).where(eq(tasks.id, task.id)).run();

      // 4. Persist status + attempts now that worktree exists. Insert runs row
      this.db.delete(reviewAcks).where(eq(reviewAcks.taskId, task.id)).run();
      this.db
        .update(tasks)
        .set({
          status: startTrans.state.status,
          attempts: startTrans.state.attempts,
        })
        .where(eq(tasks.id, task.id))
        .run();

      const provRow = this.db
        .select()
        .from(providersTable)
        .where(eq(providersTable.name, providerName))
        .get();

      if (!provRow) {
        throw new TaskRunnerError(`Provider ${providerName} not found in database`, 502);
      }

      const runStartTime = this.now();
      const [insertedRun] = this.db
        .insert(runs)
        .values({
          taskId: task.id,
          providerId: provRow.id,
          role: "implement",
          start: runStartTime,
        })
        .returning()
        .all();

      runId = insertedRun!.id;

      // 5. Start session and send task prompt
      session = await this.sessions.start(
        {
          ...project,
          localPath: worktreeDir,
        },
        providerName,
      );

      // Build task prompt from static template (placeholder until M7 prompt builder)
      let template = DEFAULT_PROMPT_TEMPLATE;
      if (this.templatePath && existsSync(this.templatePath)) {
        try {
          template = readFileSync(this.templatePath, "utf8");
        } catch {
          // ignore, keep default
        }
      }

      let taskDescription = "";
      try {
        const planDoc = readShapingDoc(project.localPath, SHAPING_DOCS.plan);
        if (planDoc.content) {
          const parsed = parsePlanMarkdown(planDoc.content);
          const pt = parsed.tasks.find((t) => t.code === task.code);
          if (pt?.description) {
            taskDescription = pt.description;
          }
        }
      } catch {
        // ignore
      }
      if (!taskDescription && task.description) {
        taskDescription = task.description;
      }

      const specLinks = (task.linkedSpecSections || [])
        .map((s) => `[[SPEC#${s}]]`)
        .join(" ");

      const reviewNotesText = task.reviewNotes
        ? `## Review Notes\n${task.reviewNotes}\n\n`
        : "";

      const prompt = template
        .replaceAll("{{CODE}}", task.code)
        .replaceAll("{{TITLE}}", task.title)
        .replaceAll("{{DESCRIPTION}}", taskDescription)
        .replaceAll("{{CHECK_COMMAND}}", task.checkCommand)
        .replaceAll("{{SPEC_LINKS}}", specLinks)
        .replaceAll("{{REVIEW_NOTES}}", reviewNotesText);

      await session.prompt(prompt);

      // 6. When turn ends, run check
      checkRes = await this.checkExecutor(task.checkCommand, worktreeDir, {
        timeoutMs: this.checkTimeoutMs,
      });

      this.lastCheckOutputs.set(runKey, checkRes.output);

      const checkExitCode1 = checkRes.ok ? 0 : (checkRes.exitCode ?? (checkRes.timedOut ? null : 1));
      const checkOutput1 = formatCheckOutputForDb(checkRes.output);

      this.db
        .update(runs)
        .set({
          checkExitCode: checkExitCode1,
          checkOutput: checkOutput1,
        })
        .where(eq(runs.id, runId))
        .run();

      let currentStatus = startTrans.state.status;
      let currentAttempts = startTrans.state.attempts;

      if (checkRes.ok) {
        commitSha = await this.gitOps.commitAll(
          worktreeDir,
          `${task.code}: ${task.title} (Daedalus task run)`,
          { noVerify: true },
        );
        const passTrans = this.transition(
          { status: currentStatus, attempts: currentAttempts },
          { type: "check-passed" },
        );
        finalStatus = passTrans.state.status;
        this.db
          .update(tasks)
          .set({
            status: passTrans.state.status,
            attempts: passTrans.state.attempts,
          })
          .where(eq(tasks.id, task.id))
          .run();
        await session.stop();
        // Keep worktree for review
      } else {
        const failTrans1 = this.transition(
          { status: currentStatus, attempts: currentAttempts },
          { type: "check-failed" },
        );
        currentStatus = failTrans1.state.status;
        currentAttempts = failTrans1.state.attempts;
        finalStatus = currentStatus;

        this.db
          .update(tasks)
          .set({
            status: currentStatus,
            attempts: currentAttempts,
          })
          .where(eq(tasks.id, task.id))
          .run();

        if (currentStatus === "running") {
          // Exactly ONE follow-up prompt in same session with last 4 KiB redacted check output
          const tailOutput = checkRes.output.slice(-4096);
          const retryPrompt = [
            `Check failed with exit code ${checkRes.exitCode ?? (checkRes.timedOut ? "timeout" : 1)}.`,
            "Check output (last 4 KiB):",
            tailOutput,
            "",
            "Please fix the code so the check passes.",
          ].join("\n");

          await session.prompt(retryPrompt);

          // Check again
          checkRes = await this.checkExecutor(task.checkCommand, worktreeDir, {
            timeoutMs: this.checkTimeoutMs,
          });
          this.lastCheckOutputs.set(runKey, checkRes.output);

          const checkExitCode2 = checkRes.ok ? 0 : (checkRes.exitCode ?? (checkRes.timedOut ? null : 1));
          const checkOutput2 = formatCheckOutputForDb(checkRes.output);

          this.db
            .update(runs)
            .set({
              checkExitCode: checkExitCode2,
              checkOutput: checkOutput2,
            })
            .where(eq(runs.id, runId))
            .run();

          if (checkRes.ok) {
            commitSha = await this.gitOps.commitAll(
              worktreeDir,
              `${task.code}: ${task.title} (Daedalus task run)`,
              { noVerify: true },
            );
            const passTrans = this.transition(
              { status: currentStatus, attempts: currentAttempts },
              { type: "check-passed" },
            );
            finalStatus = passTrans.state.status;
            this.db
              .update(tasks)
              .set({
                status: passTrans.state.status,
                attempts: passTrans.state.attempts,
              })
              .where(eq(tasks.id, task.id))
              .run();
            await session.stop();
            // Keep worktree for review
          } else {
            const failTrans2 = this.transition(
              { status: currentStatus, attempts: currentAttempts },
              { type: "check-failed" },
            );
            finalStatus = failTrans2.state.status;
            this.db
              .update(tasks)
              .set({
                status: failTrans2.state.status,
                attempts: failTrans2.state.attempts,
              })
              .where(eq(tasks.id, task.id))
              .run();
            await session.stop();

            if (failTrans2.inbox === "failed_check") {
              this.db
                .insert(inbox)
                .values({
                  projectId,
                  kind: "failed_check",
                  link: `/projects/${projectId}/pipeline#${task.code}`,
                })
                .run();
            }
          }
        } else {
          // Result was immediately check-failed
          await session.stop();
          if (failTrans1.inbox === "failed_check") {
            this.db
              .insert(inbox)
              .values({
                projectId,
                kind: "failed_check",
                link: `/projects/${projectId}/pipeline#${task.code}`,
              })
              .run();
          }
        }
      }

      // 7. Close runs row
      let logPath: string | null = null;
      if (session) {
        const potentialLog = join(
          this.dataDir,
          "runs",
          session.startedAt.slice(0, 10),
          `${session.id}.jsonl`,
        );
        if (existsSync(potentialLog)) {
          logPath = potentialLog;
        }
      }

      const finalExitCode = checkRes.ok ? 0 : (checkRes.exitCode ?? (checkRes.timedOut ? null : 1));
      const finalOutput = formatCheckOutputForDb(checkRes.output);

      this.db
        .update(runs)
        .set({
          end: this.now(),
          exitStatus: checkRes.ok ? 0 : (checkRes.exitCode ?? 1),
          logPath,
          checkExitCode: finalExitCode,
          checkOutput: finalOutput,
        })
        .where(eq(runs.id, runId))
        .run();

      return {
        ok: checkRes.ok,
        status: finalStatus,
        runId,
        commitSha,
        checkResult: checkRes,
      };
    } catch (err) {
      let errorToThrow = err;
      if (err instanceof NotImplementedError || (err as Error)?.name === "NotImplementedError") {
        errorToThrow = new TaskRunnerError(503, "Needs the task state machine (T5.2)");
      }

      // If anything throws after step 4: record in run row, stop session, insert inbox item, leave status as is
      if (runId !== null) {
        if (session) {
          try {
            await session.stop();
          } catch {
            // ignore
          }
        }

        try {
          this.db
            .update(runs)
            .set({
              end: this.now(),
              exitStatus: 1,
            })
            .where(eq(runs.id, runId))
            .run();
        } catch {
          // ignore
        }

        try {
          this.db
            .insert(inbox)
            .values({
              projectId,
              kind: "failed_check",
              link: `/projects/${projectId}/pipeline#${task.code}`,
            })
            .run();
        } catch {
          // ignore
        }
      } else if (worktreeCreated) {
        // If anything fails after the worktree/branch were created and before the run row exists,
        // remove the worktree and delete the branch (ignore cleanup errors, keep the original error)
        try {
          await this.gitOps.removeWorktree(project.localPath, worktreeDir);
        } catch {
          // ignore cleanup errors
        }
        try {
          if (existsSync(worktreeDir)) {
            rmSync(worktreeDir, { recursive: true, force: true });
          }
        } catch {
          // ignore cleanup errors
        }
        try {
          await this.gitOps.deleteBranch(project.localPath, branch);
        } catch {
          // ignore cleanup errors
        }
        try {
          this.db
            .update(tasks)
            .set({ branch: null, status: task.status, attempts: task.attempts })
            .where(eq(tasks.id, task.id))
            .run();
        } catch {
          // ignore cleanup errors
        }
      }

      throw errorToThrow;
    } finally {
      this.activeRuns.delete(runKey);
    }
  }
}
