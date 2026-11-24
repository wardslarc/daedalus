/**
 * Release gate and automatic security checks (T6.3, SPEC#Release gate, SPEC#Gate findings, ADR 0020).
 * Handles the Verify stage, gate runs, secret scanning, dependency audits, saved security tests,
 * ship checklist, findings lifecycle, and fix tasks.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import {
  gateFindings,
  gateRuns,
  projects,
  securityTests,
  shapingState,
  shipChecklistTicks,
  tasks,
  type GateCheckStatus,
  type GateRunChecks,
} from "@daedalus/db";
import { execGit } from "@daedalus/git";
import { shipChecklist, type ProjectLike } from "@daedalus/core/profiles";
import { redact, scrubEnv } from "@daedalus/providers";
import { runCheck } from "./check-exec.js";
import {
  buildReviewDiffArgs,
  buildReviewLogArgs,
  REVIEW_GIT_ENV,
  scanPatchAddedLinesForDetailedSecrets,
} from "./review.js";

export class ReleaseGateError extends Error {
  override name = "ReleaseGateError";
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export type ReleaseGateStatus =
  | "not-ready"
  | "needs-run"
  | "running"
  | "blocked"
  | "needs-decision"
  | "checklist"
  | "pass";

export type ReleaseGateData = {
  version: string | null;
  branch: string | null;
  verifyStartedAt: string | null;
  stage: "build" | "verify";
  status: ReleaseGateStatus;
  latestRun: typeof gateRuns.$inferSelect | null;
  checks: GateRunChecks | null;
  findings: Array<typeof gateFindings.$inferSelect>;
  checklist: Array<{ id: string; label: string; ticked: boolean }>;
  milestoneTasksSummary?: { done: number; total: number; milestoneCode: string | null };
};

export type AuditRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export type ReleaseGateDeps = {
  db: DaedalusDb;
  dataDir: string;
  execGit?: typeof execGit;
  auditRunner?: AuditRunner;
  testRunner?: typeof runCheck;
  onWorktreeCreated?: (path: string) => void;
};

// Process tracking for active gate runs so shutdown can stop them immediately
type ActiveRunRecord = {
  projectId: number;
  worktreeDir: string | null;
  repoPath: string;
  pids: Set<number>;
  killAll: () => void;
};

const activeRuns = new Map<number, ActiveRunRecord>();

/**
 * Filter and sanitize environment variables for dependency audits (ADR 0020).
 * Strips secrets via scrubEnv, and additionally removes all npm_config_*, NPM_CONFIG_*, and COREPACK_* vars.
 */
export function buildAuditEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = scrubEnv(baseEnv);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(clean)) {
    if (/^npm_config_/i.test(k) || /^corepack_/i.test(k)) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Default spawn-based runner for dependency audit commands (argv array, no shell).
 */
export async function defaultAuditRunner(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  onPid?: (pid: number) => void,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }

    const pid = child.pid;
    if (pid && onPid) {
      onPid(pid);
    }

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }, opts.timeoutMs);
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Check if the active milestone satisfies verify conditions and set activeMilestoneVerifyStartedAt if not set.
 * Conditions:
 * 1. Active milestone is frozen.
 * 2. Has at least one frozen task.
 * 3. Every frozen task of it is 'done'.
 * 4. activeMilestoneVerifyStartedAt is null -> set it (server time).
 * Never clears it.
 */
export function refreshVerifyStage(db: DaedalusDb, projectId: number): string | null {
  const shaping = db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  if (!shaping || !shaping.activeMilestoneFrozen) {
    return null;
  }

  if (shaping.activeMilestoneVerifyStartedAt) {
    return shaping.activeMilestoneVerifyStartedAt;
  }

  const activeVer = shaping.activeMilestoneVersion?.toLowerCase();
  const activeCode = shaping.activeMilestoneCode?.toLowerCase();

  const allTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();

  const frozenMilestoneTasks = allTasks.filter((t) => {
    if (!t.frozenAt) return false;
    const taskMilestone = t.milestoneCode?.toLowerCase();
    return Boolean(
      taskMilestone &&
        ((activeVer && taskMilestone === activeVer) ||
          (activeCode && taskMilestone === activeCode)),
    );
  });

  if (frozenMilestoneTasks.length === 0) {
    return null;
  }

  const allDone = frozenMilestoneTasks.every((t) => t.status === "done");
  if (allDone) {
    const now = new Date().toISOString();
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: now })
      .where(eq(shapingState.projectId, projectId))
      .run();
    return now;
  }

  return null;
}

