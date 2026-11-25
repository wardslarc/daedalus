/**
 * Saved UAT scripts (Playwright codegen) and replay (T6.5, SPEC#Release gate, SPEC#Gate findings, ADR 0024).
 * Security-sensitive: executes owner-recorded Playwright scripts from SQLite (never repo files),
 * verifies sha256 before writing/running, scrubs environment (ADR 0010), tracks process groups for cleanup,
 * fails closed on missing/unreadable/partial reports, and redacts all failure output.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  gateFindings,
  projects,
  shapingState,
  uatItems,
  uatReplayResults,
  uatReplayRuns,
  uatScripts,
  uatSessions,
} from "@daedalus/db";
import { execGit } from "@daedalus/git";
import { redact, scrubEnv } from "@daedalus/providers";
import {
  getActiveUatSession,
  getUatAppConfig,
  markActiveSessionReplayFinished,
  setActiveSessionCodegenKill,
  setActiveSessionReplayKill,
  UatError,
  type UatDeps,
} from "./uat.js";

export const MAX_UAT_SCRIPT_BYTES = 256 * 1024;
export const MAX_UAT_REPLAY_DETAIL_CHARS = 2000;
export const MAX_UAT_SCRIPT_REASON_CHARS = 500;
export const UAT_REPLAY_TEST_TIMEOUT_MS = 60_000;
export const UAT_REPLAY_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 10 * 1024 * 1024;

// Process groups of every running codegen/replay child, killed if the server exits unexpectedly.
const liveUatChildGroups = new Set<number>();
let exitHookInstalled = false;

function trackChildGroup(pid: number): void {
  liveUatChildGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const g of liveUatChildGroups) {
      killProcessGroup(g);
    }
    liveUatChildGroups.clear();
  });
}

function untrackChildGroup(pid: number): void {
  liveUatChildGroups.delete(pid);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // ignore ESRCH
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ignore ESRCH
  }
}

function resolvePlaywrightTestPaths(): { cliPath: string; packageDir: string } {
  const req = createRequire(import.meta.url);
  const pkgJsonPath = req.resolve("@playwright/test/package.json");
  const cliPath = realpathSync(req.resolve("@playwright/test/cli"));
  const packageDir = realpathSync(dirname(pkgJsonPath));
  return { cliPath, packageDir };
}

// ---------------------------------------------------------------------------
// Types & Injectables
// ---------------------------------------------------------------------------

export type UatCodegenRunner = (opts: {
  outputFile: string;
  appUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onSpawn?: (proc: { pid: number; kill: () => void }) => void;
}) => Promise<{ exitCode: number | null; signal?: string | null; stderr?: string }>;

export type UatReplayPreparedScript = {
  id: number;
  itemText: string;
  releaseVersion: string;
  recordedOrigin: string;
  rawScriptText: string;
  rewrittenScriptText: string;
  sha256: string;
};

export type UatReplayScriptOutcome = {
  scriptId: number;
  status: "passed" | "failed" | "error";
  detail?: string | null;
  tracePath?: string | null;
  durationMs?: number | null;
};

export type UatReplayRunOutcome = {
  status: "passed" | "failed" | "error";
  error?: string | null;
  results: UatReplayScriptOutcome[];
};

export type UatReplayRunner = (opts: {
  replayDir: string;
  sessionFolder: string;
  currentOrigin: string;
  scripts: UatReplayPreparedScript[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  onSpawn?: (proc: { pid: number; kill: () => void }) => void;
}) => Promise<UatReplayRunOutcome>;

export type UatScriptLastResult = {
  runId: number;
  status: "passed" | "failed" | "error";
  detail: string | null;
  tracePath: string | null;
  traceUrl: string | null;
  createdAt: string;
};

export type UatScriptInfo = typeof uatScripts.$inferSelect & {
  lastResult: UatScriptLastResult | null;
};

export type UatReplayResultItem = typeof uatReplayResults.$inferSelect & {
  itemText: string;
  scriptReleaseVersion: string;
  traceUrl: string | null;
};

export type UatReplayState = {
  status: "none" | "pending" | "running" | "passed" | "failed" | "error";
  latestRun: typeof uatReplayRuns.$inferSelect | null;
  results: UatReplayResultItem[];
  earlierActiveCount: number;
  passOnCurrentHead: boolean;
  gateDetail: string | null;
};

export type UatRecordingState = {
  active: boolean;
  itemId: number | null;
  replaceScriptId: number | null;
  startedAt: string | null;
  lastError: string | null;
};

// ---------------------------------------------------------------------------
// In-memory active codegen tracking
// ---------------------------------------------------------------------------

type ActiveCodegenRecord = {
  projectId: number;
  sessionId: string;
  itemId: number | null;
  replaceScriptId: number | null;
  startedAt: string;
  cancelled: boolean;
  kill: () => void;
};

const activeCodegens = new Map<number, ActiveCodegenRecord>();
const lastCodegenErrors = new Map<number, string>();

// ---------------------------------------------------------------------------
// Validation & Origin Rewrite (ADR 0024)
// ---------------------------------------------------------------------------

/**
 * Validate a Playwright codegen script buffer against ADR 0024 rules (fail closed):
 * max 256 KiB, valid UTF-8, no NUL bytes, non-empty, contains @playwright/test and test(.
 */
export function validateRecordedScriptContent(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) {
    throw new UatError("Recorded script must be a byte buffer.", 400);
  }
  if (buf.length === 0) {
    throw new UatError("Recorded script file is empty.", 400);
  }
  if (buf.length > MAX_UAT_SCRIPT_BYTES) {
    throw new UatError("Recorded script exceeds 256 KiB limit.", 400);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new UatError("Recorded script is not valid UTF-8.", 400);
  }

  if (text.includes("\0")) {
    throw new UatError("Recorded script contains invalid NUL bytes.", 400);
  }
  if (text.trim().length === 0) {
    throw new UatError("Recorded script file is empty.", 400);
  }
  if (!text.includes("@playwright/test")) {
    throw new UatError("Recorded script must contain @playwright/test.", 400);
  }
  if (!/\btest\s*\(/.test(text)) {
    throw new UatError("Recorded script must contain at least one test(.", 400);
  }

  return text;
}

function readAndValidateRecordedFile(outputFile: string, codegenDir: string): string {
  if (!existsSync(outputFile)) {
    throw new UatError("Playwright codegen did not produce a script file.", 400);
  }
  let stat;
  try {
    stat = lstatSync(outputFile);
  } catch {
    throw new UatError("Recorded script file could not be read.", 400);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UatError("Recorded script must be a regular file.", 400);
  }

  const realCodegenDir = realpathSync(codegenDir);
  const realFile = realpathSync(outputFile);
  const rel = relative(realCodegenDir, realFile);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UatError("Recorded script path escapes codegen directory.", 403);
  }

  if (stat.size === 0) {
    throw new UatError("Recorded script file is empty.", 400);
  }
  if (stat.size > MAX_UAT_SCRIPT_BYTES) {
    throw new UatError("Recorded script exceeds 256 KiB limit.", 400);
  }

  const buf = readFileSync(outputFile);
  return validateRecordedScriptContent(buf);
}

/**
 * Rewrite `recordedOrigin` to `currentOrigin` ONLY where `recordedOrigin` appears immediately
 * after `'`, `"` or `` ` `` and ends at an origin boundary (ADR 0024).
 */
