import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  openDb,
  projects,
  providers,
  tasks,
  runs,
  reviews,
  usage,
  inbox,
  docNodes,
  docLinks,
} from "../src/index.js";

describe("@daedalus/db", () => {
  it("migrations apply cleanly from empty database", () => {
    const db = openDb(":memory:");
    expect(db).toBeDefined();

    // Verify all 9 application tables exist in sqlite_master
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual([
      "doc_links",
      "doc_nodes",
      "inbox",
      "projects",
      "providers",
      "reviews",
      "runs",
      "tasks",
      "usage",
    ]);
  });

  it("performs insert and select for each of the 9 tables", () => {
    const db = openDb(":memory:");

    // 1. projects
    const [project] = db
      .insert(projects)
      .values({
        name: "Daedalus",
        localPath: "/home/user/daedalus",
        profile: "default",
        gitHost: "github",
        gitRemote: "git@github.com:user/daedalus.git",
        defaultBranch: "main",
        geminiAllowed: true,
      })
      .returning()
      .all();
    expect(project).toBeDefined();
    expect(project?.id).toBe(1);
    expect(project?.name).toBe("Daedalus");
    expect(project?.geminiAllowed).toBe(true);

    const fetchedProject = db
      .select()
      .from(projects)
      .where(eq(projects.id, project!.id))
      .get();
    expect(fetchedProject).toEqual(project);

    // 2. providers
    const [provider] = db
      .insert(providers)
      .values({
        name: "claude-code",
        kind: "acp",
        launchCommand: "claude-code-acp",
        roles: ["implement", "review"],
        allowedProfiles: ["work", "personal"],
        enabled: true,
      })
      .returning()
      .all();
    expect(provider).toBeDefined();
    expect(provider?.name).toBe("claude-code");
    expect(provider?.roles).toEqual(["implement", "review"]);
    expect(provider?.allowedProfiles).toEqual(["work", "personal"]);

    const fetchedProvider = db
      .select()
      .from(providers)
      .where(eq(providers.id, provider!.id))
      .get();
    expect(fetchedProvider).toEqual(provider);

    // 3. tasks
    const [task] = db
      .insert(tasks)
      .values({
        projectId: project!.id,
        code: "T1.2",
        title: "SQLite + migrations",
        tag: "[gemini]",
        checkCommand: "pnpm --filter @daedalus/db test",
        status: "queued",
        linkedSpecSections: ["[[SPEC#Projects hub]]"],
        attempts: 1,
        branch: "daedalus/T1.2",
      })
      .returning()
      .all();
    expect(task).toBeDefined();
    expect(task?.code).toBe("T1.2");
    expect(task?.linkedSpecSections).toEqual(["[[SPEC#Projects hub]]"]);

    const fetchedTask = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task!.id))
      .get();
    expect(fetchedTask).toEqual(task);

    // 4. runs
    const [run] = db
      .insert(runs)
      .values({
        taskId: task!.id,
        providerId: provider!.id,
        role: "implement",
        start: "2026-11-20T15:00:00Z",
        end: "2026-11-20T15:05:00Z",
        exitStatus: 0,
        logPath: "/logs/run-1.log",
        usageEstimate: { promptTokens: 1200, completionTokens: 400 },
      })
      .returning()
      .all();
    expect(run).toBeDefined();
    expect(run?.role).toBe("implement");
    expect(run?.exitStatus).toBe(0);
    expect(run?.usageEstimate).toEqual({
      promptTokens: 1200,
      completionTokens: 400,
    });

    const fetchedRun = db
      .select()
      .from(runs)
      .where(eq(runs.id, run!.id))
      .get();
    expect(fetchedRun).toEqual(run);

    // 5. reviews
    const [review] = db
      .insert(reviews)
      .values({
        taskId: task!.id,
        reviewer: "claude",
        findings: "Code looks solid, all tests passing.",
        claudeTriage: "approved",
        ownerDecision: "merged",
      })
      .returning()
      .all();
    expect(review).toBeDefined();
    expect(review?.findings).toBe("Code looks solid, all tests passing.");

    const fetchedReview = db
      .select()
      .from(reviews)
      .where(eq(reviews.id, review!.id))
      .get();
    expect(fetchedReview).toEqual(review);

    // 6. usage
    const [usageRecord] = db
      .insert(usage)
      .values({
        providerId: provider!.id,
        week: "2026-W47",
        amountUsed: 15000,
        limit: 50000,
      })
      .returning()
      .all();
    expect(usageRecord).toBeDefined();
    expect(usageRecord?.amountUsed).toBe(15000);

    const fetchedUsage = db
      .select()
      .from(usage)
      .where(eq(usage.id, usageRecord!.id))
      .get();
    expect(fetchedUsage).toEqual(usageRecord);

    // 7. inbox
    const [inboxItem] = db
      .insert(inbox)
      .values({
        projectId: project!.id,
        kind: "approval",
        link: "/projects/1/tasks/1",
        read: false,
      })
      .returning()
      .all();
    expect(inboxItem).toBeDefined();
    expect(inboxItem?.kind).toBe("approval");
    expect(inboxItem?.read).toBe(false);

    const fetchedInbox = db
      .select()
      .from(inbox)
      .where(eq(inbox.id, inboxItem!.id))
      .get();
    expect(fetchedInbox).toEqual(inboxItem);

    // 8. doc_nodes
    const [docNode] = db
      .insert(docNodes)
      .values({
        projectId: project!.id,
        path: "docs/SPEC.md",
        heading: "Projects hub",
        slug: "projects-hub",
        content: "## Projects hub\nDetails...",
      })
      .returning()
      .all();
    expect(docNode).toBeDefined();
    expect(docNode?.slug).toBe("projects-hub");

    const fetchedDocNode = db
      .select()
      .from(docNodes)
      .where(eq(docNodes.id, docNode!.id))
      .get();
    expect(fetchedDocNode).toEqual(docNode);

    // 9. doc_links
    const [targetNode] = db
      .insert(docNodes)
      .values({
        projectId: project!.id,
        path: "docs/PLAN.md",
        heading: "T1.2",
        slug: "t1-2",
        content: "Task T1.2 details",
      })
      .returning()
      .all();

    const [docLink] = db
      .insert(docLinks)
      .values({
        sourceNodeId: docNode!.id,
        targetNodeId: targetNode!.id,
        rawTarget: "[[PLAN#T1.2]]",
        isEmbed: false,
      })
      .returning()
      .all();
    expect(docLink).toBeDefined();
    expect(docLink?.rawTarget).toBe("[[PLAN#T1.2]]");

    const fetchedDocLink = db
      .select()
      .from(docLinks)
      .where(eq(docLinks.id, docLink!.id))
      .get();
    expect(fetchedDocLink).toEqual(docLink);
  });

  it("enforces foreign keys on insertion", () => {
    const db = openDb(":memory:");

    // Inserting task with non-existent projectId fails
    expect(() => {
      db.insert(tasks)
        .values({
          projectId: 999999,
          code: "T99",
          title: "Non-existent project task",
        })
        .run();
    }).toThrowError(/FOREIGN KEY/i);

    // Inserting run with non-existent taskId fails
    const [provider] = db
      .insert(providers)
      .values({
        name: "test-provider",
        kind: "cli",
        launchCommand: "cmd",
        roles: ["implement"],
        allowedProfiles: ["default"],
      })
      .returning()
      .all();

    expect(() => {
      db.insert(runs)
        .values({
          taskId: 999999,
          providerId: provider!.id,
          role: "implement",
        })
        .run();
    }).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces foreign key cascade and restrict behaviors as designed", () => {
    const db = openDb(":memory:");

    // Create a project hierarchy
    const [project] = db
      .insert(projects)
      .values({
        name: "Cascade Project",
        localPath: "/path",
      })
      .returning()
      .all();

    const [provider] = db
      .insert(providers)
      .values({
        name: "agy",
        kind: "cli",
        launchCommand: "agy",
        roles: ["implement"],
        allowedProfiles: ["work"],
      })
      .returning()
      .all();

    const [task] = db
      .insert(tasks)
      .values({
        projectId: project!.id,
        code: "T1",
        title: "Test Task",
      })
      .returning()
      .all();

    db.insert(runs)
      .values({
        taskId: task!.id,
        providerId: provider!.id,
        role: "implement",
      })
      .run();

    db.insert(reviews)
      .values({
        taskId: task!.id,
        reviewer: "claude",
        findings: "approved",
      })
      .run();

    db.insert(inbox)
      .values({
        projectId: project!.id,
        kind: "quota",
        link: "/quota",
      })
      .run();

    const [docNode] = db
      .insert(docNodes)
      .values({
        projectId: project!.id,
        path: "docs/A.md",
      })
      .returning()
      .all();

    const [targetDocNode] = db
      .insert(docNodes)
      .values({
        projectId: project!.id,
        path: "docs/B.md",
      })
      .returning()
      .all();

    const [link] = db
      .insert(docLinks)
      .values({
        sourceNodeId: docNode!.id,
        targetNodeId: targetDocNode!.id,
        rawTarget: "[[B]]",
      })
      .returning()
      .all();

    db.insert(usage)
      .values({
        providerId: provider!.id,
        week: "2026-W47",
        amountUsed: 100,
      })
      .run();

    // 1. RESTRICT check: Deleting provider while runs exist should throw RESTRICT violation
    expect(() => {
      db.delete(providers).where(eq(providers.id, provider!.id)).run();
    }).toThrowError(/FOREIGN KEY/i);

    // 2. SET NULL check on doc_links target_node_id: Deleting targetDocNode sets targetNodeId to NULL
    db.delete(docNodes).where(eq(docNodes.id, targetDocNode!.id)).run();
    const updatedLink = db
      .select()
      .from(docLinks)
      .where(eq(docLinks.id, link!.id))
      .get();
    expect(updatedLink).toBeDefined();
    expect(updatedLink?.targetNodeId).toBeNull();

    // 3. CASCADE check on projects: Deleting project should cascade delete tasks, runs, reviews, inbox, doc_nodes, doc_links
    db.delete(projects).where(eq(projects.id, project!.id)).run();

    const remainingTasks = db.select().from(tasks).all();
    const remainingRuns = db.select().from(runs).all();
    const remainingReviews = db.select().from(reviews).all();
    const remainingInbox = db.select().from(inbox).all();
    const remainingDocNodes = db.select().from(docNodes).all();
    const remainingDocLinks = db.select().from(docLinks).all();

    expect(remainingTasks).toHaveLength(0);
    expect(remainingRuns).toHaveLength(0);
    expect(remainingReviews).toHaveLength(0);
    expect(remainingInbox).toHaveLength(0);
    expect(remainingDocNodes).toHaveLength(0);
    expect(remainingDocLinks).toHaveLength(0);

    // 4. CASCADE check on providers: Now that runs are gone (via task cascade), deleting provider succeeds and cascades to usage
    const providerUsageBefore = db.select().from(usage).all();
    expect(providerUsageBefore).toHaveLength(1);

    db.delete(providers).where(eq(providers.id, provider!.id)).run();

    const remainingProviders = db.select().from(providers).all();
    const remainingUsage = db.select().from(usage).all();
    expect(remainingProviders).toHaveLength(0);
    expect(remainingUsage).toHaveLength(0);
  });

  it("defaults projects.gemini_allowed to false when omitted", () => {
    const db = openDb(":memory:");
    const [project] = db
      .insert(projects)
      .values({
        name: "Untrusted Project",
        localPath: "/tmp/untrusted",
      })
      .returning()
      .all();

    expect(project).toBeDefined();
    expect(project?.geminiAllowed).toBe(false);

    const fetched = db
      .select()
      .from(projects)
      .where(eq(projects.id, project!.id))
      .get();
    expect(fetched?.geminiAllowed).toBe(false);
  });

  it("enforces DB-level CHECK constraints on enums via raw SQL inserts", () => {
    const db = openDb(":memory:");

    const [project] = db
      .insert(projects)
      .values({
        name: "Test Project",
        localPath: "/tmp/project",
      })
      .returning()
      .all();

    const [provider] = db
      .insert(providers)
      .values({
        name: "test-provider",
        kind: "acp",
        launchCommand: "cmd",
        roles: ["implement"],
        allowedProfiles: ["default"],
      })
      .returning()
      .all();

    const [task] = db
      .insert(tasks)
      .values({
        projectId: project!.id,
        code: "T1",
        title: "Test Task",
      })
      .returning()
      .all();

    // 1. providers.kind CHECK ('acp', 'cli')
    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO providers (name, kind, launch_command, roles, allowed_profiles) VALUES (?, ?, ?, ?, ?)",
        )
        .run("invalid-provider", "invalid_kind", "cmd", "[]", "[]");
    }).toThrowError(/CHECK constraint failed/i);

    // 2. runs.role CHECK ('implement', 'review', 'chat')
    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO runs (task_id, provider_id, role) VALUES (?, ?, ?)",
        )
        .run(task!.id, provider!.id, "invalid_role");
    }).toThrowError(/CHECK constraint failed/i);

    // 3. inbox.kind CHECK ('review', 'approval', 'failed_check', 'quota')
    // specifically test that the old "failed check" with space is rejected
    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO inbox (project_id, kind, link) VALUES (?, ?, ?)",
        )
        .run(project!.id, "failed check", "/link");
    }).toThrowError(/CHECK constraint failed/i);

    // Also test arbitrary invalid kind
    expect(() => {
      db.$client
        .prepare(
          "INSERT INTO inbox (project_id, kind, link) VALUES (?, ?, ?)",
        )
        .run(project!.id, "unknown_kind", "/link");
    }).toThrowError(/CHECK constraint failed/i);
  });

  it("enforces unique constraints on projects(local_path), tasks(project_id, code), and usage(provider_id, week)", () => {
    const db = openDb(":memory:");

    const [project1] = db
      .insert(projects)
      .values({
        name: "Project 1",
        localPath: "/unique/path",
      })
      .returning()
      .all();

    // 1. projects (local_path) uniqueness
    expect(() => {
      db.insert(projects)
        .values({
          name: "Project 2",
          localPath: "/unique/path",
        })
        .run();
    }).toThrowError(/UNIQUE constraint failed/i);

    // 2. tasks (project_id, code) uniqueness
    db.insert(tasks)
      .values({
        projectId: project1!.id,
        code: "T1",
        title: "Task 1",
      })
      .run();

    expect(() => {
      db.insert(tasks)
        .values({
          projectId: project1!.id,
          code: "T1",
          title: "Duplicate Code Task",
        })
        .run();
    }).toThrowError(/UNIQUE constraint failed/i);

    // Different project with same code should succeed
    const [project2] = db
      .insert(projects)
      .values({
        name: "Project 2",
        localPath: "/other/path",
      })
      .returning()
      .all();

    expect(() => {
      db.insert(tasks)
        .values({
          projectId: project2!.id,
          code: "T1",
          title: "Same Code Different Project",
        })
        .run();
    }).not.toThrow();

    // 3. usage (provider_id, week) uniqueness
    const [provider] = db
      .insert(providers)
      .values({
        name: "usage-provider",
        kind: "cli",
        launchCommand: "cmd",
        roles: ["implement"],
        allowedProfiles: ["default"],
      })
      .returning()
      .all();

    db.insert(usage)
      .values({
        providerId: provider!.id,
        week: "2026-W47",
        amountUsed: 10,
      })
      .run();

    expect(() => {
      db.insert(usage)
        .values({
          providerId: provider!.id,
          week: "2026-W47",
          amountUsed: 20,
        })
        .run();
    }).toThrowError(/UNIQUE constraint failed/i);
  });
});
