import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
