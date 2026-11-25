import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  gateFindings,
  gateRuns,
  openDb,
  projects,
  providers,
  runs,
  securityTests,
  shapingState,
  tasks,
  type DaedalusDb,
  type GateRunChecks,
} from "@daedalus/db";
import {
  ackGate,
  approveTask,
  buildAuditEnv,
  decideFinding,
  getReleaseGate,
  getReview,
  parsePnpmWorkspacePackages,
  refreshVerifyStage,
  ReleaseGateError,
  setChecklistItem,
  startGateRun,
  syncPlanTasksToDb,
  type AuditRunner,
} from "../src/index.js";
import { shipChecklist } from "@daedalus/core/profiles";
import type { TaskState } from "@daedalus/core/task-state";
import { TaskRunner, type TaskRunnerSessions } from "../src/runner.js";
import { type ProviderEntry } from "@daedalus/providers";
import { execGit } from "@daedalus/git";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Release gate and automatic security checks (T6.3, SPEC#Release gate)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let projectRow: typeof projects.$inferSelect;
  let activeRunPromises: Promise<void>[] = [];

  beforeEach(() => {
    activeRunPromises = [];
    testDir = mkdtempSync(join(tmpdir(), "daedalus-gate-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));

    repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "Gate Tester");
    git(repoDir, "config", "user.email", "gate@example.com");

    writeFileSync(join(repoDir, "README.md"), "# Project\ninitial content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit");

    // Create release branch
    git(repoDir, "branch", "daedalus/release-v1.0", "main");

    const [proj] = db
      .insert(projects)
      .values({
        name: "Test Project",
        localPath: repoDir,
        profile: "work",
        defaultBranch: "main",
      })
      .returning()
      .all();
    projectRow = proj!;

    db.insert(providers)
      .values({
        name: "claude",
        kind: "cli",
        launchCommand: "echo",
        roles: ["coder"],
        allowedProfiles: ["work", "client", "personal"],
      })
      .run();

    db.insert(shapingState)
      .values({
        projectId: projectRow.id,
        activeMilestoneVersion: "v1.0",
        activeMilestoneCode: "M1",
        activeMilestoneBranch: "daedalus/release-v1.0",
        activeMilestoneStartedAt: new Date().toISOString(),
        activeMilestoneFrozen: true,
        activeMilestoneVerifyStartedAt: null,
      })
      .run();
  });

  afterEach(async () => {
    await Promise.allSettled(activeRunPromises);
    activeRunPromises = [];
    try {
      db.$client.close();
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("Verify starts only when every frozen task of the active milestone is done; approving the last task sets it", async () => {
    // Insert 2 frozen tasks for milestone M1: one done, one in-review
    const now = new Date().toISOString();
    db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.1",
        title: "Task 1",
        status: "done",
        milestoneCode: "M1",
        frozenAt: now,
      })
      .run();

    const [t12] = db.insert(tasks)
      .values({
        projectId: projectRow.id,
        code: "T1.2",
        title: "Task 2",
        status: "in-review",
        milestoneCode: "M1",
        frozenAt: now,
        branch: "daedalus/t1.2",
      })
      .returning()
      .all();

    const prov = db.select().from(providers).get()!;
    db.insert(runs)
      .values({
        taskId: t12!.id,
        providerId: prov.id,
        role: "implement",
        checkExitCode: 0,
        checkOutput: "ok",
        exitStatus: 0,
      })
      .run();

    // Verify stage should be null because T1.2 is not done
    const refreshedBefore = refreshVerifyStage(db, projectRow.id);
    expect(refreshedBefore).toBeNull();

    const gateBefore = await getReleaseGate(db, projectRow);
    expect(gateBefore.stage).toBe("build");
    expect(gateBefore.status).toBe("not-ready");

    // Checkout task branch in git and commit
    git(repoDir, "checkout", "-b", "daedalus/t1.2", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "feature.txt"), "done\n");
    git(repoDir, "add", "feature.txt");
    git(repoDir, "commit", "-m", "feature");
    git(repoDir, "checkout", "main");

    const headSha = git(repoDir, "rev-parse", "daedalus/t1.2");

    // Acknowledge any needs-ack gates (e.g. cross-review) so task can be approved
    const review = await getReview(db, projectRow, "T1.2");
    for (const gate of review.gates) {
      if (gate.status === "needs-ack") {
        await ackGate(
          db,
          projectRow,
          "T1.2",
          gate.id,
          "ack for test",
          headSha,
          gate.fingerprint,
        );
      }
    }

    // Approve the last task (T1.2)
    const approveResult = await approveTask(db, projectRow, "T1.2", headSha, {
      dataDir,
      transition: (s: TaskState) => ({ state: { ...s, status: "done" }, inbox: null }),
    });
    expect(approveResult.status).toBe("done");

    // Approving the last task must have set activeMilestoneVerifyStartedAt
    const shapingRow = db
      .select()
      .from(shapingState)
      .where(eq(shapingState.projectId, projectRow.id))
      .get();
    expect(shapingRow?.activeMilestoneVerifyStartedAt).toBeTruthy();

    const gateAfter = await getReleaseGate(db, projectRow);
    expect(gateAfter.stage).toBe("verify");
    expect(gateAfter.status).toBe("needs-run");
  });

  it("a secret added in one commit and removed in the next on the release branch → blocking finding from history; the stored row and API output never contain the secret value; gate blocked; it becomes a FIX task only", async () => {
    // Start verify stage
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const secretKey = "sk-ant-api03-historysecretkey1234567890abcdef";

    // Commit 1 on release branch adds the secret
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "secret.ts"), `export const KEY = "${secretKey}";\n`);
    git(repoDir, "add", "secret.ts");
    git(repoDir, "commit", "-m", "planted secret");

    // Commit 2 on release branch removes the secret file
    git(repoDir, "rm", "secret.ts");
    git(repoDir, "commit", "-m", "removed secret");
    git(repoDir, "checkout", "main");

    // Start gate run
    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;
    expect(runId).toBeGreaterThan(0);

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    // Finding must exist for the secret from history
    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();
    expect(findings.length).toBe(1);

    const f = findings[0]!;
    expect(f.check).toBe("secrets");
    expect(f.blocking).toBe(true);
    expect(f.severity).toBe("critical");
    expect(f.location).toContain("secret.ts");

    // Verify secret value is never in the stored DB row or API output
    const dbRowJson = JSON.stringify(f);
    expect(dbRowJson).not.toContain(secretKey);

    const gate = await getReleaseGate(db, projectRow);
    const gateJson = JSON.stringify(gate);
    expect(gateJson).not.toContain(secretKey);
    expect(gate.status).toBe("blocked");

    // Attempting to accept or defer a blocking finding must throw 400
    await expect(
      decideFinding(db, projectRow.id, f.id, {
        outcome: "accept",
        reason: "Valid business reason for 10+ characters",
      }),
    ).rejects.toThrow(ReleaseGateError);

    await expect(
      decideFinding(db, projectRow.id, f.id, {
        outcome: "defer",
        reason: "Valid business reason for 10+ characters",
      }),
    ).rejects.toThrow(ReleaseGateError);

    // It becomes a FIX task only
    const fixResult = await decideFinding(db, projectRow.id, f.id, {
      outcome: "fix-task",
      checkCommand: "pnpm test:secret",
    });
    expect(fixResult.task).toBeDefined();
    expect(fixResult.task?.code).toBe("FIX-1");
    expect(fixResult.task?.tag).toBe("claude");
    expect(fixResult.task?.status).toBe("queued");
    expect(fixResult.task?.checkCommand).toBe("pnpm test:secret");
  });

  it("the same secret in two commits → one finding", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const secretKey = "ghp_1111222233334444555566667777888899990000";

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "auth.ts"), `const token = "${secretKey}";\n`);
    git(repoDir, "add", "auth.ts");
    git(repoDir, "commit", "-m", "first commit with token");

    writeFileSync(join(repoDir, "auth.ts"), `// comment\nconst token = "${secretKey}";\n`);
    git(repoDir, "add", "auth.ts");
    git(repoDir, "commit", "-m", "second commit with same token");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();
    expect(findings.length).toBe(1);
  });

  it("dependency audit with a stub command runner (inject it): high → blocking; moderate → defer refused without a reason and with a 9-char reason, accepted with a 10+ char reason; gate needs-decision until then", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Create a dummy package-lock.json in release branch so audit is triggered
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package-lock.json"), "{}");
    git(repoDir, "add", "package-lock.json");
    git(repoDir, "commit", "-m", "add lockfile");
    git(repoDir, "checkout", "main");

    // Stub audit runner that reports a high finding and a moderate finding
    const stubRunner = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        vulnerabilities: {
          lodash: {
            name: "lodash",
            severity: "high",
            via: [
              {
                source: 1065,
                title: "Prototype Pollution in lodash",
                url: "https://github.com/advisories/GHSA-1065",
                severity: "high",
              },
            ],
            nodes: ["node_modules/lodash"],
          },
          minimist: {
            name: "minimist",
            severity: "moderate",
            via: [
              {
                source: 1066,
                title: "Prototype Pollution in minimist",
                url: "https://github.com/advisories/GHSA-1066",
                severity: "moderate",
              },
            ],
            nodes: ["node_modules/minimist"],
          },
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const { runId, promise } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const highFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, "dependencies:lodash:1065"),
        ),
      )
      .get();
    expect(highFinding).toBeDefined();
    expect(highFinding?.blocking).toBe(true);

    const modFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, "dependencies:minimist:1066"),
        ),
      )
      .get();
    expect(modFinding).toBeDefined();
    expect(modFinding?.blocking).toBe(false);

    // Resolve high finding via fix-task so we can test moderate outcome decisions
    await decideFinding(db, projectRow.id, highFinding!.id, {
      outcome: "fix-task",
      checkCommand: "pnpm audit",
    });

    // Gate should now be "needs-decision" because moderate is undecided
    const gateBefore = await getReleaseGate(db, projectRow);
    expect(gateBefore.status).toBe("needs-decision");

    // Defer without reason → 400
    await expect(
      decideFinding(db, projectRow.id, modFinding!.id, {
        outcome: "defer",
      }),
    ).rejects.toThrow("Reason must be at least 10 characters");

    // Defer with 9-char reason → 400
    await expect(
      decideFinding(db, projectRow.id, modFinding!.id, {
        outcome: "defer",
        reason: "123456789",
      }),
    ).rejects.toThrow("Reason must be at least 10 characters");

    // Defer with 10+ char reason → succeeds
    const decided = await decideFinding(db, projectRow.id, modFinding!.id, {
      outcome: "defer",
      reason: "Will patch in the next sprint",
    });
    expect(decided.finding.outcome).toBe("defer");
    expect(decided.finding.reason).toContain("Will patch");
  });

  it("unparseable audit output → check error, gate blocked, no findings resolved by that run", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package-lock.json"), "{}");
    git(repoDir, "add", "package-lock.json");
    git(repoDir, "commit", "-m", "add lockfile");
    git(repoDir, "checkout", "main");

    // Pre-insert an open finding
    const [existing] = db
      .insert(gateFindings)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        check: "dependencies",
        fingerprint: "dependencies:test:1",
        severity: "low",
        title: "Test finding",
        blocking: false,
        state: "open",
      })
      .returning()
      .all();

    const stubRunner = async () => ({
      exitCode: 1,
      stdout: "internal server error / broken json",
      stderr: "error",
      timedOut: false,
    });

    const { runId, promise } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("error");

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");

    // Pre-existing open finding must NOT be marked resolved because check errored
    const findingAfter = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.id, existing!.id))
      .get();
    expect(findingAfter?.state).toBe("open");
  });

  it("no lockfile → not-applicable", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("not-applicable");
  });

  it("the audit command gets the forced registry and no npm_config_* variables", async () => {
    const dirtyEnv = {
      PATH: "/usr/bin",
      npm_config_registry: "http://malicious-registry.local",
      NPM_CONFIG_FOO: "bar",
      COREPACK_ENABLE: "1",
      NORMAL_VAR: "kept",
    };
    const cleaned = buildAuditEnv(dirtyEnv);
    expect(cleaned.npm_config_registry).toBeUndefined();
    expect(cleaned.NPM_CONFIG_FOO).toBeUndefined();
    expect(cleaned.COREPACK_ENABLE).toBeUndefined();
    expect(cleaned.NORMAL_VAR).toBe("kept");
  });

  it("saved test: changed file hash → blocking tampered finding; failing command → blocking finding; passing → pass", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const testContent = "#!/bin/sh\nexit 0\n";
    const testHash = createHash("sha256").update(testContent).digest("hex");

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "sec-test.sh"), testContent);
    git(repoDir, "add", "sec-test.sh");
    git(repoDir, "commit", "-m", "add sec test");
    git(repoDir, "checkout", "main");

    // Case 1: Tampered file (stored hash differs from repo file)
    const [stRow] = db
      .insert(securityTests)
      .values({
        projectId: projectRow.id,
        name: "Security Probe",
        path: "sec-test.sh",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        command: "sh sec-test.sh",
      })
      .returning()
      .all();

    const run1 = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(run1.promise);
    await run1.promise;

    const tamperedFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, `security-tests:${stRow!.id}:tampered`),
        ),
      )
      .get();
    expect(tamperedFinding).toBeDefined();
    expect(tamperedFinding?.blocking).toBe(true);

    // Case 2: Correct hash, but command fails
    db.update(securityTests)
      .set({ sha256: testHash, command: "sh -c 'echo test-failed && exit 1'" })
      .where(eq(securityTests.id, stRow!.id))
      .run();

    const run2 = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(run2.promise);
    await run2.promise;

    const failedFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, `security-tests:${stRow!.id}:failed`),
        ),
      )
      .get();
    expect(failedFinding).toBeDefined();
    expect(failedFinding?.blocking).toBe(true);
    expect(failedFinding?.detail).toContain("test-failed");

    // Case 3: Passing test
    db.update(securityTests)
      .set({ command: "sh -c 'exit 0'" })
      .where(eq(securityTests.id, stRow!.id))
      .run();

    const run3 = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(run3.promise);
    await run3.promise;
    const r3 = db.select().from(gateRuns).where(eq(gateRuns.id, run3.runId)).get();

    const r3Checks = r3?.checks as GateRunChecks | null;
    expect(r3Checks?.securityTests?.status).toBe("pass");
  });

  it("rerun after the cause is gone → finding resolved; a new release-branch commit makes the run stale (needs-run)", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Plant secret on release branch
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "temp-secret.ts"), 'export const K = "sk-ant-12345678901234567890";\n');
    git(repoDir, "add", "temp-secret.ts");
    git(repoDir, "commit", "-m", "secret commit");
    git(repoDir, "checkout", "main");

    const run1 = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(run1.promise);
    await run1.promise;

    const finding = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all()[0]!;
    expect(finding.state).toBe("open");

    // Rewrite history so secret is gone
    git(repoDir, "checkout", "daedalus/release-v1.0");
    git(repoDir, "reset", "--hard", "HEAD~1");
    git(repoDir, "checkout", "main");

    // Rerun checks
    const run2 = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(run2.promise);
    await run2.promise;

    const findingResolved = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.id, finding.id))
      .get();
    expect(findingResolved?.state).toBe("resolved");

    // A new release-branch commit makes the run stale
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "new-file.txt"), "fresh\n");
    git(repoDir, "add", "new-file.txt");
    git(repoDir, "commit", "-m", "new commit");
    git(repoDir, "checkout", "main");

    const gateAfterNewCommit = await getReleaseGate(db, projectRow);
    expect(gateAfterNewCommit.status).toBe("needs-run");
  });

  it("fix task: created frozen in the active milestone with the owner's check, tag claude, FIX-1 then FIX-2; survives syncPlanTasksToDb; the runner accepts it", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const [f1] = db
      .insert(gateFindings)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        check: "dependencies",
        fingerprint: "dep:f1",
        severity: "high",
        title: "High Vuln 1",
        blocking: true,
        state: "open",
      })
      .returning()
      .all();

    const [f2] = db
      .insert(gateFindings)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        check: "dependencies",
        fingerprint: "dep:f2",
        severity: "critical",
        title: "Critical Vuln 2",
        blocking: true,
        state: "open",
      })
      .returning()
      .all();

    const fix1 = await decideFinding(db, projectRow.id, f1!.id, {
      outcome: "fix-task",
      checkCommand: "echo check-fix-1",
    });
    expect(fix1.task?.code).toBe("FIX-1");
    expect(fix1.task?.tag).toBe("claude");
    expect(fix1.task?.frozenAt).toBeTruthy();
    expect(fix1.task?.milestoneCode).toBe("M1");

    const fix2 = await decideFinding(db, projectRow.id, f2!.id, {
      outcome: "fix-task",
      checkCommand: "echo check-fix-2",
    });
    expect(fix2.task?.code).toBe("FIX-2");

    // Write a PLAN.md that does not contain FIX-1 or FIX-2
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial Release
Done when: all tasks pass.
- [ ] **T1.1 Initial Task** [claude]
  Initial implementation.
  check: echo pass
