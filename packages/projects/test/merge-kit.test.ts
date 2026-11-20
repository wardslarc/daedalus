import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@daedalus/db";
import { describe, expect, it } from "vitest";
import { importProject, KIT_BRANCH, mergeKit, realGitOps } from "../src/index.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** A repo imported through T2.4, so daedalus/kit exists. */
async function imported(setup?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mk-"));
  g(dir, "init", "--initial-branch=main");
  g(dir, "config", "user.name", "Owner");
  g(dir, "config", "user.email", "o@example.com");
  writeFileSync(join(dir, "README.md"), "# app\n");
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "init");
  const res = await importProject(
    { source: dir, profile: "personal" },
    { db: openDb(":memory:"), git: realGitOps, home: mkdtempSync(join(tmpdir(), "h-")), forbiddenRoots: [], tmpRoot: tmpdir(), today: "2026-11-20" },
  );
  setup?.(dir);
  return { dir, project: res.project };
}
const deps = { tmpRoot: tmpdir() };
const worktrees = (dir: string) => g(dir, "worktree", "list").split("\n").length;

describe("mergeKit", () => {
  it("merges into the checked-out, clean main and deletes daedalus/kit", async () => {
    const { dir, project } = await imported();
    const res = await mergeKit(project, deps);
    expect(res.sha).toBe(g(dir, "rev-parse", "main"));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(g(dir, "branch", "--list", KIT_BRANCH)).toBe("");
    expect(g(dir, "log", "-1", "--format=%s")).toBe("Merge Daedalus project kit");
  });

  it("refuses when main is checked out with uncommitted changes, changing nothing", async () => {
    const { dir, project } = await imported((d) => writeFileSync(join(d, "README.md"), "# app\nwip\n"));
    const head = g(dir, "rev-parse", "HEAD");
    await expect(mergeKit(project, deps)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/commit or stash/i) });
    expect(g(dir, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("wip");
    expect(g(dir, "branch", "--list", KIT_BRANCH)).toContain(KIT_BRANCH);
  });

  it("merges through a temporary worktree when the owner is on another branch, touching none of their work", async () => {
    const { dir, project } = await imported((d) => {
      g(d, "checkout", "-q", "-b", "feature");
      writeFileSync(join(d, "README.md"), "# app\nfeature wip\n");
    });
    const before = g(dir, "status", "--porcelain");
    const res = await mergeKit(project, deps);
    expect(g(dir, "branch", "--show-current")).toBe("feature");
    expect(g(dir, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(g(dir, "rev-parse", "main")).toBe(res.sha);
    expect(g(dir, "show", "main:AGENTS.md")).toContain("agent guide");
    expect(worktrees(dir)).toBe(1);
  });

  it("aborts on a conflict and reports the path; both branches unchanged, no leftover worktree", async () => {
    const { dir, project } = await imported((d) => {
      writeFileSync(join(d, "AGENTS.md"), "main's own agents file\n");
      g(d, "add", "AGENTS.md");
      g(d, "commit", "-qm", "own AGENTS.md");
    });
    const main = g(dir, "rev-parse", "main");
    const kit = g(dir, "rev-parse", KIT_BRANCH);
    await expect(mergeKit(project, deps)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("AGENTS.md") });
    expect(g(dir, "rev-parse", "main")).toBe(main);
    expect(g(dir, "rev-parse", KIT_BRANCH)).toBe(kit);
    expect(g(dir, "status", "--porcelain")).toBe("");
    expect(worktrees(dir)).toBe(1);
  });

  it("answers 409 when there is nothing to merge", async () => {
    const { project } = await imported();
    await mergeKit(project, deps);
    await expect(mergeKit(project, deps)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing to merge/i) });
  });
});
