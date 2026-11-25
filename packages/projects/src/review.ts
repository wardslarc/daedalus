/**
 * Review center (T6.1, SPEC#Review): diff against release branch, automatic gates
 * (secrets, dependencies, tests, check), acknowledgements and owner review decisions
 * (approve, send back with notes, discard).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  inbox,
  reviewAcks,
  reviews,
  runs,
  shapingState,
  tasks,
} from "@daedalus/db";
import {
  addWorktreeForBranch,
  deleteBranch,
  execGit,
  GitError,
  mergeCommitNoFf,
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
import type { Finding } from "./review-prompts.js";

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

export type GateId = "secrets" | "dependencies" | "tests" | "check" | "cross-review";

export type Gate = {
  id: GateId;
  status: "pass" | "blocked" | "needs-ack";
  items: string[];
  fingerprint: string;
  ack?: { id?: number; ackedAt: string; note: string } | null;
};

export type { Finding };

export type TriagedFinding = Finding & {
  bucket?: "must-fix" | "should-fix" | "nit";
  reason?: string;
};

export type CrossReviewData = {
  id: number;
  status: string;
  reviewer: string;
  headSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  findings: TriagedFinding[];
};

export type ReviewData = {
  task: typeof tasks.$inferSelect;
  releaseBranch: string;
  headSha: string | null;
  diff: ReviewDiff;
  check: ReviewCheck | null;
  gates: Gate[];
  crossReview: CrossReviewData | null;
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
    mergeCommitNoFf?: typeof mergeCommitNoFf;
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
    execGit?: typeof execGit;
  };
};

export type DiscardOptions = {
  dataDir?: string;
  transition?: (state: TaskState, event: TaskEvent) => Transition;
  gitOps?: {
    removeWorktree?: (repoDir: string, worktreeDir: string) => Promise<void>;
    deleteBranch?: (dir: string, name: string) => Promise<void>;
    execGit?: typeof execGit;
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

export const REVIEW_GIT_ENV: Record<string, string> = {
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
 * A gate's fingerprint = sha256 of JSON { gate, status, items } as computed for the current state;
 * for the cross-review gate also include the latest review's id, status, findings and claude_triage.
 */