/**
 * Parse dependency audit JSON output into normalized findings.
 * Supports both npm v7+ (vulnerabilities object) and pnpm / npm v6 (advisories object/array).
 */
export type RawAuditFinding = {
  package: string;
  advisoryId: string;
  severity: "critical" | "high" | "moderate" | "low";
  title: string;
  detail: string;
  location: string;
  blocking: boolean;
};

export function parseAuditJson(rawJson: unknown): RawAuditFinding[] {
  if (typeof rawJson !== "object" || rawJson === null) return [];
  const root = rawJson as Record<string, unknown>;
  const findings: RawAuditFinding[] = [];

  const mapSeverity = (s?: unknown): "critical" | "high" | "moderate" | "low" => {
    const str = typeof s === "string" ? s.toLowerCase() : "";
    if (str === "critical") return "critical";
    if (str === "high") return "high";
    if (str === "moderate" || str === "medium") return "moderate";
    return "low";
  };

  // Shape 1: npm v7+ { vulnerabilities: { [pkgName]: { name, severity, via, nodes, ... } } }
  if (root.vulnerabilities && typeof root.vulnerabilities === "object") {
    const vulns = root.vulnerabilities as Record<string, unknown>;
    for (const [pkgName, vulnObj] of Object.entries(vulns)) {
      if (typeof vulnObj !== "object" || vulnObj === null) continue;
      const v = vulnObj as Record<string, unknown>;
      const via = Array.isArray(v.via) ? v.via : [];
      const location = Array.isArray(v.nodes) && v.nodes.length > 0 ? String(v.nodes[0]) : pkgName;

      let foundViaObj = false;
      for (const item of via) {
        if (typeof item === "object" && item !== null) {
          foundViaObj = true;
          const advisoryObj = item as Record<string, unknown>;
          const advisoryId = String(
            advisoryObj.source ?? advisoryObj.id ?? advisoryObj.url ?? pkgName,
          );
          const sev = mapSeverity(advisoryObj.severity ?? v.severity);
          const title = String(advisoryObj.title ?? `Vulnerability in ${pkgName}`);
          const url = advisoryObj.url ? String(advisoryObj.url) : "";
          const detail = url ? `${title}\n${url}` : title;
          findings.push({
            package: pkgName,
            advisoryId,
            severity: sev,
            title,
            detail: redact(detail),
            location,
            blocking: sev === "critical" || sev === "high",
          });
        }
      }

      if (!foundViaObj) {
        const sev = mapSeverity(v.severity);
        const title = `Vulnerability in ${pkgName}`;
        findings.push({
          package: pkgName,
          advisoryId: pkgName,
          severity: sev,
          title,
          detail: redact(title),
          location,
          blocking: sev === "critical" || sev === "high",
        });
      }
    }
    return findings;
  }

  // Shape 2: pnpm / npm v6 { advisories: { [id]: { id, module_name, title, severity, url, findings } } }
  if (root.advisories && typeof root.advisories === "object") {
    const advList = Array.isArray(root.advisories)
      ? root.advisories
      : Object.values(root.advisories as Record<string, unknown>);

    for (const adv of advList) {
      if (typeof adv !== "object" || adv === null) continue;
      const a = adv as Record<string, unknown>;
      const pkgName = String(a.module_name ?? a.name ?? "unknown");
      const advisoryId = String(a.id ?? Math.random().toString(36).slice(2));
      const sev = mapSeverity(a.severity);
      const title = String(a.title ?? `Vulnerability in ${pkgName}`);
      const url = a.url ? String(a.url) : "";
      const detail = url ? `${title}\n${url}` : title;
      let location = pkgName;
      if (Array.isArray(a.findings) && a.findings.length > 0) {
        const f0 = a.findings[0] as Record<string, unknown>;
        if (Array.isArray(f0?.paths) && f0.paths.length > 0) {
          location = String(f0.paths[0]);
        }
      }
      findings.push({
        package: pkgName,
        advisoryId,
        severity: sev,
        title,
        detail: redact(detail),
        location,
        blocking: sev === "critical" || sev === "high",
      });
    }
    return findings;
  }

  return findings;
}

/**
 * Get release gate data for a project (SPEC#Release gate, ADR 0020).
 */
