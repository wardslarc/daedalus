/**
 * Review center (T6.1, SPEC#Review): diff against release branch, automatic gates
 * (secrets, dependencies, tests, check), acknowledgements and owner review decisions
 * (approve, send back with notes, discard).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  projects,
  reviewAcks,
  runs,
  shapingState,
  tasks,
} from "@daedalus/db";
import {
  addWorktreeForBranch,
  deleteBranch,
  execGit,
  GitError,
  mergeNoFf,
  removeWorktree,
  statusPorcelain,
  worktreeForBranch,
} from "@daedalus/git";
import {
  NotImplementedError,
  transition as defaultTransition,
  type TaskEvent,
  type TaskState,
  type TaskStatus,
  type Transition,
} from "@daedalus/core/task-state";
import type { ProjectLike } from "@daedalus/core/profiles";
import { redact } from "@daedalus/providers";
import { getRecordedCheckResult } from "./runner.js";

export class ReviewError extends Error {
  override name = "ReviewError";
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ReviewDiffFile = {
  path: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
};

export type ReviewDiff = {
  files: ReviewDiffFile[];
  patch: string;
};

export type ReviewCheck = {
  ok: boolean;
  exitCode: number | null;
  output: string;
};

export type GateId = "secrets" | "dependencies" | "tests" | "check";

export type Gate = {
  id: GateId;
  status: "pass" | "blocked" | "needs-ack";
  items: string[];
  ack?: { id?: number; ackedAt: string; note: string } | null;
};

export type ReviewData = {
  task: typeof tasks.$inferSelect;
  releaseBranch: string;
  diff: ReviewDiff;
  check: ReviewCheck | null;
  gates: Gate[];
};

export type ReviewOptions = {
  dataDir?: string;
  checkResult?: ReviewCheck | null;
  releaseBranch?: string;
};

export type ApproveOptions = {
  dataDir?: string;
  transition?: (state: TaskState, event: TaskEvent) => Transition;
  gitOps?: {
    worktreeForBranch?: typeof worktreeForBranch;
    statusPorcelain?: typeof statusPorcelain;
    addWorktreeForBranch?: typeof addWorktreeForBranch;
    mergeNoFf?: typeof mergeNoFf;
    removeWorktree?: typeof removeWorktree;
  };
};

export type SendBackOptions = {
  dataDir?: string;
  transition?: (state: TaskState, event: TaskEvent) => Transition;
  gitOps?: {
    removeWorktree?: (repoDir: string, worktreeDir: string) => Promise<void>;
    deleteBranch?: (dir: string, name: string) => Promise<void>;
  };
};

export type DiscardOptions = {
  dataDir?: string;
  transition?: (state: TaskState, event: TaskEvent) => Transition;
  gitOps?: {
    removeWorktree?: (repoDir: string, worktreeDir: string) => Promise<void>;
    deleteBranch?: (dir: string, name: string) => Promise<void>;
  };
};

const ONE_MIB = 1024 * 1024;

/**
 * Defensive schema bootstrap in case reviewer migrations haven't run yet.
 */
export function ensureReviewSchema(db: DaedalusDb): void {
  try {
    db.$client.exec(`
      CREATE TABLE IF NOT EXISTS review_acks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        gate TEXT NOT NULL,
        acked_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        note TEXT NOT NULL,
        UNIQUE(task_id, gate)
      );
    `);
  } catch {
    // ignore
  }
  try {
    db.$client.exec(`ALTER TABLE tasks ADD COLUMN review_notes TEXT;`);
  } catch {
    // column already exists
  }
}

/** Check if a file path is considered a dependency manifest or lock file. */
export function isDependencyPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  if (base === "package.json") return true;
  if (base === "go.mod" || base === "go.sum") return true;
  if (base === "Cargo.toml" || base === "Cargo.lock") return true;
  if (/^requirements.*\.txt$/i.test(base)) return true;
  if (
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "pnpm-lock.yml" ||
    base === "yarn.lock" ||
    base === "bun.lockb" ||
    base === "poetry.lock" ||
    base === "Gemfile.lock" ||
    base === "composer.lock" ||
    base.endsWith(".lock")
  ) {
    return true;
  }
  return false;
}

