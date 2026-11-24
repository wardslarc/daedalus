/**
 * Cross-review by the other provider (T6.2, SPEC#Review, ADR 0019).
 * Starts an isolated read-only session in a detached worktree, gathers findings,
 * triages them with Claude, validates output strictly, and enforces tamper detection.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  projects,
  providers as providersTable,
  reviews,
  runs,
  tasks,
} from "@daedalus/db";
import {
  addDetachedWorktree as defaultAddDetachedWorktree,
  execGit,
  removeWorktree as defaultRemoveWorktree,
} from "@daedalus/git";
import { assertProviderAllowed } from "@daedalus/core/profiles";
import { redact, type AgentEvent, type AgentSession, type ProviderEntry, type SessionProject } from "@daedalus/providers";
import { parsePlanMarkdown } from "./pipeline.js";
import { getReview, ReviewError } from "./review.js";
import {
  buildReviewPrompt,
  buildTriagePrompt,
  type Finding,
  type TriageItem,
} from "./review-prompts.js";
import { readShapingDoc, SHAPING_DOCS } from "./shaping.js";

export { Finding, TriageItem } from "./review-prompts.js";

export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * Parses the last ```json fenced block in the message text as an array of findings.
 * Enforces strict limits: <= 50 findings, severity enum, relative POSIX normalized path,
 * line >= 1 or null, lengths, redacts claim and proof, drops unknown keys.
 */