export async function getReleaseGate(
  db: DaedalusDb,
  project: ProjectLike & { id: number; localPath: string; defaultBranch?: string },
  options?: { execGit?: typeof execGit },
): Promise<ReleaseGateData> {
  const verifyStartedAt = refreshVerifyStage(db, project.id);
  const shaping = db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, project.id))
    .get();

  const releaseVersion = shaping?.activeMilestoneVersion ?? null;
  const releaseBranch = shaping?.activeMilestoneBranch ?? null;
  const stage = verifyStartedAt ? "verify" : "build";

  // Task summary for banner count
  const allTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .all();

  const activeVer = releaseVersion?.toLowerCase();
  const activeCode = shaping?.activeMilestoneCode?.toLowerCase();
  const milestoneTasks = allTasks.filter((t) => {
    const tm = t.milestoneCode?.toLowerCase();
    return Boolean(
      t.frozenAt &&
        tm &&
        ((activeVer && tm === activeVer) || (activeCode && tm === activeCode)),
    );
  });
  const doneCount = milestoneTasks.filter((t) => t.status === "done").length;
  const milestoneTasksSummary = {
    done: doneCount,
    total: milestoneTasks.length,
    milestoneCode: shaping?.activeMilestoneCode ?? null,
  };

  // Ship checklist items
  const profileItems = shipChecklist(project.profile);
  const ticks = releaseVersion
    ? db
        .select()
        .from(shipChecklistTicks)
        .where(
          and(
            eq(shipChecklistTicks.projectId, project.id),
            eq(shipChecklistTicks.releaseVersion, releaseVersion),
          ),
        )
        .all()
    : [];
  const tickedIds = new Set(ticks.map((t) => t.itemId));
  const checklist = profileItems.map((item) => ({
    id: item.id,
    label: item.label,
    ticked: tickedIds.has(item.id),
  }));

  // Findings
  const findings = releaseVersion
    ? db
        .select()
        .from(gateFindings)
        .where(
          and(
            eq(gateFindings.projectId, project.id),
            eq(gateFindings.releaseVersion, releaseVersion),
          ),
        )
        .orderBy(desc(gateFindings.id))
        .all()
    : [];

  // Gate runs
  const runsList = releaseVersion
    ? db
        .select()
        .from(gateRuns)
        .where(
          and(
            eq(gateRuns.projectId, project.id),
            eq(gateRuns.releaseVersion, releaseVersion),
          ),
        )
        .orderBy(desc(gateRuns.id))
        .all()
    : [];

  const latestRun = runsList[0] ?? null;

  // Resolve current release branch head SHA
  let currentHeadSha: string | null = null;
  if (releaseBranch && existsSync(project.localPath)) {
    try {
      const gitCmd = options?.execGit ?? execGit;
      const res = await gitCmd(["rev-parse", releaseBranch], {
        cwd: project.localPath,
      });
      currentHeadSha = res.stdout.trim();
    } catch {
      currentHeadSha = null;
    }
  }

  // Determine gate status
  let status: ReleaseGateStatus = "not-ready";

  if (!verifyStartedAt) {
    status = "not-ready";
  } else if (latestRun?.status === "running") {
    status = "running";
  } else if (
    !latestRun ||
    latestRun.status !== "done" ||
    (currentHeadSha && latestRun.headSha !== currentHeadSha)
  ) {
    status = "needs-run";
  } else {
    // A finished run for the current head exists
    const checks = latestRun.checks as GateRunChecks | null;
    const anyCheckError =
      latestRun.status === "error" ||
      checks?.secrets?.status === "error" ||
      checks?.dependencies?.status === "error" ||
      checks?.securityTests?.status === "error" ||
      checks?.checklist?.status === "error";

    const openFindings = findings.filter((f) => f.state === "open");
    const anyBlockingOpen = openFindings.some((f) => f.blocking);
    const anyUndecidedNonBlocking = openFindings.some(
      (f) => !f.blocking && (!f.outcome || f.outcome.trim() === ""),
    );
    const anyUnticked = checklist.some((item) => !item.ticked);

    if (anyCheckError || anyBlockingOpen) {
      status = "blocked";
    } else if (anyUndecidedNonBlocking) {
      status = "needs-decision";
    } else if (anyUnticked) {
      status = "checklist";
    } else {
      status = "pass";
    }
  }

  return {
    version: releaseVersion,
    branch: releaseBranch,
    verifyStartedAt,
    stage,
    status,
    latestRun,
    checks: latestRun?.checks ?? null,
    findings,
    checklist,
    milestoneTasksSummary,
  };
}

/**
 * Start a gate run in the background (SPEC#Release gate, ADR 0020).
 * Answers immediately with { runId }.
 */
