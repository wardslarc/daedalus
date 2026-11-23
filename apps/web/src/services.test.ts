import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, tasks } from "@daedalus/db";
import { closeServices, initServices } from "./init-services.js";
import { getServices } from "./services.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("services", () => {
  afterEach(() => closeServices());

  it("throws a clear error when used before the server starts", () => {
    expect(() => getServices()).toThrow(/not initialised/);
  });

  it("opens the SQLite file in the data dir, migrated, with foreign keys on", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "svc-")), "data");
    const s = initServices({ dataDir: dir, repoRoot: "/srv/daedalus" });
    expect(existsSync(join(dir, "daedalus.db"))).toBe(true);
    expect(s.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(getServices()).toBe(s);
  });

  it("is idempotent: a second init (e.g. a dev reload) returns the same instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "svc-"));
    const a = initServices({ dataDir: dir, repoRoot: "/srv/daedalus" });
    expect(initServices({ dataDir: dir, repoRoot: "/srv/daedalus" })).toBe(a);
  });

  it("listProjects returns project rows with kitPending boolean", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
    const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });

    // Repo 1: has daedalus/kit branch
    const repo1 = mkdtempSync(join(tmpdir(), "repo1-"));
    git(repo1, "init", "--initial-branch=main");
    git(repo1, "config", "user.name", "Tester");
    git(repo1, "config", "user.email", "test@example.com");
    writeFileSync(join(repo1, "README.md"), "# repo1\n");
    git(repo1, "add", ".");
    git(repo1, "commit", "-m", "init");
    git(repo1, "branch", "daedalus/kit");

    // Repo 2: has no daedalus/kit branch
    const repo2 = mkdtempSync(join(tmpdir(), "repo2-"));
    git(repo2, "init", "--initial-branch=main");
    git(repo2, "config", "user.name", "Tester");
    git(repo2, "config", "user.email", "test@example.com");
    writeFileSync(join(repo2, "README.md"), "# repo2\n");
    git(repo2, "add", ".");
    git(repo2, "commit", "-m", "init");

    // Repo 3: directory does not exist
    const repo3 = join(tmpdir(), "nonexistent-" + Date.now());

    s.db.insert(projects).values([
      { name: "P1", localPath: repo1, profile: "personal" },
      { name: "P2", localPath: repo2, profile: "work" },
      { name: "P3", localPath: repo3, profile: "client" },
    ]).run();

    const list = await s.listProjects();
    expect(list).toHaveLength(3);
    const p1 = list.find((p) => p.name === "P1");
    const p2 = list.find((p) => p.name === "P2");
    const p3 = list.find((p) => p.name === "P3");
    expect(p1?.kitPending).toBe(true);
    expect(p2?.kitPending).toBe(false);
    expect(p3?.kitPending).toBe(false);
  });

  describe("updateProjectSettings", () => {
    it("saves a Client opt-in", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });
      const [inserted] = s.db
        .insert(projects)
        .values({
          name: "Client Proj",
          localPath: "/tmp/client-proj",
          profile: "client",
          geminiAllowed: false,
        })
        .returning()
        .all();

      const result = await s.updateProjectSettings(inserted!.id, {
        profile: "client",
        geminiAllowed: true,
      });

      expect(result.project.profile).toBe("client");
      expect(result.project.geminiAllowed).toBe(true);

      const row = s.db.select().from(projects).where(eq(projects.id, inserted!.id)).get();
      expect(row?.profile).toBe("client");
      expect(row?.geminiAllowed).toBe(true);
    });

    it("Work + geminiAllowed true throws ProfileRuleError and the row is unchanged", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });
      const [inserted] = s.db
        .insert(projects)
        .values({
          name: "Work Proj",
          localPath: "/tmp/work-proj",
          profile: "work",
          geminiAllowed: false,
        })
        .returning()
        .all();

      await expect(
        s.updateProjectSettings(inserted!.id, {
          profile: "work",
          geminiAllowed: true,
        }),
      ).rejects.toThrow(/can't allow Gemini/);

      const row = s.db.select().from(projects).where(eq(projects.id, inserted!.id)).get();
      expect(row?.profile).toBe("work");
      expect(row?.geminiAllowed).toBe(false);
    });

    it("unknown id throws 404-status error", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });

      try {
        await s.updateProjectSettings(999999, {
          profile: "work",
          geminiAllowed: false,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as { status?: number }).status).toBe(404);
      }
    });

    it("stops a running agent the new settings no longer allow, and only that one", async () => {
      const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-data-")), repoRoot: "/srv/daedalus" });
      const [p] = s.db.insert(projects).values({ name: "C", localPath: "/tmp/c", profile: "client", geminiAllowed: true }).returning().all();
      const fakeSession = (id: string, projectId: number, providerId: string) => ({ id, project: { id: projectId }, providerId, stop: vi.fn(async () => undefined) });
      const agy = fakeSession("s1", p!.id, "antigravity");
      const claude = fakeSession("s2", p!.id, "claude");
      const otherAgy = fakeSession("s3", p!.id + 1, "antigravity");
      vi.spyOn(s.sessions, "list").mockReturnValue([agy, claude, otherAgy] as never);

      const result = await s.updateProjectSettings(p!.id, { profile: "client", geminiAllowed: false });

      expect(agy.stop).toHaveBeenCalledOnce();
      expect(claude.stop).not.toHaveBeenCalled();
      expect(otherAgy.stop).not.toHaveBeenCalled();
      expect(result.stoppedSessions).toEqual(["s1"]);
    });

    it("switching a Client project with Gemini on to Work is refused (not silently turned off)", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });
      const [inserted] = s.db
        .insert(projects)
        .values({
          name: "Client With Gemini",
          localPath: "/tmp/client-gemini",
          profile: "client",
          geminiAllowed: true,
        })
        .returning()
        .all();

      await expect(
        s.updateProjectSettings(inserted!.id, {
          profile: "work",
        }),
      ).rejects.toThrow(/can't allow Gemini/);

      const row = s.db.select().from(projects).where(eq(projects.id, inserted!.id)).get();
      expect(row?.profile).toBe("client");
      expect(row?.geminiAllowed).toBe(true);
    });
  });
});