export function parseFindings(text: string): Finding[] {
  if (typeof text !== "string") {
    throw new ParseError("Input must be a string");
  }

  const jsonBlocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/gi)];
  if (jsonBlocks.length === 0) {
    throw new ParseError("No ```json block found in review output");
  }

  const lastBlock = jsonBlocks[jsonBlocks.length - 1]![1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    throw new ParseError(`Invalid JSON in review output: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ParseError("Review output must be a JSON object");
  }

  const findingsRaw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) {
    throw new ParseError("Review JSON must have a 'findings' array");
  }

  if (findingsRaw.length > 50) {
    throw new ParseError(`Too many findings (${findingsRaw.length} > 50)`);
  }

  const out: Finding[] = [];
  for (let i = 0; i < findingsRaw.length; i++) {
    const item = findingsRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ParseError(`Finding at index ${i} must be an object`);
    }

    const { severity, file, line, claim, proof } = item as Record<string, unknown>;

    if (severity !== "high" && severity !== "medium" && severity !== "low") {
      throw new ParseError(`Finding ${i}: invalid severity '${String(severity)}'`);
    }

    if (typeof file !== "string" || file.length === 0 || file.length > 300) {
      throw new ParseError(`Finding ${i}: file must be a non-empty string <= 300 characters`);
    }

    if (file.includes("\\")) {
      throw new ParseError(`Finding ${i}: file must use POSIX slashes`);
    }

    if (file.startsWith("/") || posix.isAbsolute(file)) {
      throw new ParseError(`Finding ${i}: file path must not be absolute`);
    }

    const segments = file.split("/");
    if (segments.some((s) => s === ".." || s === "." || s === "")) {
      throw new ParseError(`Finding ${i}: file path contains invalid segment (.. or empty)`);
    }

    const normalized = posix.normalize(file);
    if (normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) {
      throw new ParseError(`Finding ${i}: path traversal detected in file path`);
    }

    let parsedLine: number | null = null;
    if (line !== null && line !== undefined) {
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
        throw new ParseError(`Finding ${i}: line must be null or an integer >= 1`);
      }
      parsedLine = line;
    }

    if (typeof claim !== "string" || claim.length < 1 || claim.length > 2000) {
      throw new ParseError(`Finding ${i}: claim must be between 1 and 2000 characters`);
    }

    if (typeof proof !== "string" || proof.length > 4000) {
      throw new ParseError(`Finding ${i}: proof must be a string <= 4000 characters`);
    }

    out.push({
      severity,
      file: normalized,
      line: parsedLine,
      claim: redact(claim),
      proof: redact(proof),
    });
  }

  return out;
}

/**
 * Parses the last ```json fenced block as triage items.
 * Validates that every index in [0..findingsCount - 1] is present exactly once,
 * bucket is valid enum, reason <= 1000 chars, redacted.
 */
export function parseTriage(text: string, findingsCount: number): TriageItem[] {
  if (findingsCount === 0) {
    return [];
  }

  if (typeof text !== "string") {
    throw new ParseError("Input must be a string");
  }

  const jsonBlocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/gi)];
  if (jsonBlocks.length === 0) {
    throw new ParseError("No ```json block found in triage output");
  }

  const lastBlock = jsonBlocks[jsonBlocks.length - 1]![1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    throw new ParseError(`Invalid JSON in triage output: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ParseError("Triage output must be a JSON object");
  }

  const triageRaw = (parsed as { triage?: unknown }).triage;
  if (!Array.isArray(triageRaw)) {
    throw new ParseError("Triage JSON must have a 'triage' array");
  }

  if (triageRaw.length !== findingsCount) {
    throw new ParseError(`Triage item count (${triageRaw.length}) does not match findings count (${findingsCount})`);
  }

  const seenIndices = new Set<number>();
  const out: TriageItem[] = [];

  for (let i = 0; i < triageRaw.length; i++) {
    const item = triageRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ParseError(`Triage item at index ${i} must be an object`);
    }

    const { index, bucket, reason } = item as Record<string, unknown>;

    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= findingsCount
    ) {
      throw new ParseError(`Triage item ${i}: index must be an integer between 0 and ${findingsCount - 1}`);
    }

    if (seenIndices.has(index)) {
      throw new ParseError(`Duplicate triage entry for finding index ${index}`);
    }
    seenIndices.add(index);

    if (bucket !== "must-fix" && bucket !== "should-fix" && bucket !== "nit") {
      throw new ParseError(`Triage item ${i}: invalid bucket '${String(bucket)}'`);
    }

    if (typeof reason !== "string" || reason.length > 1000) {
      throw new ParseError(`Triage item ${i}: reason must be a string <= 1000 characters`);
    }

    out.push({
      index,
      bucket,
      reason: redact(reason),
    });
  }

  if (seenIndices.size !== findingsCount) {
    throw new ParseError("Not all finding indices are covered in triage");
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

function getFilesRecursive(dir: string, baseDir: string = dir): Array<{ relPath: string; fullPath: string }> {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: Array<{ relPath: string; fullPath: string }> = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFilesRecursive(full, baseDir));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push({ relPath: relative(baseDir, full), fullPath: full });
    }
  }
  return files;
}

export function hashGitCommonDir(commonDir: string): string {
  const hash = createHash("sha256");

  // 1. config
  const configFile = join(commonDir, "config");
  if (existsSync(configFile)) {
    hash.update("config:exists\0");
    try {
      hash.update(readFileSync(configFile));
    } catch {
      hash.update("unreadable\0");
    }
  } else {
    hash.update("config:missing\0");
  }

  // 2. hooks/
  const hooksDir = join(commonDir, "hooks");
  const hookFiles = getFilesRecursive(hooksDir);
  hookFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  hash.update(`hooks:${hookFiles.length}\0`);
  for (const hf of hookFiles) {
    hash.update(`hook:${hf.relPath}\0`);
    try {
      hash.update(readFileSync(hf.fullPath));
    } catch {
      hash.update("unreadable\0");
    }
  }

  // 3. info/attributes
  const infoAttrFile = join(commonDir, "info", "attributes");
  if (existsSync(infoAttrFile)) {
    hash.update("info/attributes:exists\0");
    try {
      hash.update(readFileSync(infoAttrFile));
    } catch {
      hash.update("unreadable\0");
    }
  } else {
    hash.update("info/attributes:missing\0");
  }

  return hash.digest("hex");
}

export type Snapshot = {
  taskBranchSha: string;
  worktreeHeadSha: string;
  statusOutput: string;
  commonDirHash: string;
};

export async function takeSnapshot(
  runExecGit: typeof execGit,
  repoDir: string,
  worktreeDir: string,
  taskBranch: string,
): Promise<Snapshot> {
  const [branchRes, headRes, statusRes, commonDirRes] = await Promise.all([
    runExecGit(["rev-parse", "--verify", `${taskBranch}^{commit}`], { cwd: repoDir }),
    runExecGit(["rev-parse", "--verify", "HEAD"], { cwd: worktreeDir }),
    runExecGit(
      ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"],
      { cwd: worktreeDir },
    ),
    runExecGit(["rev-parse", "--git-common-dir"], { cwd: worktreeDir }),
  ]);

  const commonDirRaw = commonDirRes.stdout.trim();
  const commonDir = resolve(worktreeDir, commonDirRaw);
  const commonDirHash = hashGitCommonDir(commonDir);

  return {
    taskBranchSha: branchRes.stdout.trim(),
    worktreeHeadSha: headRes.stdout.trim(),
    statusOutput: statusRes.stdout,
    commonDirHash,
  };
}

export function isSameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.taskBranchSha === b.taskBranchSha &&
    a.worktreeHeadSha === b.worktreeHeadSha &&
    a.statusOutput === b.statusOutput &&
    a.commonDirHash === b.commonDirHash
  );
}

export type CrossReviewDeps = {
  db: DaedalusDb;
  dataDir: string;
  sessions: {
    start: (
      project: SessionProject,
      providerId: string,
      opts?: { permissionPolicy?: "ask-owner" | "read-only" },
    ) => Promise<Pick<AgentSession, "startedAt" | "prompt" | "stop"> & {
      id: string;
      cancel?: () => Promise<void>;
      onEvent?: (listener: (e: AgentEvent) => void) => () => void;
    }>;
    stopAll?: () => Promise<void>;
  };
  providers?: readonly ProviderEntry[];
  gitOps?: {
    execGit?: typeof execGit;
    addDetachedWorktree?: typeof defaultAddDetachedWorktree;
    removeWorktree?: typeof defaultRemoveWorktree;
  };
  now?: () => string;
  reviewTimeoutMs?: number;
  triageTimeoutMs?: number;
};

export type ActiveReview = {
  worktreeDir: string;
  repoDir: string;
  getSessions: () => Array<{ stop: () => Promise<void> }>;
};

const activeReviews = new Map<number, ActiveReview>();

/** Stop all active cross-reviews and remove their worktrees (server shutdown). */
export async function closeAllReviews(db: DaedalusDb): Promise<void> {
  for (const active of activeReviews.values()) {
    for (const s of active.getSessions()) {
      try {
        await s.stop();
      } catch {
        // ignore
      }
    }
    if (existsSync(active.worktreeDir)) {
      try {
        await defaultRemoveWorktree(active.repoDir, active.worktreeDir);
      } catch {
        // ignore
      }
      try {
        rmSync(active.worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  activeReviews.clear();

  const now = new Date().toISOString();
  try {
    db.update(reviews)
      .set({
        status: "failed",
        finishedAt: now,
        error: "server stopped",
      })
      .where(eq(reviews.status, "running"))
      .run();
  } catch {
    // ignore
  }

  try {
    const runningRuns = db
      .select()
      .from(runs)
      .where(and(eq(runs.role, "review"), isNull(runs.end)))
      .all();
    for (const r of runningRuns) {
      db.update(runs)
        .set({
          end: now,
          exitStatus: 1,
        })
        .where(eq(runs.id, r.id))
        .run();
    }
  } catch {
    // ignore
  }
}

/** Mark any left-over running reviews from previous crashes/shutdown as failed (server startup). */
export function recoverReviewsOnStartup(db: DaedalusDb): void {
  const now = new Date().toISOString();
  try {
    db.update(reviews)
      .set({
        status: "failed",
        finishedAt: now,
        error: "server stopped",
      })
      .where(eq(reviews.status, "running"))
      .run();
  } catch {
    // ignore
  }

  try {
    const runningRuns = db
      .select()
      .from(runs)
      .where(and(eq(runs.role, "review"), isNull(runs.end)))
      .all();
    for (const r of runningRuns) {
      db.update(runs)
        .set({
          end: now,
          exitStatus: 1,
        })
        .where(eq(runs.id, r.id))
        .run();
    }
  } catch {
    // ignore
  }
}

export type StartCrossReviewResult = {
  reviewId: number;
  promise: Promise<void>;
};

type ReviewSession = Pick<AgentSession, "startedAt" | "prompt" | "stop"> & {
  id: string;
  cancel?: () => Promise<void>;
  onEvent?: (listener: (e: AgentEvent) => void) => () => void;
};

/**
 * Starts a cross-review on an in-review task.
 * Returns { reviewId, promise } immediately (HTTP 202).
 */
export async function startCrossReview(
  deps: CrossReviewDeps,
  projectId: number,
  taskCode: string,
): Promise<StartCrossReviewResult> {
  const { db } = deps;

  // 1. Verify project & task
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new ReviewError(`Project ${projectId} not found`, 404);
  }

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all()
    .find((t) => t.code.toLowerCase() === taskCode.toLowerCase());

  if (!task) {
    throw new ReviewError(`Task ${taskCode} not found in project ${projectId}`, 404);
  }

  if (task.status !== "in-review") {
    throw new ReviewError(
      `Task ${task.code} is "${task.status}", expected "in-review" to start cross-review`,
      409,
    );
  }

  // 2. Determine writer and reviewer
  const latestImplementRun = db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.role, "implement")))
    .orderBy(desc(runs.id))
    .limit(1)
    .get();

  if (!latestImplementRun) {
    throw new ReviewError("no implement run", 409);
  }

  const writerProviderRow = db
    .select()
    .from(providersTable)
    .where(eq(providersTable.id, latestImplementRun.providerId))
    .get();

  const writerName = (writerProviderRow?.name ?? "").toLowerCase();

  let reviewer = "claude";
  if (project.profile === "work") {
    reviewer = "claude";
  } else {
    const other = writerName === "claude" ? "antigravity" : "claude";
    let otherAllowed = false;
    try {
      assertProviderAllowed(project, other);
      const registryEntry = deps.providers?.find((p) => p.id === other);
      if (registryEntry) {
        otherAllowed = (registryEntry.allowedProfiles as readonly string[]).includes(project.profile);
      } else {
        const provInDb = db.select().from(providersTable).where(eq(providersTable.name, other)).get();
        if (provInDb) {
          const allowed = Array.isArray(provInDb.allowedProfiles)
            ? provInDb.allowedProfiles
            : JSON.parse(provInDb.allowedProfiles as string);
          otherAllowed = (allowed as string[]).includes(project.profile);
        }
      }
    } catch {
      otherAllowed = false;
    }
    reviewer = otherAllowed ? other : "claude";
  }

  // Look up reviewer provider row BEFORE inserting anything (Item 5)
  const reviewerProvRow = db
    .select()
    .from(providersTable)
    .where(eq(providersTable.name, reviewer))
    .get();

  if (!reviewerProvRow) {
    throw new ReviewError(`Provider ${reviewer} not found in database`, 409);
  }

  // 3. Get the head SHA first (Item 7)
  const runExecGit = deps.gitOps?.execGit ?? execGit;
  const taskBranch = task.branch || `daedalus/${task.code.toLowerCase()}`;
  const revRes = await runExecGit(["rev-parse", "--verify", `${taskBranch}^{commit}`], {
    cwd: project.localPath,
  });
  const headSha = revRes.stdout.trim();
  if (!headSha) {
    throw new ReviewError(`Cannot determine head commit of branch ${taskBranch}`, 400);
  }

  const now = deps.now ? deps.now() : new Date().toISOString();

  // Atomically check already running and insert reviews & runs rows (Item 7)
  const { reviewId, runId } = db.transaction((tx) => {
    const existingRunning = tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.taskId, task.id), eq(reviews.status, "running")))
      .get();

    if (existingRunning) {
      throw new ReviewError(
        `A cross-review is already running for task ${task.code}`,
        409,
      );
    }

    const [insertedReview] = tx
      .insert(reviews)
      .values({
        taskId: task.id,
        reviewer,
        status: "running",
        headSha,
        findings: "[]",
        startedAt: now,
      })
      .returning()
      .all();

    const [insertedRun] = tx
      .insert(runs)
      .values({
        taskId: task.id,
        providerId: reviewerProvRow.id,
        role: "review",
        start: now,
      })
      .returning()
      .all();

    return { reviewId: insertedReview!.id, runId: insertedRun!.id };
  });

  // 4. Background execution
  const backgroundPromise = (async () => {
    const worktreeDir = resolve(
      deps.dataDir,
      "worktrees",
      `review-${project.id}-${task.code.toLowerCase()}-${reviewId}`,
    );

    let reviewerSession: ReviewSession | null = null;
    let triageSession: ReviewSession | null = null;
    let reviewStatus: "done" | "failed" | "timed-out" | "tampered" = "done";
    let reviewError: string | null = null;
    let findings: Finding[] = [];
    let claudeTriage: TriageItem[] | null = null;
    let initialSnapshot: Snapshot | null = null;

    activeReviews.set(reviewId, {
      worktreeDir,
      repoDir: project.localPath,
      getSessions: () => [reviewerSession, triageSession].filter((s): s is ReviewSession => s !== null),
    });

    try {
      // 4.a Add detached worktree
      mkdirSync(dirname(worktreeDir), { recursive: true });
      const addDetached = deps.gitOps?.addDetachedWorktree ?? defaultAddDetachedWorktree;
      await addDetached(project.localPath, worktreeDir, headSha);

      // 4.b Initial snapshot
      initialSnapshot = await takeSnapshot(runExecGit, project.localPath, worktreeDir, taskBranch);

      // 4.c Start reviewer session with read-only
      try {
        reviewerSession = await deps.sessions.start(
          { ...project, localPath: worktreeDir },
          reviewer,
          { permissionPolicy: "read-only" },
        );
      } catch (err: unknown) {
        reviewStatus = "failed";
        reviewError = err instanceof Error ? err.message : "2 sessions are already running. Stop one first.";
        return;
      }

      // Read task description if available
      let taskDescription = "";
      try {
        const planDoc = readShapingDoc(project.localPath, SHAPING_DOCS.plan);
        if (planDoc.content) {
          const parsed = parsePlanMarkdown(planDoc.content);
          const pt = parsed.tasks.find((t) => t.code.toLowerCase() === task.code.toLowerCase());
          if (pt?.description) {
            taskDescription = pt.description;
          }
        }
      } catch {
        // ignore
      }

      // Build review prompt
      const reviewData = await getReview(db, project, task.code, {
        dataDir: deps.dataDir,
        gitOps: { execGit: runExecGit },
      });

      const reviewPrompt = buildReviewPrompt({
        task: {
          code: task.code,
          title: task.title,
          description: taskDescription,
          linkedSpecSections: task.linkedSpecSections,
        },
        files: reviewData.diff.files,
        patch: reviewData.diff.patch,
      });

      let reviewerMessageText = "";
      const offReviewer = reviewerSession.onEvent?.((e: AgentEvent) => {
        if (e.type === "message") {
          reviewerMessageText += e.text;
        }
      });

      const reviewTimeoutMs = deps.reviewTimeoutMs ?? 15 * 60 * 1000;
      let reviewerTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<"timed-out">((res) => {
        reviewerTimer = setTimeout(() => res("timed-out"), reviewTimeoutMs);
      });

      const reviewerTurnPromise = reviewerSession.prompt(reviewPrompt);
      const raceResult = await Promise.race([reviewerTurnPromise, timeoutPromise]);
      clearTimeout(reviewerTimer);
      offReviewer?.();

      if (raceResult === "timed-out") {
        await reviewerSession.cancel?.().catch(() => {});
        await reviewerSession.stop().catch(() => {});
        reviewerSession = null;
        reviewStatus = "timed-out";
        reviewError = "Review timed out after 15 minutes";
        return;
      }

      // 4.d Stop reviewer session and verify snapshot
      await reviewerSession.stop().catch(() => {});
      reviewerSession = null;

      let postReviewerSnapshot: Snapshot;
      try {
        postReviewerSnapshot = await takeSnapshot(runExecGit, project.localPath, worktreeDir, taskBranch);
      } catch {
        reviewStatus = "tampered";
        reviewError = "The reviewer changed files; its review was discarded.";
        try {
          findings = parseFindings(reviewerMessageText);
        } catch {
          findings = [];
        }
        return;
      }
      if (!isSameSnapshot(initialSnapshot, postReviewerSnapshot)) {
        reviewStatus = "tampered";
        reviewError = "The reviewer changed files; its review was discarded.";
        try {
          findings = parseFindings(reviewerMessageText);
        } catch {
          findings = [];
        }
        return;
      }

      // 4.e Parse findings
      try {
        findings = parseFindings(reviewerMessageText);
      } catch (err: unknown) {
        reviewStatus = "failed";
        reviewError = err instanceof Error ? err.message : "Invalid findings JSON output";
        return;
      }

      // 4.f Triage with Claude (read-only)
      let preTriageSnapshot: Snapshot;
      try {
        preTriageSnapshot = await takeSnapshot(runExecGit, project.localPath, worktreeDir, taskBranch);
      } catch {
        reviewStatus = "tampered";
        reviewError = "The reviewer changed files; its review was discarded.";
        claudeTriage = null;
        return;
      }

      try {
        triageSession = await deps.sessions.start(
          { ...project, localPath: worktreeDir },
          "claude",
          { permissionPolicy: "read-only" },
        );
      } catch {
        claudeTriage = null;
        return;
      }

      const triagePrompt = buildTriagePrompt(findings);
      let triageMessageText = "";
      const offTriage = triageSession.onEvent?.((e: AgentEvent) => {
        if (e.type === "message") {
          triageMessageText += e.text;
        }
      });

      const triageTimeoutMs = deps.triageTimeoutMs ?? 5 * 60 * 1000;
      let triageTimer: NodeJS.Timeout | undefined;
      const triageTimeoutPromise = new Promise<"timed-out">((res) => {
        triageTimer = setTimeout(() => res("timed-out"), triageTimeoutMs);
      });

      const triageTurnPromise = triageSession.prompt(triagePrompt);
      const triageRaceResult = await Promise.race([triageTurnPromise, triageTimeoutPromise]);
      clearTimeout(triageTimer);
      offTriage?.();

      if (triageRaceResult === "timed-out") {
        await triageSession.cancel?.().catch(() => {});
        await triageSession.stop().catch(() => {});
        triageSession = null;
        claudeTriage = null;
        return;
      }

      await triageSession.stop().catch(() => {});
      triageSession = null;

      let postTriageSnapshot: Snapshot;
      try {
        postTriageSnapshot = await takeSnapshot(runExecGit, project.localPath, worktreeDir, taskBranch);
      } catch {
        reviewStatus = "tampered";
        reviewError = "The reviewer changed files; its review was discarded.";
        claudeTriage = null;
        return;
      }
      if (!isSameSnapshot(preTriageSnapshot, postTriageSnapshot)) {
        reviewStatus = "tampered";
        reviewError = "The reviewer changed files; its review was discarded.";
        claudeTriage = null;
        return;
      }

      try {
        claudeTriage = parseTriage(triageMessageText, findings.length);
      } catch {
        claudeTriage = null;
      }
    } catch (err: unknown) {
      reviewStatus = "failed";
      reviewError = err instanceof Error ? err.message : String(err);
    } finally {
      // 4.g Final cleanup & tamper verification
      if (reviewerSession) {
        await reviewerSession.cancel?.().catch(() => {});
        await reviewerSession.stop().catch(() => {});
        reviewerSession = null;
      }
      if (triageSession) {
        await triageSession.cancel?.().catch(() => {});
        await triageSession.stop().catch(() => {});
        triageSession = null;
      }

      // Once the initial snapshot exists, every exit path stops the sessions first,
      // then takes the after-snapshot and compares; any difference or failure to verify -> tampered,
      // which wins over every other status.
      if (initialSnapshot) {
        try {
          if (!existsSync(worktreeDir)) {
            reviewStatus = "tampered";
            reviewError = "The reviewer changed files; its review was discarded.";
          } else {
            const finalSnapshot = await takeSnapshot(runExecGit, project.localPath, worktreeDir, taskBranch);
            if (!isSameSnapshot(initialSnapshot, finalSnapshot)) {
              reviewStatus = "tampered";
              reviewError = "The reviewer changed files; its review was discarded.";
            }
          }
        } catch {
          reviewStatus = "tampered";
          reviewError = "The reviewer changed files; its review was discarded.";
        }
      }

      if (existsSync(worktreeDir)) {
        const remove = deps.gitOps?.removeWorktree ?? defaultRemoveWorktree;
        try {
          await remove(project.localPath, worktreeDir);
        } catch {
          // ignore
        }
        try {
          rmSync(worktreeDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }

      activeReviews.delete(reviewId);

      const finishedAt = deps.now ? deps.now() : new Date().toISOString();

      try {
        db.update(reviews)
          .set({
            status: reviewStatus,
            findings: JSON.stringify(findings),
            claudeTriage: claudeTriage ? JSON.stringify(claudeTriage) : null,
            finishedAt,
            error: reviewError,
          })
          .where(eq(reviews.id, reviewId))
          .run();
      } catch {
        // ignore
      }

      try {
        db.update(runs)
          .set({
            end: finishedAt,
            exitStatus: reviewStatus === "done" ? 0 : 1,
          })
          .where(eq(runs.id, runId))
          .run();
      } catch {
        // ignore
      }
    }
  })();

  return { reviewId, promise: backgroundPromise };
}
