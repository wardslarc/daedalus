import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, projects } from "@daedalus/db";
import { ProfileRuleError } from "@daedalus/core/profiles";
import { KIT_FILES } from "@daedalus/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { addKitOnBranch, importProject, KIT_BRANCH, type GitOps } from "../src/import.js";
import { ImportError } from "../src/source.js";

/** Fake git: records calls, "repos" are folders containing .git, worktrees are plain folders. */
function fakeGit(over: Partial<GitOps> = {}) {
  const calls: string[] = [];
  const branches = new Set<string>(["main"]);
  const committed: { dir: string; files: string[]; noVerify?: boolean }[] = [];
  const git: GitOps = {
    isRepo: async (d) => existsSync(join(d, ".git")),
    clone: async (url, dest) => {
      calls.push(`clone ${url}`);
      mkdirSync(join(dest, ".git"), { recursive: true });
    },
    branchExists: async (_d, b) => branches.has(b),
    currentBranch: async () => "main",
    remoteUrl: async () => "git@gitlab.com:team/app.git",
    detectHost: (u) => (u.includes("gitlab") ? "gitlab" : u.includes("github") ? "github" : "other"),
    addWorktree: async (_repo, wt, { branch, from }) => {
      calls.push(`worktree add ${branch} from ${from}`);
      branches.add(branch);
      mkdirSync(wt, { recursive: true });
    },
    removeWorktree: async () => {
      calls.push("worktree remove");
    },
    deleteBranch: async (_repo, b) => {
      calls.push(`branch -D ${b}`);
      branches.delete(b);
    },
    commitFiles: async (dir, files, _m, opts) => {
      committed.push({ dir, files, noVerify: opts?.noVerify });
      return "abc123";
    },
    ...over,
  };
  return { git, calls, branches, committed };
}

const repo = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "imp-repo-"));
  mkdirSync(join(dir, ".git"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};

describe("addKitOnBranch", () => {
  const vars = { PROJECT_NAME: "App", PROFILE: "Personal", TODAY: "2026-11-20", PROFILE_RULES: "- r" };

  it("commits only the missing kit files on daedalus/kit, in a worktree outside the repo, without hooks", async () => {
    const dir = repo({ "AGENTS.md": "mine" });
    const { git, calls, committed } = fakeGit();
    const res = await addKitOnBranch(dir, vars, { git, tmpRoot: tmpdir(), baseBranch: "main" });
    expect(res.status).toBe("added");
    expect(calls).toContain(`worktree add ${KIT_BRANCH} from main`);
    expect(calls.at(-1)).toBe("worktree remove");
    const c = committed[0]!;
    expect(c.dir.startsWith(dir)).toBe(false);
    expect(c.noVerify).toBe(true);
    expect(c.files).not.toContain("AGENTS.md");
    expect(c.files.length).toBe(KIT_FILES.length - 1);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
  });

  it("does nothing when the kit is already complete", async () => {
    const dir = repo(Object.fromEntries(KIT_FILES.map((f) => [f, "x"])));
    const { git, calls } = fakeGit();
    expect((await addKitOnBranch(dir, vars, { git, tmpRoot: tmpdir(), baseBranch: "main" })).status).toBe("complete");
    expect(calls).toEqual([]);
  });

  it("leaves an existing daedalus/kit branch alone", async () => {
    const dir = repo();
    const { git, calls, branches } = fakeGit();
    branches.add(KIT_BRANCH);
    expect((await addKitOnBranch(dir, vars, { git, tmpRoot: tmpdir(), baseBranch: "main" })).status).toBe("exists");
    expect(calls).toEqual([]);
  });

  it("removes the worktree and the half-made branch if the commit fails", async () => {
    const dir = repo();
    const { git, calls, branches } = fakeGit({
      commitFiles: async () => {
        throw new Error("hook exploded");
      },
    });
    await expect(addKitOnBranch(dir, vars, { git, tmpRoot: tmpdir(), baseBranch: "main" })).rejects.toThrow("hook exploded");
    expect(calls).toContain("worktree remove");
    expect(branches.has(KIT_BRANCH)).toBe(false);
  });
});

describe("importProject", () => {
  let db: ReturnType<typeof openDb>;
  let home: string;
  beforeEach(() => {
    db = openDb(":memory:");
    home = mkdtempSync(join(tmpdir(), "home-"));
  });
  const deps = (git: GitOps) => ({ db, git, home, forbiddenRoots: ["/srv/daedalus"], tmpRoot: tmpdir(), today: "2026-11-20" });

  it("imports a local repo: row saved with profile, kit added, warnings for a host mismatch", async () => {
    const dir = repo();
    const { git } = fakeGit({ remoteUrl: async () => "https://github.com/me/app.git" });
    const res = await importProject({ source: dir, profile: "work" }, deps(git));
    expect(res.kit.status).toBe("added");
    expect(res.project).toMatchObject({ localPath: dir, profile: "work", geminiAllowed: false, gitHost: "github", defaultBranch: "main" });
    expect(res.warnings.join(" ")).toMatch(/GitLab/);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });

  it("refuses Work + Gemini before touching anything", async () => {
    const dir = repo();
    const { git, calls } = fakeGit();
    await expect(importProject({ source: dir, profile: "work", geminiAllowed: true }, deps(git))).rejects.toThrow(ProfileRuleError);
    expect(calls).toEqual([]);
    expect(db.select().from(projects).all()).toHaveLength(0);
  });

  it("answers 409 when the folder is already imported", async () => {
    const dir = repo();
    const { git } = fakeGit();
    await importProject({ source: dir, profile: "personal" }, deps(git));
    await expect(importProject({ source: dir, profile: "personal" }, deps(git))).rejects.toMatchObject({ status: 409 });
  });

  it("clones a URL into the profile's folder", async () => {
    const { git, calls } = fakeGit();
    const res = await importProject({ source: "https://github.com/me/Bilyo.git", profile: "personal" }, deps(git));
    expect(calls[0]).toBe("clone https://github.com/me/Bilyo.git");
    expect(res.project.localPath).toBe(join(home, "projects", "bilyo"));
    expect(res.project.name).toBe("bilyo");
  });

  it("won't clone over an existing folder", async () => {
    mkdirSync(join(home, "work", "app"), { recursive: true });
    const { git, calls } = fakeGit();
    await expect(importProject({ source: "git@gitlab.com:team/app.git", profile: "work" }, deps(git))).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
  });

  it("deletes a fresh clone if a later step fails, but never a folder the owner pointed at", async () => {
    const boom = { addWorktree: async () => { throw new Error("no worktree"); } };
    const a = fakeGit(boom);
    await expect(importProject({ source: "https://github.com/me/app.git", profile: "personal" }, deps(a.git))).rejects.toThrow();
    expect(existsSync(join(home, "projects", "app"))).toBe(false);

    const dir = repo();
    const b = fakeGit(boom);
    await expect(importProject({ source: dir, profile: "personal" }, deps(b.git))).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  it("validates the display name", async () => {
    const { git } = fakeGit();
    await expect(importProject({ source: repo(), profile: "personal", name: "a\u0000b" }, deps(git))).rejects.toThrow(ImportError);
    await expect(importProject({ source: repo(), profile: "personal", name: "x".repeat(101) }, deps(git))).rejects.toThrow(ImportError);
    const ok = await importProject({ source: repo(), profile: "personal", name: "  My App  " }, deps(git));
    expect(ok.project.name).toBe("My App");
  });
});