describe("services: provider registry", () => {
  afterEach(() => {
    closeServices();
    delete process.env.DAE_PROVIDERS_FILE;
  });

  it("loads providers.json at startup and mirrors it into the providers table", () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-prov-")), repoRoot: "/srv/daedalus" });
    expect(s.providers.map((p) => p.id).sort()).toEqual(["antigravity", "claude"]);
    const rows = s.db.$client.prepare("SELECT name, enabled FROM providers ORDER BY name").all();
    expect(rows).toEqual([
      { name: "antigravity", enabled: 1 },
      { name: "claude", enabled: 1 },
    ]);
  });

  it("refuses to start with a broken providers file", () => {
    const dir = mkdtempSync(join(tmpdir(), "svc-prov-"));
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "claude", kind: "acp" }] }));
    process.env.DAE_PROVIDERS_FILE = join(dir, "providers.json");
    expect(() => initServices({ dataDir: dir, repoRoot: "/srv/daedalus" })).toThrow(/providers\.json/);
  });
});

describe("services: agent sessions", () => {
  afterEach(() => closeServices());

  it("closeServices stops every agent session before closing the database", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-sess-")), repoRoot: "/srv/daedalus" });
    const stopAll = vi.spyOn(s.sessions, "stopAll");
    await closeServices();
    expect(stopAll).toHaveBeenCalledOnce();
    expect(() => getServices()).toThrow(/not initialised/);
  });
});

