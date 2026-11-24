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

export type ReviewProject = ProjectLike & {
  id: number;
  localPath: string;
  defaultBranch: string;
};

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
  oldPath?: string;
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

export type ReviewGitOps = {
  execGit?: typeof execGit;
};

export type ReviewOptions = {
  dataDir?: string;
  checkResult?: ReviewCheck | null;
  releaseBranch?: string;
  gitOps?: ReviewGitOps;
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
    execGit?: typeof execGit;
  };
};

export type AckGateOptions = {
  gitOps?: {
    execGit?: typeof execGit;
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
const SIXTY_FOUR_MIB = 64 * 1024 * 1024;

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

/** Check if a file path is considered a .gitattributes file. */
export function isGitAttributesPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  return base === ".gitattributes";
}

export const REVIEW_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/**
 * Builds git diff command arguments with strict safety flags that prevent
 * review gates from being bypassed by repo-local or user git configs,
 * external diff tools, color codes, or gitattributes.
 */
export function buildReviewDiffArgs(extraArgs: string[], range: string): string[] {
  return [
    "-c",
    "color.ui=never",
    "-c",
    "color.diff=never",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.relative=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.external=",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    ...extraArgs,
    "--end-of-options",
    range,
  ];
}

/**
 * Scan added lines of a unified diff patch for secrets using the redaction rules.
 * Any hit returns `${filePath}:${lineNumber}`, never the secret itself.
 */
export function scanPatchAddedLinesForSecrets(rawPatch: string): string[] {
  const hits: string[] = [];
  let currentFile = "";
  let currentNewLine = 0;
  let remainingNewLines = 0;
  let inHunk = false;

  for (const line of rawPatch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      remainingNewLines = 0;
      const match = /diff --git a\/(.+) b\/(.+)/.exec(line);
      if (match) {
        currentFile = match[2]!;
      }
    } else if (!inHunk && line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
    } else if (line.startsWith("@@ ")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        currentNewLine = parseInt(match[1]!, 10);
        const countStr = match[2];
        remainingNewLines = countStr !== undefined ? parseInt(countStr, 10) : 1;
        inHunk = remainingNewLines > 0;
      }
    } else if (inHunk) {
      if (line.startsWith("+")) {
        const addedContent = line.slice(1);
        const redactedContent = redact(addedContent);
        if (redactedContent !== addedContent || redactedContent.includes("[REDACTED:")) {
          hits.push(`${currentFile}:${currentNewLine}`);
        }
        currentNewLine++;
        remainingNewLines--;
        if (remainingNewLines <= 0) {
          inHunk = false;
        }
      } else if (line.startsWith("-")) {
        // deleted line from old file, does not affect new line count or number
      } else if (line.startsWith(" ") || (line === "" && remainingNewLines > 0)) {
        // context line
        currentNewLine++;
        remainingNewLines--;
        if (remainingNewLines <= 0) {
          inHunk = false;
        }
      }
    }
  }

  return hits;
}

/**
 * Get review data for a task (diff, check result, automatic gates, acknowledgements).
 */