export function rewriteScriptOrigin(
  scriptText: string,
  recordedOrigin: string,
  currentOrigin: string,
): string {
  if (!recordedOrigin || !currentOrigin || recordedOrigin === currentOrigin) {
    return scriptText;
  }
  const escaped = recordedOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(['"\`])${escaped}(?=$|['"\`/?#\\s:,;)])`, "g");
  return scriptText.replace(re, (_match, quote: string) => `${quote}${currentOrigin}`);
}

// ---------------------------------------------------------------------------
// Default Injectables (Codegen & Replay)
// ---------------------------------------------------------------------------

export const defaultUatCodegenRunner: UatCodegenRunner = async (opts) => {
  const { cliPath } = resolvePlaywrightTestPaths();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [cliPath, "codegen", "--target=playwright-test", "--output", opts.outputFile, opts.appUrl],
        {
          cwd: opts.cwd,
          env: opts.env,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      resolve({
        exitCode: 1,
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const pid = child.pid;
    let killed = false;
    if (pid) {
      trackChildGroup(pid);
      opts.onSpawn?.({
        pid,
        kill: () => {
          if (!killed) {
            killed = true;
            killProcessGroup(pid);
          }
        },
      });
    }

    const errChunks: Buffer[] = [];
    let errBytes = 0;
    child.stderr?.on("data", (d: Buffer) => {
      if (errBytes < MAX_CAPTURE_BYTES) {
        errChunks.push(d);
        errBytes += d.length;
      }
    });

    let settled = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (pid) untrackChildGroup(pid);
      const stderr = Buffer.concat(errChunks).toString("utf8").slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
      resolve({ exitCode, signal, stderr });
    };

    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      errChunks.push(Buffer.from(err.message, "utf8"));
      finish(1, null);
    });
  });
};

type JsonReportAttachment = {
  name?: unknown;
  path?: unknown;
};

type JsonReportError = {
  message?: unknown;
};

type JsonReportTestResult = {
  status?: unknown;
  duration?: unknown;
  error?: JsonReportError;
  errors?: JsonReportError[];
  attachments?: JsonReportAttachment[];
};

type JsonReportTest = {
  status?: unknown;
  results?: JsonReportTestResult[];
};

type JsonReportSpec = {
  file?: unknown;
  ok?: unknown;
  tests?: JsonReportTest[];
};

type JsonReportSuite = {
  file?: unknown;
  specs?: JsonReportSpec[];
  suites?: JsonReportSuite[];
};

type JsonReportShape = {
  suites?: unknown;
  errors?: unknown;
  stats?: unknown;
};

function collectSpecsByFile(
  suites: unknown[],
  parentFile: string | undefined,
  byFile: Map<string, JsonReportSpec[]>,
): void {
  for (const rawSuite of suites) {
    if (!rawSuite || typeof rawSuite !== "object") continue;
    const suite = rawSuite as JsonReportSuite;
    const suiteFile = typeof suite.file === "string" && suite.file ? suite.file : parentFile;

    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!spec || typeof spec !== "object") continue;
        const specFile = typeof spec.file === "string" && spec.file ? spec.file : suiteFile;
        if (specFile) {
          const normalized = posix.basename(specFile.replace(/\\/g, "/"));
          const list = byFile.get(normalized) ?? [];
          list.push(spec);
          byFile.set(normalized, list);
        }
      }
    }

    if (Array.isArray(suite.suites)) {
      collectSpecsByFile(suite.suites, suiteFile, byFile);
    }
  }
}

function validateTraceAttachment(
  rawPath: string,
  replayDir: string,
  sessionFolder: string,
): string | null {
  try {
    const candidate = isAbsolute(rawPath) ? rawPath : join(replayDir, rawPath);
    if (!existsSync(candidate)) return null;
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;

    const realSession = realpathSync(sessionFolder);
    const realFile = realpathSync(candidate);
    const rel = relative(realSession, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    const posixRel = rel.replace(/\\/g, "/");
    if (!posixRel.endsWith(".zip")) return null;
    return posixRel;
  } catch {
    return null;
  }
}

/**
 * Strictly parse a Playwright JSON report file (fail closed on missing/unreadable/partial/missing script).
 */
export function parsePlaywrightJsonReport(
  rawReport: unknown,
  expectedScripts: Array<{ id: number; fileName: string }>,
  opts: {
    replayDir: string;
    sessionFolder: string;
    exitCode: number | null;
    stderr?: string;
  },
): UatReplayRunOutcome {
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) {
    return {
      status: "error",
      error: "Replay report is not a valid JSON object.",
      results: expectedScripts.map((s) => ({
        scriptId: s.id,
        status: "error",
        detail: "Replay report is not a valid JSON object.",
      })),
    };
  }

  const report = rawReport as JsonReportShape;
  if (
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    !report.stats ||
    typeof report.stats !== "object" ||
    Array.isArray(report.stats)
  ) {
    return {
      status: "error",
      error: "Replay report is missing required suites, errors, or stats fields.",
      results: expectedScripts.map((s) => ({
        scriptId: s.id,
        status: "error",
        detail: "Replay report is incomplete.",
      })),
    };
  }

  const globalErrors: string[] = [];
  for (const e of report.errors) {
    if (e && typeof e === "object" && typeof (e as JsonReportError).message === "string") {
      globalErrors.push((e as JsonReportError).message as string);
    } else {
      globalErrors.push("Unknown Playwright runner error");
    }
  }

  const specsByFile = new Map<string, JsonReportSpec[]>();
  collectSpecsByFile(report.suites, undefined, specsByFile);

  const results: UatReplayScriptOutcome[] = [];
  let anyError = globalErrors.length > 0;
  let anyFailed = false;

  for (const expected of expectedScripts) {
    const specs = specsByFile.get(expected.fileName) ?? [];
    if (specs.length === 0) {
      anyError = true;
      results.push({
        scriptId: expected.id,
        status: "error",
        detail: redact(
          globalErrors[0] ?? `Script ${expected.fileName} is missing from replay report.`,
        ).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS),
      });
      continue;
    }

    const allTests: Array<{ specOk: boolean; test: JsonReportTest }> = [];
    for (const sp of specs) {
      if (Array.isArray(sp.tests)) {
        for (const t of sp.tests) {
          if (t && typeof t === "object") {
            allTests.push({ specOk: sp.ok === true, test: t });
          }
        }
      }
    }

    if (allTests.length === 0) {
      anyError = true;
      results.push({
        scriptId: expected.id,
        status: "error",
        detail: `Script ${expected.fileName} produced no test entries in replay report.`,
      });
      continue;
    }

    let scriptError: string | null = null;
    let scriptFailure: string | null = null;
    let tracePath: string | null = null;
    let durationMs = 0;

    for (const { specOk, test } of allTests) {
      const testResults = Array.isArray(test.results) ? test.results : [];
      if (test.status === "skipped" || testResults.length === 0) {
        scriptError = `Test in ${expected.fileName} was skipped or did not run.`;
        break;
      }

      for (const r of testResults) {
        if (typeof r.duration === "number" && Number.isFinite(r.duration)) {
          durationMs += Math.round(r.duration);
        }
        if (Array.isArray(r.attachments)) {
          for (const att of r.attachments) {
            if (att && att.name === "trace" && typeof att.path === "string" && !tracePath) {
              tracePath = validateTraceAttachment(att.path, opts.replayDir, opts.sessionFolder);
            }
          }
        }
        if (r.status !== "passed") {
          const msg =
            (typeof r.error?.message === "string" && r.error.message) ||
            (Array.isArray(r.errors) &&
              typeof r.errors[0]?.message === "string" &&
              r.errors[0].message) ||
            `Test failed with status '${String(r.status ?? "unknown")}'`;
          if (!scriptFailure) {
            scriptFailure = msg;
          }
        }
      }

      if (!specOk || test.status !== "expected") {
        if (!scriptFailure && !scriptError) {
          scriptFailure = `Test status was '${String(test.status ?? "unknown")}'`;
        }
      }
    }

    if (scriptError) {
      anyError = true;
      results.push({
        scriptId: expected.id,
        status: "error",
        detail: redact(scriptError).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS),
        tracePath,
        durationMs,
      });
    } else if (scriptFailure) {
      anyFailed = true;
      results.push({
        scriptId: expected.id,
        status: "failed",
        detail: redact(scriptFailure).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS),
        tracePath,
        durationMs,
      });
    } else {
      results.push({
        scriptId: expected.id,
        status: "passed",
        detail: null,
        tracePath: null,
        durationMs,
      });
    }
  }

  if (anyError) {
    const errDetail = globalErrors.length > 0
      ? redact(globalErrors.join("\n")).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS)
      : redact(opts.stderr || "One or more scripts missing or errored in replay report.").slice(
          0,
          MAX_UAT_REPLAY_DETAIL_CHARS,
        );
    return {
      status: "error",
      error: errDetail,
      results,
    };
  }

  if (anyFailed) {
    return {
      status: "failed",
      error: null,
      results,
    };
  }

  if (opts.exitCode !== 0) {
    const errText = redact(
      opts.stderr?.trim() || `Playwright replay exited with status ${String(opts.exitCode)}`,
    ).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
    return {
      status: "error",
      error: errText,
      results: results.map((r) => ({ ...r, status: "error", detail: errText })),
    };
  }

  return {
    status: "passed",
    error: null,
    results,
  };
}

