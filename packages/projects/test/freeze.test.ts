import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, projects, shapingState, tasks, type DaedalusDb } from "@daedalus/db";
import { syncPlanTasksToDb } from "../src/pipeline.js";
import { startMilestoneRelease } from "../src/shaping.js";

describe("Milestone freeze and ADR 0018 rules", () => {
  let testDir: string;
  let db: DaedalusDb;
  let projectId: number;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-freeze-test-"));
    db = openDb(join(testDir, "test.db"));

    const [proj] = db
      .insert(projects)
      .values({
        name: "Freeze Test Project",
        localPath: testDir,
        profile: "personal",
      })
      .returning()
      .all();
    projectId = proj!.id;

    mkdirSync(join(testDir, "docs"), { recursive: true });

    // Set up approved INTAKE.md, SPEC.md, mock.html, and PLAN.md
    writeFileSync(
      join(testDir, "docs", "INTAKE.md"),
      "# Intake\n- **Problem:** Test\n- **Users:** Dev\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(testDir, "docs", "SPEC.md"),
      "# Spec\n## Overview\nTest overview\n## Verify\nVerify criteria\n",
      "utf8",
    );
    writeFileSync(
      join(testDir, "docs", "mock.html"),
      "<!DOCTYPE html><html><body>Mock</body></html>",
      "utf8",
    );
    writeFileSync(
      join(testDir, "docs", "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial
Done when: It works.
- [ ] **T1.1 Build feature** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test
- [ ] **T1.2 Owner feature** \`[you]\` — [[SPEC#Verify]]
  check: pnpm test:owner
`,
      "utf8",
    );

    // Record approvals in DB (ADR 0017)
    db.insert(shapingState)
      .values({
        projectId,
        specApprovedAt: new Date().toISOString(),
        mockApprovedAt: new Date().toISOString(),
        mockArtifactUrl: "https://example.com/mock",
        mockApprovedBy: "Tester",
        planApprovedAt: new Date().toISOString(),
      })
      .run();
  });

  afterEach(() => {
    db.$client.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("after Start milestone, editing check to rm -rf ~ and syncing leaves DB check unchanged", async () => {
    const fakeGitOps = {
      branchExists: async () => false,
      createBranch: async () => {},
    };

    const projectRow = db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
      fakeGitOps,
    );

    // Verify task row is frozen
    const rowBefore = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;
    expect(rowBefore.frozenAt).not.toBeNull();
    expect(rowBefore.checkCommand).toBe("pnpm test");
    expect(rowBefore.tag).toBe("claude");
    expect(rowBefore.status).toBe("queued");
    expect(rowBefore.attempts).toBe(0);

    // Malicious or accidental edit in PLAN.md
    writeFileSync(
      join(testDir, "docs", "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial
Done when: It works.
- [x] **T1.1 Build feature** \`[gemini]\` — [[SPEC#Overview]]
  check: rm -rf ~
- [ ] **T1.2 Owner feature** \`[you]\` — [[SPEC#Verify]]
  check: pnpm test:owner
`,
      "utf8",
    );

    syncPlanTasksToDb(db, projectId, testDir);

    const rowAfter = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;

    // Check command remains the frozen value
    expect(rowAfter.checkCommand).toBe("pnpm test");
    // Tag remains frozen
    expect(rowAfter.tag).toBe("claude");
    // [x] does not change status
    expect(rowAfter.status).toBe("queued");
    expect(rowAfter.frozenAt).toBe(rowBefore.frozenAt);
  });

  it("ignores tag changes for frozen tasks but updates titles", async () => {
    const fakeGitOps = {
      branchExists: async () => false,
      createBranch: async () => {},
    };

    const projectRow = db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
      fakeGitOps,
    );

    writeFileSync(
      join(testDir, "docs", "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial
Done when: It works.
- [ ] **T1.1 Build feature Updated Title** \`[gemini]\` — [[SPEC#Overview]]
  check: malicious command
`,
      "utf8",
    );

    syncPlanTasksToDb(db, projectId, testDir);

    const row = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;
    expect(row.title).toBe("Build feature Updated Title");
    expect(row.tag).toBe("claude"); // ignored gemini
    expect(row.checkCommand).toBe("pnpm test"); // ignored malicious command
  });

  it("tasks added to PLAN.md under started milestone after start are not runnable (frozenAt null)", async () => {
    const fakeGitOps = {
      branchExists: async () => false,
      createBranch: async () => {},
    };

    const projectRow = db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
      fakeGitOps,
    );

    // Add a new task T1.3 to PLAN.md
    writeFileSync(
      join(testDir, "docs", "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial
Done when: It works.
- [ ] **T1.1 Build feature** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test
- [ ] **T1.3 Late task** \`[claude]\` — [[SPEC#Overview]]
  check: echo late
`,
      "utf8",
    );

    const result = syncPlanTasksToDb(db, projectId, testDir);
    const t3 = result.tasks.find((t) => t.code === "T1.3")!;
    expect(t3).toBeDefined();
    expect(t3.frozenAt).toBeNull();
  });
});