export async function getReview(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  options?: ReviewOptions,
): Promise<ReviewData> {
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

  const runExecGit = options?.gitOps?.execGit ?? execGit;
  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;

  let currentHeadSha: string | null = null;
  try {
    const revRes = await runExecGit(["rev-parse", "--verify", `${taskBranch}^{commit}`], {
      cwd: project.localPath,
    });
    currentHeadSha = revRes.stdout.trim() || null;
  } catch {
    currentHeadSha = null;
  }

  // Execute git diff <release>...daedalus/<task> with review safety flags
  let rawPatch = "";
  let diffError: string | null = null;
  const files: ReviewDiffFile[] = [];
  const binaryPaths = new Set<string>();

  try {
    const nameStatusRes = await runExecGit(
      buildReviewDiffArgs(["--name-status", "-z"], `${releaseBranch}...${taskBranch}`),
      { cwd: project.localPath, env: REVIEW_GIT_ENV },
    );

    const numstatRes = await runExecGit(
      buildReviewDiffArgs(["--numstat", "-z"], `${releaseBranch}...${taskBranch}`),
      { cwd: project.localPath, env: REVIEW_GIT_ENV },
    );

    const nameTokens = nameStatusRes.stdout ? nameStatusRes.stdout.split("\0") : [];
    if (nameTokens.length > 0 && nameTokens[nameTokens.length - 1] === "") {
      nameTokens.pop();
    }

    const numTokens = numstatRes.stdout ? numstatRes.stdout.split("\0") : [];
    if (numTokens.length > 0 && numTokens[numTokens.length - 1] === "") {
      numTokens.pop();
    }

    interface NumstatEntry {
      additions: number;
      deletions: number;
      binary: boolean;
    }
    const numstatMap = new Map<string, NumstatEntry>();

    let numIdx = 0;
    while (numIdx < numTokens.length) {
      const token = numTokens[numIdx++];
      if (!token) continue;

      const parts = token.split("\t");
      if (parts.length < 2) {
        throw new Error("truncated numstat record");
      }

      const addStr = parts[0]?.trim();
      const delStr = parts[1]?.trim();
      const isBinary = addStr === "-" || delStr === "-";
      const additions = isBinary ? 0 : parseInt(addStr ?? "0", 10) || 0;
      const deletions = isBinary ? 0 : parseInt(delStr ?? "0", 10) || 0;

      let newPath: string;
      const rest = parts.slice(2).join("\t");
      if (rest !== "") {
        newPath = rest;
      } else {
        const rawOld = numTokens[numIdx++];
        const rawNew = numTokens[numIdx++];
        if (rawOld === undefined || rawNew === undefined) {
          throw new Error("truncated numstat record");
        }
        newPath = rawNew;
      }

      numstatMap.set(newPath, { additions, deletions, binary: isBinary });
    }

    let nameIdx = 0;
    while (nameIdx < nameTokens.length) {
      const rawStatus = nameTokens[nameIdx++];
      if (!rawStatus) continue;
      const statusChar = rawStatus[0];
      const isRenameOrCopy = statusChar === "R" || statusChar === "C";

      let oldPath: string | undefined;
      let filePath: string;

      if (isRenameOrCopy) {
        const rawOld = nameTokens[nameIdx++];
        const rawNew = nameTokens[nameIdx++];
        if (rawOld === undefined || rawNew === undefined) {
          throw new Error("truncated name-status record");
        }
        oldPath = rawOld;
        filePath = rawNew;
      } else {
        const rawPath = nameTokens[nameIdx++];
        if (rawPath === undefined) {
          throw new Error("truncated name-status record");
        }
        filePath = rawPath;
      }

      let additions = 0;
      let deletions = 0;

      const numstat = numstatMap.get(filePath);
      if (!numstat || numstat.binary) {
        binaryPaths.add(filePath);
        if (oldPath) binaryPaths.add(oldPath);
        additions = 0;
        deletions = 0;
      } else {
        additions = numstat.additions;
        deletions = numstat.deletions;
      }

      let status: "A" | "M" | "D" | "R" = "M";
      if (statusChar === "A") status = "A";
      else if (statusChar === "D") status = "D";
      else if (statusChar === "R" || statusChar === "C") status = "R";
      else status = "M";

      files.push({
        path: filePath,
        ...(oldPath ? { oldPath } : {}),
        status,
        additions,
        deletions,
      });
    }

    const patchRes = await runExecGit(
      buildReviewDiffArgs([], `${releaseBranch}...${taskBranch}`),
      { cwd: project.localPath, maxBuffer: SIXTY_FOUR_MIB, env: REVIEW_GIT_ENV },
    );
    rawPatch = patchRes.stdout;
  } catch (err) {
    diffError = (err instanceof Error ? err.message : String(err)).trim();
    rawPatch = "";
    files.length = 0;
  }

  // Scan added lines for secrets from the unredacted patch
  const secretHits = diffError ? [] : scanPatchAddedLinesForSecrets(rawPatch);

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
    const lastRun = db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(desc(runs.id))
      .limit(1)
      .get();

    if (lastRun && lastRun.checkExitCode !== null && lastRun.checkExitCode !== undefined) {
      const ok = lastRun.checkExitCode === 0;
      check = {
        ok,
        exitCode: lastRun.checkExitCode,
        output: redact(
          lastRun.checkOutput ??
            (ok ? "Check passed" : `Check failed with exit code ${lastRun.checkExitCode}`),
        ),
      };
    } else if (lastRun && lastRun.exitStatus !== null && lastRun.exitStatus !== undefined) {
      const ok = lastRun.exitStatus === 0;
      check = {
        ok,
        exitCode: lastRun.exitStatus,
        output: redact(
          lastRun.checkOutput ??
            (ok ? "Check passed" : `Check failed with exit code ${lastRun.exitStatus}`),
        ),
      };
    }
  }

  if (check) {
    check.output = redact(check.output);
  }

  // Gates
  // 1. secrets
  const secretNeedsAckItems: string[] = [];
  for (const f of files) {
    if (binaryPaths.has(f.path)) {
      secretNeedsAckItems.push(`${f.path}: binary or attribute change, not scanned`);
    } else {
      const isGitAttr = isGitAttributesPath(f.path) || (f.oldPath ? isGitAttributesPath(f.oldPath) : false);
      if (isGitAttr && f.status !== "D") {
        const p = isGitAttributesPath(f.path) ? f.path : f.oldPath!;
        secretNeedsAckItems.push(`${p}: changes how git shows diffs`);
      }
    }
  }

  const secretItems: string[] = [];
  if (diffError) {
    secretItems.push(`diff unavailable: ${diffError}`);
  } else {
    secretItems.push(...secretHits);
  }
  secretItems.push(...secretNeedsAckItems);

  let secretGateStatus: "pass" | "blocked" | "needs-ack" = "pass";
  if (diffError || secretHits.length > 0) {
    secretGateStatus = "blocked";
  } else if (secretNeedsAckItems.length > 0) {
    secretGateStatus = "needs-ack";
  }

  // 2. dependencies
  const depItems = files
    .filter((f) => isDependencyPath(f.path) || (f.oldPath ? isDependencyPath(f.oldPath) : false))
    .map((f) => f.path);

  // 3. tests: deleted test file or modified test file where lines were removed, or moved out of tests
  const testItems: string[] = [];
  for (const f of files) {
    const isTest = isTestPath(f.path);
    const wasTest = f.oldPath ? isTestPath(f.oldPath) : false;
    if ((isTest || wasTest) && (!isTest || f.status === "D" || f.deletions > 0)) {
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

  const validAcks = acks.filter((ack) => {
    if (ack.headSha && currentHeadSha && ack.headSha !== currentHeadSha) {
      return false;
    }
    return true;
  });

  const ackMap = new Map(validAcks.map((a) => [a.gate, a]));

  const gates: Gate[] = [
    {
      id: "secrets",
      status: secretGateStatus,
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
  project: ReviewProject,
  taskCode: string,
  options?: ApproveOptions,
): Promise<{ sha: string; status: TaskStatus }> {
  const review = await getReview(db, project, taskCode, {
    dataDir: options?.dataDir,
    gitOps: options?.gitOps ? { execGit: options.gitOps.execGit } : undefined,
  });
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

    try {
      db.delete(reviewAcks).where(eq(reviewAcks.taskId, task.id)).run();
    } catch {
      // ignore
    }

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
  project: ReviewProject,
  taskCode: string,
  notes: string,
  options?: SendBackOptions,
): Promise<{ status: TaskStatus }> {
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
 * Discard: transition(requeue), remove worktree, delete branch, clear notes.
 */
export async function discardTask(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  options?: DiscardOptions,
): Promise<{ status: TaskStatus }> {
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
  project: ReviewProject,
  taskCode: string,
  gateId: string,
  note: string,
  options?: AckGateOptions,
): Promise<{ gate: string; note: string; ackedAt: string; headSha?: string | null }> {
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

  if (task.status !== "in-review") {
    throw new ReviewError(
      `Task ${task.code} is "${task.status}", expected "in-review" to acknowledge gates.`,
      409,
    );
  }

  const review = await getReview(db, project, taskCode, {
    gitOps: options?.gitOps,
  });
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

  const runExecGit = options?.gitOps?.execGit ?? execGit;
  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;
  let headSha: string | null = null;
  try {
    const revRes = await runExecGit(["rev-parse", "--verify", `${taskBranch}^{commit}`], {
      cwd: project.localPath,
    });
    headSha = revRes.stdout.trim() || null;
  } catch {
    headSha = null;
  }

  const ackedAt = new Date().toISOString();
  db.insert(reviewAcks)
    .values({
      taskId: task.id,
      gate: gateId,
      note: note.trim(),
      ackedAt,
      headSha,
    })
    .onConflictDoUpdate({
      target: [reviewAcks.taskId, reviewAcks.gate],
      set: {
        note: note.trim(),
        ackedAt,
        headSha,
      },
    })
    .run();

  return {
    gate: gateId,
    note: note.trim(),
    ackedAt,
    headSha,
  };
}