export const defaultUatReplayRunner: UatReplayRunner = async (opts) => {
  rmSync(opts.replayDir, { recursive: true, force: true });
  mkdirSync(opts.replayDir, { recursive: true });

  const expectedScripts: Array<{ id: number; fileName: string }> = [];

  for (const s of opts.scripts) {
    const actualSha = createHash("sha256").update(s.rawScriptText, "utf8").digest("hex");
    if (actualSha !== s.sha256) {
      const msg = redact(
        `Script #${s.id} sha256 mismatch (expected ${s.sha256}, got ${actualSha})`,
      ).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
      return {
        status: "error",
        error: msg,
        results: opts.scripts.map((item) => ({
          scriptId: item.id,
          status: "error",
          detail: item.id === s.id ? msg : "Aborted due to sha256 mismatch.",
        })),
      };
    }

    const fileName = `s${s.id}.spec.ts`;
    writeFileSync(join(opts.replayDir, fileName), s.rewrittenScriptText, "utf8");
    expectedScripts.push({ id: s.id, fileName });
  }

  const configPath = join(opts.replayDir, "playwright.config.mjs");
  const configContent = [
    "export default {",
    '  testDir: ".",',
    '  outputDir: "./test-results",',
    "  workers: 1,",
    "  retries: 0,",
    `  timeout: ${UAT_REPLAY_TEST_TIMEOUT_MS},`,
    `  globalTimeout: ${opts.timeoutMs},`,
    '  reporter: [["json", { outputFile: "./report.json" }]],',
    "  use: {",
    '    browserName: "chromium",',
    "    headless: true,",
    '    trace: "retain-on-failure",',
    "  },",
    "};",
    "",
  ].join("\n");
  writeFileSync(configPath, configContent, "utf8");

  const { cliPath, packageDir } = resolvePlaywrightTestPaths();
  const nmPlaywrightScope = join(opts.replayDir, "node_modules", "@playwright");
  mkdirSync(nmPlaywrightScope, { recursive: true });
  symlinkSync(packageDir, join(nmPlaywrightScope, "test"), "dir");

  const procResult = await new Promise<{
    exitCode: number | null;
    timedOut: boolean;
    stderr: string;
  }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [cliPath, "test", "--config", configPath], {
        cwd: opts.replayDir,
        env: opts.env,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        timedOut: false,
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const pid = child.pid;
    let killed = false;
    if (pid) {
      trackChildGroup(pid);
      opts.onSpawn?.({
        pid,
        kill: () => {
          if (!killed) {
            killed = true;
            killProcessGroup(pid);
          }
        },
      });
    }

    const errChunks: Buffer[] = [];
    let errBytes = 0;
    const appendErr = (d: Buffer) => {
      if (errBytes < MAX_CAPTURE_BYTES) {
        errChunks.push(d);
        errBytes += d.length;
      }
    };
    child.stdout?.on("data", appendErr);
    child.stderr?.on("data", appendErr);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killProcessGroup(pid);
    }, opts.timeoutMs);

    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid) untrackChildGroup(pid);
      resolve({
        exitCode,
        timedOut,
        stderr: Buffer.concat(errChunks).toString("utf8").slice(0, MAX_UAT_REPLAY_DETAIL_CHARS),
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      errChunks.push(Buffer.from(err.message, "utf8"));
      finish(1);
    });
  });

  if (procResult.timedOut) {
    const msg = "Replay timed out after 10 minutes.";
    return {
      status: "error",
      error: msg,
      results: expectedScripts.map((s) => ({ scriptId: s.id, status: "error", detail: msg })),
    };
  }

  const reportPath = join(opts.replayDir, "report.json");
  if (!existsSync(reportPath)) {
    const msg = redact(
      procResult.stderr.trim() || "Replay did not produce report.json.",
    ).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
    return {
      status: "error",
      error: msg,
      results: expectedScripts.map((s) => ({ scriptId: s.id, status: "error", detail: msg })),
    };
  }

  let reportRawText: string;
  try {
    const st = lstatSync(reportPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_REPORT_BYTES) {
      throw new Error("Replay report.json is invalid or too large.");
    }
    const realReplay = realpathSync(opts.replayDir);
    const realReport = realpathSync(reportPath);
    const rel = relative(realReplay, realReport);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Replay report.json escapes replay folder.");
    }
    reportRawText = readFileSync(reportPath, "utf8");
  } catch (err) {
    const msg = redact(err instanceof Error ? err.message : String(err)).slice(
      0,
      MAX_UAT_REPLAY_DETAIL_CHARS,
    );
    return {
      status: "error",
      error: msg,
      results: expectedScripts.map((s) => ({ scriptId: s.id, status: "error", detail: msg })),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(reportRawText);
  } catch {
    const msg = "Replay report.json is not valid JSON.";
    return {
      status: "error",
      error: msg,
      results: expectedScripts.map((s) => ({ scriptId: s.id, status: "error", detail: msg })),
    };
  }

  return parsePlaywrightJsonReport(parsedJson, expectedScripts, {
    replayDir: opts.replayDir,
    sessionFolder: opts.sessionFolder,
    exitCode: procResult.exitCode,
    stderr: procResult.stderr,
  });
};

