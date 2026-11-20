import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "@daedalus/db";
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
