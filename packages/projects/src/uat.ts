/**
 * UAT checklist with a recorded browser (T6.4, SPEC#Release gate, SPEC#Gate findings, ADR 0021).
 * Handles frozen UAT items from PLAN.md and SPEC.md, owner-configured app start and probing,
 * Playwright browser launching with tracing and video, screenshot capture, manual marks (pass/fail),
 * bug fix tasks and change requests, session lifecycle, recovery and recordings serving.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  gateFindings,
  projects,
  shapingState,
  tasks,
  uatAppConfig,
  uatItems,
  uatMarks,
  uatSessions,
} from "@daedalus/db";
import { execGit } from "@daedalus/git";
import { redact, scrubEnv } from "@daedalus/providers";
import { parsePlanMarkdown } from "./pipeline.js";
import { readShapingDoc, SHAPING_DOCS } from "./shaping.js";
import { refreshVerifyStage } from "./release-gate.js";
import {
  assertSessionReplayFinished,
  cleanupScriptsOnSessionStop,
  getUatScriptsAndReplayState,
  promoteDraftScriptInTx,
  recoverScriptsOnStartup,
  runSessionReplay,
  stopAllScriptProcesses,
  type UatCodegenRunner,
  type UatRecordingState,
  type UatReplayRunner,
  type UatReplayState,
  type UatScriptInfo,
} from "./uat-scripts.js";
import type { Browser, BrowserContext, Page } from "playwright";

export class UatError extends Error {
  override name = "UatError";
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export type UatProcessRunner = (
  cmd: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ pid: number; kill: () => void }>;

export type UatUrlProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export type UatPortProbe = (port: number) => Promise<boolean>;

export type UatTracingStopOpts = { path: string };

export type UatBrowserPage = {
  goto: (url: string) => Promise<unknown>;
  screenshot: (opts: { path: string }) => Promise<Buffer>;
  close?: () => Promise<void>;
};

export type UatBrowserContext = {
  close: () => Promise<void>;
  tracing: { stop: (opts: UatTracingStopOpts) => Promise<void> };
  newPage: () => Promise<UatBrowserPage>;
};

export type UatBrowserInstance = {
  browser: Browser | { close: () => Promise<void> };
  context: BrowserContext | UatBrowserContext;
  page: Page | UatBrowserPage;
};

export type UatBrowserLauncher = (opts: {
  headless: boolean;
  appUrl: string;
  videoDir: string;
  sessionFolder: string;
}) => Promise<UatBrowserInstance>;

export type UatDeps = {
  db: DaedalusDb;
  dataDir: string;
  execGit?: typeof execGit;
  processRunner?: UatProcessRunner;
  urlProbe?: UatUrlProbe;
  portProbe?: UatPortProbe;
  browserLauncher?: UatBrowserLauncher;
  codegenRunner?: UatCodegenRunner;
  replayRunner?: UatReplayRunner;
  daedalusPort?: number;
};

export type UatItemStatus = "pass" | "fail" | "re-test" | "untested";

export type UatItemWithMark = {
  id: number;
  projectId: number;
  releaseVersion: string;
  position: number;
  text: string;
  source: "plan" | "spec";
  createdAt: string;
  status: UatItemStatus;
  latestMark: {
    id: number;
    itemId: number;
    result: "pass" | "fail";
    note: string | null;
    kind: "bug" | "change" | null;
    headSha: string;
    sessionId: string | null;
    fixTaskId: number | null;
    findingId: number | null;
    markedAt: string;
    fixTaskStatus?: string | null;
    fixTaskCode?: string | null;
  } | null;
};

export type UatRecordingFile = {
  name: string;
  sessionId: string;
  size: number;
  url: string;
  type: "trace" | "video" | "screenshot";
  createdAt: string;
};

export type UatGateData = {
  items: UatItemWithMark[];
  session: typeof uatSessions.$inferSelect | null;
  config: typeof uatAppConfig.$inferSelect | null;
  recordings: UatRecordingFile[];
  scripts: UatScriptInfo[];
  replay: UatReplayState;
  recording: UatRecordingState;
  gateLine: {
    status: "pass" | "fail";
    detail?: string;
  };
  blockedReason?: string;
};

export type MarkUatItemInput = {
  result: "pass" | "fail";
  note?: string;
  kind?: "bug" | "change";
  checkCommand?: string;
  headSha: string;
};

// ---------------------------------------------------------------------------
// In-memory active UAT sessions tracking
// ---------------------------------------------------------------------------

export type ActiveUatSession = {
  sessionId: string;
  projectId: number;
  status: "starting" | "running";
  worktreeDir: string;
  sessionFolder: string;
  repoPath: string;
  childPid: number | null;
  killApp: () => void;
  killReplay?: () => void;
  killCodegen?: () => void;
  replayFinished: boolean;
  browserInstance: UatBrowserInstance | null;
  cancelled?: boolean;
};

const activeUatSessions = new Map<number, ActiveUatSession>();

export function getActiveUatSession(projectId: number): ActiveUatSession | undefined {
  return activeUatSessions.get(projectId);
}

export function setActiveSessionReplayKill(
  projectId: number,
  killFn: (() => void) | undefined,
): void {
  const active = activeUatSessions.get(projectId);
  if (active) {
    active.killReplay = killFn;
  }
}

export function setActiveSessionCodegenKill(
  projectId: number,
  killFn: (() => void) | undefined,
): void {
  const active = activeUatSessions.get(projectId);
  if (active) {
    active.killCodegen = killFn;
  }
}

export function markActiveSessionReplayFinished(projectId: number): void {
  const active = activeUatSessions.get(projectId);
  if (active) {
    active.replayFinished = true;
    active.killReplay = undefined;
  }
}

// ---------------------------------------------------------------------------
// Config validation (ADR 0021)
// ---------------------------------------------------------------------------

export function validateUatAppConfig(
  config: { startCommand?: string; appUrl?: string },
  opts?: { daedalusPort?: number },
): { startCommand: string; appUrl: string } {
  const startCommand = (config.startCommand ?? "").trim();
  if (startCommand.length < 1 || startCommand.length > 500) {
    throw new UatError("startCommand must be between 1 and 500 characters.", 400);
  }

  const rawUrl = (config.appUrl ?? "").trim();
  if (!rawUrl) {
    throw new UatError("appUrl is required.", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UatError("Invalid appUrl format.", 400);
  }

  if (parsed.protocol !== "http:") {
    throw new UatError("appUrl must use http protocol (http://127.0.0.1:<port> or http://localhost:<port>).", 400);
  }

  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new UatError("appUrl hostname must be exactly 127.0.0.1 or localhost.", 400);
  }

  if (parsed.username || parsed.password) {
    throw new UatError("appUrl userinfo (username/password) is not allowed.", 400);
  }

  if (parsed.search) {
    throw new UatError("appUrl query parameters are not allowed.", 400);
  }

  if (parsed.hash) {
    throw new UatError("appUrl hash is not allowed.", 400);
  }

  if (parsed.pathname && parsed.pathname !== "/") {
    throw new UatError("appUrl path is not allowed (must be root only).", 400);
  }

  if (!parsed.port) {
    throw new UatError("appUrl must explicitly specify a port (1024-65535).", 400);
  }

  const port = parseInt(parsed.port, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    throw new UatError("appUrl port must be an integer between 1024 and 65535.", 400);
  }

  const daePort = opts?.daedalusPort;
  const e2ePort = Number(process.env.DAE_E2E_PORT || 4318);

  if (port === 4317 || port === e2ePort || (daePort !== undefined && port === daePort)) {
    throw new UatError("appUrl port cannot be Daedalus's own port.", 400);
  }

  const normalizedUrl = `http://${parsed.hostname}:${port}`;
  return { startCommand, appUrl: normalizedUrl };
}

export function getUatAppConfig(
  db: DaedalusDb,
  projectId: number,
): typeof uatAppConfig.$inferSelect | null {
  return db
    .select()
    .from(uatAppConfig)
    .where(eq(uatAppConfig.projectId, projectId))
    .get() ?? null;
}

export function setUatAppConfig(
  db: DaedalusDb,
  projectId: number,
  input: { startCommand: string; appUrl: string },
  opts?: { daedalusPort?: number },
): typeof uatAppConfig.$inferSelect {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const validated = validateUatAppConfig(input, opts);
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(uatAppConfig)
    .where(eq(uatAppConfig.projectId, projectId))
    .get();

  if (existing) {
    db.update(uatAppConfig)
      .set({
        startCommand: validated.startCommand,
        appUrl: validated.appUrl,
        updatedAt: now,
      })
      .where(eq(uatAppConfig.projectId, projectId))
      .run();
  } else {
    db.insert(uatAppConfig)
      .values({
        projectId,
        startCommand: validated.startCommand,
        appUrl: validated.appUrl,
        updatedAt: now,
      })
      .run();
  }

  return db
    .select()
    .from(uatAppConfig)
    .where(eq(uatAppConfig.projectId, projectId))
    .get()!;
}

// ---------------------------------------------------------------------------
// Spec items parsing
// ---------------------------------------------------------------------------

export function extractSpecVerifyItems(specContent: string): string[] {
  const lines = specContent.split(/\r?\n/);
  let inVerify = false;
  const items: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+verify\b/i.test(line)) {
      inVerify = true;
      continue;
    }
    if (inVerify) {
      if (/^#{1,2}\s+\S/.test(line)) {
        break;
      }
      if (
        line.length > 0 &&
        line !== "- How we know the whole thing works (the end-to-end check)."
      ) {
        const bulletMatch = line.match(/^[-*]\s+(.*)$/);
        const itemText = (bulletMatch ? bulletMatch[1] : line)?.trim() ?? "";
        if (itemText.length > 0 && !items.includes(itemText)) {
          items.push(itemText);
        }
      }
    }
  }

  return items;
}

export async function addUatItemFromSpec(
  deps: UatDeps,
  projectId: number,
  text: string,
): Promise<typeof uatItems.$inferSelect> {
  const verifyStartedAt = refreshVerifyStage(deps.db, projectId);
  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  if (!verifyStartedAt || !shaping?.activeMilestoneFrozen) {
    throw new UatError("Verify stage has not started for this project.", 409);
  }

  const releaseVersion = shaping.activeMilestoneVersion;
  if (!releaseVersion) {
    throw new UatError("Active release version not found.", 400);
  }

  if (!shaping.specApprovedAt) {
    throw new UatError("docs/SPEC.md has not been approved.", 400);
  }

  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const specDoc = readShapingDoc(project.localPath, SHAPING_DOCS.spec);
  if (!specDoc.exists || !specDoc.content) {
    throw new UatError("docs/SPEC.md does not exist or is empty.", 400);
  }

  const verifyItems = extractSpecVerifyItems(specDoc.content);
  const inputTrimmed = (text ?? "").trim();
  if (inputTrimmed.length < 1 || inputTrimmed.length > 500) {
    throw new UatError("Item text must be between 1 and 500 characters.", 400);
  }

  const matched = verifyItems.find(
    (it) => it === inputTrimmed || it === inputTrimmed.replace(/^[-*]\s+/, "").trim(),
  );

  if (!matched) {
    throw new UatError(
      "Item text must match one of the approved spec's ## Verify items.",
      400,
    );
  }

  const existingItems = deps.db
    .select()
    .from(uatItems)
    .where(
      and(
        eq(uatItems.projectId, projectId),
        eq(uatItems.releaseVersion, releaseVersion),
      ),
    )
    .all();

  const maxPosition = existingItems.reduce((max, i) => Math.max(max, i.position), 0);
  const nextPosition = maxPosition + 1;

  const [inserted] = deps.db
    .insert(uatItems)
    .values({
      projectId,
      releaseVersion,
      position: nextPosition,
      text: matched.slice(0, 500),
      source: "spec",
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all();

  return inserted!;
}

// ---------------------------------------------------------------------------
// Default injectables for process, probe, browser
// ---------------------------------------------------------------------------

export const defaultUatProcessRunner: UatProcessRunner = async (cmd, opts) => {
  const child = spawn("/bin/sh", ["-c", cmd], {
    cwd: opts.cwd,
    detached: true,
    env: opts.env,
    stdio: "ignore",
  });

  if (!child.pid) {
    throw new Error("Failed to spawn process for startCommand");
  }

  const pid = child.pid;
  child.unref();

  return {
    pid,
    kill: () => {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // ignore
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // ignore
      }
    },
  };
};

export const defaultUatPortProbe: UatPortProbe = async (port: number) => {
  try {
    const probeUrl = `http://127.0.0.1:${port}`;
    await fetch(probeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
};

export const defaultUatUrlProbe: UatUrlProbe = async (urlStr, timeoutMs) => {
  const parsed = new URL(urlStr);
  const probeUrl = `http://127.0.0.1:${parsed.port}`;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      await fetch(probeUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(1000),
      });
      return true;
    } catch {
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  return false;
};

export const defaultUatBrowserLauncher: UatBrowserLauncher = async (opts) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext({
    recordVideo: { dir: opts.videoDir },
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await page.goto(opts.appUrl);
  return { browser, context, page };
};

// ---------------------------------------------------------------------------
// Session lifecycle (start, screenshot, stop, recover)
// ---------------------------------------------------------------------------

export async function startUatSession(
  deps: UatDeps,
  projectId: number,
): Promise<typeof uatSessions.$inferSelect> {
  const verifyStartedAt = refreshVerifyStage(deps.db, projectId);
  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  if (!verifyStartedAt || !shaping?.activeMilestoneFrozen) {
    throw new UatError("Verify stage has not started for this project.", 409);
  }

  const releaseVersion = shaping.activeMilestoneVersion;
  const releaseBranch = shaping.activeMilestoneBranch;
  if (!releaseVersion || !releaseBranch) {
    throw new UatError("Active release branch not found.", 400);
  }

  const config = getUatAppConfig(deps.db, projectId);
  if (!config) {
    throw new UatError("UAT app config not set. Configure app start command and URL first.", 409);
  }

  // Check no session already starting or running
  const runningDb = deps.db
    .select()
    .from(uatSessions)
    .where(
      and(
        eq(uatSessions.projectId, projectId),
        inArray(uatSessions.status, ["starting", "running"]),
      ),
    )
    .get();

  if (runningDb || activeUatSessions.has(projectId)) {
    throw new UatError("A UAT session is already starting or running for this project.", 409);
  }

  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  // 1. Synchronously, right after the check and before any await, reserve the project (Finding 2)
  const allSessions = deps.db
    .select({ id: uatSessions.id })
    .from(uatSessions)
    .all();
  let maxId = 0;
  for (const s of allSessions) {
    const n = Number(s.id);
    if (Number.isInteger(n) && n > maxId) maxId = n;
  }
  const sessionId = String(maxId + 1);

  const sessionFolder = join(deps.dataDir, "uat", String(projectId), sessionId);
  const worktreeDir = join(deps.dataDir, "worktrees", `uat-${projectId}-${sessionId}`);

  const placeholder: ActiveUatSession = {
    sessionId,
    projectId,
    status: "starting",
    worktreeDir,
    sessionFolder,
    repoPath: project.localPath,
    childPid: null,
    killApp: () => {},
    replayFinished: false,
    browserInstance: null,
    cancelled: false,
  };
  activeUatSessions.set(projectId, placeholder);

  // Synchronously insert the starting row into the database (Finding 2)
  try {
    deps.db
      .insert(uatSessions)
      .values({
        id: sessionId,
        projectId,
        releaseVersion,
        headSha: "starting",
        status: "starting",
        startedAt: new Date().toISOString(),
      })
      .run();
  } catch (err: unknown) {
    activeUatSessions.delete(projectId);
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("UNIQUE constraint failed") ||
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw new UatError("A UAT session is already starting or running for this project.", 409);
    }
    throw err;
  }

  // Check display before creating worktree or spawning anything (Finding 2)
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !deps.browserLauncher) {
    activeUatSessions.delete(projectId);
    deps.db
      .update(uatSessions)
      .set({
        status: "error",
        error: "No display for the recorded browser",
        endedAt: new Date().toISOString(),
      })
      .where(eq(uatSessions.id, sessionId))
      .run();
    throw new UatError("No display for the recorded browser", 400);
  }

  // Check if port is already in use before creating worktree or spawning anything (Finding 2)
  const parsedUrl = new URL(config.appUrl);
  const appPort = parseInt(parsedUrl.port, 10);
  const portProbe = deps.portProbe ?? defaultUatPortProbe;
  const isPortInUse = await portProbe(appPort);
  if (isPortInUse) {
    activeUatSessions.delete(projectId);
    deps.db
      .update(uatSessions)
      .set({
        status: "error",
        error: `Port ${appPort} is already in use; stop that app first`,
        endedAt: new Date().toISOString(),
      })
      .where(eq(uatSessions.id, sessionId))
      .run();
    throw new UatError(`Port ${appPort} is already in use; stop that app first`, 409);
  }

  if (placeholder.cancelled) {
    activeUatSessions.delete(projectId);
    throw new UatError("Session stopped during startup", 400);
  }

  const gitCmd = deps.execGit ?? execGit;
  let headSha: string;
  try {
    const headRes = await gitCmd(
      ["rev-parse", "--verify", "--end-of-options", `${releaseBranch}^{commit}`],
      { cwd: project.localPath },
    );
    headSha = headRes.stdout.trim();
    if (!headSha) throw new Error("Empty head SHA");
    deps.db
      .update(uatSessions)
      .set({ headSha })
      .where(eq(uatSessions.id, sessionId))
      .run();
  } catch (err) {
    activeUatSessions.delete(projectId);
    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }
    const errMsg = `Could not resolve head for release branch ${releaseBranch}: ${err instanceof Error ? err.message : String(err)}`;
    deps.db
      .update(uatSessions)
      .set({
        status: "error",
        error: redact(errMsg).slice(0, 2000),
        endedAt: new Date().toISOString(),
      })
      .where(eq(uatSessions.id, sessionId))
      .run();
    throw new UatError(errMsg, 400);
  }

  if (placeholder.cancelled) {
    activeUatSessions.delete(projectId);
    throw new UatError("Session stopped during startup", 400);
  }

  const videoDir = join(sessionFolder, "video");
  const screenshotsDir = join(sessionFolder, "screenshots");

  mkdirSync(videoDir, { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });

  let spawnedProc: { pid: number; kill: () => void } | null = null;
  let browserInstance: UatBrowserInstance | null = null;
  let worktreeCreated = false;

  const cleanupPartial = async () => {
    if (placeholder.killCodegen) {
      try {
        placeholder.killCodegen();
      } catch {
        // ignore
      }
      placeholder.killCodegen = undefined;
    }
    if (placeholder.killReplay) {
      try {
        placeholder.killReplay();
      } catch {
        // ignore
      }
      placeholder.killReplay = undefined;
    }
    if (browserInstance) {
      try {
        await browserInstance.context.close();
      } catch {
        // ignore
      }
      try {
        await browserInstance.browser.close();
      } catch {
        // ignore
      }
      browserInstance = null;
      placeholder.browserInstance = null;
    }
    if (spawnedProc) {
      placeholder.killApp();
      spawnedProc = null;
      placeholder.childPid = null;
    }
    if (worktreeCreated && existsSync(worktreeDir)) {
      try {
        await gitCmd(["worktree", "remove", "--force", worktreeDir], { cwd: project.localPath });
      } catch {
        // ignore
      }
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };

  try {
    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }

    // 1. Create detached worktree
    mkdirSync(dirname(worktreeDir), { recursive: true });
    await gitCmd(["worktree", "add", "--detach", "--", worktreeDir, headSha], {
      cwd: project.localPath,
    });
    worktreeCreated = true;

    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }

    // 2. Spawn app command in worktree
    const procRunner = deps.processRunner ?? defaultUatProcessRunner;
    const cleanEnv: NodeJS.ProcessEnv = scrubEnv(process.env) as NodeJS.ProcessEnv;
    spawnedProc = await procRunner(config.startCommand, {
      cwd: worktreeDir,
      env: cleanEnv,
    });
    placeholder.childPid = spawnedProc.pid;
    let procKilled = false;
    const safeKill = () => {
      if (!procKilled) {
        procKilled = true;
        try {
          spawnedProc?.kill();
        } catch {
          // ignore
        }
      }
    };
    placeholder.killApp = safeKill;

    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }

    // 3. Poll URL
    const urlProbe = deps.urlProbe ?? defaultUatUrlProbe;
    const answered = await urlProbe(config.appUrl, 120_000);
    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }
    if (!answered) {
      throw new Error(`App did not respond at ${config.appUrl} within 2 minutes.`);
    }

    // 3b. Replay active earlier-release scripts before opening the headed browser (T6.5, ADR 0024)
    await runSessionReplay(deps, {
      projectId,
      sessionId,
      releaseVersion,
      headSha,
      appUrl: config.appUrl,
      sessionFolder,
      onKillRegister: (killFn) => {
        placeholder.killReplay = killFn;
      },
      isCancelled: () => Boolean(placeholder.cancelled),
    });

    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }

    // 4. Launch Playwright browser
    const launcher = deps.browserLauncher ?? defaultUatBrowserLauncher;
    browserInstance = await launcher({
      headless: false,
      appUrl: config.appUrl,
      videoDir,
      sessionFolder,
    });
    placeholder.browserInstance = browserInstance;

    if (placeholder.cancelled) {
      throw new UatError("Session stopped during startup", 400);
    }

    // 5. Transition session to running
    deps.db
      .update(uatSessions)
      .set({ status: "running" })
      .where(eq(uatSessions.id, sessionId))
      .run();

    placeholder.status = "running";

    return deps.db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.id, sessionId))
      .get()!;
  } catch (err) {
    await cleanupPartial();
    activeUatSessions.delete(projectId);

    if (placeholder.cancelled) {
      if (err instanceof UatError) {
        throw err;
      }
      throw new UatError("Session stopped during startup", 400);
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    deps.db
      .update(uatSessions)
      .set({
        status: "error",
        error: redact(errMsg).slice(0, 2000),
        endedAt: new Date().toISOString(),
      })
      .where(eq(uatSessions.id, sessionId))
      .run();

    if (err instanceof UatError) {
      throw err;
    }
    throw new UatError(errMsg, 400);
  }
}

export async function uatScreenshot(
  deps: UatDeps,
  projectId: number,
): Promise<{ path: string; name: string }> {
  const active = activeUatSessions.get(projectId);
  if (!active || !active.browserInstance?.page) {
    throw new UatError("No active UAT browser session for this project.", 400);
  }

  const screenshotsDir = join(active.sessionFolder, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  const existingFiles = readdirSync(screenshotsDir);
  let maxN = 0;
  for (const f of existingFiles) {
    const m = /^(\d+)\.png$/.exec(f);
    if (m && m[1]) {
      const num = parseInt(m[1], 10);
      if (num > maxN) maxN = num;
    }
  }

  const nextN = maxN + 1;
  const fileName = `${nextN}.png`;
  const filePath = join(screenshotsDir, fileName);

  await active.browserInstance.page.screenshot({ path: filePath });
  return { path: filePath, name: fileName };
}

export async function stopUatSession(
  deps: UatDeps,
  projectId: number,
): Promise<typeof uatSessions.$inferSelect> {
  const active = activeUatSessions.get(projectId);
  const now = new Date().toISOString();
  const gitCmd = deps.execGit ?? execGit;

  if (active) {
    active.cancelled = true;
    activeUatSessions.delete(projectId);

    if (active.killCodegen) {
      try {
        active.killCodegen();
      } catch {
        // ignore
      }
      active.killCodegen = undefined;
    }

    if (active.killReplay) {
      try {
        active.killReplay();
      } catch {
        // ignore
      }
      active.killReplay = undefined;
    }

    cleanupScriptsOnSessionStop(deps.db, projectId, active.sessionId);

    if (active.browserInstance) {
      try {
        const tracePath = join(active.sessionFolder, "trace.zip");
        await active.browserInstance.context.tracing.stop({ path: tracePath });
      } catch {
        // ignore
      }
      try {
        await active.browserInstance.context.close();
      } catch {
        // ignore
      }
      try {
        await active.browserInstance.browser.close();
      } catch {
        // ignore
      }
    }

    try {
      active.killApp();
    } catch {
      // ignore
    }

    if (active.worktreeDir && existsSync(active.worktreeDir)) {
      try {
        await gitCmd(["worktree", "remove", "--force", active.worktreeDir], {
          cwd: active.repoPath,
        });
      } catch {
        // ignore
      }
      try {
        rmSync(active.worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    deps.db
      .update(uatSessions)
      .set({
        status: "stopped",
        endedAt: now,
      })
      .where(eq(uatSessions.id, active.sessionId))
      .run();

    return deps.db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.id, active.sessionId))
      .get()!;
  }

  // If no in-memory record, check database for leftover running/starting session
  const dbRunning = deps.db
    .select()
    .from(uatSessions)
    .where(
      and(
        eq(uatSessions.projectId, projectId),
        inArray(uatSessions.status, ["starting", "running"]),
      ),
    )
    .get();

  if (!dbRunning) {
    throw new UatError("No running UAT session found for this project.", 404);
  }

  cleanupScriptsOnSessionStop(deps.db, projectId, dbRunning.id);

  const worktreeDir = join(deps.dataDir, "worktrees", `uat-${projectId}-${dbRunning.id}`);
  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  deps.db
    .update(uatSessions)
    .set({
      status: "stopped",
      endedAt: now,
    })
    .where(eq(uatSessions.id, dbRunning.id))
    .run();

  return deps.db
    .select()
    .from(uatSessions)
    .where(eq(uatSessions.id, dbRunning.id))
    .get()!;
}

export async function stopAllUatSessions(
  db: DaedalusDb,
  dataDir: string,
): Promise<void> {
  const now = new Date().toISOString();
  stopAllScriptProcesses(db);

  for (const [, active] of activeUatSessions) {
    active.cancelled = true;
    if (active.killCodegen) {
      try {
        active.killCodegen();
      } catch {
        // ignore
      }
      active.killCodegen = undefined;
    }
    if (active.killReplay) {
      try {
        active.killReplay();
      } catch {
        // ignore
      }
      active.killReplay = undefined;
    }
    if (active.browserInstance) {
      try {
        const tracePath = join(active.sessionFolder, "trace.zip");
        await active.browserInstance.context.tracing.stop({ path: tracePath });
      } catch {
        // ignore
      }
      try {
        await active.browserInstance.context.close();
      } catch {
        // ignore
      }
      try {
        await active.browserInstance.browser.close();
      } catch {
        // ignore
      }
    }
    try {
      active.killApp();
    } catch {
      // ignore
    }
    if (active.worktreeDir && existsSync(active.worktreeDir)) {
      try {
        await execGit(["worktree", "remove", "--force", active.worktreeDir], {
          cwd: active.repoPath,
        });
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
  activeUatSessions.clear();

  const openSessions = db
    .select()
    .from(uatSessions)
    .where(inArray(uatSessions.status, ["starting", "running"]))
    .all();

  for (const s of openSessions) {
    const worktreeDir = join(dataDir, "worktrees", `uat-${s.projectId}-${s.id}`);
    if (existsSync(worktreeDir)) {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    db.update(uatSessions)
      .set({
        status: "error",
        error: "server stopped",
        endedAt: now,
      })
      .where(eq(uatSessions.id, s.id))
      .run();
  }
}

export function recoverUatSessionsOnStartup(
  db: DaedalusDb,
  dataDir: string,
): void {
  const now = new Date().toISOString();
  recoverScriptsOnStartup(db);
  const openSessions = db
    .select()
    .from(uatSessions)
    .where(inArray(uatSessions.status, ["starting", "running"]))
    .all();

  for (const s of openSessions) {
    const worktreeDir = join(dataDir, "worktrees", `uat-${s.projectId}-${s.id}`);
    if (existsSync(worktreeDir)) {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    db.update(uatSessions)
      .set({
        status: "error",
        error: "server restarted",
        endedAt: now,
      })
      .where(eq(uatSessions.id, s.id))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Marks lifecycle (pass/fail -> bug / change)
// ---------------------------------------------------------------------------

export async function markUatItem(
  deps: UatDeps,
  projectId: number,
  itemId: number,
  input: MarkUatItemInput,
): Promise<{
  mark: typeof uatMarks.$inferSelect;
  task?: typeof tasks.$inferSelect;
  finding?: typeof gateFindings.$inferSelect;
}> {
  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  const releaseVersion = shaping?.activeMilestoneVersion;
  const releaseBranch = shaping?.activeMilestoneBranch;
  if (!releaseVersion || !releaseBranch) {
    throw new UatError("Active milestone release branch not found.", 400);
  }

  const item = deps.db
    .select()
    .from(uatItems)
    .where(and(eq(uatItems.id, itemId), eq(uatItems.projectId, projectId)))
    .get();

  if (!item) {
    throw new UatError(`UAT item ${itemId} not found.`, 404);
  }

  if (item.releaseVersion !== releaseVersion) {
    throw new UatError("UAT item does not belong to the active release.", 409);
  }

  // Head SHA check: must equal current release head SHA
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const gitCmd = deps.execGit ?? execGit;
  let currentHeadSha: string;
  try {
    const headRes = await gitCmd(
      ["rev-parse", "--verify", "--end-of-options", `${releaseBranch}^{commit}`],
      { cwd: project.localPath },
    );
    currentHeadSha = headRes.stdout.trim();
  } catch (err) {
    throw new UatError(
      `Could not resolve head for release branch ${releaseBranch}: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  const inputHeadSha = (input.headSha ?? "").trim();
  if (!inputHeadSha || inputHeadSha !== currentHeadSha) {
    throw new UatError("The release changed; reload.", 409);
  }

  assertSessionReplayFinished(deps.db, projectId);

  const result = input.result;
  if (result !== "pass" && result !== "fail") {
    throw new UatError("result must be 'pass' or 'fail'.", 400);
  }

  const now = new Date().toISOString();
  let noteToSave: string | null = null;
  let kindToSave: "bug" | "change" | null = null;
  let checkCommand = "";

  if (result === "pass") {
    if (input.note !== undefined && input.note !== null) {
      const trimmedNote = input.note.trim();
      if (trimmedNote.length > 2000) {
        throw new UatError("Note must be at most 2000 characters.", 400);
      }
      noteToSave = trimmedNote.length > 0 ? trimmedNote : null;
    }
  } else {
    // result === "fail"
    const rawNote = (input.note ?? "").trim();
    if (rawNote.length < 1 || rawNote.length > 2000) {
      throw new UatError("Note is required for fail marks (1-2000 characters).", 400);
    }
    noteToSave = rawNote;

    const kind = input.kind;
    if (kind !== "bug" && kind !== "change") {
      throw new UatError("kind must be 'bug' or 'change' for fail marks.", 400);
    }
    kindToSave = kind;

    if (kind === "bug") {
      checkCommand = (input.checkCommand ?? "").trim();
      if (checkCommand.length === 0 || checkCommand.length > 500) {
        throw new UatError(
          "checkCommand must be non-empty and at most 500 characters for bug marks.",
          400,
        );
      }
    }
  }

  const active = activeUatSessions.get(projectId);
  const activeSessionId = active ? active.sessionId : null;

  return deps.db.transaction((tx) => {
    let createdTask: typeof tasks.$inferSelect | undefined;
    let createdFinding: typeof gateFindings.$inferSelect | undefined;

    if (result === "fail") {
      if (kindToSave === "bug") {
        // Allocate next free FIX-<n> code in project
        const existingTasks = tx
          .select()
          .from(tasks)
          .where(eq(tasks.projectId, projectId))
          .all();

        const usedNums = new Set<number>();
        for (const t of existingTasks) {
          const m = /^FIX-(\d+)$/i.exec(t.code);
          if (m && m[1]) {
            usedNums.add(parseInt(m[1], 10));
          }
        }

        let nextN = 1;
        while (usedNums.has(nextN)) {
          nextN++;
        }
        const taskCode = `FIX-${nextN}`;

        const rawTitle = `Fix: ${item.text}`;
        const taskTitle = rawTitle.length > 120 ? rawTitle.slice(0, 120) : rawTitle;

        const descLines = [
          `UAT item failed: ${item.text}`,
          `Item ID: ${item.id}`,
          `Note: ${noteToSave}`,
        ];
        const taskDescription = redact(descLines.join("\n"));

        const activeMilestone =
          shaping.activeMilestoneCode ?? shaping.activeMilestoneVersion ?? "M1";

        const [newTask] = tx
          .insert(tasks)
          .values({
            projectId,
            code: taskCode,
            title: taskTitle,
            tag: "claude",
            description: taskDescription,
            checkCommand,
            milestoneCode: activeMilestone,
            status: "queued",
            frozenAt: now,
            createdAt: now,
          })
          .returning()
          .all();

        createdTask = newTask!;
      } else {
        // kindToSave === "change"
        const fingerprint = `uat:item:${item.id}:${Date.now()}`;
        const [newFinding] = tx
          .insert(gateFindings)
          .values({
            projectId,
            releaseVersion,
            check: "uat",
            fingerprint,
            severity: "moderate",
            blocking: true,
            state: "open",
            outcome: "change-request",
            title: item.text,
            detail: noteToSave,
            location: `UAT item #${item.position}`,
            decidedAt: now,
            createdAt: now,
          })
          .returning()
          .all();

        createdFinding = newFinding!;
      }
    }

    const [mark] = tx
      .insert(uatMarks)
      .values({
        itemId: item.id,
        result,
        note: noteToSave,
        kind: kindToSave,
        headSha: currentHeadSha,
        sessionId: activeSessionId,
        fixTaskId: createdTask?.id ?? null,
        findingId: createdFinding?.id ?? null,
        markedAt: now,
      })
      .returning()
      .all();

    if (result === "pass") {
      promoteDraftScriptInTx(tx, projectId, item.id, now);
    }

    return {
      mark: mark!,
      ...(createdTask ? { task: createdTask } : {}),
      ...(createdFinding ? { finding: createdFinding } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// UAT state query and fallback (ADR 0021)
// ---------------------------------------------------------------------------

export async function getUatState(
  deps: UatDeps,
  projectId: number,
): Promise<UatGateData> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  const releaseVersion = shaping?.activeMilestoneVersion ?? null;
  const config = getUatAppConfig(deps.db, projectId);

  let session: typeof uatSessions.$inferSelect | null = null;
  if (releaseVersion) {
    const sessionsList = deps.db
      .select()
      .from(uatSessions)
      .where(
        and(
          eq(uatSessions.projectId, projectId),
          eq(uatSessions.releaseVersion, releaseVersion),
        ),
      )
      .orderBy(desc(uatSessions.startedAt))
      .all();
    session = sessionsList[0] ?? null;
  }

  if (!releaseVersion) {
    const scriptsAndReplay = await getUatScriptsAndReplayState(
      deps,
      project,
      null,
      null,
    );
    return {
      items: [],
      session,
      config,
      recordings: [],
      scripts: scriptsAndReplay.scripts,
      replay: scriptsAndReplay.replay,
      recording: scriptsAndReplay.recording,
      gateLine: { status: "fail", detail: "No active release milestone" },
    };
  }

  let rawItems = deps.db
    .select()
    .from(uatItems)
    .where(
      and(
        eq(uatItems.projectId, projectId),
        eq(uatItems.releaseVersion, releaseVersion),
      ),
    )
    .orderBy(uatItems.position)
    .all();

  let blockedReason: string | undefined;

  // Fallback per ADR 0021 for a milestone with no rows
  if (rawItems.length === 0 && shaping?.planApprovedSha256) {
    const planDoc = readShapingDoc(project.localPath, SHAPING_DOCS.plan);
    if (!planDoc.exists || planDoc.content === null) {
      blockedReason = "PLAN.md changed since you approved it";
    } else {
      const currentSha = createHash("sha256").update(planDoc.content, "utf8").digest("hex");
      if (currentSha !== shaping.planApprovedSha256) {
        blockedReason = "PLAN.md changed since you approved it";
      } else {
        const parsed = parsePlanMarkdown(planDoc.content);
        const milestoneCode = shaping.activeMilestoneCode;
        const matched =
          (milestoneCode
            ? parsed.milestones.find(
                (m) => m.code.toLowerCase() === milestoneCode.toLowerCase(),
              )
            : null) ??
          parsed.milestones.find(
            (m) =>
              m.code.toLowerCase() === releaseVersion.toLowerCase() ||
              m.title.toLowerCase().includes(releaseVersion.toLowerCase()),
          ) ??
          parsed.milestones[0];

        const doneWhen = matched?.doneWhen ?? [];
        let pos = 1;
        for (const dw of doneWhen) {
          const trimmed = dw.trim().slice(0, 500);
          if (trimmed.length > 0) {
            deps.db
              .insert(uatItems)
              .values({
                projectId,
                releaseVersion,
                position: pos++,
                text: trimmed,
                source: "plan",
                createdAt: new Date().toISOString(),
              })
              .run();
          }
        }

        rawItems = deps.db
          .select()
          .from(uatItems)
          .where(
            and(
              eq(uatItems.projectId, projectId),
              eq(uatItems.releaseVersion, releaseVersion),
            ),
          )
          .orderBy(uatItems.position)
          .all();
      }
    }
  }

  // Load latest mark for each item
  const allItemMarks = deps.db
    .select()
    .from(uatMarks)
    .orderBy(desc(uatMarks.id))
    .all();

  const marksByItemId = new Map<number, typeof uatMarks.$inferSelect>();
  for (const m of allItemMarks) {
    if (!marksByItemId.has(m.itemId)) {
      marksByItemId.set(m.itemId, m);
    }
  }

  // Cache tasks for status checks
  const projectTasks = deps.db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();
  const taskMap = new Map(projectTasks.map((t) => [t.id, t]));

  // Cache findings for state checks
  const releaseFindings = deps.db
    .select()
    .from(gateFindings)
    .where(
      and(
        eq(gateFindings.projectId, projectId),
        eq(gateFindings.releaseVersion, releaseVersion),
      ),
    )
    .all();
  const findingMap = new Map(releaseFindings.map((f) => [f.id, f]));

  const enrichedItems: UatItemWithMark[] = rawItems.map((item) => {
    const mark = marksByItemId.get(item.id) ?? null;
    let status: UatItemStatus = "untested";
    let fixTaskStatus: string | null = null;
    let fixTaskCode: string | null = null;

    if (mark) {
      if (mark.result === "pass") {
        status = "pass";
      } else {
        // fail
        if (mark.kind === "bug" && mark.fixTaskId) {
          const t = taskMap.get(mark.fixTaskId);
          if (t) {
            fixTaskStatus = t.status;
            fixTaskCode = t.code;
            if (t.status === "done") {
              status = "re-test";
            } else {
              status = "fail";
            }
          } else {
            status = "fail";
          }
        } else if (mark.kind === "change" && mark.findingId) {
          const f = findingMap.get(mark.findingId);
          if (f && f.state === "resolved") {
            status = "re-test";
          } else {
            status = "fail";
          }
        } else {
          status = "fail";
        }
      }
    }

    return {
      ...item,
      status,
      latestMark: mark
        ? {
            id: mark.id,
            itemId: mark.itemId,
            result: mark.result as "pass" | "fail",
            note: mark.note,
            kind: mark.kind as "bug" | "change" | null,
            headSha: mark.headSha,
            sessionId: mark.sessionId,
            fixTaskId: mark.fixTaskId,
            findingId: mark.findingId,
            markedAt: mark.markedAt,
            fixTaskStatus,
            fixTaskCode,
          }
        : null,
    };
  });

  const scriptsAndReplay = await getUatScriptsAndReplayState(
    deps,
    project,
    releaseVersion,
    shaping?.activeMilestoneBranch ?? null,
  );

  // Open UAT findings
  const openUatFindings = releaseFindings.filter(
    (f) => f.check === "uat" && f.state === "open",
  );

  // Compute gateLine
  const hasItems = enrichedItems.length > 0;
  const allPassed = hasItems && enrichedItems.every((i) => i.status === "pass");
  const noOpenFindings = openUatFindings.length === 0;
  const replayPass = scriptsAndReplay.replay.passOnCurrentHead;
  const gatePass = (!hasItems || allPassed) && noOpenFindings && replayPass && !blockedReason;

  let gateDetail: string;
  if (blockedReason) {
    gateDetail = blockedReason;
  } else if (!noOpenFindings) {
    gateDetail = `${openUatFindings.length} open UAT finding(s)`;
  } else if (!replayPass) {
    gateDetail =
      scriptsAndReplay.replay.gateDetail ??
      "Earlier-release UAT script replay did not pass";
  } else if (!hasItems) {
    gateDetail = "No UAT items";
  } else if (allPassed) {
    gateDetail = `All ${enrichedItems.length} items passed`;
  } else {
    const passedCount = enrichedItems.filter((i) => i.status === "pass").length;
    gateDetail = `${passedCount} of ${enrichedItems.length} items passed`;
  }

  // Gather recordings
  const recordings: UatRecordingFile[] = [];
  const projectUatDir = join(deps.dataDir, "uat", String(projectId));

  if (existsSync(projectUatDir)) {
    const sessionDirs = readdirSync(projectUatDir);
    for (const sDir of sessionDirs) {
      const fullSDir = join(projectUatDir, sDir);
      try {
        const sStat = statSync(fullSDir);
        if (!sStat.isDirectory()) continue;

        // Trace
        const tracePath = join(fullSDir, "trace.zip");
        if (existsSync(tracePath)) {
          const tStat = statSync(tracePath);
          if (tStat.isFile()) {
            recordings.push({
              name: "trace.zip",
              sessionId: sDir,
              size: tStat.size,
              url: `/api/projects/${projectId}/release/uat/files/${sDir}/trace.zip`,
              type: "trace",
              createdAt: tStat.mtime.toISOString(),
            });
          }
        }

        // Videos
        const videoDir = join(fullSDir, "video");
        if (existsSync(videoDir)) {
          const vFiles = readdirSync(videoDir);
          for (const vf of vFiles) {
            if (vf.endsWith(".webm")) {
              const vfPath = join(videoDir, vf);
              const vfStat = statSync(vfPath);
              if (vfStat.isFile()) {
                recordings.push({
                  name: `video/${vf}`,
                  sessionId: sDir,
                  size: vfStat.size,
                  url: `/api/projects/${projectId}/release/uat/files/${sDir}/video/${vf}`,
                  type: "video",
                  createdAt: vfStat.mtime.toISOString(),
                });
              }
            }
          }
        }

        // Screenshots
        const scDir = join(fullSDir, "screenshots");
        if (existsSync(scDir)) {
          const scFiles = readdirSync(scDir);
          for (const sf of scFiles) {
            if (sf.endsWith(".png")) {
              const sfPath = join(scDir, sf);
              const sfStat = statSync(sfPath);
              if (sfStat.isFile()) {
                recordings.push({
                  name: `screenshots/${sf}`,
                  sessionId: sDir,
                  size: sfStat.size,
                  url: `/api/projects/${projectId}/release/uat/files/${sDir}/screenshots/${sf}`,
                  type: "screenshot",
                  createdAt: sfStat.mtime.toISOString(),
                });
              }
            }
          }
        }
      } catch {
        // ignore errors reading directory
      }
    }
  }

  // Sort recordings newest first
  recordings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    items: enrichedItems,
    session,
    config,
    recordings,
    scripts: scriptsAndReplay.scripts,
    replay: scriptsAndReplay.replay,
    recording: scriptsAndReplay.recording,
    gateLine: {
      status: gatePass ? "pass" : "fail",
      detail: gateDetail,
    },
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function resolveUatRecordingPath(
  deps: { db: DaedalusDb; dataDir: string },
  projectId: number,
  sessionId: string,
  nameParts: string[],
): { path: string; contentType: string; attachment: boolean } {
  if (!sessionId || !/^[1-9]\d{0,9}$/.test(sessionId)) {
    throw new UatError("Session not found.", 404);
  }

  // Row must exist with that projectId
  const session = deps.db
    .select()
    .from(uatSessions)
    .where(
      and(
        eq(uatSessions.id, sessionId),
        eq(uatSessions.projectId, projectId),
      ),
    )
    .get();

  if (!session) {
    throw new UatError("Session not found.", 404);
  }

  if (!nameParts || !Array.isArray(nameParts) || nameParts.length === 0) {
    throw new UatError("Missing file name.", 400);
  }

  // Check individual path segments for null bytes or traversal
  for (const segment of nameParts) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\0") ||
      segment.includes("\\") ||
      segment.includes("/")
    ) {
      throw new UatError("Invalid file path segment.", 400);
    }
  }

  const relPath = nameParts.join("/");

  // Allowed filename patterns per brief:
  // (trace.zip, video/*.webm, screenshots/*.png, replay.../*/trace.zip)
  const isTrace = relPath === "trace.zip";
  const isVideo = /^video\/[A-Za-z0-9_.-]+\.webm$/.test(relPath);
  const isScreenshot = /^screenshots\/[A-Za-z0-9_.-]+\.png$/.test(relPath);
  const isReplayTrace =
    /^replay(?:-[A-Za-z0-9-]+)?(?:\/[A-Za-z0-9_.-]+)+\/trace\.zip$/.test(relPath);

  if (!isTrace && !isVideo && !isScreenshot && !isReplayTrace) {
    throw new UatError("File requested is not an allowed UAT recording file.", 400);
  }

  const sessionFolder = join(deps.dataDir, "uat", String(projectId), sessionId);
  if (!existsSync(sessionFolder)) {
    throw new UatError("Session recordings folder not found.", 404);
  }

  let realSessionFolder: string;
  try {
    realSessionFolder = realpathSync(sessionFolder);
  } catch {
    throw new UatError("Session recordings folder not found.", 404);
  }

  // Realpath every intermediate parent folder so a symlinked folder anywhere in the path is refused
  for (let i = 1; i < nameParts.length; i++) {
    const parentDir = join(sessionFolder, ...nameParts.slice(0, i));
    if (!existsSync(parentDir)) {
      throw new UatError("Recording file not found.", 404);
    }
    try {
      const parentStat = lstatSync(parentDir);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new UatError("Invalid parent directory.", 404);
      }
      const realParent = realpathSync(parentDir);
      const parentRel = relative(realSessionFolder, realParent);
      if (parentRel.startsWith("..") || isAbsolute(parentRel)) {
        throw new UatError("Path traversal refused.", 403);
      }
    } catch (err) {
      if (err instanceof UatError) throw err;
      throw new UatError("Invalid parent directory.", 404);
    }
  }

  const filePath = join(sessionFolder, ...nameParts);
  if (!existsSync(filePath)) {
    throw new UatError("Recording file not found.", 404);
  }

  // Strict symlink and realpath boundary check (fail closed)
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UatError("File must be a regular file.", 404);
    }
    const realFile = realpathSync(filePath);
    const rel = relative(realSessionFolder, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new UatError("Path traversal refused.", 403);
    }
  } catch (err) {
    if (err instanceof UatError) throw err;
    throw new UatError("Recording file not found.", 404);
  }

  let contentType = "application/octet-stream";
  let attachment = false;

  if (isTrace || isReplayTrace) {
    contentType = "application/zip";
    attachment = true;
  } else if (isVideo) {
    contentType = "video/webm";
  } else if (isScreenshot) {
    contentType = "image/png";
  }

  return {
    path: filePath,
    contentType,
    attachment,
  };
}