// ---------------------------------------------------------------------------
// Finding Upsert / Resolution Helpers
// ---------------------------------------------------------------------------

function upsertReplayFinding(
  db: DaedalusDb,
  params: {
    projectId: number;
    releaseVersion: string;
    fingerprint: string;
    severity: "critical" | "high";
    title: string;
    detail: string;
    location: string;
  },
): void {
  const existing = db
    .select()
    .from(gateFindings)
    .where(
      and(
        eq(gateFindings.projectId, params.projectId),
        eq(gateFindings.releaseVersion, params.releaseVersion),
        eq(gateFindings.fingerprint, params.fingerprint),
      ),
    )
    .get();

  const safeDetail = redact(params.detail).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
  const safeTitle = redact(params.title).slice(0, 200);

  if (existing) {
    db.update(gateFindings)
      .set({
        state: "open",
        title: safeTitle,
        detail: safeDetail,
        location: params.location,
        severity: params.severity,
        blocking: true,
      })
      .where(eq(gateFindings.id, existing.id))
      .run();
  } else {
    db.insert(gateFindings)
      .values({
        projectId: params.projectId,
        releaseVersion: params.releaseVersion,
        check: "uat",
        fingerprint: params.fingerprint,
        severity: params.severity,
        title: safeTitle,
        detail: safeDetail,
        location: params.location,
        blocking: true,
        state: "open",
      })
      .run();
  }
}

