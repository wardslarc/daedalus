import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, projects } from "@daedalus/db";
import { ProfileRuleError } from "@daedalus/core/profiles";
import { KIT_FILES } from "@daedalus/kit";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/create.js";
import { realGitOps } from "../src/git-ops.js";
import { ImportError } from "../src/source.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeTempHome(prefix = "dae-test-home-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeTestDb(): ReturnType<typeof openDb> {
  const dbDir = mkdtempSync(join(tmpdir(), "dae-test-db-"));
  return openDb(join(dbDir, "test.db"));
}

describe("createProject", () => {
  const today = "2026-11-20";

  it("creates a new project: folder has every kit file, exactly one commit on main, profile rules in AGENTS.md", async () => {
    const home = makeTempHome();
    const db = makeTestDb();

    const { project } = await createProject(
      { name: "My New Project", profile: "personal" },
      { db, git: realGitOps, home, today },
    );

    expect(project).toBeDefined();
    expect(project.name).toBe("My New Project");
    expect(project.profile).toBe("personal");
    expect(project.defaultBranch).toBe("main");
    expect(project.gitRemote).toBeNull();
    expect(project.gitHost).toBeNull();

    const expectedFolder = join(home, "projects", "my-new-project");
    expect(project.localPath).toBe(expectedFolder);
    expect(existsSync(expectedFolder)).toBe(true);

    // Folder has every kit file
    for (const f of KIT_FILES) {
      expect(existsSync(join(expectedFolder, f)), `Missing kit file ${f}`).toBe(true);
    }

    // AGENTS.md has profile rules
    const agentsMd = readFileSync(join(expectedFolder, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("# My New Project — agent guide");
    expect(agentsMd).toContain("## Profile: Personal");
    expect(agentsMd).toContain("- Claude and Gemini are both allowed.");

    // Exactly one commit on main
    expect(git(expectedFolder, "branch", "--show-current")).toBe("main");
    const log = git(expectedFolder, "log", "--oneline").split("\n").filter(Boolean);
    expect(log).toHaveLength(1);
    expect(git(expectedFolder, "log", "-1", "--format=%s")).toBe("Start My New Project from the Daedalus kit");
  });

  it("Work + geminiAllowed: true throws ProfileRuleError and creates no folder", async () => {
    const home = makeTempHome();
    const db = makeTestDb();

    await expect(
      createProject(
        { name: "Work App", profile: "work", geminiAllowed: true },
        { db, git: realGitOps, home, today },
      ),
    ).rejects.toThrow(ProfileRuleError);

    const folder = join(home, "work", "work-app");
    expect(existsSync(folder)).toBe(false);
  });

  it("fails with 409 ImportError if the folder or project row already exists", async () => {
    const home = makeTempHome();
    const db = makeTestDb();

    await createProject(
      { name: "Existing Project", profile: "personal" },
      { db, git: realGitOps, home, today },
    );

    // Existing folder on disk
    await expect(
      createProject(
        { name: "Existing Project", profile: "personal" },
        { db, git: realGitOps, home, today },
      ),
    ).rejects.toThrow(ImportError);
    await expect(
      createProject(
        { name: "Existing Project", profile: "personal" },
        { db, git: realGitOps, home, today },
      ),
    ).rejects.toMatchObject({
      name: "ImportError",
      status: 409,
    });

    // Existing project row in db (different disk location or disk cleared)
    const folder2 = join(home, "projects", "row-conflict");
    db.insert(projects)
      .values({
        name: "Row Conflict",
        localPath: folder2,
        profile: "personal",
        defaultBranch: "main",
      })
      .run();

    await expect(
      createProject(
        { name: "Row Conflict", profile: "personal" },
        { db, git: realGitOps, home, today },
      ),
    ).rejects.toThrow(ImportError);
    await expect(
      createProject(
        { name: "Row Conflict", profile: "personal" },
        { db, git: realGitOps, home, today },
      ),
    ).rejects.toMatchObject({
      name: "ImportError",
      status: 409,
    });
  });

  it("bad names throw 400 ImportError", async () => {
    const home = makeTempHome();
    const db = makeTestDb();

    const badNames = [
      "",
      "   ",
      "a".repeat(101),
      "bad\0name",
      "bad\nname",
      "???",
      "---",
      "...",
    ];

    for (const name of badNames) {
      await expect(
        createProject(
          { name, profile: "personal" },
          { db, git: realGitOps, home, today },
        ),
      ).rejects.toMatchObject({
        name: "ImportError",
        status: 400,
      });
    }
  });

  it("removes the folder when the DB insert fails", async () => {
    const home = makeTempHome();
    const db = makeTestDb();

    // Cause DB insert to fail by mocking db.insert to throw
    const brokenDb = {
      ...db,
      select: db.select.bind(db),
      insert: () => {
        throw new Error("Disk full or DB crashed");
      },
    } as unknown as ReturnType<typeof openDb>;

    await expect(
      createProject(
        { name: "Failing Db", profile: "personal" },
        { db: brokenDb, git: realGitOps, home, today },
      ),
    ).rejects.toThrow("Disk full or DB crashed");

    const folder = join(home, "projects", "failing-db");
    expect(existsSync(folder)).toBe(false);
  });
});