/** Check if a file path is considered a test file. */
export function isTestPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  if (/(?:^|\/)(?:test|tests|e2e|__tests__)\//i.test(norm)) return true;
  const base = norm.split("/").pop() ?? "";
  return /\.(?:test|spec)\.[^/]+$/i.test(base);
}

/**
 * Scan added lines of a unified diff patch for secrets using the redaction rules.
 * Any hit returns `${filePath}:${lineNumber}`, never the secret itself.
 */
export function scanPatchAddedLinesForSecrets(rawPatch: string): string[] {
  const hits: string[] = [];
  let currentFile = "";
  let currentNewLine = 0;

  for (const line of rawPatch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /diff --git a\/(.+) b\/(.+)/.exec(line);
      if (match) {
        currentFile = match[2]!;
      }
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
    } else if (line.startsWith("@@ ")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        currentNewLine = parseInt(match[1]!, 10);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedContent = line.slice(1);
      const redactedContent = redact(addedContent);
      if (redactedContent !== addedContent || redactedContent.includes("[REDACTED:")) {
        hits.push(`${currentFile}:${currentNewLine}`);
      }
      currentNewLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // deleted line, do not advance target line number
    } else {
      // context line
      currentNewLine++;
    }
  }

  return hits;
}

/**
 * Get review data for a task (diff, check result, automatic gates, acknowledgements).
 */