`,
    );

    // syncPlanTasksToDb: FIX-1 and FIX-2 survive unchanged
    const syncRes = syncPlanTasksToDb(db, projectRow.id, repoDir);
    const codes = syncRes.tasks.map((t) => t.code);
    expect(codes).toContain("FIX-1");
    expect(codes).toContain("FIX-2");

    const fix1InDb = db.select().from(tasks).where(eq(tasks.code, "FIX-1")).get();
    expect(fix1InDb).toBeDefined();
    expect(fix1InDb?.checkCommand).toBe("echo check-fix-1");

    // Task runner acceptance
    const providerEntry: ProviderEntry = {
      id: "claude",
      kind: "cli",
      command: "echo",
      args: [],
      roles: ["coder"],
      allowedProfiles: ["work", "client", "personal"],
      version: "1.0.0",
    };
    const sessions: TaskRunnerSessions = {
      start: async () => ({
        id: "fake-session",
        startedAt: new Date().toISOString(),
        prompt: async () => "end_turn",
        stop: async () => {},
      }),
      stopAll: async () => {},
    };
    const runner = new TaskRunner({
      db,
      dataDir,
      sessions,
      providers: [providerEntry],
      transition: (state, event) => ({
        state: {
          status: event.type === "start" ? "running" : "in-review",
          attempts: state.attempts,
        },
        inbox: null,
      }),
      checkTimeoutMs: 5000,
    });

    const runResult = await runner.runTask(projectRow.id, "FIX-1");
    expect(runResult.ok).toBe(true);
    expect(runResult.checkResult.exitCode).toBe(0);
    expect(runResult.status).toBe("in-review");
  });

  it("two startGateRun together → one 409", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const results = await Promise.allSettled([
      startGateRun({ db, dataDir }, projectRow.id),
      startGateRun({ db, dataDir }, projectRow.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const fulfilledResult = (
      fulfilled[0] as PromiseFulfilledResult<{ runId: number; promise: Promise<void> }>
    ).value;
    activeRunPromises.push(fulfilledResult.promise);
    await fulfilledResult.promise;

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(ReleaseGateError);
    expect(error.status).toBe(409);
  });

  it("checklist: unknown item id → 400; all ticked → checklist pass", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Work profile checklist items are: mr-opened, kollab-form, release-notes, deploy-owner
    await expect(
      setChecklistItem(db, projectRow.id, "non-existent-item", true),
    ).rejects.toThrow(ReleaseGateError);

    // Tick all valid items
    await setChecklistItem(db, projectRow.id, "mr-opened", true);
    await setChecklistItem(db, projectRow.id, "kollab-form", true);
    await setChecklistItem(db, projectRow.id, "release-notes", true);
    await setChecklistItem(db, projectRow.id, "deploy-owner", true);

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.checklist.every((i) => i.ticked)).toBe(true);
  });

  it("delete the release branch after a passing run → gate is not pass (blocked with unknown head)", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const items = shipChecklist(projectRow.profile);
    for (const item of items) {
      await setChecklistItem(db, projectRow.id, item.id, true);
    }

    const gatePassing = await getReleaseGate(db, projectRow);
    expect(gatePassing.status).toBe("pass");

    git(repoDir, "branch", "-D", "daedalus/release-v1.0");

    const gateAfterDelete = await getReleaseGate(db, projectRow);
    expect(gateAfterDelete.status).toBe("blocked");
    expect(gateAfterDelete.status).not.toBe("pass");
  });

  it("package.json with pnpm.auditConfig → dependencies check error", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        pnpm: {
          auditConfig: {
            ignoreCves: ["CVE-2023-1234"],
          },
        },
      }),
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", "package.json", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "add auditConfig and lockfile");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("error");
    expect(checks?.dependencies?.detail).toBe(
      "package.json pnpm.auditConfig is not allowed: the gate decides which advisories are accepted",
    );

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");
  });

  it("audit command receives --audit-level=low and --include=dev (for npm) and forced registry", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    let capturedCmd = "";
    let capturedArgs: string[] = [];
    const stubRunner: AuditRunner = async (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      return {
        exitCode: 0,
        stdout: JSON.stringify({ vulnerabilities: {} }),
        stderr: "",
        timedOut: false,
      };
    };

    // 1. With package-lock.json (npm)
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "package-lock.json"), "{}");
    git(repoDir, "add", "package-lock.json");
    git(repoDir, "commit", "-m", "add package-lock.json");
    git(repoDir, "checkout", "main");

    const { runId: runId1, promise: p1 } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(p1);
    await p1;

    expect(capturedCmd).toBe("npm");
    expect(capturedArgs).toContain("--audit-level=low");
    expect(capturedArgs).toContain("--include=dev");
    expect(capturedArgs).toContain("--registry=https://registry.npmjs.org/");
    expect(capturedArgs.some((a) => a.startsWith("--userconfig="))).toBe(true);

    // 2. With pnpm-lock.yaml (pnpm)
    git(repoDir, "checkout", "daedalus/release-v1.0");
    rmSync(join(repoDir, "package-lock.json"), { force: true });
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", "package-lock.json", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "switch to pnpm-lock.yaml");
    git(repoDir, "checkout", "main");

    const { runId: runId2, promise: p2 } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(p2);
    await p2;

    expect(runId1).toBeGreaterThan(0);
    expect(runId2).toBeGreaterThan(runId1);

    expect(capturedCmd).toBe("pnpm");
    expect(capturedArgs).toContain("--audit-level=low");
    expect(capturedArgs).not.toContain("--include=dev");
    expect(capturedArgs).toContain("--ignore-pnpmfile");
    expect(capturedArgs).toContain("--registry=https://registry.npmjs.org/");
    expect(capturedArgs.some((a) => a.startsWith("--userconfig="))).toBe(true);
  });

  it("dependency audit runner cwd has no .pnpmfile.cjs or .npmrc even when repo has them, and args include --ignore-pnpmfile and --userconfig", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Plant .pnpmfile.cjs and .npmrc in release branch
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, ".pnpmfile.cjs"), "throw new Error('pnpmfile executed');\n");
    writeFileSync(join(repoDir, ".npmrc"), "registry=http://malicious.local\n");
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "audit-test-pkg" }));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", ".pnpmfile.cjs", ".npmrc", "pnpm-workspace.yaml", "package.json", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "add config files and lockfile");
    git(repoDir, "checkout", "main");

    let capturedCwd = "";
    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    let cwdHasPnpmfile = true;
    let cwdHasNpmrc = true;
    let cwdHasPkgJson = false;
    let cwdHasLockfile = false;
    let cwdHasWorkspace = false;

    const stubRunner: AuditRunner = async (_cmd, args, opts) => {
      capturedCwd = opts.cwd;
      capturedArgs = [...args];
      capturedEnv = { ...opts.env };
      cwdHasPnpmfile = existsSync(join(opts.cwd, ".pnpmfile.cjs"));
      cwdHasNpmrc = existsSync(join(opts.cwd, ".npmrc"));
      cwdHasPkgJson = existsSync(join(opts.cwd, "package.json"));
      cwdHasLockfile = existsSync(join(opts.cwd, "pnpm-lock.yaml"));
      cwdHasWorkspace = existsSync(join(opts.cwd, "pnpm-workspace.yaml"));

      return {
        exitCode: 0,
        stdout: JSON.stringify({ advisories: {} }),
        stderr: "",
        timedOut: false,
      };
    };

    const { runId, promise } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    // Verify isolated directory properties
    expect(cwdHasPnpmfile).toBe(false);
    expect(cwdHasNpmrc).toBe(false);
    expect(cwdHasPkgJson).toBe(true);
    expect(cwdHasLockfile).toBe(true);
    expect(cwdHasWorkspace).toBe(true);

    // Verify flags
    expect(capturedArgs).toContain("--ignore-pnpmfile");
    const userConfigArg = capturedArgs.find((a) => a.startsWith("--userconfig="));
    expect(userConfigArg).toBeDefined();
    const emptyConfigPath = userConfigArg!.slice("--userconfig=".length);
    expect(capturedEnv.npm_config_globalconfig).toBe(emptyConfigPath);

    // Verify temp directory removed afterwards
    expect(existsSync(capturedCwd)).toBe(false);
  });

  it("secret introduced only in a merge commit resolution → blocking finding", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const secretKey = "ghp_MergeConflictSecret9999999999999999";

    // Base file on release branch
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "conflict-target.ts"), "export const value = 'base';\n");
    git(repoDir, "add", "conflict-target.ts");
    git(repoDir, "commit", "-m", "base commit on release");

    // Feature branch modifies conflict-target.ts
    git(repoDir, "checkout", "-b", "feat/conflict-branch");
    writeFileSync(join(repoDir, "conflict-target.ts"), "export const value = 'from-feature';\n");
    git(repoDir, "add", "conflict-target.ts");
    git(repoDir, "commit", "-m", "feature change");

    // Release branch also modifies conflict-target.ts
    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "conflict-target.ts"), "export const value = 'from-release';\n");
    git(repoDir, "add", "conflict-target.ts");
    git(repoDir, "commit", "-m", "release change");

    // Merge feature branch into release branch -> conflicts
    try {
      execFileSync("git", ["merge", "feat/conflict-branch"], { cwd: repoDir, stdio: "pipe" });
    } catch {
      // Conflict expected
    }

    // Resolve conflict by introducing a secret into conflict-target.ts
    writeFileSync(
      join(repoDir, "conflict-target.ts"),
      `export const value = 'resolved';\nconst token = "${secretKey}";\n`,
    );
    git(repoDir, "add", "conflict-target.ts");
    git(repoDir, "commit", "-m", "resolve conflict with secret");

    // Remove the secret in a follow-up commit so HEAD release diff has no secret;
    // secret exists only in the merge commit resolution!
    writeFileSync(
      join(repoDir, "conflict-target.ts"),
      "export const value = 'resolved-no-secret';\n",
    );
    git(repoDir, "add", "conflict-target.ts");
    git(repoDir, "commit", "-m", "remove secret from head");

    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();

    const secretFinding = findings.find((f) => f.check === "secrets");
    expect(secretFinding).toBeDefined();
    expect(secretFinding?.blocking).toBe(true);
    expect(secretFinding?.location).toContain("conflict-target.ts");

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");
  });

  it("pnpm-workspace.yaml with auditConfig and overrides → refusal", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\noverrides:\n  foo: '1.0.0'\nauditConfig:\n  ignoreCves:\n    - CVE-2023-1234\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", "pnpm-workspace.yaml", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "add workspace with auditConfig and overrides");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("error");
    expect(checks?.dependencies?.detail).toBe(
      "package.json pnpm.auditConfig is not allowed: the gate decides which advisories are accepted",
    );

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");
  });

  it("pnpm-workspace.yaml with only packages + catalog → audit folder copy has packages only", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n  - 'apps/*'\ncatalog:\n  react: 19.0.0\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", "pnpm-workspace.yaml", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "add workspace with packages and catalog");
    git(repoDir, "checkout", "main");

    let auditWorkspaceContent: string | null = null;
    const stubRunner: AuditRunner = async (_cmd, _args, opts) => {
      const wsPath = join(opts.cwd, "pnpm-workspace.yaml");
      if (existsSync(wsPath)) {
        auditWorkspaceContent = readFileSync(wsPath, "utf8");
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ vulnerabilities: {} }),
        stderr: "",
        timedOut: false,
      };
    };

    const { runId, promise } = await startGateRun(
      { db, dataDir, auditRunner: stubRunner },
      projectRow.id,
    );
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("pass");

    expect(auditWorkspaceContent).toBeTruthy();
    expect(auditWorkspaceContent).toContain("packages:");
    expect(auditWorkspaceContent).toContain("packages/*");
    expect(auditWorkspaceContent).toContain("apps/*");
    expect(auditWorkspaceContent).not.toContain("catalog");
    expect(auditWorkspaceContent).not.toContain("react");
  });

  it("pnpm-workspace.yaml that cannot be read unambiguously → dependencies check error", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      "packages:\n  invalid indentation or item\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repoDir, "add", "pnpm-workspace.yaml", "pnpm-lock.yaml");
    git(repoDir, "commit", "-m", "add ambiguous workspace");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("error");
    expect(checks?.dependencies?.detail).toBe(
      "pnpm-workspace.yaml packages list could not be read unambiguously",
    );

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");
  });

  it("parsePnpmWorkspacePackages strictly parses top-level packages list and rejects ambiguity", () => {
    // Valid standard with quotes, comments, trailing keys
    const validYaml = `---