describe("services: session REST helpers", () => {
  afterEach(() => closeServices());

  it("startSession loads the project from the database and applies the profile rules", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-rest-")), repoRoot: "/srv/daedalus" });
    const [work] = s.db.insert(projects).values({ name: "W", localPath: mkdtempSync(join(tmpdir(), "w-")), profile: "work", geminiAllowed: false }).returning().all();
    await expect(s.startSession(work!.id, "antigravity")).rejects.toMatchObject({ name: "ProfileRuleError" });
    await expect(s.startSession(999999, "claude")).rejects.toMatchObject({ status: 404 });
    expect(s.listSessions()).toEqual([]);
    await expect(s.stopSession("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("services: project chat and intake", () => {
  afterEach(() => closeServices());

  it("getProjectChat returns 404 for unknown project", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-chat-")), repoRoot: "/srv/daedalus" });
    await expect(s.getProjectChat(999999)).rejects.toMatchObject({ status: 404 });
  });

  it("getProjectChat returns shaping state, project info, and rules", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-chat-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-chat-"));
    const [p] = s.db
      .insert(projects)
      .values({ name: "ChatProj", localPath: repo, profile: "client", geminiAllowed: true })
      .returning()
      .all();

    const chat = await s.getProjectChat(p!.id);
    expect(chat.project.id).toBe(p!.id);
    expect(chat.currentStep).toBe("intake");
    expect(chat.rules.effectiveGemini).toBe(true);
    expect(chat.steps.find((st) => st.id === "mock")?.provider).toBe("Claude / Antigravity");
  });

  it("saveIntake saves docs/INTAKE.md and advances step to spec", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-chat-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-chat-"));
    const [p] = s.db
      .insert(projects)
      .values({ name: "ChatProj", localPath: repo, profile: "personal", geminiAllowed: true })
      .returning()
      .all();

    const saved = await s.saveIntake(p!.id, {
      fields: {
        problem: "Goal is great",
        users: "Me",
        constraints: "None",
      },
    });

    expect(saved.ok).toBe(true);
    expect(saved.currentStep).toBe("spec");
    expect(saved.steps[0]!.status).toBe("completed");

    const chat = await s.getProjectChat(p!.id);
    expect(chat.currentStep).toBe("spec");
    expect(chat.intake.exists).toBe(true);
    expect(chat.intake.fields.problem).toBe("Goal is great");
  });

  it("approveSpec enforces ## Verify section and advances step to mock (T4.2)", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-chat-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-chat-"));
    const [p] = s.db
      .insert(projects)
      .values({ name: "SpecProj", localPath: repo, profile: "work", geminiAllowed: false })
      .returning()
      .all();

    await s.saveIntake(p!.id, {
      fields: {
        problem: "Fragmented workflow",
        users: "Solo dev",
        constraints: "Local only",
      },
    });

    // Write SPEC.md without ## Verify -> approveSpec rejects
    writeFileSync(join(repo, "docs", "SPEC.md"), "# Spec\n\n## Overview\n- Feature\n", "utf8");
    await expect(s.approveSpec(p!.id)).rejects.toThrow(/## Verify/i);

    // Update SPEC.md with ## Verify -> approveSpec succeeds and advances to mock
    writeFileSync(
      join(repo, "docs", "SPEC.md"),
      "# Spec\n\n## Overview\n- Feature\n\n## Verify\n- End-to-end check passes\n",
      "utf8",
    );
    const approved = await s.approveSpec(p!.id);
    expect(approved.ok).toBe(true);
    expect(approved.currentStep).toBe("mock");
    expect(approved.spec.approved).toBe(true);
  });

  it("startMockSession enforces profile rules (refuses antigravity on Work, allows on Personal)", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-mock-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-mock-"));
    const [workP] = s.db
      .insert(projects)
      .values({ name: "WorkMock", localPath: repo, profile: "work", geminiAllowed: false })
      .returning()
      .all();

    await s.saveIntake(workP!.id, {
      fields: { problem: "P", users: "U", constraints: "C" },
    });
    writeFileSync(
      join(repo, "docs", "SPEC.md"),
      "# Spec\n\n## Overview\n- F\n\n## Verify\n- Passes\n",
      "utf8",
    );
    await s.approveSpec(workP!.id);

    // Antigravity refused on Work
    await expect(s.startMockSession(workP!.id, "antigravity")).rejects.toThrow(/Gemini/i);

    // Personal project allows antigravity
    const persRepo = mkdtempSync(join(tmpdir(), "repo-pers-mock-"));
    const [persP] = s.db
      .insert(projects)
      .values({ name: "PersMock", localPath: persRepo, profile: "personal", geminiAllowed: true })
      .returning()
      .all();

    await s.saveIntake(persP!.id, {
      fields: { problem: "P", users: "U", constraints: "C" },
    });
    writeFileSync(
      join(persRepo, "docs", "SPEC.md"),
      "# Spec\n\n## Overview\n- F\n\n## Verify\n- Passes\n",
      "utf8",
    );
    await s.approveSpec(persP!.id);

    vi.spyOn(s.sessions, "start").mockResolvedValueOnce({
      id: "fake-mock-session",
      project: persP!,
      providerId: "antigravity",
      startedAt: new Date().toISOString(),
      isBusy: false,
      backlog: () => [],
      prompt: vi.fn().mockResolvedValue(undefined),
    } as never);

    const started = await s.startMockSession(persP!.id, "antigravity");
    expect(started.session.providerId).toBe("antigravity");
    expect(started.prompt).toContain("[Mock build]");
  });

  it("approveMock validates and advances to plan, stopping running mock session", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-mock-app-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-mock-app-"));
    const [p] = s.db
      .insert(projects)
      .values({ name: "AppMock", localPath: repo, profile: "personal", geminiAllowed: true })
      .returning()
      .all();

    await s.saveIntake(p!.id, {
      fields: { problem: "P", users: "U", constraints: "C" },
    });
    writeFileSync(
      join(repo, "docs", "SPEC.md"),
      "# Spec\n\n## Overview\n- F\n\n## Verify\n- Passes\n",
      "utf8",
    );
    await s.approveSpec(p!.id);
    await s.startMockSession(p!.id, "claude");

    // Session is running
    expect(s.sessions.list().some((sess) => sess.project.id === p!.id)).toBe(true);

    // Rejects if mock.html missing
    await expect(
      s.approveMock(p!.id, { artifactUrl: "https://claude.site/artifacts/123", approvedBy: "Tester" }),
    ).rejects.toThrow(/mock\.html/i);

    writeFileSync(join(repo, "docs", "mock.html"), "<html><body>Mock UI</body></html>", "utf8");

    // Rejects invalid URL
    await expect(
      s.approveMock(p!.id, { artifactUrl: "not-url", approvedBy: "Tester" }),
    ).rejects.toThrow(/valid/i);

    const clientTimestamp = "2020-01-01T00:00:00.000Z";
    const approved = await s.approveMock(p!.id, {
      artifactUrl: "https://claude.site/artifacts/456",
      approvedBy: "Alice",
      approvedAt: clientTimestamp,
    } as unknown as Parameters<typeof s.approveMock>[1]);

    expect(approved.ok).toBe(true);
    expect(approved.currentStep).toBe("plan");
    expect(approved.mock.approved).toBe(true);
    expect(approved.approval.artifactUrl).toBe("https://claude.site/artifacts/456");
    expect(approved.approval.approvedBy).toBe("Alice");
    expect(approved.approval.approvedAt).not.toBe(clientTimestamp);

    // Running mock session stopped
    expect(s.sessions.list().some((sess) => sess.project.id === p!.id)).toBe(false);
  });

  it("ignores forged docs/.shaping.json in project folder", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-forged-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-forged-"));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Tester");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "# Forged\n", "utf8");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");

    const [p] = s.db
      .insert(projects)
      .values({ name: "ForgedProj", localPath: repo, profile: "personal", geminiAllowed: true })
      .returning()
      .all();

    mkdirSync(join(repo, "docs"));
    writeFileSync(
      join(repo, "docs", ".shaping.json"),
      JSON.stringify({
        mockApproval: {
          artifactUrl: "https://claude.site/artifacts/forged",
          approvedBy: "Attacker",
          approvedAt: "2020-01-01T00:00:00.000Z",
        },
        planApprovedAt: "2020-01-01T00:00:00.000Z",
        activeMilestone: {
          version: "v1.0",
          branch: "daedalus/release-v1.0",
          startedAt: "2020-01-01T00:00:00.000Z",
          frozen: false,
        },
      }),
      "utf8",
    );

    const chat = await s.getProjectChat(p!.id);
    expect(chat.mock.approved).toBe(false);
    expect(chat.plan.approved).toBe(false);
    expect(chat.plan.activeMilestone).toBeNull();
  });

  it("requires db record for approval: imported repo with docs stays at spec and refuses downstream sessions", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-no-rec-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-no-rec-"));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Tester");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "# NoRec\n", "utf8");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "INTAKE.md"), "# Intake\n- **Problem:** Real problem\n- **Users:** Developers\n- **Constraints:** None\n", "utf8");
    writeFileSync(join(repo, "docs", "SPEC.md"), "# Spec\n\n## Overview\n- Features\n\n## Verify\n- E2E passes\n", "utf8");
    writeFileSync(join(repo, "docs", "mock.html"), "<html><body>Mock</body></html>", "utf8");
    writeFileSync(
      join(repo, "docs", "PLAN.md"),
      [
        "# Plan",
        "",
        "## M1 — v1.0",
        "",
        "Done when: ready",
        "",
        "- [ ] **T1.1 Task** `[claude]` — [[SPEC#Overview]]",
        "  check: `pnpm test`",
        "",
      ].join("\n"),
      "utf8",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");

    const [p] = s.db
      .insert(projects)
      .values({ name: "NoRecProj", localPath: repo, profile: "personal", geminiAllowed: true, defaultBranch: "main" })
      .returning()
      .all();

    const chat = await s.getProjectChat(p!.id);
    expect(chat.spec.approved).toBe(false);
    expect(chat.mock.approved).toBe(false);
    expect(chat.plan.approved).toBe(false);
    expect(chat.currentStep).toBe("spec");

    await expect(s.startPlanSession(p!.id)).rejects.toThrow(/SPEC\.md/i);
    await expect(s.approvePlan(p!.id)).rejects.toThrow(/SPEC\.md/i);
    await expect(s.startMilestone(p!.id)).rejects.toThrow(/SPEC\.md/i);
  });

  it("approvePlan saves docs/PLAN.md and startMilestone creates daedalus/release-v1.0 in git (T4.4)", async () => {
    const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-plan-")), repoRoot: "/srv/daedalus" });
    const repo = mkdtempSync(join(tmpdir(), "repo-plan-"));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Tester");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "# PlanRepo\n", "utf8");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");

    const [p] = s.db
      .insert(projects)
      .values({ name: "PlanProj", localPath: repo, profile: "personal", geminiAllowed: true, defaultBranch: "main" })
      .returning()
      .all();

    await s.saveIntake(p!.id, { fields: { problem: "P", users: "U", constraints: "C" } });
    writeFileSync(join(repo, "docs", "SPEC.md"), "# Spec\n\n## Overview\n- F\n\n## Verify\n- Passes\n", "utf8");
    await s.approveSpec(p!.id);
    writeFileSync(join(repo, "docs", "mock.html"), "<html><body>Mock</body></html>", "utf8");
    await s.approveMock(p!.id, {
      artifactUrl: "https://claude.site/artifacts/789",
      approvedBy: "Carls",
    });

    const planMd = [
      "# Plan — PlanProj",
      "",
      "## M1 — v1.0 Initial Release",
      "",
      "Done when: end-to-end tests pass.",
      "",
      "- [ ] **T1.1 First task** `[claude]` — [[SPEC#Overview]]",
      "  Implement feature.",
      "  check: `pnpm test`",
      "",
    ].join("\n");

    const approvedPlan = await s.approvePlan(p!.id, { content: planMd });
    expect(approvedPlan.ok).toBe(true);
    expect(approvedPlan.plan.approved).toBe(true);

    // Syncing into DB on approvePlan
    const dbTasks = s.db.select().from(tasks).where(eq(tasks.projectId, p!.id)).all();
    expect(dbTasks).toHaveLength(1);
    expect(dbTasks[0]?.code).toBe("T1.1");
    expect(dbTasks[0]?.status).toBe("queued");

    const started = await s.startMilestone(p!.id, { version: "v1.0" });
    expect(started.ok).toBe(true);
    expect(started.milestone.branch).toBe("daedalus/release-v1.0");
    expect(started.milestone.frozen).toBe(true);

    const branchOut = git(repo, "branch", "--list", "daedalus/release-v1.0");
    expect(branchOut).toContain("daedalus/release-v1.0");
  });

  describe("getProjectPipeline", () => {
    it("throws 404 if project does not exist", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });
      await expect(s.getProjectPipeline(99999)).rejects.toThrow(/No such project/);
    });

    it("returns shaping stage during shaping, then Build/Review/Verify during milestone execution", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "svc-data-"));
      const s = initServices({ dataDir, repoRoot: "/srv/daedalus" });

      const repo = mkdtempSync(join(tmpdir(), "repo-pipe-"));
      git(repo, "init", "--initial-branch=main");
      git(repo, "config", "user.name", "Tester");
      git(repo, "config", "user.email", "test@example.com");
      writeFileSync(join(repo, "README.md"), "# PipeRepo\n", "utf8");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "init");

      const [p] = s.db
        .insert(projects)
        .values({ name: "PipeProj", localPath: repo, profile: "personal", defaultBranch: "main" })
        .returning()
        .all();

      // Stage during shaping (Intake)
      let pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Intake");
      expect(pipe.tasks).toHaveLength(0);

      // Move to Spec
      await s.saveIntake(p!.id, { fields: { problem: "P", users: "U", constraints: "C" } });
      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Spec");

      // Move to Mock
      writeFileSync(join(repo, "docs", "SPEC.md"), "# Spec\n\n## Overview\n- F\n\n## Verify\n- Passes\n", "utf8");
      await s.approveSpec(p!.id);
      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Mock");

      // Move to Plan
      writeFileSync(join(repo, "docs", "mock.html"), "<html><body>Mock</body></html>", "utf8");
      await s.approveMock(p!.id, { artifactUrl: "https://mock.com", approvedBy: "Carls" });
      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Plan");

      // Approve plan and start milestone -> Build stage
      const planMd = [
        "## M1 — v1.0",
        "Done when: all tasks pass.",
        "- [ ] **T1.1 Task One** `[claude]` — [[SPEC#Overview]]",
        "  check: pnpm test:1",
        "- [ ] **T1.2 Task Two** `[gemini]` — [[SPEC#Overview]]",
        "  check: pnpm test:2",
      ].join("\n");
      await s.approvePlan(p!.id, { content: planMd });
      await s.startMilestone(p!.id, { version: "v1.0" });

      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Build");
      expect(pipe.tasks).toHaveLength(2);
      expect(pipe.activeMilestone?.branch).toBe("daedalus/release-v1.0");

      // When a task is in-review -> Review stage
      s.db.update(tasks).set({ status: "in-review" }).where(eq(tasks.code, "T1.1")).run();
      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Review");

      // When all tasks are done -> Verify stage
      s.db.update(tasks).set({ status: "done" }).where(eq(tasks.code, "T1.1")).run();
      s.db.update(tasks).set({ status: "done" }).where(eq(tasks.code, "T1.2")).run();
      pipe = await s.getProjectPipeline(p!.id);
      expect(pipe.stage).toBe("Verify");
    });

    it("sends mock approval POST straight after saving intake and gets 400 (BRIEF section 6)", async () => {
      const s = initServices({ dataDir: mkdtempSync(join(tmpdir(), "svc-mock-gate-")), repoRoot: "/srv/daedalus" });
      const repo = mkdtempSync(join(tmpdir(), "repo-mock-gate-"));
      const [p] = s.db
        .insert(projects)
        .values({ name: "GateProj", localPath: repo, profile: "personal", geminiAllowed: true })
        .returning()
        .all();

      await s.saveIntake(p!.id, { fields: { problem: "P", users: "U", constraints: "C" } });
      writeFileSync(join(repo, "docs", "mock.html"), "<html><body>Mock</body></html>", "utf8");

      // Calling approveMock directly without spec approval rejects
      await expect(
        s.approveMock(p!.id, { artifactUrl: "https://claude.site/artifacts/123", approvedBy: "Carls" }),
      ).rejects.toThrow(/SPEC\.md/i);

      // Sending mock approval POST straight after saving intake gets 400
      const { POST: mockRoutePost } = await import("../app/api/projects/[id]/chat/mock/route.js");
      const req = new Request(`http://127.0.0.1/api/projects/${p!.id}/chat/mock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactUrl: "https://claude.site/artifacts/123", approvedBy: "Carls" }),
      });
      const res = await mockRoutePost(req, { params: Promise.resolve({ id: String(p!.id) }) });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toMatch(/SPEC\.md/i);
    });
  });
});