export async function getReview(
  db: DaedalusDb,
  project: ProjectLike,
  taskCode: string,
  options?: ReviewOptions,
): Promise<ReviewData> {
  ensureReviewSchema(db);

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .all()
    .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

  if (!task) {
    throw new ReviewError(`Task ${taskCode} not found in project ${project.id}`, 404);
  }

  // Determine release branch
  let releaseBranch = options?.releaseBranch ?? "";
  if (!releaseBranch) {
    const shapingRow = db
      .select()
      .from(shapingState)
      .where(eq(shapingState.projectId, project.id))
      .get();
    if (shapingRow?.activeMilestoneBranch) {
      releaseBranch = shapingRow.activeMilestoneBranch;
    } else {
      releaseBranch = "daedalus/release-v1.0";
    }
  }

  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;

  // Execute git diff <release>...daedalus/<task> with --no-ext-diff --no-textconv
  let rawPatch = "";
  const files: ReviewDiffFile[] = [];

  try {
    const nameStatusRes = await execGit(
      [
        "diff",
        "--name-status",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        `${releaseBranch}...${taskBranch}`,
      ],
      { cwd: project.localPath },
    );

    const numstatRes = await execGit(
      [
        "diff",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        `${releaseBranch}...${taskBranch}`,
      ],
      { cwd: project.localPath },
    );

    const nameLines = nameStatusRes.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const numLines = numstatRes.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const parsedNumstat = numLines.map((line) => {
      const parts = line.split("\t");
      const addStr = parts[0]?.trim() ?? "0";
      const delStr = parts[1]?.trim() ?? "0";
      return {
        additions: addStr === "-" ? 0 : parseInt(addStr, 10) || 0,
        deletions: delStr === "-" ? 0 : parseInt(delStr, 10) || 0,
      };
    });

    nameLines.forEach((line, idx) => {
      const parts = line.split("\t");
      const rawStatus = parts[0]?.trim() ?? "M";
      let status: "A" | "M" | "D" | "R" = "M";
      if (rawStatus.startsWith("A")) status = "A";
      else if (rawStatus.startsWith("D")) status = "D";
      else if (rawStatus.startsWith("R")) status = "R";
      else status = "M";

      const filePath =
        status === "R"
          ? (parts[2] ?? parts[1] ?? "").trim()
          : (parts[1] ?? "").trim();
      const num = parsedNumstat[idx];

      files.push({
        path: filePath,
        status,
        additions: num?.additions ?? 0,
        deletions: num?.deletions ?? 0,
      });
    });

    const patchRes = await execGit(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        `${releaseBranch}...${taskBranch}`,
      ],
      { cwd: project.localPath },
    );
    rawPatch = patchRes.stdout;
  } catch (err) {
    if (err instanceof GitError) {
      rawPatch = "";
    } else {
      throw err;
    }
  }

  // Scan added lines for secrets from the unredacted patch
  const secretHits = scanPatchAddedLinesForSecrets(rawPatch);

  // Cap patch at 1 MiB
  let patch = rawPatch;
  if (Buffer.byteLength(patch, "utf8") > ONE_MIB) {
    const buf = Buffer.from(patch, "utf8").subarray(0, ONE_MIB);
    patch = buf.toString("utf8") + "\n\n[Diff truncated: exceeds 1 MiB cap]";
  }
  patch = redact(patch);

  // Check result
  let check: ReviewCheck | null = null;
  if (options?.checkResult !== undefined) {
    check = options.checkResult;
  } else {
    const recorded = getRecordedCheckResult(project.id, task.code);
    if (recorded) {
      check = {
        ok: recorded.ok,
        exitCode: recorded.exitCode,
        output: redact(recorded.output),
      };
    } else {
      const lastRun = db
        .select()
        .from(runs)
        .where(eq(runs.taskId, task.id))
        .orderBy(desc(runs.id))
        .limit(1)
        .get();

      if (lastRun) {
        const ok = lastRun.exitStatus === 0;
        check = {
          ok,
          exitCode: lastRun.exitStatus,
          output: ok ? "Check passed" : `Check failed with exit code ${lastRun.exitStatus ?? 1}`,
        };
      }
    }
  }

  if (check) {
    check.output = redact(check.output);
  }

  // Gates
  // 1. secrets
  const secretItems = secretHits;

  // 2. dependencies
  const depItems = files
    .filter((f) => isDependencyPath(f.path))
    .map((f) => f.path);

  // 3. tests: deleted test file or modified test file where lines were removed
  const testItems: string[] = [];
  for (const f of files) {
    if (isTestPath(f.path) && (f.status === "D" || f.deletions > 0)) {
      testItems.push(f.path);
    }
  }

  // 4. check: last check failed or missing -> blocked
  let checkGateStatus: "pass" | "blocked" = "pass";
  const checkGateItems: string[] = [];
  if (!check) {
    checkGateStatus = "blocked";
    checkGateItems.push("Check result missing");
  } else if (!check.ok || check.exitCode !== 0) {
    checkGateStatus = "blocked";
    checkGateItems.push(`Last check failed with exit code ${check.exitCode ?? 1}`);
  }

  // Fetch acknowledgements
  let acks: Array<typeof reviewAcks.$inferSelect> = [];
  try {
    acks = db
      .select()
      .from(reviewAcks)
      .where(eq(reviewAcks.taskId, task.id))
      .all();
  } catch {
    // ignore
  }

  const ackMap = new Map(acks.map((a) => [a.gate, a]));

  const gates: Gate[] = [
    {
      id: "secrets",
      status: secretItems.length > 0 ? "blocked" : "pass",
      items: secretItems,
      ack: ackMap.get("secrets")
        ? {
            id: ackMap.get("secrets")!.id,
            ackedAt: ackMap.get("secrets")!.ackedAt,
            note: ackMap.get("secrets")!.note,
          }
        : null,
    },
    {
      id: "dependencies",
      status: depItems.length > 0 ? "needs-ack" : "pass",
      items: depItems,
      ack: ackMap.get("dependencies")
        ? {
            id: ackMap.get("dependencies")!.id,
            ackedAt: ackMap.get("dependencies")!.ackedAt,
            note: ackMap.get("dependencies")!.note,
          }
        : null,
    },
    {
      id: "tests",
      status: testItems.length > 0 ? "needs-ack" : "pass",
      items: testItems,
      ack: ackMap.get("tests")
        ? {
            id: ackMap.get("tests")!.id,
            ackedAt: ackMap.get("tests")!.ackedAt,
            note: ackMap.get("tests")!.note,
          }
        : null,
    },
    {
      id: "check",
      status: checkGateStatus,
      items: checkGateItems,
      ack: ackMap.get("check")
        ? {
            id: ackMap.get("check")!.id,
            ackedAt: ackMap.get("check")!.ackedAt,
            note: ackMap.get("check")!.note,
          }
        : null,
    },
  ];

  return {
    task,
    releaseBranch,
    diff: {
      files,
      patch,
    },
    check,
    gates,
  };
}