export function computeGateFingerprint(
  gate: { id: string; status: string; items: string[] },
  latestReview?: {
    id: number;
    status: string;
    findings: string;
    claudeTriage: string | null;
  } | null,
): string {
  const payload: Record<string, unknown> = {
    gate: gate.id,
    status: gate.status,
    items: gate.items,
  };
  if (gate.id === "cross-review") {
    payload.id = latestReview ? latestReview.id : null;
    payload.status = latestReview ? latestReview.status : gate.status;
    payload.findings = latestReview ? latestReview.findings : null;
    payload.claude_triage = latestReview ? latestReview.claudeTriage : null;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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

  // Execute git diff <release>...<headSha> with review safety flags
  let rawPatch: string;
  let diffError: string | null = null;
  const files: ReviewDiffFile[] = [];
  const binaryPaths = new Set<string>();

  if (!currentHeadSha) {
    diffError = `Cannot resolve head of ${taskBranch}`;
    rawPatch = "";
  } else {
    try {
      const nameStatusRes = await runExecGit(
        buildReviewDiffArgs(["--name-status", "-z"], `${releaseBranch}...${currentHeadSha}`),
        {
          cwd: project.localPath,
          // Cast only: Next.js types make NODE_ENV a required key of ProcessEnv.
          env: REVIEW_GIT_ENV as NodeJS.ProcessEnv,
        },
      );

      const numstatRes = await runExecGit(
        buildReviewDiffArgs(["--numstat", "-z"], `${releaseBranch}...${currentHeadSha}`),
        {
          cwd: project.localPath,
          // Cast only: Next.js types make NODE_ENV a required key of ProcessEnv.
          env: REVIEW_GIT_ENV as NodeJS.ProcessEnv,
        },
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
        buildReviewDiffArgs([], `${releaseBranch}...${currentHeadSha}`),
        {
          cwd: project.localPath,
          maxBuffer: SIXTY_FOUR_MIB,
          // Cast only: Next.js types make NODE_ENV a required key of ProcessEnv.
          env: REVIEW_GIT_ENV as NodeJS.ProcessEnv,
        },
      );
      rawPatch = patchRes.stdout;
    } catch (err) {
      diffError = (err instanceof Error ? err.message : String(err)).trim();
      rawPatch = "";
      files.length = 0;
    }
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
  let check: ReviewCheck | null;
  if (options?.checkResult !== undefined) {
    check = options.checkResult;
  } else {
    const lastImplementRun = db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.role, "implement")))
      .orderBy(desc(runs.id))
      .limit(1)
      .get();

    if (
      lastImplementRun &&
      lastImplementRun.checkExitCode !== null &&
      lastImplementRun.checkExitCode !== undefined
    ) {
      const ok = lastImplementRun.checkExitCode === 0;
      check = {
        ok,
        exitCode: lastImplementRun.checkExitCode,
        output: redact(
          lastImplementRun.checkOutput ??
            (ok ? "Check passed" : `Check failed with exit code ${lastImplementRun.checkExitCode}`),
        ),
      };
    } else {
      check = null;
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

  // Cross-review gate data (T6.2, ADR 0019)
  let latestReview: typeof reviews.$inferSelect | null;
  try {
    latestReview = db
      .select()
      .from(reviews)
      .where(eq(reviews.taskId, task.id))
      .orderBy(desc(reviews.id))
      .limit(1)
      .get() ?? null;
  } catch {
    latestReview = null;
  }

  let crossReview: CrossReviewData | null = null;
  if (latestReview) {
    let parsedFindings: Finding[] = [];
    try {
      const raw = JSON.parse(latestReview.findings);
      if (Array.isArray(raw)) parsedFindings = raw;
    } catch {
      parsedFindings = [];
    }

    let parsedTriage: Array<{ index: number; bucket: "must-fix" | "should-fix" | "nit"; reason: string }> = [];
    if (latestReview.claudeTriage) {
      try {
        const raw = JSON.parse(latestReview.claudeTriage);
        if (Array.isArray(raw)) parsedTriage = raw;
      } catch {
        parsedTriage = [];
      }
    }

    const triageMap = new Map(parsedTriage.map((t) => [t.index, t]));
    const triagedFindings: TriagedFinding[] = parsedFindings.map((f, i) => {
      const t = triageMap.get(i);
      return {
        ...f,
        ...(t ? { bucket: t.bucket, reason: t.reason } : {}),
      };
    });

    crossReview = {
      id: latestReview.id,
      status: latestReview.status,
      reviewer: latestReview.reviewer,
      headSha: latestReview.headSha,
      startedAt: latestReview.startedAt,
      finishedAt: latestReview.finishedAt,
      error: latestReview.error,
      findings: triagedFindings,
    };
  }

  let crossReviewGateStatus: "pass" | "blocked" | "needs-ack";
  const crossReviewGateItems: string[] = [];

  if (!latestReview || !currentHeadSha || latestReview.headSha !== currentHeadSha) {
    crossReviewGateStatus = "needs-ack";
    crossReviewGateItems.push("no cross-review for this commit");
  } else if (latestReview.status === "running") {
    crossReviewGateStatus = "blocked";
    crossReviewGateItems.push("cross-review running");
  } else if (latestReview.status === "tampered") {
    crossReviewGateStatus = "blocked";
    crossReviewGateItems.push("The reviewer changed files; its review was discarded.");
  } else if (latestReview.status === "timed-out") {
    crossReviewGateStatus = "needs-ack";
    crossReviewGateItems.push(latestReview.error || "Cross-review timed out");
  } else if (latestReview.status === "failed") {
    crossReviewGateStatus = "needs-ack";
    crossReviewGateItems.push(latestReview.error || "Cross-review failed");
  } else if (latestReview.status === "done") {
    const findingsList = crossReview?.findings ?? [];
    const isUntriaged = findingsList.length > 0 && (!latestReview.claudeTriage || findingsList.some((f) => !f.bucket));
    if (isUntriaged) {
      crossReviewGateStatus = "needs-ack";
      crossReviewGateItems.push("Cross-review findings are untriaged");
    } else {
      const mustFixList = findingsList.filter((f) => f.bucket === "must-fix");
      if (mustFixList.length > 0) {
        crossReviewGateStatus = "needs-ack";
        for (const mf of mustFixList) {
          crossReviewGateItems.push(`must-fix: ${mf.file}${mf.line ? `:${mf.line}` : ""}: ${mf.claim}`);
        }
      } else {
        crossReviewGateStatus = "pass";
      }
    }
  } else {
    crossReviewGateStatus = "needs-ack";
    crossReviewGateItems.push(latestReview.error || `Cross-review status: ${latestReview.status}`);
  }

  const rawAckMap = new Map(acks.map((a) => [a.gate, a]));

  const getValidAck = (
    gateId: GateId,
    fingerprint: string,
  ): { id?: number; ackedAt: string; note: string } | null => {
    const ack = rawAckMap.get(gateId);
    if (!ack) return null;
    if (!currentHeadSha || !ack.headSha || ack.headSha !== currentHeadSha) {
      return null;
    }
    if (!ack.itemsSha256) {
      return null;
    }
    if (ack.itemsSha256 !== fingerprint) {
      return null;
    }
    return {
      id: ack.id,
      ackedAt: ack.ackedAt,
      note: ack.note,
    };
  };

  const createGate = (
    id: GateId,
    status: "pass" | "blocked" | "needs-ack",
    items: string[],
  ): Gate => {
    const fingerprint = computeGateFingerprint(
      { id, status, items },
      id === "cross-review" ? latestReview : null,
    );
    return {
      id,
      status,
      items,
      fingerprint,
      ack: getValidAck(id, fingerprint),
    };
  };

  const gates: Gate[] = [
    createGate("secrets", secretGateStatus, secretItems),
    createGate("dependencies", depItems.length > 0 ? "needs-ack" : "pass", depItems),
    createGate("tests", testItems.length > 0 ? "needs-ack" : "pass", testItems),
    createGate("check", checkGateStatus, checkGateItems),
    createGate("cross-review", crossReviewGateStatus, crossReviewGateItems),
  ];

  return {
    task,
    releaseBranch,
    headSha: currentHeadSha,
    diff: {
      files,
      patch,
    },
    check,
    gates,
    crossReview,
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
 * Approve task: 409 unless in-review, no gate is blocked, every needs-ack gate is acked,
 * and headSha matches the reviewed snapshot headSha.
 * Merges the reviewed commit SHA (not the branch name) into the release branch with mergeNoFf.
 * Uses a temporary worktree under <dataDir>/worktrees/ (or checked out release worktree if clean).
 * Never touches main or default branch.
 */
export async function approveTask(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  headSha: string,
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

  if (!headSha || review.headSha === null || review.headSha !== headSha) {
    throw new ReviewError("The review changed since you opened it; reload.", 409);
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
  const gitMergeCommitNoFf = options?.gitOps?.mergeCommitNoFf ?? mergeCommitNoFf;
  const gitRemoveWorktree = options?.gitOps?.removeWorktree ?? removeWorktree;
  const runExecGit = options?.gitOps?.execGit ?? execGit;

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
    let result: Awaited<ReturnType<typeof mergeCommitNoFf>>;
    try {
      result = await gitMergeCommitNoFf(workDir, headSha, `Merge task ${task.code}: ${task.title}`);
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

    // After the merge, check whether the task branch still points at headSha
    let currentBranchSha: string | null = null;
    try {
      const revRes = await runExecGit(["rev-parse", "--verify", `${taskBranch}^{commit}`], {
        cwd: repo,
      });
      currentBranchSha = revRes.stdout.trim() || null;
    } catch {
      currentBranchSha = null;
    }
    const branchMoved = currentBranchSha !== headSha;

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

    if (branchMoved) {
      // Task branch moved: keep merge, do NOT delete task branch, do NOT remove task worktree, add inbox item
      db.insert(inbox)
        .values({
          projectId: project.id,
          kind: "review",
          link: `/projects/${project.id}/review#${task.code}`,
        })
        .run();
    } else {
      // Remove task worktree
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
 * remove worktree and delete task branch. Refuses (409) if headSha does not match.
 */
export async function sendBack(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  notes: string,
  headSha: string,
  options?: SendBackOptions,
): Promise<{ status: TaskStatus }> {
  if (typeof notes !== "string" || notes.trim().length < 1 || notes.length > 4000) {
    throw new ReviewError("Review notes must be between 1 and 4000 characters.", 400);
  }

  const review = await getReview(db, project, taskCode, {
    dataDir: options?.dataDir,
    gitOps: options?.gitOps ? { execGit: options.gitOps.execGit } : undefined,
  });
  const task = review.task;

  if (!headSha || review.headSha === null || review.headSha !== headSha) {
    throw new ReviewError("The review changed since you opened it; reload.", 409);
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
 * Refuses (409) if headSha does not match.
 */
export async function discardTask(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  headSha: string,
  options?: DiscardOptions,
): Promise<{ status: TaskStatus }> {
  const review = await getReview(db, project, taskCode, {
    dataDir: options?.dataDir,
    gitOps: options?.gitOps ? { execGit: options.gitOps.execGit } : undefined,
  });
  const task = review.task;

  if (!headSha || review.headSha === null || review.headSha !== headSha) {
    throw new ReviewError("The review changed since you opened it; reload.", 409);
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
 * Refuses with 409 unless headSha and fingerprint match the getReview snapshot.
 */
export async function ackGate(
  db: DaedalusDb,
  project: ReviewProject,
  taskCode: string,
  gateId: string,
  note: string,
  headSha: string,
  fingerprint: string,
  options?: AckGateOptions,
): Promise<{
  gate: string;
  note: string;
  ackedAt: string;
  headSha?: string | null;
  itemsSha256?: string | null;
}> {
  if (typeof note !== "string" || note.trim().length < 1 || note.length > 1000) {
    throw new ReviewError("Acknowledgement note must be between 1 and 1000 characters.", 400);
  }

  const review = await getReview(db, project, taskCode, {
    gitOps: options?.gitOps,
  });
  const task = review.task;

  if (task.status !== "in-review") {
    throw new ReviewError(
      `Task ${task.code} is "${task.status}", expected "in-review" to acknowledge gates.`,
      409,
    );
  }

  const gate = review.gates.find((g) => g.id === gateId);
  if (!gate) {
    throw new ReviewError(`Unknown gate '${gateId}'.`, 404);
  }

  if (
    !headSha ||
    !fingerprint ||
    review.headSha === null ||
    review.headSha !== headSha ||
    gate.fingerprint !== fingerprint
  ) {
    throw new ReviewError("The review changed since you opened it; reload.", 409);
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
      headSha,
      itemsSha256: fingerprint,
    })
    .onConflictDoUpdate({
      target: [reviewAcks.taskId, reviewAcks.gate],
      set: {
        note: note.trim(),
        ackedAt,
        headSha,
        itemsSha256: fingerprint,
      },
    })
    .run();

  return {
    gate: gateId,
    note: note.trim(),
    ackedAt,
    headSha,
    itemsSha256: fingerprint,
  };
}