function resolveReplayFindingIfOpen(
  db: DaedalusDb,
  projectId: number,
  releaseVersion: string,
  fingerprint: string,
): void {
  const existing = db
    .select()
    .from(gateFindings)
    .where(
      and(
        eq(gateFindings.projectId, projectId),
        eq(gateFindings.releaseVersion, releaseVersion),
        eq(gateFindings.fingerprint, fingerprint),
        eq(gateFindings.state, "open"),
      ),
    )
    .get();

  if (existing) {
    db.update(gateFindings)
      .set({ state: "resolved" })
      .where(eq(gateFindings.id, existing.id))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Replay Execution (Session Start & Single-Script Replace)
// ---------------------------------------------------------------------------

async function executeScriptsReplay(
  deps: UatDeps,
  opts: {
    projectId: number;
    sessionId: string;
    releaseVersion: string;
    headSha: string;
    appUrl: string;
    sessionFolder: string;
    replaySubdir: string;
    kind: "full" | "single";
    scripts: Array<typeof uatScripts.$inferSelect>;
    createFindings: boolean;
    onKillRegister?: (kill: () => void) => void;
    isCancelled?: () => boolean;
  },
): Promise<{
  run: typeof uatReplayRuns.$inferSelect;
  results: Array<typeof uatReplayResults.$inferSelect>;
}> {
  const nowStart = new Date().toISOString();
  const [runRow] = deps.db
    .insert(uatReplayRuns)
    .values({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      releaseVersion: opts.releaseVersion,
      headSha: opts.headSha,
      kind: opts.kind,
      status: "running",
      totalScripts: opts.scripts.length,
      passedScripts: 0,
      failedScripts: 0,
      startedAt: nowStart,
    })
    .returning()
    .all();

  const runId = runRow!.id;
  const currentOrigin = new URL(opts.appUrl).origin;
  const replayDir = join(opts.sessionFolder, opts.replaySubdir);

  const finalizeRun = (
    status: "passed" | "failed" | "error",
    errorText: string | null,
    outcomes: UatReplayScriptOutcome[],
  ) => {
    const finishedAt = new Date().toISOString();
    const safeError = errorText
      ? redact(errorText).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS)
      : null;

    let passedCount = 0;
    let failedCount = 0;
    const insertedResults: Array<typeof uatReplayResults.$inferSelect> = [];

    // Ensure every expected script has a result row (fail closed if runner omitted one)
    const outcomeByScriptId = new Map<number, UatReplayScriptOutcome>();
    for (const o of outcomes) {
      if (!outcomeByScriptId.has(o.scriptId)) {
        outcomeByScriptId.set(o.scriptId, o);
      }
    }

    let missingFromRunner = false;
    for (const s of opts.scripts) {
      let o = outcomeByScriptId.get(s.id);
      if (!o) {
        missingFromRunner = true;
        o = {
          scriptId: s.id,
          status: "error",
          detail: "Script result was omitted by replay runner.",
        };
      }
      if (o.status === "passed") passedCount++;
      else failedCount++;

      const safeDetail = o.detail
        ? redact(o.detail).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS)
        : null;

      const [resRow] = deps.db
        .insert(uatReplayResults)
        .values({
          runId,
          projectId: opts.projectId,
          scriptId: s.id,
          status: o.status,
          detail: safeDetail,
          tracePath: o.tracePath ?? null,
          durationMs: o.durationMs ?? null,
          createdAt: finishedAt,
        })
        .returning()
        .all();
      insertedResults.push(resRow!);
    }

    const finalStatus: "passed" | "failed" | "error" =
      missingFromRunner || status === "error"
        ? "error"
        : failedCount > 0 || status === "failed"
          ? "failed"
          : "passed";

    deps.db
      .update(uatReplayRuns)
      .set({
        status: finalStatus,
        passedScripts: passedCount,
        failedScripts: failedCount,
        error: finalStatus === "error" ? (safeError ?? "Replay errored.") : null,
        finishedAt,
      })
      .where(eq(uatReplayRuns.id, runId))
      .run();

    if (opts.createFindings) {
      if (finalStatus === "error") {
        upsertReplayFinding(deps.db, {
          projectId: opts.projectId,
          releaseVersion: opts.releaseVersion,
          fingerprint: "uat:replay:error",
          severity: "critical",
          title: `UAT replay error (${opts.releaseVersion})`,
          detail: safeError ?? "UAT script replay failed to produce a valid report.",
          location: "UAT replay",
        });
      } else {
        resolveReplayFindingIfOpen(
          deps.db,
          opts.projectId,
          opts.releaseVersion,
          "uat:replay:error",
        );
      }

      for (const s of opts.scripts) {
        const resRow = insertedResults.find((r) => r.scriptId === s.id);
        const fp = `uat:script:${s.id}`;
        if (resRow?.status === "failed") {
          upsertReplayFinding(deps.db, {
            projectId: opts.projectId,
            releaseVersion: opts.releaseVersion,
            fingerprint: fp,
            severity: "high",
            title: `UAT script failed (${s.releaseVersion}): ${s.itemText}`,
            detail: resRow.detail ?? "Saved UAT script failed during replay.",
            location: `Script #${s.id} (recorded in ${s.releaseVersion})`,
          });
        } else if (resRow?.status === "passed" && finalStatus !== "error") {
          resolveReplayFindingIfOpen(deps.db, opts.projectId, opts.releaseVersion, fp);
        } else if (resRow?.status === "error" && finalStatus !== "error") {
          upsertReplayFinding(deps.db, {
            projectId: opts.projectId,
            releaseVersion: opts.releaseVersion,
            fingerprint: fp,
            severity: "critical",
            title: `UAT script error (${s.releaseVersion}): ${s.itemText}`,
            detail: resRow.detail ?? "Saved UAT script errored during replay.",
            location: `Script #${s.id} (recorded in ${s.releaseVersion})`,
          });
        }
      }
    }

    const updatedRun = deps.db
      .select()
      .from(uatReplayRuns)
      .where(eq(uatReplayRuns.id, runId))
      .get()!;

    return { run: updatedRun, results: insertedResults };
  };

  // Check sha256 of EVERY script BEFORE running anything
  const preparedScripts: UatReplayPreparedScript[] = [];
  for (const s of opts.scripts) {
    const actualSha = createHash("sha256").update(s.scriptText, "utf8").digest("hex");
    if (actualSha !== s.sha256) {
      const msg = `Script #${s.id} sha256 mismatch (expected ${s.sha256}, got ${actualSha})`;
      return finalizeRun(
        "error",
        msg,
        opts.scripts.map((item) => ({
          scriptId: item.id,
          status: "error" as const,
          detail: item.id === s.id ? msg : "Aborted due to sha256 mismatch.",
        })),
      );
    }

    preparedScripts.push({
      id: s.id,
      itemText: s.itemText,
      releaseVersion: s.releaseVersion,
      recordedOrigin: s.recordedOrigin,
      rawScriptText: s.scriptText,
      rewrittenScriptText: rewriteScriptOrigin(s.scriptText, s.recordedOrigin, currentOrigin),
      sha256: s.sha256,
    });
  }

  const runner = deps.replayRunner ?? defaultUatReplayRunner;
  const cleanEnv = scrubEnv(process.env) as NodeJS.ProcessEnv;

  let outcome: UatReplayRunOutcome;
  try {
    outcome = await runner({
      replayDir,
      sessionFolder: opts.sessionFolder,
      currentOrigin,
      scripts: preparedScripts,
      timeoutMs: UAT_REPLAY_RUN_TIMEOUT_MS,
      env: cleanEnv,
      onSpawn: (proc) => {
        opts.onKillRegister?.(proc.kill);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finalizeRun(
      "error",
      msg,
      opts.scripts.map((s) => ({
        scriptId: s.id,
        status: "error" as const,
        detail: msg,
      })),
    );
  }

  if (opts.isCancelled?.()) {
    return finalizeRun(
      "error",
      "Session stopped during replay.",
      opts.scripts.map((s) => ({
        scriptId: s.id,
        status: "error" as const,
        detail: "Session stopped during replay.",
      })),
    );
  }

  return finalizeRun(outcome.status, outcome.error ?? null, outcome.results);
}

/**
 * Run automatic replay of all active earlier-release scripts during UAT session startup
 * (after app URL answers, before headed browser opens).
 */
export async function runSessionReplay(
  deps: UatDeps,
  opts: {
    projectId: number;
    sessionId: string;
    releaseVersion: string;
    headSha: string;
    appUrl: string;
    sessionFolder: string;
    onKillRegister: (kill: () => void) => void;
    isCancelled: () => boolean;
  },
): Promise<typeof uatReplayRuns.$inferSelect> {
  const earlierScripts = deps.db
    .select()
    .from(uatScripts)
    .where(
      and(
        eq(uatScripts.projectId, opts.projectId),
        eq(uatScripts.status, "active"),
        ne(uatScripts.releaseVersion, opts.releaseVersion),
      ),
    )
    .orderBy(uatScripts.id)
    .all();

  if (earlierScripts.length === 0) {
    const now = new Date().toISOString();
    const [runRow] = deps.db
      .insert(uatReplayRuns)
      .values({
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        releaseVersion: opts.releaseVersion,
        headSha: opts.headSha,
        kind: "full",
        status: "passed",
        totalScripts: 0,
        passedScripts: 0,
        failedScripts: 0,
        startedAt: now,
        finishedAt: now,
      })
      .returning()
      .all();
    markActiveSessionReplayFinished(opts.projectId);
    return runRow!;
  }

  const { run } = await executeScriptsReplay(deps, {
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    releaseVersion: opts.releaseVersion,
    headSha: opts.headSha,
    appUrl: opts.appUrl,
    sessionFolder: opts.sessionFolder,
    replaySubdir: "replay",
    kind: "full",
    scripts: earlierScripts,
    createFindings: true,
    onKillRegister: opts.onKillRegister,
    isCancelled: opts.isCancelled,
  });

  markActiveSessionReplayFinished(opts.projectId);
  return run;
}

// ---------------------------------------------------------------------------
// Recording (Item Draft or Script Replacement)
// ---------------------------------------------------------------------------

export type StartRecordingTarget =
  | number
  | { replaceScriptId: number; reason: string };

export async function startScriptRecording(
  deps: UatDeps,
  projectId: number,
  target: StartRecordingTarget,
): Promise<{
  recording: UatRecordingState;
  promise: Promise<typeof uatScripts.$inferSelect>;
}> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const activeSession = getActiveUatSession(projectId);
  const dbSession = deps.db
    .select()
    .from(uatSessions)
    .where(and(eq(uatSessions.projectId, projectId), eq(uatSessions.status, "running")))
    .get();

  if (!activeSession || activeSession.status !== "running" || !dbSession || dbSession.id !== activeSession.sessionId) {
    throw new UatError("A running UAT session is required to record a script.", 409);
  }

  if (activeCodegens.has(projectId)) {
    throw new UatError("A script recording is already running for this session.", 409);
  }

  const config = getUatAppConfig(deps.db, projectId);
  if (!config) {
    throw new UatError("UAT app config not set.", 409);
  }

  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();
  const activeReleaseVersion = shaping?.activeMilestoneVersion ?? dbSession.releaseVersion;

  let itemRow: typeof uatItems.$inferSelect | null = null;
  let replaceOldScript: typeof uatScripts.$inferSelect | null = null;
  let replaceReason: string | null = null;

  if (typeof target === "number") {
    const found = deps.db
      .select()
      .from(uatItems)
      .where(and(eq(uatItems.id, target), eq(uatItems.projectId, projectId)))
      .get();
    if (!found) {
      throw new UatError(`UAT item ${target} not found in this project.`, 404);
    }
    if (found.releaseVersion !== activeReleaseVersion) {
      throw new UatError("UAT item does not belong to the active release.", 409);
    }
    itemRow = found;
  } else {
    const found = deps.db
      .select()
      .from(uatScripts)
      .where(and(eq(uatScripts.id, target.replaceScriptId), eq(uatScripts.projectId, projectId)))
      .get();
    if (!found) {
      throw new UatError(`UAT script ${target.replaceScriptId} not found in this project.`, 404);
    }
    if (found.status !== "active") {
      throw new UatError("Only active UAT scripts can be replaced.", 409);
    }
    const trimmedReason = (target.reason ?? "").trim();
    if (trimmedReason.length < 1 || trimmedReason.length > MAX_UAT_SCRIPT_REASON_CHARS) {
      throw new UatError("Replacement reason must be between 1 and 500 characters.", 400);
    }
    replaceOldScript = found;
    replaceReason = trimmedReason;
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !deps.codegenRunner) {
    throw new UatError("No display for Playwright codegen.", 400);
  }

  // Synchronously reserve activeCodegens before any await
  const startedAt = new Date().toISOString();
  const record: ActiveCodegenRecord = {
    projectId,
    sessionId: dbSession.id,
    itemId: itemRow?.id ?? null,
    replaceScriptId: replaceOldScript?.id ?? null,
    startedAt,
    cancelled: false,
    kill: () => {},
  };
  activeCodegens.set(projectId, record);
  lastCodegenErrors.delete(projectId);
  setActiveSessionCodegenKill(projectId, () => {
    record.cancelled = true;
    record.kill();
  });

  const codegenDir = join(activeSession.sessionFolder, "codegen");
  mkdirSync(codegenDir, { recursive: true });
  const fileSlug = itemRow
    ? `item-${itemRow.id}-${Date.now()}.spec.ts`
    : `replace-${replaceOldScript!.id}-${Date.now()}.spec.ts`;
  const outputFile = join(codegenDir, fileSlug);

  const runner = deps.codegenRunner ?? defaultUatCodegenRunner;
  const cleanEnv = scrubEnv(process.env) as NodeJS.ProcessEnv;

  const promise = (async (): Promise<typeof uatScripts.$inferSelect> => {
    try {
      const codegenRes = await runner({
        outputFile,
        appUrl: config.appUrl,
        cwd: codegenDir,
        env: cleanEnv,
        onSpawn: (proc) => {
          record.kill = proc.kill;
          if (record.cancelled) {
            proc.kill();
          }
        },
      });

      if (record.cancelled) {
        throw new UatError("Script recording was cancelled because the session stopped.", 400);
      }

      if (codegenRes.exitCode !== 0 && codegenRes.exitCode !== null) {
        const msg = redact(
          codegenRes.stderr?.trim() || `Playwright codegen exited with code ${codegenRes.exitCode}.`,
        ).slice(0, MAX_UAT_REPLAY_DETAIL_CHARS);
        throw new UatError(msg, 400);
      }
      if (codegenRes.exitCode === null && !existsSync(outputFile)) {
        throw new UatError("Playwright codegen exited without saving a script.", 400);
      }

      const scriptText = readAndValidateRecordedFile(outputFile, codegenDir);
      const sha256 = createHash("sha256").update(scriptText, "utf8").digest("hex");
      const recordedOrigin = new URL(config.appUrl).origin;
      const now = new Date().toISOString();

      if (itemRow) {
        // Save as draft, replacing this item's existing draft
        const saved = deps.db.transaction((tx) => {
          tx.delete(uatScripts)
            .where(
              and(
                eq(uatScripts.projectId, projectId),
                eq(uatScripts.itemId, itemRow.id),
                eq(uatScripts.status, "draft"),
              ),
            )
            .run();

          const [inserted] = tx
            .insert(uatScripts)
            .values({
              projectId,
              itemId: itemRow.id,
              itemText: itemRow.text,
              releaseVersion: activeReleaseVersion,
              recordedOrigin,
              headSha: dbSession.headSha,
              sessionId: dbSession.id,
              scriptText,
              sha256,
              status: "draft",
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .all();

          return inserted!;
        });

        return saved;
      }

      // Replace flow: insert candidate as draft, immediately replay just that script,
      // and only if it passes, retire old + activate new + resolve open finding in one transaction.
      const oldScript = replaceOldScript!;
      const safeReason = redact(replaceReason!);

      const [candidate] = deps.db
        .insert(uatScripts)
        .values({
          projectId,
          itemId: oldScript.itemId,
          itemText: oldScript.itemText,
          releaseVersion: activeReleaseVersion,
          recordedOrigin,
          headSha: dbSession.headSha,
          sessionId: dbSession.id,
          scriptText,
          sha256,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      const { run, results } = await executeScriptsReplay(deps, {
        projectId,
        sessionId: dbSession.id,
        releaseVersion: activeReleaseVersion,
        headSha: dbSession.headSha,
        appUrl: config.appUrl,
        sessionFolder: activeSession.sessionFolder,
        replaySubdir: `replay-replace-${candidate!.id}-${Date.now()}`,
        kind: "single",
        scripts: [candidate!],
        createFindings: false,
        onKillRegister: (kill) => setActiveSessionReplayKill(projectId, kill),
        isCancelled: () => record.cancelled,
      });

      if (record.cancelled) {
        throw new UatError("Script replacement was cancelled because the session stopped.", 400);
      }

      const candidateResult = results[0];
      if (run.status !== "passed" || candidateResult?.status !== "passed") {
        const failDetail =
          candidateResult?.detail ?? run.error ?? "Replacement script failed replay.";
        throw new UatError(`Replacement script did not pass replay: ${failDetail}`, 400);
      }

      const activated = deps.db.transaction((tx) => {
        const doneAt = new Date().toISOString();

        tx.update(uatScripts)
          .set({ status: "active", updatedAt: doneAt })
          .where(eq(uatScripts.id, candidate!.id))
          .run();

        tx.update(uatScripts)
          .set({
            status: "retired",
            retiredReason: safeReason,
            replacedBy: candidate!.id,
            updatedAt: doneAt,
          })
          .where(eq(uatScripts.id, oldScript.id))
          .run();

        tx.update(gateFindings)
          .set({
            state: "resolved",
            outcome: "accept",
            reason: safeReason,
            decidedAt: doneAt,
          })
          .where(
            and(
              eq(gateFindings.projectId, projectId),
              eq(gateFindings.releaseVersion, activeReleaseVersion),
              eq(gateFindings.fingerprint, `uat:script:${oldScript.id}`),
              eq(gateFindings.state, "open"),
            ),
          )
          .run();

        return tx
          .select()
          .from(uatScripts)
          .where(eq(uatScripts.id, candidate!.id))
          .get()!;
      });

      return activated;
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err)).slice(
        0,
        MAX_UAT_REPLAY_DETAIL_CHARS,
      );
      if (!record.cancelled) {
        lastCodegenErrors.set(projectId, msg);
      }
      throw err;
    } finally {
      activeCodegens.delete(projectId);
      setActiveSessionCodegenKill(projectId, undefined);
    }
  })();

  return {
    recording: {
      active: true,
      itemId: record.itemId,
      replaceScriptId: record.replaceScriptId,
      startedAt: record.startedAt,
      lastError: null,
    },
    promise,
  };
}

// ---------------------------------------------------------------------------
// Retire Script Without Replacement (ADR 0024)
// ---------------------------------------------------------------------------

export async function retireUatScript(
  deps: UatDeps,
  projectId: number,
  scriptId: number,
  reason: string,
): Promise<typeof uatScripts.$inferSelect> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const script = deps.db
    .select()
    .from(uatScripts)
    .where(and(eq(uatScripts.id, scriptId), eq(uatScripts.projectId, projectId)))
    .get();
  if (!script) {
    throw new UatError(`UAT script ${scriptId} not found in this project.`, 404);
  }
  if (script.status !== "active") {
    throw new UatError("Only active UAT scripts can be retired.", 409);
  }

  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > MAX_UAT_SCRIPT_REASON_CHARS) {
    throw new UatError("Retirement reason must be between 1 and 500 characters.", 400);
  }
  const safeReason = redact(trimmed);

  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();
  const activeReleaseVersion = shaping?.activeMilestoneVersion ?? null;

  return deps.db.transaction((tx) => {
    const now = new Date().toISOString();

    tx.update(uatScripts)
      .set({
        status: "retired",
        retiredReason: safeReason,
        replacedBy: null,
        updatedAt: now,
      })
      .where(eq(uatScripts.id, script.id))
      .run();

    if (activeReleaseVersion) {
      tx.update(gateFindings)
        .set({
          state: "resolved",
          outcome: "accept",
          reason: safeReason,
          decidedAt: now,
        })
        .where(
          and(
            eq(gateFindings.projectId, projectId),
            eq(gateFindings.releaseVersion, activeReleaseVersion),
            eq(gateFindings.fingerprint, `uat:script:${script.id}`),
            eq(gateFindings.state, "open"),
          ),
        )
        .run();
    }

    return tx.select().from(uatScripts).where(eq(uatScripts.id, script.id)).get()!;
  });
}

// ---------------------------------------------------------------------------
// Hooks for uat.ts (Marks, Stop, Shutdown, Startup, GetState)
// ---------------------------------------------------------------------------

/**
 * Refuse manual marks (409) while an active UAT session's replay has not finished.
 */
export function assertSessionReplayFinished(db: DaedalusDb, projectId: number): void {
  const active = getActiveUatSession(projectId);
  if (active && !active.replayFinished) {
    throw new UatError("Wait for the session replay to finish before marking items.", 409);
  }

  const activeDbSession = db
    .select()
    .from(uatSessions)
    .where(eq(uatSessions.projectId, projectId))
    .orderBy(desc(uatSessions.startedAt))
    .all()
    .find((s) => s.status === "starting" || s.status === "running");

  if (!activeDbSession) {
    return;
  }

  if (activeDbSession.status === "starting") {
    throw new UatError("Wait for the session replay to finish before marking items.", 409);
  }

  const sessionReplay = db
    .select()
    .from(uatReplayRuns)
    .where(
      and(
        eq(uatReplayRuns.sessionId, activeDbSession.id),
        eq(uatReplayRuns.kind, "full"),
      ),
    )
    .orderBy(desc(uatReplayRuns.id))
    .get();

  if (!sessionReplay || sessionReplay.status === "running") {
    throw new UatError("Wait for the session replay to finish before marking items.", 409);
  }
}

/**
 * Promote an item's draft script (if any) to active inside the markUatItem pass transaction.
 */
export function promoteDraftScriptInTx(
  tx: Parameters<Parameters<DaedalusDb["transaction"]>[0]>[0],
  projectId: number,
  itemId: number,
  now: string,
): typeof uatScripts.$inferSelect | null {
  const drafts = tx
    .select()
    .from(uatScripts)
    .where(
      and(
        eq(uatScripts.projectId, projectId),
        eq(uatScripts.itemId, itemId),
        eq(uatScripts.status, "draft"),
      ),
    )
    .orderBy(desc(uatScripts.id))
    .all();

  if (drafts.length === 0) {
    return null;
  }

  const newest = drafts[0]!;

  // Retire any prior active script for the same item so it is never silently duplicated
  tx.update(uatScripts)
    .set({
      status: "retired",
      retiredReason: "Superseded by new accepted recording for item",
      replacedBy: newest.id,
      updatedAt: now,
    })
    .where(
      and(
        eq(uatScripts.projectId, projectId),
        eq(uatScripts.itemId, itemId),
        eq(uatScripts.status, "active"),
      ),
    )
    .run();

  tx.update(uatScripts)
    .set({
      status: "active",
      updatedAt: now,
    })
    .where(eq(uatScripts.id, newest.id))
    .run();

  // Delete any older duplicate drafts for this item
  for (let i = 1; i < drafts.length; i++) {
    tx.delete(uatScripts).where(eq(uatScripts.id, drafts[i]!.id)).run();
  }

  return tx.select().from(uatScripts).where(eq(uatScripts.id, newest.id)).get() ?? null;
}

export function cleanupScriptsOnSessionStop(
  db: DaedalusDb,
  projectId: number,
  sessionId?: string,
): void {
  const activeCg = activeCodegens.get(projectId);
  if (activeCg) {
    activeCg.cancelled = true;
    try {
      activeCg.kill();
    } catch {
      // ignore
    }
    activeCodegens.delete(projectId);
  }
  lastCodegenErrors.delete(projectId);

  // Unaccepted drafts of a stopped session are deleted
  db.delete(uatScripts)
    .where(
      sessionId
        ? and(
            eq(uatScripts.projectId, projectId),
            eq(uatScripts.sessionId, sessionId),
            eq(uatScripts.status, "draft"),
          )
        : and(eq(uatScripts.projectId, projectId), eq(uatScripts.status, "draft")),
    )
    .run();

  if (sessionId) {
    db.update(uatReplayRuns)
      .set({
        status: "error",
        error: "session stopped",
        finishedAt: new Date().toISOString(),
      })
      .where(and(eq(uatReplayRuns.sessionId, sessionId), eq(uatReplayRuns.status, "running")))
      .run();
  }
}

export function stopAllScriptProcesses(db: DaedalusDb): void {
  for (const [, cg] of activeCodegens) {
    cg.cancelled = true;
    try {
      cg.kill();
    } catch {
      // ignore
    }
  }
  activeCodegens.clear();
  lastCodegenErrors.clear();

  const now = new Date().toISOString();
  db.update(uatReplayRuns)
    .set({
      status: "error",
      error: "server stopped",
      finishedAt: now,
    })
    .where(eq(uatReplayRuns.status, "running"))
    .run();

  db.delete(uatScripts).where(eq(uatScripts.status, "draft")).run();
}

export function recoverScriptsOnStartup(db: DaedalusDb): void {
  const now = new Date().toISOString();
  db.update(uatReplayRuns)
    .set({
      status: "error",
      error: "server restarted",
      finishedAt: now,
    })
    .where(eq(uatReplayRuns.status, "running"))
    .run();

  db.delete(uatScripts).where(eq(uatScripts.status, "draft")).run();
}

// ---------------------------------------------------------------------------
// Queries for API & getUatState
// ---------------------------------------------------------------------------

function buildTraceUrl(
  projectId: number,
  sessionId: string | null,
  tracePath: string | null,
): string | null {
  if (!sessionId || !tracePath) return null;
  const cleanRel = tracePath.replace(/^\/+/, "");
  return `/api/projects/${projectId}/release/uat/files/${sessionId}/${cleanRel}`;
}

export function listUatScripts(deps: UatDeps, projectId: number): UatScriptInfo[] {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const scripts = deps.db
    .select()
    .from(uatScripts)
    .where(eq(uatScripts.projectId, projectId))
    .orderBy(desc(uatScripts.id))
    .all();

  const allResults = deps.db
    .select()
    .from(uatReplayResults)
    .where(eq(uatReplayResults.projectId, projectId))
    .orderBy(desc(uatReplayResults.id))
    .all();

  const allRuns = deps.db
    .select()
    .from(uatReplayRuns)
    .where(eq(uatReplayRuns.projectId, projectId))
    .all();
  const runById = new Map(allRuns.map((r) => [r.id, r]));

  const lastResultByScriptId = new Map<number, UatScriptLastResult>();
  for (const r of allResults) {
    if (!lastResultByScriptId.has(r.scriptId)) {
      const parentRun = runById.get(r.runId);
      lastResultByScriptId.set(r.scriptId, {
        runId: r.runId,
        status: r.status as "passed" | "failed" | "error",
        detail: r.detail,
        tracePath: r.tracePath,
        traceUrl: buildTraceUrl(projectId, parentRun?.sessionId ?? null, r.tracePath),
        createdAt: r.createdAt,
      });
    }
  }

  return scripts.map((s) => ({
    ...s,
    lastResult: lastResultByScriptId.get(s.id) ?? null,
  }));
}

export function getUatReplayResults(
  deps: UatDeps,
  projectId: number,
): {
  latestRun: typeof uatReplayRuns.$inferSelect | null;
  runs: Array<typeof uatReplayRuns.$inferSelect>;
  results: UatReplayResultItem[];
} {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new UatError(`Project ${projectId} not found.`, 404);
  }

  const runs = deps.db
    .select()
    .from(uatReplayRuns)
    .where(eq(uatReplayRuns.projectId, projectId))
    .orderBy(desc(uatReplayRuns.id))
    .all();

  const latestRun = runs[0] ?? null;

  const scripts = deps.db
    .select()
    .from(uatScripts)
    .where(eq(uatScripts.projectId, projectId))
    .all();
  const scriptById = new Map(scripts.map((s) => [s.id, s]));
  const runById = new Map(runs.map((r) => [r.id, r]));

  const rawResults = latestRun
    ? deps.db
        .select()
        .from(uatReplayResults)
        .where(eq(uatReplayResults.runId, latestRun.id))
        .orderBy(uatReplayResults.id)
        .all()
    : [];

  const results: UatReplayResultItem[] = rawResults.map((r) => {
    const s = scriptById.get(r.scriptId);
    const parentRun = runById.get(r.runId);
    return {
      ...r,
      itemText: s?.itemText ?? `Script #${r.scriptId}`,
      scriptReleaseVersion: s?.releaseVersion ?? "",
      traceUrl: buildTraceUrl(projectId, parentRun?.sessionId ?? null, r.tracePath),
    };
  });

  return { latestRun, runs, results };
}

export async function getUatScriptsAndReplayState(
  deps: UatDeps,
  project: typeof projects.$inferSelect,
  releaseVersion: string | null,
  releaseBranch: string | null,
): Promise<{
  scripts: UatScriptInfo[];
  replay: UatReplayState;
  recording: UatRecordingState;
}> {
  const scripts = listUatScripts(deps, project.id);

  const activeCg = activeCodegens.get(project.id);
  const recording: UatRecordingState = {
    active: Boolean(activeCg),
    itemId: activeCg?.itemId ?? null,
    replaceScriptId: activeCg?.replaceScriptId ?? null,
    startedAt: activeCg?.startedAt ?? null,
    lastError: lastCodegenErrors.get(project.id) ?? null,
  };

  if (!releaseVersion) {
    return {
      scripts,
      recording,
      replay: {
        status: "none",
        latestRun: null,
        results: [],
        earlierActiveCount: 0,
        passOnCurrentHead: true,
        gateDetail: null,
      },
    };
  }

  const earlierActiveScripts = scripts.filter(
    (s) => s.status === "active" && s.releaseVersion !== releaseVersion,
  );

  // Resolve current head SHA
  let currentHeadSha: string | null = null;
  if (releaseBranch && existsSync(project.localPath)) {
    try {
      const gitCmd = deps.execGit ?? execGit;
      const res = await gitCmd(
        ["rev-parse", "--verify", "--end-of-options", `${releaseBranch}^{commit}`],
        { cwd: project.localPath },
      );
      currentHeadSha = res.stdout.trim() || null;
    } catch {
      currentHeadSha = null;
    }
  }

  const allReleaseRuns = deps.db
    .select()
    .from(uatReplayRuns)
    .where(
      and(
        eq(uatReplayRuns.projectId, project.id),
        eq(uatReplayRuns.releaseVersion, releaseVersion),
      ),
    )
    .orderBy(desc(uatReplayRuns.id))
    .all();

  const latestRun = allReleaseRuns[0] ?? null;
  const latestFullOnHead = currentHeadSha
    ? allReleaseRuns.find((r) => r.kind === "full" && r.headSha === currentHeadSha) ?? null
    : null;
  const displayRun =
    earlierActiveScripts.length > 0 && latestFullOnHead ? latestFullOnHead : latestRun;

  const scriptById = new Map(scripts.map((s) => [s.id, s]));
  const rawResults = displayRun
    ? deps.db
        .select()
        .from(uatReplayResults)
        .where(eq(uatReplayResults.runId, displayRun.id))
        .orderBy(uatReplayResults.id)
        .all()
    : [];

  const results: UatReplayResultItem[] = rawResults.map((r) => {
    const s = scriptById.get(r.scriptId);
    return {
      ...r,
      itemText: s?.itemText ?? `Script #${r.scriptId}`,
      scriptReleaseVersion: s?.releaseVersion ?? "",
      traceUrl: buildTraceUrl(project.id, displayRun?.sessionId ?? null, r.tracePath),
    };
  });

  if (earlierActiveScripts.length === 0) {
    return {
      scripts,
      recording,
      replay: {
        status: latestRun ? (latestRun.status as UatReplayState["status"]) : "none",
        latestRun,
        results,
        earlierActiveCount: 0,
        passOnCurrentHead: true,
        gateDetail: null,
      },
    };
  }

  if (!currentHeadSha) {
    return {
      scripts,
      recording,
      replay: {
        status: latestRun ? (latestRun.status as UatReplayState["status"]) : "pending",
        latestRun,
        results,
        earlierActiveCount: earlierActiveScripts.length,
        passOnCurrentHead: false,
        gateDetail: "Release branch head unknown; earlier-release script replay required",
      },
    };
  }

  if (!latestFullOnHead) {
    return {
      scripts,
      recording,
      replay: {
        status: "pending",
        latestRun,
        results,
        earlierActiveCount: earlierActiveScripts.length,
        passOnCurrentHead: false,
        gateDetail: `${earlierActiveScripts.length} earlier-release UAT script(s) must pass replay on current head`,
      },
    };
  }

  if (latestFullOnHead.status === "running") {
    return {
      scripts,
      recording,
      replay: {
        status: "running",
        latestRun: latestFullOnHead,
        results,
        earlierActiveCount: earlierActiveScripts.length,
        passOnCurrentHead: false,
        gateDetail: "Earlier-release UAT script replay is running",
      },
    };
  }

  if (latestFullOnHead.status === "error") {
    return {
      scripts,
      recording,
      replay: {
        status: "error",
        latestRun: latestFullOnHead,
        results,
        earlierActiveCount: earlierActiveScripts.length,
        passOnCurrentHead: false,
        gateDetail: "Latest UAT script replay errored",
      },
    };
  }

  const headRunResults = deps.db
    .select()
    .from(uatReplayResults)
    .where(eq(uatReplayResults.runId, latestFullOnHead.id))
    .all();
  const resultByScript = new Map(headRunResults.map((r) => [r.scriptId, r]));

  const allEarlierPassed = earlierActiveScripts.every(
    (s) => resultByScript.get(s.id)?.status === "passed",
  );

  if (!allEarlierPassed) {
    return {
      scripts,
      recording,
      replay: {
        status: "failed",
        latestRun: latestFullOnHead,
        results,
        earlierActiveCount: earlierActiveScripts.length,
        passOnCurrentHead: false,
        gateDetail: "One or more earlier-release UAT scripts failed replay on current head",
      },
    };
  }

  return {
    scripts,
    recording,
    replay: {
      status: "passed",
      latestRun: latestFullOnHead,
      results,
      earlierActiveCount: earlierActiveScripts.length,
      passOnCurrentHead: true,
      gateDetail: null,
    },
  };
}
