import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chromium, type Page } from "playwright";
import {
  gateFindings,
  gateRuns,
  openDb,
  projects,
  providers,
  shapingState,
  uatItems,
  uatMarks,
  uatReplayRuns,
  uatScripts,
  type DaedalusDb,
} from "@daedalus/db";
import {
  defaultUatReplayRunner,
  getReleaseGate,
  getUatReplayResults,
  getUatState,
  listUatScripts,
  markUatItem,
  parsePlaywrightJsonReport,
  recoverUatSessionsOnStartup,
  resolveUatRecordingPath,
  retireUatScript,
  rewriteScriptOrigin,
  setChecklistItem,
  setUatAppConfig,
  startScriptRecording,
  startUatSession,
  stopAllUatSessions,
  stopUatSession,
  UatError,
  type UatBrowserLauncher,
  type UatCodegenRunner,
  type UatPortProbe,
  type UatProcessRunner,
  type UatReplayRunner,
  type UatUrlProbe,
} from "../src/index.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const VALID_SCRIPT = `import { test, expect } from '@playwright/test';

test('home loads', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/');
  await expect(page).toHaveURL(/127\\.0\\.0\\.1/);
});
`;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeFakeSessionDeps(
  db: DaedalusDb,
  dataDir: string,
  overrides?: {
    codegenRunner?: UatCodegenRunner;
    replayRunner?: UatReplayRunner;
    processRunner?: UatProcessRunner;
    browserLauncher?: UatBrowserLauncher;
  },
) {
  const processRunner: UatProcessRunner =
    overrides?.processRunner ??
    (async () => ({
      pid: 11111,
      kill: () => {},
    }));
  const urlProbe: UatUrlProbe = async () => true;
  const portProbe: UatPortProbe = async () => false;
  const browserLauncher: UatBrowserLauncher =
    overrides?.browserLauncher ??
    (async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({
            goto: async () => null,
            screenshot: async () => Buffer.from(""),
          }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    }));

  return {
    db,
    dataDir,
    processRunner,
    urlProbe,
    portProbe,
    browserLauncher,
    codegenRunner: overrides?.codegenRunner,
    replayRunner: overrides?.replayRunner,
  };
}

describe("Saved UAT scripts and replay (T6.5, ADR 0024)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let projectRow: typeof projects.$inferSelect;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-uat-scripts-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));

    repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "UAT Scripts Tester");
    git(repoDir, "config", "user.email", "uat-scripts@example.com");

    writeFileSync(join(repoDir, "README.md"), "# Project\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit");
    git(repoDir, "branch", "daedalus/release-v1.0", "main");
    git(repoDir, "branch", "daedalus/release-v1.1", "main");

    const [proj] = db
      .insert(projects)
      .values({
        name: "Scripts Test Project",
        localPath: repoDir,
        profile: "personal",
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
        activeMilestoneVerifyStartedAt: new Date().toISOString(),
      })
      .run();

    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev --port 5173",
      appUrl: "http://127.0.0.1:5173",
    });
  });

  afterEach(async () => {
    await stopAllUatSessions(db, dataDir);
    db.$client.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("draft saved on codegen exit, replaces item draft, and refuses second record with 409", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "User can view home page",
        source: "plan",
      })
      .returning()
      .all();

    let resolveFirst!: (res: { exitCode: number }) => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((r) => {
      firstStarted = r;
    });

    const deps = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ outputFile }) => {
        writeFileSync(outputFile, VALID_SCRIPT, "utf8");
        firstStarted();
        return new Promise((r) => {
          resolveFirst = r;
        });
      },
    });

    // Without running session -> 409
    await expect(startScriptRecording(deps, projectRow.id, item!.id)).rejects.toMatchObject({
      status: 409,
    });

    await startUatSession(deps, projectRow.id);

    const rec1 = await startScriptRecording(deps, projectRow.id, item!.id);
    await firstStartedPromise;
    expect(rec1.recording.active).toBe(true);
    expect(rec1.recording.itemId).toBe(item!.id);

    // Second record while first is running -> 409
    await expect(startScriptRecording(deps, projectRow.id, item!.id)).rejects.toMatchObject({
      status: 409,
    });

    resolveFirst({ exitCode: 0 });
    const draft1 = await rec1.promise;
    expect(draft1.status).toBe("draft");
    expect(draft1.sha256).toBe(sha256(VALID_SCRIPT));
    expect(draft1.recordedOrigin).toBe("http://127.0.0.1:5173");

    // Recording again replaces the item's draft
    const updatedScript = VALID_SCRIPT.replace("home loads", "home loads v2");
    const deps2 = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ outputFile }) => {
        writeFileSync(outputFile, updatedScript, "utf8");
        return { exitCode: 0 };
      },
    });
    const rec2 = await startScriptRecording(deps2, projectRow.id, item!.id);
    const draft2 = await rec2.promise;

    const allDrafts = db
      .select()
      .from(uatScripts)
      .where(and(eq(uatScripts.projectId, projectRow.id), eq(uatScripts.status, "draft")))
      .all();
    expect(allDrafts.length).toBe(1);
    expect(allDrafts[0]!.id).toBe(draft2.id);
    expect(allDrafts[0]!.scriptText).toContain("home loads v2");
  });

  it("rejects invalid recorded files (empty, too big, invalid UTF-8, no @playwright/test, no test()", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "Validation check",
        source: "plan",
      })
      .returning()
      .all();

    const baseDeps = makeFakeSessionDeps(db, dataDir);
    await startUatSession(baseDeps, projectRow.id);

    const cases: Array<{ label: string; write: (p: string) => void; msg: string }> = [
      {
        label: "empty",
        write: (p) => writeFileSync(p, "   \n", "utf8"),
        msg: "empty",
      },
      {
        label: "too big",
        write: (p) =>
          writeFileSync(
            p,
            `import { test } from '@playwright/test';\ntest('x', () => {});\n// ${"a".repeat(256 * 1024)}`,
            "utf8",
          ),
        msg: "256 KiB",
      },
      {
        label: "invalid utf-8",
        write: (p) => writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00, 0x80])),
        msg: "UTF-8",
      },
      {
        label: "no @playwright/test",
        write: (p) => writeFileSync(p, "test('foo', async () => {});", "utf8"),
        msg: "@playwright/test",
      },
      {
        label: "no test(",
        write: (p) => writeFileSync(p, "import { expect } from '@playwright/test';", "utf8"),
        msg: "test(",
      },
    ];

    for (const c of cases) {
      const deps = makeFakeSessionDeps(db, dataDir, {
        codegenRunner: async ({ outputFile }) => {
          c.write(outputFile);
          return { exitCode: 0 };
        },
      });
      const rec = await startScriptRecording(deps, projectRow.id, item!.id);
      await expect(rec.promise, c.label).rejects.toThrow(c.msg);
    }

    const drafts = db
      .select()
      .from(uatScripts)
      .where(eq(uatScripts.projectId, projectRow.id))
      .all();
    expect(drafts.length).toBe(0);
  });

  it("pass promotes draft in the same transaction and rolls back both on failure; unaccepted drafts deleted on Stop", async () => {
    const [item1] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "Item 1",
        source: "plan",
      })
      .returning()
      .all();
    const [item2] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 2,
        text: "Item 2",
        source: "plan",
      })
      .returning()
      .all();

    const deps = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ outputFile }) => {
        writeFileSync(outputFile, VALID_SCRIPT, "utf8");
        return { exitCode: 0 };
      },
    });
    await startUatSession(deps, projectRow.id);

    const rec1 = await startScriptRecording(deps, projectRow.id, item1!.id);
    const draft1 = await rec1.promise;

    const rec2 = await startScriptRecording(deps, projectRow.id, item2!.id);
    const draft2 = await rec2.promise;

    const headSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    // Verify transactional rollback if DB trigger fails during pass promotion
    db.$client.exec(`
      CREATE TRIGGER fail_promote_test BEFORE UPDATE ON uat_scripts
      WHEN NEW.status = 'active' AND NEW.id = ${draft1.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced promotion failure');
      END;
    `);

    await expect(
      markUatItem(deps, projectRow.id, item1!.id, { result: "pass", headSha }),
    ).rejects.toThrow("forced promotion failure");

    // Neither mark nor active script was committed
    const marksAfterFail = db.select().from(uatMarks).where(eq(uatMarks.itemId, item1!.id)).all();
    expect(marksAfterFail.length).toBe(0);
    const scriptAfterFail = db.select().from(uatScripts).where(eq(uatScripts.id, draft1.id)).get();
    expect(scriptAfterFail?.status).toBe("draft");

    db.$client.exec("DROP TRIGGER fail_promote_test;");

    // Real pass promotes draft1 to active
    await markUatItem(deps, projectRow.id, item1!.id, { result: "pass", headSha });
    const script1Active = db.select().from(uatScripts).where(eq(uatScripts.id, draft1.id)).get();
    expect(script1Active?.status).toBe("active");

    // Stop session deletes unaccepted draft2 but keeps active script1
    await stopUatSession(deps, projectRow.id);
    const remaining = db.select().from(uatScripts).where(eq(uatScripts.projectId, projectRow.id)).all();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe(draft1.id);
    expect(remaining[0]!.status).toBe("active");
    expect(db.select().from(uatScripts).where(eq(uatScripts.id, draft2.id)).get()).toBeUndefined();
  });

  it("refuses marks (409) before session replay finishes", async () => {
    const headSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    // Seed an earlier-release v0.9 active script
    db.insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Old feature",
        releaseVersion: "v0.9",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .run();

    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "New feature",
        source: "plan",
      })
      .returning()
      .all();

    let replayEntered!: () => void;
    const replayEnteredPromise = new Promise<void>((r) => {
      replayEntered = r;
    });
    let resolveReplay!: (out: {
      status: "passed";
      results: Array<{ scriptId: number; status: "passed" }>;
    }) => void;

    const deps = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async ({ scripts }) => {
        replayEntered();
        return new Promise((r) => {
          resolveReplay = (res) =>
            r({
              status: res.status,
              results: scripts.map((s) => ({ scriptId: s.id, status: "passed" })),
            });
        });
      },
    });

    const startPromise = startUatSession(deps, projectRow.id);
    await replayEnteredPromise;

    // Marking while replay is still in progress -> 409
    await expect(
      markUatItem(deps, projectRow.id, item!.id, { result: "pass", headSha }),
    ).rejects.toMatchObject({ status: 409 });

    resolveReplay({ status: "passed", results: [] });
    await startPromise;

    // Marking after replay finishes succeeds
    const marked = await markUatItem(deps, projectRow.id, item!.id, {
      result: "pass",
      headSha,
    });
    expect(marked.mark.result).toBe("pass");
  });

  it("replays only earlier-release active scripts, detects sha256 mismatch, and fails closed on missing/partial report", async () => {
    // Switch active milestone to v1.1
    const headShaV11 = git(repoDir, "rev-parse", "daedalus/release-v1.1");
    db.update(shapingState)
      .set({
        activeMilestoneVersion: "v1.1",
        activeMilestoneCode: "M2",
        activeMilestoneBranch: "daedalus/release-v1.1",
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // 1. Active script from earlier release v1.0 -> SHOULD replay
    const [earlierActive] = db
      .insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Earlier active",
        releaseVersion: "v1.0",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .returning()
      .all();

    // 2. Retired script from earlier release v1.0 -> should NOT replay
    db.insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Earlier retired",
        releaseVersion: "v1.0",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "retired",
        retiredReason: "No longer applicable",
      })
      .run();

    // 3. Active script recorded in current release v1.1 -> should NOT replay
    db.insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Current release active",
        releaseVersion: "v1.1",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: headShaV11,
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .run();

    const seenIds: number[] = [];
    const depsPass = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async ({ scripts }) => {
        for (const s of scripts) seenIds.push(s.id);
        return {
          status: "passed",
          results: scripts.map((s) => ({ scriptId: s.id, status: "passed" })),
        };
      },
    });

    await startUatSession(depsPass, projectRow.id);
    expect(seenIds).toEqual([earlierActive!.id]);
    await stopUatSession(depsPass, projectRow.id);

    // Report missing script -> error (never pass)
    const depsMissingFromReport = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async () => ({
        status: "passed",
        results: [], // omitted earlierActive!
      }),
    });
    await startUatSession(depsMissingFromReport, projectRow.id);
    const missingRun = getUatReplayResults(depsMissingFromReport, projectRow.id);
    expect(missingRun.latestRun?.status).toBe("error");
    expect(missingRun.results[0]?.status).toBe("error");
    await stopUatSession(depsMissingFromReport, projectRow.id);

    // Strict JSON report parser fails closed on missing/partial/skipped/error reports
    const badNull = parsePlaywrightJsonReport(null, [{ id: 1, fileName: "s1.spec.ts" }], {
      replayDir: testDir,
      sessionFolder: testDir,
      exitCode: 0,
    });
    expect(badNull.status).toBe("error");

    const missingSpec = parsePlaywrightJsonReport(
      {
        suites: [
          {
            file: "s1.spec.ts",
            specs: [
              {
                file: "s1.spec.ts",
                ok: true,
                tests: [{ status: "expected", results: [{ status: "passed", duration: 5 }] }],
              },
            ],
          },
        ],
        errors: [],
        stats: { startTime: "", duration: 5, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
      },
      [
        { id: 1, fileName: "s1.spec.ts" },
        { id: 2, fileName: "s2.spec.ts" },
      ],
      { replayDir: testDir, sessionFolder: testDir, exitCode: 0 },
    );
    expect(missingSpec.status).toBe("error");
    expect(missingSpec.results.find((r) => r.scriptId === 2)?.status).toBe("error");

    const skippedSpec = parsePlaywrightJsonReport(
      {
        suites: [
          {
            file: "s1.spec.ts",
            specs: [
              {
                file: "s1.spec.ts",
                ok: true,
                tests: [{ status: "skipped", results: [] }],
              },
            ],
          },
        ],
        errors: [],
        stats: { startTime: "", duration: 1, expected: 0, unexpected: 0, flaky: 0, skipped: 1 },
      },
      [{ id: 1, fileName: "s1.spec.ts" }],
      { replayDir: testDir, sessionFolder: testDir, exitCode: 0 },
    );
    expect(skippedSpec.status).toBe("error");

    // Default runner with syntax-error script (cannot produce valid test run) -> error (never pass)
    const badSyntaxScript = "import { test } from '@playwright/test';\nconst broken = (;\n";
    const fakeReplayDir = join(testDir, "missing-report-replay");
    const defaultResultSyntaxErr = await defaultUatReplayRunner({
      replayDir: fakeReplayDir,
      sessionFolder: join(testDir, "sess"),
      currentOrigin: "http://127.0.0.1:5173",
      scripts: [
        {
          id: earlierActive!.id,
          itemText: earlierActive!.itemText,
          releaseVersion: earlierActive!.releaseVersion,
          recordedOrigin: earlierActive!.recordedOrigin,
          rawScriptText: badSyntaxScript,
          rewrittenScriptText: badSyntaxScript,
          sha256: sha256(badSyntaxScript),
        },
      ],
      timeoutMs: 30_000,
      env: process.env,
    });
    expect(defaultResultSyntaxErr.status).toBe("error");

    // Tampered sha256 -> error before replayRunner is ever called
    db.update(uatScripts)
      .set({ scriptText: `${VALID_SCRIPT}\n// tampered` })
      .where(eq(uatScripts.id, earlierActive!.id))
      .run();

    let runnerCalled = false;
    const depsTampered = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async () => {
        runnerCalled = true;
        return { status: "passed", results: [] };
      },
    });
    await startUatSession(depsTampered, projectRow.id);
    expect(runnerCalled).toBe(false);
    const tamperedRun = getUatReplayResults(depsTampered, projectRow.id);
    expect(tamperedRun.latestRun?.status).toBe("error");
    expect(tamperedRun.latestRun?.error).toContain("sha256 mismatch");
  });

  it("replay failure creates one deduped redacted blocking finding and blocks Ship; passing allows Ship", async () => {
    const headShaV11 = git(repoDir, "rev-parse", "daedalus/release-v1.1");
    const defaultSha = git(repoDir, "rev-parse", "main");

    db.update(shapingState)
      .set({
        activeMilestoneVersion: "v1.1",
        activeMilestoneCode: "M2",
        activeMilestoneBranch: "daedalus/release-v1.1",
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Seed clean gate_runs and checklist ticks so only UAT replay decides Ship
    db.insert(gateRuns)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.1",
        headSha: headShaV11,
        defaultSha,
        status: "done",
        checks: {
          secrets: { status: "pass" },
          dependencies: { status: "pass" },
          securityTests: { status: "pass" },
          checklist: { status: "pass" },
        },
      })
      .run();

    await setChecklistItem(db, projectRow.id, "release-notes", true);
    await setChecklistItem(db, projectRow.id, "changelog-reviewed", true);

    const [itemV11] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.1",
        position: 1,
        text: "v1.1 item",
        source: "plan",
      })
      .returning()
      .all();
    await markUatItem({ db, dataDir }, projectRow.id, itemV11!.id, {
      result: "pass",
      headSha: headShaV11,
    });

    // Gate passes when there are NO active earlier-release scripts
    const gateNoScripts = await getReleaseGate(db, projectRow, { dataDir });
    expect(gateNoScripts.status).toBe("pass");

    // Add an earlier-release active script
    const [oldScript] = db
      .insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Checkout flow",
        releaseVersion: "v1.0",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .returning()
      .all();

    // Before replay runs, Ship is blocked
    const gatePending = await getReleaseGate(db, projectRow, { dataDir });
    expect(gatePending.status).toBe("blocked");

    // Replay fails with a secret in failure output -> redacted, blocking finding created
    const leakedSecret = "sk-ant-api03-secretvalue1234567890abcdef";
    const depsFail = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async () => ({
        status: "failed",
        results: [
          {
            scriptId: oldScript!.id,
            status: "failed",
            detail: `Expected visible failed token=${leakedSecret}`,
          },
        ],
      }),
    });

    await startUatSession(depsFail, projectRow.id);
    await stopUatSession(depsFail, projectRow.id);

    // Re-run and fail again -> deduped to ONE finding
    await startUatSession(depsFail, projectRow.id);
    await stopUatSession(depsFail, projectRow.id);

    const findings = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.releaseVersion, "v1.1"),
          eq(gateFindings.check, "uat"),
        ),
      )
      .all();
    expect(findings.length).toBe(1);
    expect(findings[0]!.blocking).toBe(true);
    expect(findings[0]!.title).toContain("Checkout flow");
    expect(findings[0]!.title).toContain("v1.0");
    expect(findings[0]!.detail).not.toContain(leakedSecret);
    expect(findings[0]!.detail).toContain("[REDACTED:");

    const gateBlocked = await getReleaseGate(db, projectRow, { dataDir });
    expect(gateBlocked.status).toBe("blocked");

    // Next replay passes -> finding resolved and gate passes
    const depsPass = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async () => ({
        status: "passed",
        results: [{ scriptId: oldScript!.id, status: "passed" }],
      }),
    });
    await startUatSession(depsPass, projectRow.id);
    await stopUatSession(depsPass, projectRow.id);

    const gatePassed = await getReleaseGate(db, projectRow, { dataDir });
    expect(gatePassed.status).toBe("pass");
  });

  it("replace keeps old active if new script fails; retires old and resolves finding in one transaction if new script passes", async () => {
    db.update(shapingState)
      .set({
        activeMilestoneVersion: "v1.1",
        activeMilestoneCode: "M2",
        activeMilestoneBranch: "daedalus/release-v1.1",
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    const [oldScript] = db
      .insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Updated login button",
        releaseVersion: "v1.0",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .returning()
      .all();

    // Fail old script in replay to open a blocking finding
    const depsFailOld = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async () => ({
        status: "failed",
        results: [{ scriptId: oldScript!.id, status: "failed", detail: "Button label changed" }],
      }),
    });
    await startUatSession(depsFailOld, projectRow.id);

    // Case A: replacement fails immediate replay -> old script stays active & finding stays open
    const newScriptText = VALID_SCRIPT.replace("home loads", "login v2");
    const depsReplaceFail = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ outputFile }) => {
        writeFileSync(outputFile, newScriptText, "utf8");
        return { exitCode: 0 };
      },
      replayRunner: async ({ scripts }) => ({
        status: "failed",
        results: scripts.map((s) => ({
          scriptId: s.id,
          status: "failed",
          detail: "Still failing",
        })),
      }),
    });

    const repFail = await startScriptRecording(depsReplaceFail, projectRow.id, {
      replaceScriptId: oldScript!.id,
      reason: "Button renamed intentionally",
    });
    await expect(repFail.promise).rejects.toThrow("did not pass replay");

    const oldStillActive = db.select().from(uatScripts).where(eq(uatScripts.id, oldScript!.id)).get();
    expect(oldStillActive?.status).toBe("active");
    const openFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, `uat:script:${oldScript!.id}`),
        ),
      )
      .get();
    expect(openFinding?.state).toBe("open");

    // Case B: replacement passes immediate replay -> old retired, replacedBy set, finding resolved
    const depsReplacePass = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ outputFile }) => {
        writeFileSync(outputFile, newScriptText, "utf8");
        return { exitCode: 0 };
      },
      replayRunner: async ({ scripts }) => ({
        status: "passed",
        results: scripts.map((s) => ({ scriptId: s.id, status: "passed" })),
      }),
    });

    const repPass = await startScriptRecording(depsReplacePass, projectRow.id, {
      replaceScriptId: oldScript!.id,
      reason: "Button renamed to Sign in",
    });
    const newActive = await repPass.promise;
    expect(newActive.status).toBe("active");

    const oldRetired = db.select().from(uatScripts).where(eq(uatScripts.id, oldScript!.id)).get();
    expect(oldRetired?.status).toBe("retired");
    expect(oldRetired?.retiredReason).toBe("Button renamed to Sign in");
    expect(oldRetired?.replacedBy).toBe(newActive.id);

    const resolvedFinding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, `uat:script:${oldScript!.id}`),
        ),
      )
      .get();
    expect(resolvedFinding?.state).toBe("resolved");
    expect(resolvedFinding?.reason).toBe("Button renamed to Sign in");
  });

  it("retire requires 1-500 char reason and resolves open finding", async () => {
    const [script] = db
      .insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Legacy export",
        releaseVersion: "v0.9",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "oldsha",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .returning()
      .all();

    db.insert(gateFindings)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        check: "uat",
        fingerprint: `uat:script:${script!.id}`,
        severity: "high",
        title: "Legacy export failed",
        blocking: true,
        state: "open",
      })
      .run();

    await expect(retireUatScript({ db, dataDir }, projectRow.id, script!.id, "   ")).rejects.toThrow(
      UatError,
    );
    await expect(
      retireUatScript({ db, dataDir }, projectRow.id, script!.id, "x".repeat(501)),
    ).rejects.toThrow(UatError);

    const retired = await retireUatScript(
      { db, dataDir },
      projectRow.id,
      script!.id,
      "Feature removed in v1.0",
    );
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("Feature removed in v1.0");

    const finding = db
      .select()
      .from(gateFindings)
      .where(
        and(
          eq(gateFindings.projectId, projectRow.id),
          eq(gateFindings.fingerprint, `uat:script:${script!.id}`),
        ),
      )
      .get();
    expect(finding?.state).toBe("resolved");
    expect(finding?.reason).toBe("Feature removed in v1.0");
  });

  it("origin rewrite replaces recorded origin only immediately after a quote", () => {
    const input = [
      "// comment http://127.0.0.1:5173 should stay",
      "await page.goto('http://127.0.0.1:5173/login');",
      'await page.goto("http://127.0.0.1:5173");',
      "await page.goto(`http://127.0.0.1:5173/items?q=1`);",
      "const otherPort = 'http://127.0.0.1:51730/app';",
      "const midString = 'prefix http://127.0.0.1:5173';",
    ].join("\n");

    const out = rewriteScriptOrigin(
      input,
      "http://127.0.0.1:5173",
      "http://localhost:4100",
    );

    expect(out).toContain("// comment http://127.0.0.1:5173 should stay");
    expect(out).toContain("await page.goto('http://localhost:4100/login');");
    expect(out).toContain('await page.goto("http://localhost:4100");');
    expect(out).toContain("await page.goto(`http://localhost:4100/items?q=1`);");
    expect(out).toContain("const otherPort = 'http://127.0.0.1:51730/app';");
    expect(out).toContain("const midString = 'prefix http://127.0.0.1:5173';");
  });

  it("kills codegen on Stop and kills replay on Stop / shutdown; startup recovery cleans leftovers", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "Kill test",
        source: "plan",
      })
      .returning()
      .all();

    let codegenKilled = false;
    let codegenEntered!: () => void;
    const codegenEnteredPromise = new Promise<void>((r) => {
      codegenEntered = r;
    });
    let resolveCodegen!: (r: { exitCode: number | null }) => void;

    const depsCg = makeFakeSessionDeps(db, dataDir, {
      codegenRunner: async ({ onSpawn }) => {
        onSpawn?.({
          pid: 90001,
          kill: () => {
            codegenKilled = true;
            resolveCodegen({ exitCode: null });
          },
        });
        codegenEntered();
        return new Promise((r) => {
          resolveCodegen = r;
        });
      },
    });

    await startUatSession(depsCg, projectRow.id);
    const rec = await startScriptRecording(depsCg, projectRow.id, item!.id);
    rec.promise.catch(() => {});
    await codegenEnteredPromise;

    await stopUatSession(depsCg, projectRow.id);
    expect(codegenKilled).toBe(true);
    await expect(rec.promise).rejects.toThrow("cancelled");

    // Test replay kill on stopAllUatSessions (shutdown)
    db.insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Earlier item",
        releaseVersion: "v0.9",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "old",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "active",
      })
      .run();

    let replayKilled = false;
    let replayEntered!: () => void;
    const replayEnteredPromise = new Promise<void>((r) => {
      replayEntered = r;
    });
    let resolveReplay!: (out: { status: "error"; results: [] }) => void;

    const depsRp = makeFakeSessionDeps(db, dataDir, {
      replayRunner: async ({ onSpawn }) => {
        onSpawn?.({
          pid: 90002,
          kill: () => {
            replayKilled = true;
            resolveReplay({ status: "error", results: [] });
          },
        });
        replayEntered();
        return new Promise((r) => {
          resolveReplay = r;
        });
      },
    });

    const startPromise = startUatSession(depsRp, projectRow.id);
    startPromise.catch(() => {});
    await replayEnteredPromise;
    await stopAllUatSessions(db, dataDir);
    expect(replayKilled).toBe(true);
    await expect(startPromise).rejects.toThrow();

    // Startup recovery cleans running replay runs & drafts
    const [dangling] = db
      .insert(uatScripts)
      .values({
        projectId: projectRow.id,
        itemText: "Dangling draft",
        releaseVersion: "v1.0",
        recordedOrigin: "http://127.0.0.1:5173",
        headSha: "abc",
        scriptText: VALID_SCRIPT,
        sha256: sha256(VALID_SCRIPT),
        status: "draft",
      })
      .returning()
      .all();

    const [danglingRun] = db
      .insert(uatReplayRuns)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha: "abc",
        kind: "full",
        status: "running",
      })
      .returning()
      .all();

    recoverUatSessionsOnStartup(db, dataDir);
    expect(db.select().from(uatScripts).where(eq(uatScripts.id, dangling!.id)).get()).toBeUndefined();
    const recRun = db.select().from(uatReplayRuns).where(eq(uatReplayRuns.id, danglingRun!.id)).get();
    expect(recRun?.status).toBe("error");
    expect(recRun?.error).toBe("server restarted");
  });

  it("real replay test: tiny node:http server on 127.0.0.1, one passing and one failing script via real defaultUatReplayRunner headless", async (ctx) => {
    const exe = chromium.executablePath();
    if (!exe || !existsSync(exe)) {
      ctx.skip("Chromium executable missing; install Playwright chromium to run real replay test");
      return;
    }

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><h1>Real Replay OK</h1></body></html>");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      server.close();
      throw new Error("Expected numeric server port");
    }

    try {
      const appUrl = `http://127.0.0.1:${addr.port}`;
      setUatAppConfig(db, projectRow.id, {
        startCommand: "node server.js",
        appUrl,
      });

      const passScript = `import { test, expect } from '@playwright/test';

test('real server passes', async ({ page }) => {
  await page.goto('http://127.0.0.1:9999/');
  await expect(page.getByRole('heading', { name: 'Real Replay OK' })).toBeVisible();
});
`;
      const failScript = `import { test, expect } from '@playwright/test';

test('real server fails missing text', async ({ page }) => {
  await page.goto('http://127.0.0.1:9999/');
  await expect(page.getByText('Never Rendered Text')).toBeVisible({ timeout: 1500 });
});
`;

      const [sPass] = db
        .insert(uatScripts)
        .values({
          projectId: projectRow.id,
          itemText: "Heading visible",
          releaseVersion: "v0.9",
          recordedOrigin: "http://127.0.0.1:9999",
          headSha: "oldsha",
          scriptText: passScript,
          sha256: sha256(passScript),
          status: "active",
        })
        .returning()
        .all();

      const [sFail] = db
        .insert(uatScripts)
        .values({
          projectId: projectRow.id,
          itemText: "Missing text check",
          releaseVersion: "v0.9",
          recordedOrigin: "http://127.0.0.1:9999",
          headSha: "oldsha",
          scriptText: failScript,
          sha256: sha256(failScript),
          status: "active",
        })
        .returning()
        .all();

      const deps = makeFakeSessionDeps(db, dataDir, {
        replayRunner: defaultUatReplayRunner,
      });

      const session = await startUatSession(deps, projectRow.id);
      expect(session.status).toBe("running");

      const replayData = getUatReplayResults(deps, projectRow.id);
      expect(replayData.latestRun?.status).toBe("failed");
      expect(replayData.latestRun?.totalScripts).toBe(2);
      expect(replayData.latestRun?.passedScripts).toBe(1);
      expect(replayData.latestRun?.failedScripts).toBe(1);

      const passRes = replayData.results.find((r) => r.scriptId === sPass!.id);
      const failRes = replayData.results.find((r) => r.scriptId === sFail!.id);
      expect(passRes?.status).toBe("passed");
      expect(failRes?.status).toBe("failed");
      expect(failRes?.detail).toBeTruthy();
      expect(failRes?.tracePath).toBeTruthy();

      // Verify trace file is safely servable via resolveUatRecordingPath
      const traceParts = failRes!.tracePath!.split("/");
      const resolved = resolveUatRecordingPath(
        { db, dataDir },
        projectRow.id,
        session.id,
        traceParts,
      );
      expect(resolved.contentType).toBe("application/zip");
      expect(existsSync(resolved.path)).toBe(true);

      // Verify symlinked trace traversal is refused
      const outside = join(testDir, "evil.zip");
      writeFileSync(outside, "evil");
      const sessDir = join(dataDir, "uat", String(projectRow.id), session.id);
      mkdirSync(join(sessDir, "replay", "evil"), { recursive: true });
      symlinkSync(outside, join(sessDir, "replay", "evil", "trace.zip"));
      expect(() =>
        resolveUatRecordingPath(
          { db, dataDir },
          projectRow.id,
          session.id,
          ["replay", "evil", "trace.zip"],
        ),
      ).toThrow(UatError);

      // Verify blocking finding created for failing script only
      const scriptsList = listUatScripts(deps, projectRow.id);
      expect(scriptsList.length).toBe(2);

      const uatState = await getUatState(deps, projectRow.id);
      expect(uatState.replay.status).toBe("failed");
      expect(uatState.gateLine.status).toBe("fail");

      const findings = db
        .select()
        .from(gateFindings)
        .where(and(eq(gateFindings.projectId, projectRow.id), eq(gateFindings.check, "uat")))
        .all();
      expect(findings.length).toBe(1);
      expect(findings[0]!.fingerprint).toBe(`uat:script:${sFail!.id}`);
      expect(findings[0]!.blocking).toBe(true);
    } finally {
      await stopAllUatSessions(db, dataDir);
      server.close();
    }
  });
});
