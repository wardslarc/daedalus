import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, projects, tasks, type DaedalusDb } from "@daedalus/db";
import { parsePlanMarkdown, syncPlanTasksToDb } from "../src/pipeline.js";

describe("PLAN.md parsing and task sync", () => {
  describe("parsePlanMarkdown", () => {
    it("parses milestones, Done when items, and tasks with tags, specs, and check commands", () => {
      const planMarkdown = `# Plan — Test Project

## M1 — v1.0 Initial Release

Done when: The core pipeline operates end to end without manual intervention.
- All unit and e2e tests pass on the release branch
- The user can view the pipeline board

- [ ] **T1.1 Core implementation** \`[claude]\` — [[SPEC#Overview]] [[SPEC#Architecture]]
  Implement the foundation layer in packages/core.
  Supports basic state tracking and error handling.
  check: \`pnpm --filter @daedalus/core test\`

- [~] **T1.2 Database migrations** [gemini] — [[SPEC#Storage]]
  Create SQLite tables and run drizzle migrations.
  check: pnpm --filter @daedalus/db test

- [x] **T1.3 Manual review checklist** [you] — [[SPEC#Review]]
  Verify accessibility and keyboard navigation.
  check: \`pnpm test:e2e -- manual\`

## M2 — Advanced Features

Done when: Multi-agent coordination is fully verified.

- [ ] **T2.1 Agent orchestration** \`[claude]\` — [[SPEC#Agent]]
  Coordinate multiple provider sessions simultaneously.
  check: pnpm test:agents
`;

      const parsed = parsePlanMarkdown(planMarkdown);

      expect(parsed.milestones).toHaveLength(2);

      const m1 = parsed.milestones[0]!;
      expect(m1.code).toBe("M1");
      expect(m1.title).toBe("M1 — v1.0 Initial Release");
      expect(m1.doneWhen).toEqual([
        "The core pipeline operates end to end without manual intervention.",
        "All unit and e2e tests pass on the release branch",
        "The user can view the pipeline board",
      ]);
      expect(m1.tasks).toHaveLength(3);

      const t1 = m1.tasks[0]!;
      expect(t1.code).toBe("T1.1");
      expect(t1.title).toBe("Core implementation");
      expect(t1.tag).toBe("claude");
      expect(t1.linkedSpecSections).toEqual(["Overview", "Architecture"]);
      expect(t1.markdownStatus).toBe("todo");
      expect(t1.checkCommand).toBe("pnpm --filter @daedalus/core test");
      expect(t1.description).toBe(
        "Implement the foundation layer in packages/core.\nSupports basic state tracking and error handling.",
      );
      expect(t1.milestoneCode).toBe("M1");
      expect(t1.milestoneTitle).toBe("M1 — v1.0 Initial Release");

      const t2 = m1.tasks[1]!;
      expect(t2.code).toBe("T1.2");
      expect(t2.title).toBe("Database migrations");
      expect(t2.tag).toBe("gemini");
      expect(t2.linkedSpecSections).toEqual(["Storage"]);
      expect(t2.markdownStatus).toBe("in_progress");
      expect(t2.checkCommand).toBe("pnpm --filter @daedalus/db test");
      expect(t2.description).toBe("Create SQLite tables and run drizzle migrations.");

      const t3 = m1.tasks[2]!;
      expect(t3.code).toBe("T1.3");
      expect(t3.title).toBe("Manual review checklist");
      expect(t3.tag).toBe("you");
      expect(t3.linkedSpecSections).toEqual(["Review"]);
      expect(t3.markdownStatus).toBe("done");
      expect(t3.checkCommand).toBe("pnpm test:e2e -- manual");

      const m2 = parsed.milestones[1]!;
      expect(m2.code).toBe("M2");
      expect(m2.title).toBe("M2 — Advanced Features");
      expect(m2.doneWhen).toEqual(["Multi-agent coordination is fully verified."]);
      expect(m2.tasks).toHaveLength(1);

      expect(parsed.tasks).toHaveLength(4);
      expect(parsed.tasks.map((t) => t.code)).toEqual(["T1.1", "T1.2", "T1.3", "T2.1"]);
    });

    it("handles tasks without milestone or tags", () => {
      const content = `- [ ] **T0.1 Simple task**
  Some description.
  check: echo ok
`;
      const parsed = parsePlanMarkdown(content);
      expect(parsed.milestones).toHaveLength(0);
      expect(parsed.tasks).toHaveLength(1);
      const t = parsed.tasks[0]!;
      expect(t.code).toBe("T0.1");
      expect(t.title).toBe("Simple task");
      expect(t.tag).toBeNull();
      expect(t.linkedSpecSections).toEqual([]);
      expect(t.checkCommand).toBe("echo ok");
      expect(t.milestoneCode).toBeNull();
      expect(t.milestoneTitle).toBeNull();
    });

    it("does not pick up unindented text, non-milestone headings, or plain paragraphs into task descriptions", () => {
      // 1. Task followed by ## Notes and random text
      const input1 = `- [ ] **T1.1 A** \`[claude]\` — [[SPEC#X]]
  do a
  check: \`pnpm test\`

## Notes
Random notes here.
`;
      const parsed1 = parsePlanMarkdown(input1);
      expect(parsed1.tasks[0]?.description).toBe("do a");

      // 2. Task followed by a non-milestone ## heading
      const input2 = `- [ ] **T1.1 A** \`[claude]\` — [[SPEC#X]]
  do a
  check: \`pnpm test\`

## Documentation
`;
      const parsed2 = parsePlanMarkdown(input2);
      expect(parsed2.tasks[0]?.description).toBe("do a");

      // 3. Task followed by a plain paragraph
      const input3 = `- [ ] **T1.1 A** \`[claude]\` — [[SPEC#X]]
  do a
  check: \`pnpm test\`

Plain paragraph text here.
`;
      const parsed3 = parsePlanMarkdown(input3);
      expect(parsed3.tasks[0]?.description).toBe("do a");
    });

    it("ends open Done when list upon encountering a non-milestone heading", () => {
      const input = `## M1 — v1.0
Done when:
- Item 1

## Notes
- Not a done when item!
`;
      const parsed = parsePlanMarkdown(input);
      expect(parsed.milestones[0]?.doneWhen).toEqual(["Item 1"]);
    });
  });

  describe("syncPlanTasksToDb", () => {
    let testDir: string;
    let db: DaedalusDb;
    let projectId: number;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "daedalus-pipeline-sync-"));
      db = openDb(join(testDir, "test.db"));

      const [proj] = db
        .insert(projects)
        .values({
          name: "Sync Test Project",
          localPath: testDir,
          profile: "personal",
        })
        .returning()
        .all();
      projectId = proj!.id;
    });

    afterEach(() => {
      db.$client.close();
      rmSync(testDir, { recursive: true, force: true });
    });

    it("ignores unedited kit template PLAN.md and returns empty results", () => {
      mkdirSync(join(testDir, "docs"));
      writeFileSync(
        join(testDir, "docs", "PLAN.md"),
        `# Plan — Kit
## M1 — First milestone
- [ ] **T1.1 What to build, in one or two lines.** \`[claude]\` — [[SPEC#First-feature]]
  check: \`<command that passes when this is done>\`
`,
        "utf8",
      );

      const result = syncPlanTasksToDb(db, projectId, testDir);
      expect(result.milestones).toEqual([]);
      expect(result.tasks).toEqual([]);

      const dbRows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
      expect(dbRows).toHaveLength(0);
    });

    it("inserts new tasks with initial statuses mapped from markdown", () => {
      mkdirSync(join(testDir, "docs"));
      writeFileSync(
        join(testDir, "docs", "PLAN.md"),
        `## M1 — v1.0
Done when: It works.
- [ ] **T1.1 Queued task** \`[claude]\` — [[SPEC#Section1]]
  check: pnpm test
- [~] **T1.2 Running task** \`[gemini]\` — [[SPEC#Section2]]
  check: pnpm test
- [x] **T1.3 Done task** \`[you]\` — [[SPEC#Section3]]
  check: pnpm test
`,
        "utf8",
      );

      const result = syncPlanTasksToDb(db, projectId, testDir);
      expect(result.tasks).toHaveLength(3);

      const dbRows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
      expect(dbRows).toHaveLength(3);

      const t1 = dbRows.find((r) => r.code === "T1.1");
      const t2 = dbRows.find((r) => r.code === "T1.2");
      const t3 = dbRows.find((r) => r.code === "T1.3");

      expect(t1?.status).toBe("queued");
      expect(t2?.status).toBe("running");
      expect(t3?.status).toBe("done");

      // Verify enriched return values
      const enrichedT1 = result.tasks.find((r) => r.code === "T1.1");
      expect(enrichedT1?.milestoneCode).toBe("M1");
      expect(enrichedT1?.milestoneTitle).toBe("M1 — v1.0");
      expect(enrichedT1?.linkedSpecSections).toEqual(["Section1"]);
    });

    it("updates task metadata while preserving runtime statuses like in-review and check-failed", () => {
      mkdirSync(join(testDir, "docs"));
      writeFileSync(
        join(testDir, "docs", "PLAN.md"),
        `## M1 — v1.0
Done when: v1 works.
- [ ] **T1.1 Task One** \`[claude]\` — [[SPEC#OldSection]]
  check: pnpm test:old
- [ ] **T1.2 Task Two** \`[gemini]\` — [[SPEC#OldSection]]
  check: pnpm test:old
`,
        "utf8",
      );

      syncPlanTasksToDb(db, projectId, testDir);

      // Simulate runtime execution modifying status, branch, and attempts
      db.update(tasks)
        .set({ status: "in-review", branch: "daedalus/T1.1", attempts: 1 })
        .where(eq(tasks.code, "T1.1"))
        .run();
      db.update(tasks)
        .set({ status: "check-failed", branch: "daedalus/T1.2", attempts: 2 })
        .where(eq(tasks.code, "T1.2"))
        .run();

      // Modify PLAN.md with updated title, check command, and spec sections
      writeFileSync(
        join(testDir, "docs", "PLAN.md"),
        `## M1 — v1.0
Done when: v1 works.
- [ ] **T1.1 Task One Updated** \`[claude]\` — [[SPEC#NewSection]]
  check: pnpm test:new
- [ ] **T1.2 Task Two Updated** \`[gemini]\` — [[SPEC#NewSection]]
  check: pnpm test:new
`,
        "utf8",
      );

      const result = syncPlanTasksToDb(db, projectId, testDir);
      const t1 = result.tasks.find((r) => r.code === "T1.1")!;
      const t2 = result.tasks.find((r) => r.code === "T1.2")!;

      expect(t1.title).toBe("Task One Updated");
      expect(t1.checkCommand).toBe("pnpm test:new");
      expect(t1.linkedSpecSections).toEqual(["NewSection"]);
      expect(t1.status).toBe("in-review");
      expect(t1.branch).toBe("daedalus/T1.1");
      expect(t1.attempts).toBe(1);

      expect(t2.title).toBe("Task Two Updated");
      expect(t2.status).toBe("check-failed");
      expect(t2.branch).toBe("daedalus/T1.2");
      expect(t2.attempts).toBe(2);

      // If markdown marks a task [x], status becomes "done"
      writeFileSync(
        join(testDir, "docs", "PLAN.md"),
        `## M1 — v1.0
Done when: v1 works.
- [x] **T1.1 Task One Updated** \`[claude]\` — [[SPEC#NewSection]]
  check: pnpm test:new
- [ ] **T1.2 Task Two Updated** \`[gemini]\` — [[SPEC#NewSection]]
  check: pnpm test:new
`,
        "utf8",
      );

      const result2 = syncPlanTasksToDb(db, projectId, testDir);
      const t1AfterDone = result2.tasks.find((r) => r.code === "T1.1")!;
      expect(t1AfterDone.status).toBe("done");
    });

    it("throws ShapingError (400) when PLAN.md has duplicate task codes and leaves db unchanged", () => {
      mkdirSync(join(testDir, "docs"), { recursive: true });
      const dupPlan = `## M1 — v1.0
Done when: v1 works.
- [ ] **T1.1 Task One** \`[claude]\` — [[SPEC#Core]]
  check: pnpm test
- [ ] **T1.1 Duplicate Task** \`[gemini]\` — [[SPEC#Core]]
  check: pnpm test
`;
      writeFileSync(join(testDir, "docs", "PLAN.md"), dupPlan, "utf8");

      expect(() => syncPlanTasksToDb(db, projectId, testDir)).toThrow(
        "docs/PLAN.md has task code T1.1 more than once.",
      );

      // Verify db is unchanged (0 tasks)
      const rows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
      expect(rows).toHaveLength(0);
    });
  });
});