# Top comment
packages:
  - "apps/*"
  - 'packages/*'
  - spikes # inline comment
catalog:
  react: 19.0.0
...`;
    expect(parsePnpmWorkspacePackages(validYaml)).toEqual([
      "apps/*",
      "packages/*",
      "spikes",
    ]);

    // Missing packages:
    expect(parsePnpmWorkspacePackages("catalog:\n  react: 19.0.0\n")).toBeNull();

    // Duplicate packages:
    const dup = `packages:
  - "apps/*"
packages:
  - "packages/*"`;
    expect(parsePnpmWorkspacePackages(dup)).toBeNull();

    // Ambiguous indented line under packages:
    const badIndent = `packages:
  - "apps/*"
  not-a-list-item`;
    expect(parsePnpmWorkspacePackages(badIndent)).toBeNull();

    // Empty packages:
    expect(parsePnpmWorkspacePackages("packages:\n")).toBeNull();
  });

  it("package.json as a symlink to a file outside → error, and the outside file's content appears nowhere in the run or findings", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Outside file with secret content
    const outsideSecret = "SUPER_SECRET_TOKEN_NEVER_LEAK_OUTSIDE_123456";
    const outsidePath = join(testDir, "outside-secret-file.json");
    writeFileSync(outsidePath, JSON.stringify({ secret: outsideSecret }));

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    symlinkSync(outsidePath, join(repoDir, "package.json"));
    git(repoDir, "add", "pnpm-lock.yaml", "package.json");
    git(repoDir, "commit", "-m", "symlink package.json outside");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    const checks = run?.checks as GateRunChecks | null;
    expect(checks?.dependencies?.status).toBe("error");
    expect(checks?.dependencies?.detail).toBe("package.json must be a regular file");

    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("blocked");

    // Outside secret content must appear nowhere in run row or findings
    const runJson = JSON.stringify(run);
    expect(runJson).not.toContain(outsideSecret);

    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();
    const findingsJson = JSON.stringify(findings);
    expect(findingsJson).not.toContain(outsideSecret);

    const gateJson = JSON.stringify(gate);
    expect(gateJson).not.toContain(outsideSecret);
  });

  it("release gate: a commit adding url with userinfo credential on release branch → a secrets finding with ruleId userinfo, stored finding does not contain secret", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const secretToken = "s3cr3tT0ken9x";
    const secretLine = `url = "https://bob:${secretToken}@example.com/repo.git"\n`;

    git(repoDir, "checkout", "daedalus/release-v1.0");
    writeFileSync(join(repoDir, "remote.cfg"), secretLine);
    git(repoDir, "add", "remote.cfg");
    git(repoDir, "commit", "-m", "add remote with userinfo");
    git(repoDir, "checkout", "main");

    const { runId, promise } = await startGateRun({ db, dataDir }, projectRow.id);
    activeRunPromises.push(promise);
    await promise;

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();
    expect(findings.length).toBe(1);

    const f = findings[0]!;
    expect(f.check).toBe("secrets");
    expect(f.blocking).toBe(true);
    expect(f.detail).toContain("userinfo");

    const findingJson = JSON.stringify(f);
    expect(findingJson).not.toContain(secretToken);
  });

  it("inject execGit so a commit with a planted secret lands on release branch after the run resolves its SHAs → run does not report it and gate is marked stale for new head", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    let commitPlanted = false;
    const realExecGit = execGit;

    // Injected execGit that plants a commit with a secret on release branch after SHAs are resolved
    const injectedExecGit: typeof execGit = async (args, opts) => {
      // Check if we are inside executeGateRun (e.g. diff, log, or worktree) and haven't planted yet
      if (!commitPlanted && (args.includes("diff") || args.includes("log") || args.includes("worktree"))) {
        commitPlanted = true;
        // Make a commit directly on daedalus/release-v1.0
        git(repoDir, "checkout", "daedalus/release-v1.0");
        writeFileSync(join(repoDir, "mid-run-secret.ts"), 'export const K = "sk-ant-api03-midrunsecretkey1234567890abcdef";\n');
        git(repoDir, "add", "mid-run-secret.ts");
        git(repoDir, "commit", "-m", "planted secret mid-run");
        git(repoDir, "checkout", "main");
      }
      return realExecGit(args, opts);
    };

    const { runId, promise } = await startGateRun(
      { db, dataDir, execGit: injectedExecGit },
      projectRow.id,
    );
    activeRunPromises.push(promise);
    await promise;

    expect(commitPlanted).toBe(true);

    const run = db.select().from(gateRuns).where(eq(gateRuns.id, runId)).get();
    expect(run?.status).toBe("done");

    // Because the run scanned the pinned range (resolved before the new commit landed),
    // it does NOT report the mid-run secret finding!
    const findings = db
      .select()
      .from(gateFindings)
      .where(eq(gateFindings.projectId, projectRow.id))
      .all();
    expect(findings.length).toBe(0);

    // And the gate is marked stale (needs-run) for the new head!
    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("needs-run");
  });

  it("unresolvable default branch fails closed: gate blocked and startGateRun throws 400", async () => {
    // Update existing project to have a non-existent default branch
    db.update(projects)
      .set({ defaultBranch: "non-existent-default-branch" })
      .where(eq(projects.id, projectRow.id))
      .run();

    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const brokenProj = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectRow.id))
      .get()!;

    const gate = await getReleaseGate(db, brokenProj);
    expect(gate.status).toBe("blocked");
    expect(gate.blockedReason).toContain("Could not resolve head for default branch non-existent-default-branch");

    await expect(startGateRun({ db, dataDir }, brokenProj.id)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Could not resolve head for default branch non-existent-default-branch"),
    });
  });

  it("a done run row with defaultSha null counts as stale (needs-run) and fails closed", async () => {
    db.update(shapingState)
      .set({ activeMilestoneVerifyStartedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const releaseHeadSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    // Insert a completed run row with defaultSha null
    db.insert(gateRuns)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha: releaseHeadSha,
        defaultSha: null,
        status: "done",
        checks: {
          secrets: { status: "pass" },
          dependencies: { status: "pass" },
          securityTests: { status: "not-applicable" },
          checklist: { status: "pass" },
        },
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      })
      .run();

    // With defaultSha null, the run must be treated as stale (needs-run) rather than passing
    const gate = await getReleaseGate(db, projectRow);
    expect(gate.status).toBe("needs-run");

    // And if current default branch head is unresolvable, gate fails closed with blocked
    db.update(projects)
      .set({ defaultBranch: "missing-default-branch" })
      .where(eq(projects.id, projectRow.id))
      .run();

    const updatedProj = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectRow.id))
      .get()!;

    const brokenGate = await getReleaseGate(db, updatedProj);
    expect(brokenGate.status).toBe("blocked");
    expect(brokenGate.blockedReason).toContain("Could not resolve head for default branch missing-default-branch");
  });
});