export async function startGateRun(
  deps: ReleaseGateDeps,
  projectId: number,
): Promise<{ runId: number }> {
  const verifyStartedAt = refreshVerifyStage(deps.db, projectId);
  const shaping = deps.db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  if (!verifyStartedAt || !shaping?.activeMilestoneFrozen) {
    throw new ReleaseGateError("Verify stage has not started for this project.", 409);
  }

  const project = deps.db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    throw new ReleaseGateError(`Project ${projectId} not found.`, 404);
  }

  const releaseVersion = shaping.activeMilestoneVersion;
  const releaseBranch = shaping.activeMilestoneBranch;
  if (!releaseVersion || !releaseBranch) {
    throw new ReleaseGateError("Active milestone release branch not found.", 400);
  }

  // 1. Resolve release branch head SHA first
  const gitCmd = deps.execGit ?? execGit;
  let headSha = "";
  try {
    const headRes = await gitCmd(["rev-parse", releaseBranch], {
      cwd: project.localPath,
    });
    headSha = headRes.stdout.trim();
  } catch (err) {
    throw new ReleaseGateError(
      `Could not resolve head for release branch ${releaseBranch}: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  // 2. Check running status + insert gate_runs row with nothing awaited between them
  const running = deps.db
    .select()
    .from(gateRuns)
    .where(and(eq(gateRuns.projectId, projectId), eq(gateRuns.status, "running")))
    .get();

  if (running) {
    throw new ReleaseGateError("A gate run is already in progress.", 409);
  }

  const [runRow] = deps.db
    .insert(gateRuns)
    .values({
      projectId,
      releaseVersion,
      headSha,
      status: "running",
      startedAt: new Date().toISOString(),
    })
    .returning()
    .all();

  const runId = runRow!.id;

  // Track run for shutdown and cancellation
  const pids = new Set<number>();
  const activeRecord: ActiveRunRecord = {
    projectId,
    worktreeDir: null,
    repoPath: project.localPath,
    pids,
    killAll: () => {
      for (const p of pids) {
        try {
          process.kill(-p, "SIGKILL");
        } catch {
          // ignore
        }
      }
      pids.clear();
    },
  };
  activeRuns.set(runId, activeRecord);

  // Background work
  void executeGateRun(deps, project, shaping, runId, headSha, activeRecord);

  return { runId };
}

type InternalFinding = {
  check: "secrets" | "dependencies" | "security-tests";
  fingerprint: string;
  severity: "critical" | "high" | "moderate" | "low";
  title: string;
  detail: string;
  location: string;
  blocking: boolean;
};

async function executeGateRun(
  deps: ReleaseGateDeps,
  project: typeof projects.$inferSelect,
  shaping: typeof shapingState.$inferSelect,
  runId: number,
  headSha: string,
  activeRecord: ActiveRunRecord,
): Promise<void> {
  const db = deps.db;
  const gitCmd = deps.execGit ?? execGit;
  const releaseVersion = shaping.activeMilestoneVersion!;
  const releaseBranch = shaping.activeMilestoneBranch!;
  const defaultBranch = project.defaultBranch || "main";
  const repoPath = project.localPath;

  const checks: GateRunChecks = {};
  const reportedFindings: InternalFinding[] = [];
  let unhandledError: string | null = null;
  let worktreeDir: string | null = null;

  try {
    // ----------------------------------------------------
    // CHECK 1: Secrets (no worktree)
    // ----------------------------------------------------
    try {
      const gitEnv = { ...REVIEW_GIT_ENV };

      // a) Release diff: <defaultBranch>...<releaseBranch>
      const diffArgs = buildReviewDiffArgs(["--unified=0"], `${defaultBranch}...${releaseBranch}`);
      const diffRes = await gitCmd(diffArgs, { cwd: repoPath, env: gitEnv });
      const diffHits = scanPatchAddedLinesForDetailedSecrets(diffRes.stdout);
      for (const hit of diffHits) {
        const fp = `secrets:${hit.ruleId}:${hit.file}:${hit.valueSha256}`;
        reportedFindings.push({
          check: "secrets",
          fingerprint: fp,
          severity: "critical",
          title: `Secret detected (${hit.ruleId}) in ${hit.file}`,
          detail: redact(`Rule '${hit.ruleId}' matched added content in ${hit.file}.`),
          location: `${hit.file}:${hit.line}`,
          blocking: true,
        });
      }

      // b) History: git log -p per commit in <defaultBranch>..<releaseBranch>
      const logArgs = buildReviewLogArgs([], `${defaultBranch}..${releaseBranch}`);
      const logRes = await gitCmd(logArgs, { cwd: repoPath, env: gitEnv });
      const historyHits = scanPatchAddedLinesForDetailedSecrets(logRes.stdout);
      for (const hit of historyHits) {
        const fp = `secrets:${hit.ruleId}:${hit.file}:${hit.valueSha256}`;
        const commitShort = hit.commit ? hit.commit.slice(0, 8) : "";
        reportedFindings.push({
          check: "secrets",
          fingerprint: fp,
          severity: "critical",
          title: `Secret detected (${hit.ruleId}) in history`,
          detail: redact(
            `Rule '${hit.ruleId}' matched added content in commit ${commitShort || "unknown"}.`,
          ),
          location: commitShort
            ? `${hit.file}:${hit.line} @ ${commitShort}`
            : `${hit.file}:${hit.line}`,
          blocking: true,
        });
      }

      const secretHits = reportedFindings.filter((f) => f.check === "secrets");
      if (secretHits.length > 0) {
        checks.secrets = {
          status: "fail",
          detail: `${secretHits.length} secret(s) found in diff or history`,
        };
      } else {
        checks.secrets = { status: "pass" };
      }
    } catch (err) {
      checks.secrets = {
        status: "error",
        detail: redact(err instanceof Error ? err.message : String(err)),
      };
    }

    // ----------------------------------------------------
    // Create detached worktree under <dataDir>/worktrees/gate-<projectId>-<runId>
    // ----------------------------------------------------
    worktreeDir = join(deps.dataDir, "worktrees", `gate-${project.id}-${runId}`);
    activeRecord.worktreeDir = worktreeDir;

    mkdirSync(dirname(worktreeDir), { recursive: true });
    await gitCmd(["worktree", "add", "--detach", "--", worktreeDir, headSha], {
      cwd: repoPath,
    });
    deps.onWorktreeCreated?.(worktreeDir);

    // ----------------------------------------------------
    // CHECK 2: Dependencies
    // ----------------------------------------------------
    try {
      const pnpmLockPath = join(worktreeDir, "pnpm-lock.yaml");
      const npmLockPath = join(worktreeDir, "package-lock.json");
      const hasPnpmLock = existsSync(pnpmLockPath);
      const hasNpmLock = existsSync(npmLockPath);

      if (!hasPnpmLock && !hasNpmLock) {
        checks.dependencies = {
          status: "not-applicable",
          detail: "No pnpm-lock.yaml or package-lock.json found",
        };
      } else {
        const cmd = hasPnpmLock ? "pnpm" : "npm";
        const args = ["audit", "--json", "--registry=https://registry.npmjs.org/"];
        const auditEnv = buildAuditEnv(process.env);
        const runner = deps.auditRunner ?? defaultAuditRunner;

        const auditRes = await runner(
          cmd,
          args,
          {
            cwd: worktreeDir,
            env: auditEnv,
            timeoutMs: 5 * 60 * 1000,
          },
          (pid) => activeRecord.pids.add(pid),
        );

        if (auditRes.timedOut) {
          checks.dependencies = {
            status: "error",
            detail: "Dependency audit timed out after 5 minutes",
          };
        } else if (!auditRes.stdout.trim()) {
          checks.dependencies = {
            status: "error",
            detail: redact(auditRes.stderr || "Audit command produced no output"),
          };
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(auditRes.stdout.trim());
          } catch {
            parsed = null;
          }

          if (parsed === null || typeof parsed !== "object") {
            checks.dependencies = {
              status: "error",
              detail: "Could not parse audit output as JSON",
            };
          } else {
            const rawFindings = parseAuditJson(parsed);
            for (const rf of rawFindings) {
              const fp = `dependencies:${rf.package}:${rf.advisoryId}`;
              reportedFindings.push({
                check: "dependencies",
                fingerprint: fp,
                severity: rf.severity,
                title: rf.title,
                detail: rf.detail,
                location: rf.location,
                blocking: rf.blocking,
              });
            }

            const depHits = reportedFindings.filter((f) => f.check === "dependencies");
            if (depHits.length > 0) {
              checks.dependencies = {
                status: "fail",
                detail: `${depHits.length} advisory/ies found`,
              };
            } else {
              checks.dependencies = { status: "pass" };
            }
          }
        }
      }
    } catch (err) {
      checks.dependencies = {
        status: "error",
        detail: redact(err instanceof Error ? err.message : String(err)),
      };
    }

    // ----------------------------------------------------
    // CHECK 3: Saved Security Tests
    // ----------------------------------------------------
    try {
      const tests = db
        .select()
        .from(securityTests)
        .where(eq(securityTests.projectId, project.id))
        .all();

      if (tests.length === 0) {
        checks.securityTests = { status: "not-applicable" };
      } else {
        let anyTestFailed = false;
        const testRunner = deps.testRunner ?? runCheck;

        for (const st of tests) {
          const filePath = join(worktreeDir, st.path);
          const shortHead = headSha.slice(0, 8);

          if (!existsSync(filePath)) {
            anyTestFailed = true;
            reportedFindings.push({
              check: "security-tests",
              fingerprint: `security-tests:${st.id}:tampered`,
              severity: "critical",
              title: `Security test tampered or missing: ${st.name}`,
              detail: `Test file '${st.path}' does not exist in release worktree.`,
              location: `${st.path} @ ${shortHead}`,
              blocking: true,
            });
            continue;
          }

          const fileContent = readFileSync(filePath);
          const currentHash = createHash("sha256").update(fileContent).digest("hex");
          if (currentHash !== st.sha256) {
            anyTestFailed = true;
            reportedFindings.push({
              check: "security-tests",
              fingerprint: `security-tests:${st.id}:tampered`,
              severity: "critical",
              title: `Security test tampered: ${st.name}`,
              detail: `Hash mismatch for '${st.path}'. Expected ${st.sha256}, got ${currentHash}.`,
              location: `${st.path} @ ${shortHead}`,
              blocking: true,
            });
            continue;
          }

          // Run command with /bin/sh -c
          const runRes = await testRunner(st.command, worktreeDir, {
            timeoutMs: 10 * 60 * 1000,
            onPid: (pid) => activeRecord.pids.add(pid),
          });

          if (!runRes.ok || runRes.exitCode !== 0) {
            anyTestFailed = true;
            const outputTail = redact(runRes.output).slice(-4000);
            reportedFindings.push({
              check: "security-tests",
              fingerprint: `security-tests:${st.id}:failed`,
              severity: "critical",
              title: `Security test failed: ${st.name}`,
              detail: outputTail || `Command failed with exit code ${runRes.exitCode}`,
              location: `${st.path} @ ${shortHead}`,
              blocking: true,
            });
          }
        }

        if (anyTestFailed) {
          checks.securityTests = { status: "fail", detail: "One or more saved security tests failed or tampered" };
        } else {
          checks.securityTests = { status: "pass" };
        }
      }
    } catch (err) {
      checks.securityTests = {
        status: "error",
        detail: redact(err instanceof Error ? err.message : String(err)),
      };
    }

    // ----------------------------------------------------
    // CHECK 4: Checklist
    // ----------------------------------------------------
    try {
      const profileItems = shipChecklist(project.profile);
      const ticks = db
        .select()
        .from(shipChecklistTicks)
        .where(
          and(
            eq(shipChecklistTicks.projectId, project.id),
            eq(shipChecklistTicks.releaseVersion, releaseVersion),
          ),
        )
        .all();

      const tickedIds = new Set(ticks.map((t) => t.itemId));
      const allTicked =
        profileItems.length > 0 && profileItems.every((item) => tickedIds.has(item.id));

      if (allTicked) {
        checks.checklist = { status: "pass" };
      } else {
        checks.checklist = {
          status: "fail",
          detail: `${tickedIds.size} of ${profileItems.length} checklist items completed`,
        };
      }
    } catch (err) {
      checks.checklist = {
        status: "error",
        detail: redact(err instanceof Error ? err.message : String(err)),
      };
    }

    // ----------------------------------------------------
    // UPSERT FINDINGS
    // ----------------------------------------------------
    // Deduplicate reported findings by fingerprint
    const uniqueReportedMap = new Map<string, InternalFinding>();
    for (const f of reportedFindings) {
      if (!uniqueReportedMap.has(f.fingerprint)) {
        uniqueReportedMap.set(f.fingerprint, f);
      }
    }
    const uniqueReported = Array.from(uniqueReportedMap.values());

    for (const f of uniqueReported) {
      const existing = db
        .select()
        .from(gateFindings)
        .where(
          and(
            eq(gateFindings.projectId, project.id),
            eq(gateFindings.releaseVersion, releaseVersion),
            eq(gateFindings.fingerprint, f.fingerprint),
          ),
        )
        .get();

      if (existing) {
        // Keep outcome, reason, fix_task_id; update last_seen_run_id and reopen if resolved
        db.update(gateFindings)
          .set({
            lastSeenRunId: runId,
            state: "open",
            title: f.title,
            detail: f.detail,
            location: f.location,
            severity: f.severity,
            blocking: f.blocking,
          })
          .where(eq(gateFindings.id, existing.id))
          .run();
      } else {
        db.insert(gateFindings)
          .values({
            projectId: project.id,
            releaseVersion,
            check: f.check,
            fingerprint: f.fingerprint,
            severity: f.severity,
            title: f.title,
            detail: f.detail,
            location: f.location,
            blocking: f.blocking,
            state: "open",
            firstSeenRunId: runId,
            lastSeenRunId: runId,
          })
          .run();
      }
    }

    // Resolve findings for checks that finished pass or fail
    const reportedFps = new Set(uniqueReported.map((f) => f.fingerprint));
    const checkNames: Array<"secrets" | "dependencies" | "security-tests"> = [
      "secrets",
      "dependencies",
      "security-tests",
    ];

    for (const cName of checkNames) {
      const cStatus: GateCheckStatus | undefined =
        cName === "secrets"
          ? checks.secrets?.status
          : cName === "dependencies"
            ? checks.dependencies?.status
            : checks.securityTests?.status;

      if (cStatus === "pass" || cStatus === "fail") {
        const openCheckFindings = db
          .select()
          .from(gateFindings)
          .where(
            and(
              eq(gateFindings.projectId, project.id),
              eq(gateFindings.releaseVersion, releaseVersion),
              eq(gateFindings.check, cName),
              eq(gateFindings.state, "open"),
            ),
          )
          .all();

        for (const o of openCheckFindings) {
          if (!reportedFps.has(o.fingerprint)) {
            db.update(gateFindings)
              .set({ state: "resolved" })
              .where(eq(gateFindings.id, o.id))
              .run();
          }
        }
      }
    }
  } catch (err) {
    unhandledError = err instanceof Error ? err.message : String(err);
  } finally {
    // ----------------------------------------------------
    // Cleanup worktree and finalize run row
    // ----------------------------------------------------
    if (worktreeDir && existsSync(worktreeDir)) {
      try {
        await gitCmd(["worktree", "remove", "--force", worktreeDir], {
          cwd: repoPath,
        });
      } catch {
        // ignore
      }
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    const runStatus = unhandledError ? "error" : "done";
    db.update(gateRuns)
      .set({
        status: runStatus,
        checks,
        error: unhandledError,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(gateRuns.id, runId))
      .run();

    activeRuns.delete(runId);
  }
}

/**
 * Decide an outcome for a gate finding (SPEC#Gate findings, ADR 0020).
 */
export async function decideFinding(
  db: DaedalusDb,
  projectId: number,
  findingId: number,
  input: {
    outcome: string;
    reason?: string;
    checkCommand?: string;
  },
): Promise<{
  finding: typeof gateFindings.$inferSelect;
  task?: typeof tasks.$inferSelect;
}> {
  const finding = db
    .select()
    .from(gateFindings)
    .where(and(eq(gateFindings.id, findingId), eq(gateFindings.projectId, projectId)))
    .get();

  if (!finding) {
    throw new ReleaseGateError(`Finding ${findingId} not found in project ${projectId}.`, 404);
  }

  const shaping = db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, projectId))
    .get();

  if (finding.releaseVersion !== shaping?.activeMilestoneVersion) {
    throw new ReleaseGateError("Only findings of the active release can be decided.", 409);
  }

  const outcome = input.outcome?.trim().toLowerCase();
  if (outcome !== "fix-task" && outcome !== "accept" && outcome !== "defer") {
    throw new ReleaseGateError("Outcome must be 'fix-task', 'accept', or 'defer'.", 400);
  }

  if (finding.blocking && (outcome === "accept" || outcome === "defer")) {
    throw new ReleaseGateError("Blocking findings accept only fix-task.", 400);
  }

  const now = new Date().toISOString();

  if (outcome === "accept" || outcome === "defer") {
    const reason = (input.reason ?? "").trim();
    if (reason.length < 10) {
      throw new ReleaseGateError("Reason must be at least 10 characters.", 400);
    }

    db.update(gateFindings)
      .set({
        outcome,
        reason: redact(reason),
        decidedAt: now,
      })
      .where(eq(gateFindings.id, finding.id))
      .run();

    const updated = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.id, finding.id))
      .get()!;

    return { finding: updated };
  }

  // outcome === "fix-task"
  if (finding.fixTaskId) {
    throw new ReleaseGateError("Finding already has a fix task.", 409);
  }

  const checkCommand = (input.checkCommand ?? "").trim();
  if (checkCommand.length === 0 || checkCommand.length > 500) {
    throw new ReleaseGateError("checkCommand must be non-empty and at most 500 characters.", 400);
  }

  // Allocate next free FIX-<n> code in project
  const existingTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();

  const usedNums = new Set<number>();
  for (const t of existingTasks) {
    const m = /^FIX-(\d+)$/i.exec(t.code);
    if (m) {
      usedNums.add(parseInt(m[1]!, 10));
    }
  }

  let nextN = 1;
  while (usedNums.has(nextN)) {
    nextN++;
  }
  const taskCode = `FIX-${nextN}`;

  const rawTitle = `Fix: ${finding.title}`;
  const taskTitle = rawTitle.length > 120 ? rawTitle.slice(0, 120) : rawTitle;

  const descLines = [
    `Finding: ${finding.title}`,
    `Check: ${finding.check}`,
    `Severity: ${finding.severity}`,
    `Location: ${finding.location || "unknown"}`,
    `Detail: ${finding.detail || ""}`,
  ];
  const taskDescription = redact(descLines.join("\n"));

  const activeMilestone = shaping.activeMilestoneCode ?? shaping.activeMilestoneVersion ?? "M1";

  const [newTask] = db
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

  db.update(gateFindings)
    .set({
      outcome: "fix-task",
      fixTaskId: newTask!.id,
      decidedAt: now,
    })
    .where(eq(gateFindings.id, finding.id))
    .run();

  const updatedFinding = db
    .select()
    .from(gateFindings)
    .where(eq(gateFindings.id, finding.id))
    .get()!;

  return { finding: updatedFinding, task: newTask };
}

/**
 * Toggle or set a ship checklist item (SPEC#Profiles, ADR 0020).
 */
export async function setChecklistItem(
  db: DaedalusDb,
  project: ProjectLike & { id: number },
  itemId: string,
  ticked: boolean,
): Promise<{ itemId: string; ticked: boolean }> {
  const allowedItems = shipChecklist(project.profile);
  const item = allowedItems.find((i) => i.id === itemId);
  if (!item) {
    throw new ReleaseGateError(`Unknown checklist item id '${itemId}'.`, 400);
  }

  const shaping = db
    .select()
    .from(shapingState)
    .where(eq(shapingState.projectId, project.id))
    .get();

  const releaseVersion = shaping?.activeMilestoneVersion;
  if (!releaseVersion) {
    throw new ReleaseGateError("No active release version for this project.", 409);
  }

  if (ticked) {
    const existing = db
      .select()
      .from(shipChecklistTicks)
      .where(
        and(
          eq(shipChecklistTicks.projectId, project.id),
          eq(shipChecklistTicks.releaseVersion, releaseVersion),
          eq(shipChecklistTicks.itemId, itemId),
        ),
      )
      .get();

    if (!existing) {
      db.insert(shipChecklistTicks)
        .values({
          projectId: project.id,
          releaseVersion,
          itemId,
          tickedAt: new Date().toISOString(),
        })
        .run();
    }
  } else {
    db.delete(shipChecklistTicks)
      .where(
        and(
          eq(shipChecklistTicks.projectId, project.id),
          eq(shipChecklistTicks.releaseVersion, releaseVersion),
          eq(shipChecklistTicks.itemId, itemId),
        ),
      )
      .run();
  }

  return { itemId, ticked };
}

/**
 * Server startup recovery: mark any 'running' gate runs as error ("server restarted").
 */
export function recoverGateRunsOnStartup(db: DaedalusDb): void {
  const runningRuns = db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.status, "running"))
    .all();

  const now = new Date().toISOString();
  for (const r of runningRuns) {
    db.update(gateRuns)
      .set({
        status: "error",
        error: "server restarted",
        finishedAt: now,
      })
      .where(eq(gateRuns.id, r.id))
      .run();
  }
}

/**
 * Server shutdown cleanup: stop child processes, remove gate worktrees, mark running as error ("server stopped").
 */
export async function stopAllGateRuns(db: DaedalusDb, dataDir: string): Promise<void> {
  for (const [, rec] of activeRuns) {
    rec.killAll();
    if (rec.worktreeDir && existsSync(rec.worktreeDir)) {
      try {
        await execGit(["worktree", "remove", "--force", rec.worktreeDir], {
          cwd: rec.repoPath,
        });
      } catch {
        // ignore
      }
      try {
        rmSync(rec.worktreeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  activeRuns.clear();

  const runningRuns = db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.status, "running"))
    .all();

  const now = new Date().toISOString();
  for (const r of runningRuns) {
    const worktreePath = join(dataDir, "worktrees", `gate-${r.projectId}-${r.id}`);
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    db.update(gateRuns)
      .set({
        status: "error",
        error: "server stopped",
        finishedAt: now,
      })
      .where(eq(gateRuns.id, r.id))
      .run();
  }
}
