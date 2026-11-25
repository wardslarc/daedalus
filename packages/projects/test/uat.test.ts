import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Page } from "playwright";
import {
  gateFindings,
  gateRuns,
  openDb,
  projects,
  providers,
  shapingState,
  tasks,
  uatItems,
  uatSessions,
  type DaedalusDb,
} from "@daedalus/db";
import {
  addUatItemFromSpec,
  getReleaseGate,
  getUatState,
  markUatItem,
  resolveUatRecordingPath,
  setUatAppConfig,
  startMilestoneRelease,
  startUatSession,
  stopAllUatSessions,
  stopUatSession,
  uatScreenshot,
  UatError,
  validateUatAppConfig,
  type UatBrowserLauncher,
  type UatPortProbe,
  type UatProcessRunner,
  type UatTracingStopOpts,
  type UatUrlProbe,
} from "../src/index.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("UAT checklist with a recorded browser (T6.4, ADR 0021)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let projectRow: typeof projects.$inferSelect;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-uat-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));

    repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "UAT Tester");
    git(repoDir, "config", "user.email", "uat@example.com");

    writeFileSync(join(repoDir, "README.md"), "# Project\ninitial content\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit");

    git(repoDir, "branch", "daedalus/release-v1.0", "main");

    const [proj] = db
      .insert(projects)
      .values({
        name: "Test UAT Project",
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
        activeMilestoneVerifyStartedAt: new Date().toISOString(),
      })
      .run();
  });

  afterEach(async () => {
    await stopAllUatSessions(db, dataDir);
    db.$client.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // 1. items frozen at Start milestone
  it("items frozen at Start milestone and never re-read from later PLAN.md edits", async () => {
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** test\n- **Users:** tester\n- **Constraints:** none\n",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nTest overview\n## Verify\n- End-to-end check passes\n",
    );
    writeFileSync(
      join(docsDir, "mock.html"),
      "<!DOCTYPE html><html><body>Mock</body></html>",
    );

    const initialPlanContent = `# Plan
## M2 — v2.0 Next Milestone
Done when: User can login successfully
- Item 2: User can export PDF
- [ ] **T2.1 Implement feature** [claude] [[SPEC#Overview]]
  Feature task
  check: exit 0
`;
    writeFileSync(join(docsDir, "PLAN.md"), initialPlanContent);
    const planSha = createHash("sha256").update(initialPlanContent, "utf8").digest("hex");

    // Reset shaping state to allow startMilestoneRelease for M2
    db.update(shapingState)
      .set({
        specApprovedAt: new Date().toISOString(),
        mockApprovedAt: new Date().toISOString(),
        mockArtifactUrl: "http://example.com/mock",
        mockApprovedBy: "Owner",
        planApprovedAt: new Date().toISOString(),
        planApprovedSha256: planSha,
        activeMilestoneFrozen: false,
        activeMilestoneVersion: null,
        activeMilestoneCode: null,
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    await startMilestoneRelease(
      db,
      projectRow.id,
      repoDir,
      { version: "v2.0", milestoneCode: "M2" },
      projectRow,
    );

    // Verify uat_items rows were inserted
    const items = db
      .select()
      .from(uatItems)
      .where(and(eq(uatItems.projectId, projectRow.id), eq(uatItems.releaseVersion, "v2.0")))
      .orderBy(uatItems.position)
      .all();

    expect(items.length).toBe(2);
    expect(items[0]!.text).toBe("User can login successfully");
    expect(items[0]!.source).toBe("plan");
    expect(items[0]!.position).toBe(1);
    expect(items[1]!.text).toBe("Item 2: User can export PDF");
    expect(items[1]!.source).toBe("plan");
    expect(items[1]!.position).toBe(2);

    // Later PLAN.md edit changes nothing
    writeFileSync(
      join(docsDir, "PLAN.md"),
      "# Plan\n## M2 — v2.0 Next Milestone\nDone when: Tampered plan item\n",
    );

    const uatData = await getUatState(
      { db, dataDir },
      projectRow.id,
    );
    expect(uatData.items.length).toBe(2);
    expect(uatData.items[0]!.text).toBe("User can login successfully");
  });

  // 1b. start milestone refuses done-when item over 500 chars with 400 naming the item
  it("start milestone refuses done-when item over 500 chars with 400 naming the item", async () => {
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(join(docsDir, "INTAKE.md"), "# Intake\n- **Problem:** test\n- **Users:** tester\n- **Constraints:** none\n");
    writeFileSync(join(docsDir, "SPEC.md"), "# Spec\n## Overview\nOverview\n## Verify\n- Check\n");
    writeFileSync(join(docsDir, "mock.html"), "<html><body>Mock</body></html>");

    const longItem = "A".repeat(501);
    const longPlan = `# Plan
## M3 — v3.0 Long Milestone
Done when: ${longItem}
- [ ] **T3.1 Task** [claude]
  check: exit 0
`;
    writeFileSync(join(docsDir, "PLAN.md"), longPlan);
    const planSha = createHash("sha256").update(longPlan, "utf8").digest("hex");

    db.update(shapingState)
      .set({
        specApprovedAt: new Date().toISOString(),
        mockApprovedAt: new Date().toISOString(),
        mockArtifactUrl: "http://example.com/mock",
        mockApprovedBy: "Owner",
        planApprovedAt: new Date().toISOString(),
        planApprovedSha256: planSha,
        activeMilestoneFrozen: false,
        activeMilestoneVersion: null,
        activeMilestoneCode: null,
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    await expect(
      startMilestoneRelease(
        db,
        projectRow.id,
        repoDir,
        { version: "v3.0", milestoneCode: "M3" },
        projectRow,
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(longItem),
    });
  });

  // 1c. forced insert failure in startMilestoneRelease rolls back transaction
  it("forced insert failure in startMilestoneRelease rolls back transaction: leaves no uat_items and no frozen flag", async () => {
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(join(docsDir, "INTAKE.md"), "# Intake\n- **Problem:** test\n- **Users:** tester\n- **Constraints:** none\n");
    writeFileSync(join(docsDir, "SPEC.md"), "# Spec\n## Overview\nOverview\n## Verify\n- Check\n");
    writeFileSync(join(docsDir, "mock.html"), "<html><body>Mock</body></html>");

    const validPlan = `# Plan
## M4 — v4.0 Fail Milestone
Done when: First done item
- Done item 2
- [ ] **T4.1 Task** [claude]
  check: exit 0
`;
    writeFileSync(join(docsDir, "PLAN.md"), validPlan);
    const planSha = createHash("sha256").update(validPlan, "utf8").digest("hex");

    db.update(shapingState)
      .set({
        specApprovedAt: new Date().toISOString(),
        mockApprovedAt: new Date().toISOString(),
        mockArtifactUrl: "http://example.com/mock",
        mockApprovedBy: "Owner",
        planApprovedAt: new Date().toISOString(),
        planApprovedSha256: planSha,
        activeMilestoneFrozen: false,
        activeMilestoneVersion: null,
        activeMilestoneCode: null,
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Pre-insert an item at position 2 to force a unique constraint failure when inserting position 2
    db.insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v4.0",
        position: 2,
        text: "Pre-existing collision",
        source: "plan",
      })
      .run();

    await expect(
      startMilestoneRelease(
        db,
        projectRow.id,
        repoDir,
        { version: "v4.0", milestoneCode: "M4" },
        projectRow,
      ),
    ).rejects.toThrow();

    // Verify transaction rolled back: only pre-existing item exists
    const items = db
      .select()
      .from(uatItems)
      .where(and(eq(uatItems.projectId, projectRow.id), eq(uatItems.releaseVersion, "v4.0")))
      .all();
    expect(items.length).toBe(1);
    expect(items[0]!.text).toBe("Pre-existing collision");

    // shaping_state has no active frozen flag
    const shaping = db
      .select()
      .from(shapingState)
      .where(eq(shapingState.projectId, projectRow.id))
      .get();
    expect(shaping?.activeMilestoneFrozen).toBeFalsy();
  });

  // 2. fallback blocked on changed PLAN.md
  it("fallback blocked on changed PLAN.md when milestone has no uat_items rows", async () => {
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    const approvedPlan = `# Plan
## M1 — v1.0 Initial Release
Done when: Fallback item 1
- [ ] **T1.1 Task** [claude]
  check: exit 0
`;
    const approvedSha = createHash("sha256").update(approvedPlan, "utf8").digest("hex");

    db.update(shapingState)
      .set({
        planApprovedSha256: approvedSha,
      })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Case A: PLAN.md does not exist or was edited after approval -> blocked
    writeFileSync(join(docsDir, "PLAN.md"), "# Tampered PLAN.md\n");

    const uatBlocked = await getUatState({ db, dataDir }, projectRow.id);
    expect(uatBlocked.blockedReason).toBe("PLAN.md changed since you approved it");
    expect(uatBlocked.gateLine.status).toBe("fail");

    const gateBlocked = await getReleaseGate(db, projectRow, { dataDir });
    expect(gateBlocked.status).toBe("blocked");
    expect(gateBlocked.blockedReason).toBe("PLAN.md changed since you approved it");

    // Case B: PLAN.md matches approved hash -> populates uat_items from Done when
    writeFileSync(join(docsDir, "PLAN.md"), approvedPlan);

    const uatSuccess = await getUatState({ db, dataDir }, projectRow.id);
    expect(uatSuccess.blockedReason).toBeUndefined();
    expect(uatSuccess.items.length).toBe(1);
    expect(uatSuccess.items[0]!.text).toBe("Fallback item 1");
    expect(uatSuccess.items[0]!.source).toBe("plan");

    // Second call reads from DB (items frozen)
    const itemsInDb = db.select().from(uatItems).where(eq(uatItems.projectId, projectRow.id)).all();
    expect(itemsInDb.length).toBe(1);
  });

  // 3. spec item must match approved spec
  it("spec item must match approved spec ## Verify section and appends with source spec", async () => {
    const docsDir = join(repoDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "SPEC.md"),
      `# Spec
## Overview
App spec overview.
## Verify
- User can complete checkout with credit card
- Admin dashboard exports CSV
`,
    );

    db.update(shapingState)
      .set({ specApprovedAt: new Date().toISOString() })
      .where(eq(shapingState.projectId, projectRow.id))
      .run();

    // Refused: text doesn't match approved spec
    await expect(
      addUatItemFromSpec(
        { db, dataDir },
        projectRow.id,
        "Random unverified check",
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Item text must match one of the approved spec's ## Verify items"),
    });

    // Accepted: matches bullet item
    const newItem = await addUatItemFromSpec(
        { db, dataDir },
        projectRow.id,
        "User can complete checkout with credit card",
    );
    expect(newItem.text).toBe("User can complete checkout with credit card");
    expect(newItem.source).toBe("spec");
    expect(newItem.position).toBe(1);

    // Appended item gets next position
    const secondItem = await addUatItemFromSpec(
      { db, dataDir },
      projectRow.id,
      "Admin dashboard exports CSV",
    );
    expect(secondItem.position).toBe(2);
    expect(secondItem.source).toBe("spec");
  });

  // 4. config URL validation (each refused form)
  it("config URL validation refuses forbidden forms and accepts valid localhost/127.0.0.1", () => {
    // startCommand validation
    expect(() => validateUatAppConfig({ startCommand: "", appUrl: "http://127.0.0.1:3000" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "a".repeat(501), appUrl: "http://127.0.0.1:3000" })).toThrow(UatError);

    // appUrl protocol
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "https://127.0.0.1:3000" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "ftp://127.0.0.1:3000" })).toThrow(UatError);

    // appUrl hostname
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://0.0.0.0:3000" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://example.com:3000" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://192.168.1.1:3000" })).toThrow(UatError);

    // appUrl path, query, hash, userinfo
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:3000/app" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:3000?test=1" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:3000#hash" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://user:pass@127.0.0.1:3000" })).toThrow(UatError);

    // appUrl port out of range
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:80" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:1023" })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:65536" })).toThrow(UatError);

    // appUrl Daedalus own port
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:4317" }, { daedalusPort: 4317 })).toThrow(UatError);
    expect(() => validateUatAppConfig({ startCommand: "npm start", appUrl: "http://127.0.0.1:4318" }, { daedalusPort: 4317 })).toThrow(UatError);

    // valid forms
    const val1 = validateUatAppConfig({ startCommand: "pnpm dev", appUrl: "http://127.0.0.1:5173/" });
    expect(val1.appUrl).toBe("http://127.0.0.1:5173");

    const val2 = validateUatAppConfig({ startCommand: "pnpm dev", appUrl: "http://localhost:3000" });
    expect(val2.appUrl).toBe("http://localhost:3000");

    // setUatAppConfig in DB
    const saved = setUatAppConfig(db, projectRow.id, { startCommand: "pnpm dev", appUrl: "http://127.0.0.1:5173" });
    expect(saved.startCommand).toBe("pnpm dev");
    expect(saved.appUrl).toBe("http://127.0.0.1:5173");
  });

  // 5. one session at a time (409)
  it("only one active UAT session at a time (409 on duplicate start)", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev --port 5173",
      appUrl: "http://127.0.0.1:5173",
    });

    const mockRunner: UatProcessRunner = async () => ({
      pid: 12345,
      kill: () => {},
    });
    const mockProbe: UatUrlProbe = async () => true;
    const mockLauncher: UatBrowserLauncher = async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    });

    const mockPortProbe: UatPortProbe = async () => false;

    // Start first session
    const session1 = await startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );
    expect(session1.status).toBe("running");

    // Second start attempt fails with 409
    await expect(
      startUatSession(
        {
          db,
          dataDir,
          processRunner: mockRunner,
          urlProbe: mockProbe,
          portProbe: mockPortProbe,
          browserLauncher: mockLauncher,
        },
        projectRow.id,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already starting or running"),
    });

    // Stop session
    await stopUatSession({ db, dataDir }, projectRow.id);
  });

  // 5b. double start rejects second with 409 after first enters runner and leaves no orphaned app process after stop
  it("double start rejects second with 409 after first enters runner and leaves no orphaned app process after stop", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let spawnCount = 0;
    let killCount = 0;
    let notifyRunnerEntered!: () => void;
    const runnerEnteredPromise = new Promise<void>((resolve) => {
      notifyRunnerEntered = resolve;
    });
    let resolveRunner!: (proc: { pid: number; kill: () => void }) => void;
    const slowRunnerPromise = new Promise<{ pid: number; kill: () => void }>((resolve) => {
      resolveRunner = resolve;
    });

    const mockRunner: UatProcessRunner = async () => {
      spawnCount++;
      notifyRunnerEntered();
      return slowRunnerPromise;
    };

    const mockProbe: UatUrlProbe = async () => true;
    const mockPortProbe: UatPortProbe = async () => false;
    const mockLauncher: UatBrowserLauncher = async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    });

    // 1. Call startUatSession without awaiting the first
    const firstStartPromise = startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    // Wait until the first start has reached the runner
    await runnerEnteredPromise;

    // Exactly one spawn has occurred
    expect(spawnCount).toBe(1);

    // 2. Call startUatSession second time concurrently (first is in-flight at runner)
    await expect(
      startUatSession(
        {
          db,
          dataDir,
          processRunner: mockRunner,
          urlProbe: mockProbe,
          portProbe: mockPortProbe,
          browserLauncher: mockLauncher,
        },
        projectRow.id,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already starting or running"),
    });

    // Resolve the slow runner
    resolveRunner({
      pid: 67890,
      kill: () => {
        killCount++;
      },
    });

    // First session finishes startup and reaches running state
    const session1 = await firstStartPromise;
    expect(session1.status).toBe("running");

    // Stop session kills the spawned process
    await stopUatSession({ db, dataDir }, projectRow.id);
    expect(killCount).toBe(1);
  });

  // 5b2. double start immediately back-to-back rejects second with 409 and spawns exactly once after both settle
  it("double start immediately back-to-back rejects second with 409 and spawns exactly once after both settle", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let spawnCount = 0;
    let killCount = 0;
    const mockRunner: UatProcessRunner = async () => {
      spawnCount++;
      return {
        pid: 67891,
        kill: () => {
          killCount++;
        },
      };
    };

    const mockProbe: UatUrlProbe = async () => true;
    const mockPortProbe: UatPortProbe = async () => false;
    const mockLauncher: UatBrowserLauncher = async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    });

    const firstPromise = startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    const secondPromise = startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    // Second call rejects immediately with 409
    await expect(secondPromise).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already starting or running"),
    });

    const session1 = await firstPromise;
    expect(session1.status).toBe("running");
    expect(spawnCount).toBe(1);

    await stopUatSession({ db, dataDir }, projectRow.id);
    expect(killCount).toBe(1);
  });

  // 5c. stop during starting kills whatever has been spawned so far
  it("stop during starting kills whatever has been spawned so far", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let killCount = 0;
    let resolveProbe!: (value: boolean) => void;
    const slowProbePromise = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });

    let notifyRunnerEntered!: () => void;
    const runnerEnteredPromise = new Promise<void>((resolve) => {
      notifyRunnerEntered = resolve;
    });

    let notifyProbeStarted!: () => void;
    const probeStartedPromise = new Promise<void>((resolve) => {
      notifyProbeStarted = resolve;
    });

    const mockRunner: UatProcessRunner = async () => {
      notifyRunnerEntered();
      return {
        pid: 77777,
        kill: () => {
          killCount++;
        },
      };
    };

    const mockProbe: UatUrlProbe = async () => {
      notifyProbeStarted();
      return slowProbePromise;
    };

    const mockLauncher: UatBrowserLauncher = async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    });

    const mockPortProbe: UatPortProbe = async () => false;

    const startPromise = startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    // Wait until runner has executed and probe has started
    await runnerEnteredPromise;
    await probeStartedPromise;

    // Stop while starting (in probe phase)
    const stopped = await stopUatSession({ db, dataDir }, projectRow.id);
    expect(stopped.status).toBe("stopped");
    expect(killCount).toBe(1);

    resolveProbe(true);
    await expect(startPromise).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Session stopped during startup"),
    });
  });

  // 5c2. stop during starting kills spawned process when stopped while runner is in flight
  it("stop during starting kills spawned process when stopped while runner is in flight", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let killCount = 0;
    let notifyRunnerEntered!: () => void;
    const runnerEnteredPromise = new Promise<void>((resolve) => {
      notifyRunnerEntered = resolve;
    });

    let resolveRunner!: (proc: { pid: number; kill: () => void }) => void;
    const slowRunnerPromise = new Promise<{ pid: number; kill: () => void }>((resolve) => {
      resolveRunner = resolve;
    });

    const mockRunner: UatProcessRunner = async () => {
      notifyRunnerEntered();
      return slowRunnerPromise;
    };

    const mockProbe: UatUrlProbe = async () => true;
    const mockPortProbe: UatPortProbe = async () => false;
    const mockLauncher: UatBrowserLauncher = async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => Buffer.from(""),
      } as unknown as Page,
    });

    const startPromise = startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    // Wait until runner is entered
    await runnerEnteredPromise;

    // Stop while runner is in flight
    const stopped = await stopUatSession({ db, dataDir }, projectRow.id);
    expect(stopped.status).toBe("stopped");

    // Resolve runner; the startup detects it was stopped, kills the process, and rejects 400
    resolveRunner({
      pid: 88888,
      kill: () => {
        killCount++;
      },
    });

    await expect(startPromise).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Session stopped during startup"),
    });
    expect(killCount).toBe(1);
  });

  // 5d. DB guard: partial unique index on uat_sessions(project_id) WHERE status IN ('starting','running')
  it("DB guard: partial unique index rejects concurrent starting/running row with 409", async () => {
    db.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS uat_sessions_active_project_unique ON uat_sessions(project_id) WHERE status IN ('starting', 'running')`,
    );

    // Insert an active starting row directly into DB
    db.insert(uatSessions)
      .values({
        id: "active-session-1",
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha: "abc",
        status: "starting",
      })
      .run();

    // Another insert with status 'running' or 'starting' for same project fails UNIQUE constraint
    expect(() => {
      db.insert(uatSessions)
        .values({
          id: "active-session-2",
          projectId: projectRow.id,
          releaseVersion: "v1.0",
          headSha: "def",
          status: "running",
        })
        .run();
    }).toThrow(/UNIQUE constraint failed/);

    // A session with status 'stopped' or 'error' does not conflict
    db.insert(uatSessions)
      .values({
        id: "stopped-session-3",
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha: "ghi",
        status: "stopped",
      })
      .run();
  });

  // 6. no display → error, nothing left running
  it("no display → error, nothing left running", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let runnerSpawned = false;
    const mockRunner: UatProcessRunner = async () => {
      runnerSpawned = true;
      return {
        pid: 9999,
        kill: () => {},
      };
    };
    const mockProbe: UatUrlProbe = async () => true;

    const oldDisplay = process.env.DISPLAY;
    const oldWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    try {
      await expect(
        startUatSession(
          {
            db,
            dataDir,
            processRunner: mockRunner,
            urlProbe: mockProbe,
          },
          projectRow.id,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("No display for the recorded browser"),
      });

      expect(runnerSpawned).toBe(false);

      const sessionInDb = db
        .select()
        .from(uatSessions)
        .where(eq(uatSessions.projectId, projectRow.id))
        .get();
      expect(sessionInDb?.status).toBe("error");
      expect(sessionInDb?.error).toContain("No display for the recorded browser");

      const worktreesDir = join(dataDir, "worktrees");
      const worktrees = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
      expect(worktrees.length).toBe(0);
    } finally {
      if (oldDisplay) process.env.DISPLAY = oldDisplay;
      if (oldWayland) process.env.WAYLAND_DISPLAY = oldWayland;
    }
  });

  // 6b. port busy → 409, nothing spawned
  it("port busy → 409, nothing spawned", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let runnerSpawned = false;
    const mockRunner: UatProcessRunner = async () => {
      runnerSpawned = true;
      return { pid: 9999, kill: () => {} };
    };

    const mockPortProbe: UatPortProbe = async () => true;

    await expect(
      startUatSession(
        {
          db,
          dataDir,
          processRunner: mockRunner,
          portProbe: mockPortProbe,
        },
        projectRow.id,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Port 5173 is already in use; stop that app first",
    });

    expect(runnerSpawned).toBe(false);

    const worktreesDir = join(dataDir, "worktrees");
    const worktrees = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
    expect(worktrees.length).toBe(0);
  });

  // 7. stop saves trace path and kills the process group
  it("stop saves trace path and kills the process group", async () => {
    setUatAppConfig(db, projectRow.id, {
      startCommand: "pnpm dev",
      appUrl: "http://127.0.0.1:5173",
    });

    let appKilled = false;
    let traceSavedPath = "";
    let contextClosed = false;
    let browserClosed = false;

    const mockRunner: UatProcessRunner = async () => ({
      pid: 54321,
      kill: () => {
        appKilled = true;
      },
    });
    const mockProbe: UatUrlProbe = async () => true;
    const mockLauncher: UatBrowserLauncher = async ({ sessionFolder }) => ({
      browser: {
        close: async () => {
          browserClosed = true;
        },
      },
      context: {
        close: async () => {
          contextClosed = true;
        },
        tracing: {
          stop: async (opts: UatTracingStopOpts) => {
            traceSavedPath = opts.path;
            writeFileSync(opts.path, "mock-trace-data");
          },
        },
        newPage: async () =>
          ({ goto: async () => null, screenshot: async () => Buffer.from("") }) as unknown as Page,
      },
      page: {
        goto: async () => null,
        screenshot: async () => {
          const scPath = join(sessionFolder, "screenshots", "1.png");
          writeFileSync(scPath, "mock-png-data");
          return Buffer.from("mock-png-data");
        },
      } as unknown as Page,
    });

    const mockPortProbe: UatPortProbe = async () => false;

    await startUatSession(
      {
        db,
        dataDir,
        processRunner: mockRunner,
        urlProbe: mockProbe,
        portProbe: mockPortProbe,
        browserLauncher: mockLauncher,
      },
      projectRow.id,
    );

    // Capture a screenshot
    const sc = await uatScreenshot({ db, dataDir }, projectRow.id);
    expect(sc.name).toBe("1.png");

    const stoppedSession = await stopUatSession({ db, dataDir }, projectRow.id);
    expect(stoppedSession.status).toBe("stopped");
    expect(appKilled).toBe(true);
    expect(contextClosed).toBe(true);
    expect(browserClosed).toBe(true);
    expect(traceSavedPath).toContain("trace.zip");
    expect(existsSync(traceSavedPath)).toBe(true);
  });

  // 8. failed bug mark adds a frozen fix task to the milestone
  it("failed bug mark adds a frozen fix task to the milestone and shows re-test when done", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "User can delete an account",
        source: "plan",
      })
      .returning()
      .all();

    const headSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    const markRes = await markUatItem(
      { db, dataDir },
      projectRow.id,
      item!.id,
      {
        result: "fail",
        kind: "bug",
        note: "Delete button does not trigger confirmation modal",
        checkCommand: "pnpm test:delete-account",
        headSha,
      },
    );

    expect(markRes.mark.result).toBe("fail");
    expect(markRes.mark.kind).toBe("bug");
    expect(markRes.task).toBeDefined();
    expect(markRes.task?.code).toBe("FIX-1");
    expect(markRes.task?.frozenAt).toBeTruthy();
    expect(markRes.task?.checkCommand).toBe("pnpm test:delete-account");

    const uatState = await getUatState({ db, dataDir }, projectRow.id);
    expect(uatState.items[0]!.status).toBe("fail");

    // When the fix task is done, the item status shows "re-test"
    db.update(tasks)
      .set({ status: "done" })
      .where(eq(tasks.id, markRes.task!.id))
      .run();

    const uatStateRetest = await getUatState({ db, dataDir }, projectRow.id);
    expect(uatStateRetest.items[0]!.status).toBe("re-test");
  });

  // 9. change mark adds a blocking uat finding
  it("failed change mark adds a blocking uat finding with outcome change-request", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "Export button styling",
        source: "spec",
      })
      .returning()
      .all();

    const headSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");
    const defaultSha = git(repoDir, "rev-parse", "main");

    // Seed finished gate run for current head so gate is not in needs-run
    db.insert(gateRuns)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha,
        defaultSha,
        status: "done",
        checks: {
          secrets: { status: "pass" },
          dependencies: { status: "pass" },
          securityTests: { status: "pass" },
          checklist: { status: "pass" },
        },
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      })
      .run();

    const markRes = await markUatItem(
      { db, dataDir },
      projectRow.id,
      item!.id,
      {
        result: "fail",
        kind: "change",
        note: "Owner wants button color changed to dark slate",
        headSha,
      },
    );

    expect(markRes.mark.result).toBe("fail");
    expect(markRes.mark.kind).toBe("change");
    expect(markRes.finding).toBeDefined();
    expect(markRes.finding?.check).toBe("uat");
    expect(markRes.finding?.blocking).toBe(true);
    expect(markRes.finding?.outcome).toBe("change-request");
    expect(markRes.finding?.state).toBe("open");

    const gate = await getReleaseGate(db, projectRow, { dataDir });
    expect(gate.status).toBe("blocked");
    expect(gate.checks?.uat?.status).not.toBe("pass");
    expect(gate.uat.gateLine.status).not.toBe("pass");
    expect(gate.status).not.toBe("pass");
  });

  // 10. stale headSha → 409
  it("stale headSha returns 409 'The release changed; reload.'", async () => {
    const [item] = db
      .insert(uatItems)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        position: 1,
        text: "Search filters by tag",
        source: "plan",
      })
      .returning()
      .all();

    await expect(
      markUatItem(
        { db, dataDir },
        projectRow.id,
        item!.id,
        {
          result: "pass",
          headSha: "0000000000000000000000000000000000000000",
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "The release changed; reload.",
    });
  });

  // 11. gate UAT line pass only when all items pass
  it("gate UAT line passes only when every item has pass mark and no open UAT finding exists", async () => {
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

    const headSha = git(repoDir, "rev-parse", "daedalus/release-v1.0");

    // Case A: 0 items passed -> UAT gate line fails
    const stateA = await getUatState({ db, dataDir }, projectRow.id);
    expect(stateA.gateLine.status).toBe("fail");

    // Case B: 1 item passed, 1 untested -> UAT gate line fails
    await markUatItem(
      { db, dataDir },
      projectRow.id,
      item1!.id,
      { result: "pass", headSha },
    );
    const stateB = await getUatState({ db, dataDir }, projectRow.id);
    expect(stateB.gateLine.status).toBe("fail");

    // Case C: Both items passed -> UAT gate line passes
    await markUatItem(
      { db, dataDir },
      projectRow.id,
      item2!.id,
      { result: "pass", headSha },
    );
    const stateC = await getUatState({ db, dataDir }, projectRow.id);
    expect(stateC.gateLine.status).toBe("pass");

    // Case D: Both pass, but an open UAT finding exists -> UAT gate line fails
    const [finding] = db
      .insert(gateFindings)
      .values({
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        check: "uat",
        fingerprint: "uat:change:test",
        severity: "moderate",
        blocking: true,
        state: "open",
        outcome: "change-request",
        title: "CR",
      })
      .returning()
      .all();

    const stateD = await getUatState({ db, dataDir }, projectRow.id);
    expect(stateD.gateLine.status).toBe("fail");

    // Resolve the finding -> passes again
    db.update(gateFindings)
      .set({ state: "resolved" })
      .where(eq(gateFindings.id, finding!.id))
      .run();

    const stateE = await getUatState({ db, dataDir }, projectRow.id);
    expect(stateE.gateLine.status).toBe("pass");
  });

  // 12. recordings discovery and containment check refuses ../ and symlinks
  it("recordings discovery and containment check refuses ../ and symlinks", async () => {
    const sessionId = "1";
    const sessionDir = join(dataDir, "uat", String(projectRow.id), sessionId);
    mkdirSync(join(sessionDir, "video"), { recursive: true });
    mkdirSync(join(sessionDir, "screenshots"), { recursive: true });

    writeFileSync(join(sessionDir, "trace.zip"), "trace-content");
    writeFileSync(join(sessionDir, "video", "rec.webm"), "video-content");
    writeFileSync(join(sessionDir, "screenshots", "1.png"), "png-content");

    db.insert(uatSessions)
      .values({
        id: sessionId,
        projectId: projectRow.id,
        releaseVersion: "v1.0",
        headSha: "head123",
        status: "stopped",
      })
      .run();

    const uatData = await getUatState({ db, dataDir }, projectRow.id);
    const recNames = uatData.recordings.map((r) => r.name);
    expect(recNames).toContain("trace.zip");
    expect(recNames).toContain("video/rec.webm");
    expect(recNames).toContain("screenshots/1.png");

    // Legitimate files resolve with correct content type and attachment flag
    const traceRes = resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["trace.zip"]);
    expect(traceRes.contentType).toBe("application/zip");
    expect(traceRes.attachment).toBe(true);

    const videoRes = resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["video", "rec.webm"]);
    expect(videoRes.contentType).toBe("video/webm");
    expect(videoRes.attachment).toBe(false);

    const scRes = resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["screenshots", "1.png"]);
    expect(scRes.contentType).toBe("image/png");
    expect(scRes.attachment).toBe(false);

    // Non-numeric sessionId is refused with 404
    expect(() => resolveUatRecordingPath({ db, dataDir }, projectRow.id, "abc", ["trace.zip"])).toThrow(UatError);
    try {
      resolveUatRecordingPath({ db, dataDir }, projectRow.id, "abc", ["trace.zip"]);
    } catch (err) {
      expect((err as UatError).status).toBe(404);
    }

    // Non-existent sessionId is refused with 404
    expect(() => resolveUatRecordingPath({ db, dataDir }, projectRow.id, "999", ["trace.zip"])).toThrow(UatError);
    try {
      resolveUatRecordingPath({ db, dataDir }, projectRow.id, "999", ["trace.zip"]);
    } catch (err) {
      expect((err as UatError).status).toBe(404);
    }

    // Traversal in path segments (..) is refused with 400
    expect(() => resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["..", "secret.txt"])).toThrow(UatError);
    try {
      resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["..", "secret.txt"]);
    } catch (err) {
      expect((err as UatError).status).toBe(400);
    }

    // Symlink file pointing outside session folder is refused with 404
    const outsideSecret = join(testDir, "secret.txt");
    writeFileSync(outsideSecret, "sensitive-data");
    const symlinkPath = join(sessionDir, "screenshots", "pwned.png");
    symlinkSync(outsideSecret, symlinkPath);

    expect(() => resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["screenshots", "pwned.png"])).toThrow(UatError);
    try {
      resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["screenshots", "pwned.png"]);
    } catch (err) {
      expect((err as UatError).status).toBe(404);
    }

    // Symlinked parent directory is refused with 403 or 404
    const outsideDir = join(testDir, "outside_dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "pwned.webm"), "video-secret");
    const symlinkFolder = join(sessionDir, "video_sym");
    symlinkSync(outsideDir, symlinkFolder);

    expect(() => resolveUatRecordingPath({ db, dataDir }, projectRow.id, sessionId, ["video_sym", "pwned.webm"])).toThrow(UatError);
  });
});