/**
 * List all in-review tasks for a project.
 */
export function listInReviewTasks(
  db: DaedalusDb,
  projectId: number,
): Array<typeof tasks.$inferSelect> {
  ensureReviewSchema(db);
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "in-review")))
    .all();
}

/**
 * Approve task: 409 unless in-review, no gate is blocked, and every needs-ack gate is acked.
 * Merges daedalus/<task> into the release branch with mergeNoFf.
 * Uses a temporary worktree under <dataDir>/worktrees/ (or checked out release worktree if clean).
 * Never touches main or default branch.
 */
export async function approveTask(
  db: DaedalusDb,
  project: ProjectLike,
  taskCode: string,
  options?: ApproveOptions,
): Promise<{ sha: string; status: TaskStatus }> {
  ensureReviewSchema(db);

  const review = await getReview(db, project, taskCode, { dataDir: options?.dataDir });
  const task = review.task;

  if (task.status !== "in-review") {
    throw new ReviewError(
      `Task ${task.code} is "${task.status}", expected "in-review" to approve.`,
      409,
    );
  }

  // Check gates
  for (const gate of review.gates) {
    if (gate.status === "blocked") {
      throw new ReviewError(
        `Gate '${gate.id}' is blocked. Resolve blocking items before approval.`,
        409,
      );
    }
    if (gate.status === "needs-ack" && !gate.ack) {
      throw new ReviewError(
        `Gate '${gate.id}' requires acknowledgement before approval.`,
        409,
      );
    }
  }

  const targetBranch = review.releaseBranch;
  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;

  // Safety: never merge into defaultBranch or main directly
  if (
    targetBranch === project.defaultBranch &&
    (project.defaultBranch === "main" || project.defaultBranch === "master")
  ) {
    throw new ReviewError(
      `Cannot approve into '${targetBranch}'. Tasks must merge into milestone release branch.`,
      409,
    );
  }

  const repo = project.localPath;
  const gitWorktreeForBranch = options?.gitOps?.worktreeForBranch ?? worktreeForBranch;
  const gitStatusPorcelain = options?.gitOps?.statusPorcelain ?? statusPorcelain;
  const gitAddWorktreeForBranch = options?.gitOps?.addWorktreeForBranch ?? addWorktreeForBranch;
  const gitMergeNoFf = options?.gitOps?.mergeNoFf ?? mergeNoFf;
  const gitRemoveWorktree = options?.gitOps?.removeWorktree ?? removeWorktree;

  const checkedOut = await gitWorktreeForBranch(repo, targetBranch);
  let workDir: string;
  let tempDir: string | null = null;

  if (checkedOut) {
    const changes = (await gitStatusPorcelain(checkedOut)).filter((l) => !l.startsWith("??"));
    if (changes.length > 0) {
      throw new ReviewError(
        `${targetBranch} has uncommitted changes in ${checkedOut}. Commit or stash them first.`,
        409,
      );
    }
    workDir = checkedOut;
  } else {
    const dataDir = options?.dataDir ?? resolve(repo, ".daedalus-data");
    tempDir = join(
      dataDir,
      "worktrees",
      String(project.id),
      `merge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    mkdirSync(dirname(tempDir), { recursive: true });
    await gitAddWorktreeForBranch(repo, tempDir, targetBranch);
    workDir = tempDir;
  }

  try {
    let result: Awaited<ReturnType<typeof mergeNoFf>>;
    try {
      result = await gitMergeNoFf(workDir, taskBranch, `Merge task ${task.code}: ${task.title}`);
    } catch (err) {
      const detail = err instanceof GitError ? err.message : String(err);
      throw new ReviewError(`git refused the merge, nothing was changed.\n${detail}`.trim(), 409);
    }

    if (!result.ok) {
      throw new ReviewError(
        `Merge conflict in: ${result.conflicts.join(", ")}. Nothing changed.`,
        409,
      );
    }

    // transition(approve)
    const transFn = options?.transition ?? defaultTransition;
    let trans: Transition;
    try {
      trans = transFn(
        { status: task.status as TaskStatus, attempts: task.attempts },
        { type: "approve" },
      );
    } catch (err) {
      if (err instanceof NotImplementedError || (err as Error)?.name === "NotImplementedError") {
        throw new ReviewError("Needs the task state machine (T5.2)", 503);
      }
      throw err;
    }

    // Persist status
    db.update(tasks)
      .set({
        status: trans.state.status,
        attempts: trans.state.attempts,
      })
      .where(eq(tasks.id, task.id))
      .run();

    // Remove task worktree, keep branch
    const dataDir = options?.dataDir ?? resolve(repo, ".daedalus-data");
    const taskWorktreeDir = resolve(dataDir, "worktrees", String(project.id), task.code.toLowerCase());
    if (existsSync(taskWorktreeDir)) {
      try {
        await gitRemoveWorktree(repo, taskWorktreeDir);
      } catch {
        // ignore
      }
      try {
        rmSync(taskWorktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    return { sha: result.sha, status: trans.state.status };
  } finally {
    if (tempDir) {
      try {
        await gitRemoveWorktree(repo, tempDir);
      } catch {
        // ignore
      }
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Send back: notes 1–4000 chars; transition(requeue); store notes on task;
 * remove worktree and delete task branch.
 */
export async function sendBack(
  db: DaedalusDb,
  project: ProjectLike,
  taskCode: string,
  notes: string,
  options?: SendBackOptions,
): Promise<{ status: TaskStatus }> {
  ensureReviewSchema(db);

  if (typeof notes !== "string" || notes.trim().length < 1 || notes.length > 4000) {
    throw new ReviewError("Review notes must be between 1 and 4000 characters.", 400);
  }

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .all()
    .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

  if (!task) {
    throw new ReviewError(`Task ${taskCode} not found in project ${project.id}`, 404);
  }

  const transFn = options?.transition ?? defaultTransition;
  let trans: Transition;
  try {
    trans = transFn(
      { status: task.status as TaskStatus, attempts: task.attempts },
      { type: "requeue" },
    );
  } catch (err) {
    if (err instanceof NotImplementedError || (err as Error)?.name === "NotImplementedError") {
      throw new ReviewError("Needs the task state machine (T5.2)", 503);
    }
    throw err;
  }

  db.update(tasks)
    .set({
      reviewNotes: notes.trim(),
      status: trans.state.status,
      attempts: trans.state.attempts,
      branch: null,
    })
    .where(eq(tasks.id, task.id))
    .run();

  // Remove worktree and delete branch
  const repo = project.localPath;
  const dataDir = options?.dataDir ?? resolve(repo, ".daedalus-data");
  const taskWorktreeDir = resolve(dataDir, "worktrees", String(project.id), task.code.toLowerCase());
  const gitRemoveWorktree = options?.gitOps?.removeWorktree ?? removeWorktree;
  const gitDeleteBranch = options?.gitOps?.deleteBranch ?? deleteBranch;

  if (existsSync(taskWorktreeDir)) {
    try {
      await gitRemoveWorktree(repo, taskWorktreeDir);
    } catch {
      // ignore
    }
    try {
      rmSync(taskWorktreeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;
  try {
    await gitDeleteBranch(repo, taskBranch);
  } catch {
    // branch may already be gone
  }

  return { status: trans.state.status };
}

/**
 * Discard: transition(requeue), remove worktree, delete branch, clear notes.
 */
export async function discardTask(
  db: DaedalusDb,
  project: ProjectLike,
  taskCode: string,
  options?: DiscardOptions,
): Promise<{ status: TaskStatus }> {
  ensureReviewSchema(db);

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .all()
    .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

  if (!task) {
    throw new ReviewError(`Task ${taskCode} not found in project ${project.id}`, 404);
  }

  const transFn = options?.transition ?? defaultTransition;
  let trans: Transition;
  try {
    trans = transFn(
      { status: task.status as TaskStatus, attempts: task.attempts },
      { type: "requeue" },
    );
  } catch (err) {
    if (err instanceof NotImplementedError || (err as Error)?.name === "NotImplementedError") {
      throw new ReviewError("Needs the task state machine (T5.2)", 503);
    }
    throw err;
  }

  db.update(tasks)
    .set({
      reviewNotes: null,
      branch: null,
      status: trans.state.status,
      attempts: trans.state.attempts,
    })
    .where(eq(tasks.id, task.id))
    .run();

  try {
    db.delete(reviewAcks).where(eq(reviewAcks.taskId, task.id)).run();
  } catch {
    // ignore
  }

  // Remove worktree and delete branch
  const repo = project.localPath;
  const dataDir = options?.dataDir ?? resolve(repo, ".daedalus-data");
  const taskWorktreeDir = resolve(dataDir, "worktrees", String(project.id), task.code.toLowerCase());
  const gitRemoveWorktree = options?.gitOps?.removeWorktree ?? removeWorktree;
  const gitDeleteBranch = options?.gitOps?.deleteBranch ?? deleteBranch;

  if (existsSync(taskWorktreeDir)) {
    try {
      await gitRemoveWorktree(repo, taskWorktreeDir);
    } catch {
      // ignore
    }
    try {
      rmSync(taskWorktreeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;
  try {
    await gitDeleteBranch(repo, taskBranch);
  } catch {
    // branch may already be gone
  }

  return { status: trans.state.status };
}

/**
 * Acknowledge a needs-ack gate (1-1000 characters).
 */
export async function ackGate(
  db: DaedalusDb,
  project: ProjectLike,
  taskCode: string,
  gateId: string,
  note: string,
): Promise<{ gate: string; note: string; ackedAt: string }> {
  ensureReviewSchema(db);

  if (typeof note !== "string" || note.trim().length < 1 || note.length > 1000) {
    throw new ReviewError("Acknowledgement note must be between 1 and 1000 characters.", 400);
  }

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .all()
    .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

  if (!task) {
    throw new ReviewError(`Task ${taskCode} not found in project ${project.id}`, 404);
  }

  const review = await getReview(db, project, taskCode);
  const gate = review.gates.find((g) => g.id === gateId);
  if (!gate) {
    throw new ReviewError(`Unknown gate '${gateId}'.`, 404);
  }

  if (gate.status !== "needs-ack") {
    throw new ReviewError(
      `Gate '${gateId}' has status '${gate.status}' and does not need acknowledgement.`,
      400,
    );
  }

  const ackedAt = new Date().toISOString();
  db.insert(reviewAcks)
    .values({
      taskId: task.id,
      gate: gateId,
      note: note.trim(),
      ackedAt,
    })
    .onConflictDoUpdate({
      target: [reviewAcks.taskId, reviewAcks.gate],
      set: {
        note: note.trim(),
        ackedAt,
      },
    })
    .run();

  return {
    gate: gateId,
    note: note.trim(),
    ackedAt,
  };
}
