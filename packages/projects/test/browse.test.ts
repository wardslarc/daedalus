import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportError } from "../src/source.js";
import { listFolders, translatePath } from "../src/browse.js";

describe("translatePath", () => {
  const home = "/home/ctescalo";

  it("keeps standard absolute Linux paths normalized", () => {
    expect(translatePath("/home/ctescalo/work/app", home)).toBe("/home/ctescalo/work/app");
    expect(translatePath("  /home/ctescalo/work/app/  ", home)).toBe("/home/ctescalo/work/app");
  });

  it("expands ~ and ~/... to the WSL home directory", () => {
    expect(translatePath("~", home)).toBe("/home/ctescalo");
    expect(translatePath("~/work/app", home)).toBe("/home/ctescalo/work/app");
    expect(translatePath("~\\work\\app", home)).toBe("/home/ctescalo/work/app");
  });

  it("translates Windows File Explorer WSL UNC paths (\\\\wsl.localhost\\... and \\\\wsl$\\...)", () => {
    expect(translatePath("\\\\wsl.localhost\\Ubuntu\\home\\ctescalo\\work\\app", home)).toBe(
      "/home/ctescalo/work/app",
    );
    expect(translatePath("\\\\wsl$\\Ubuntu-24.04\\home\\ctescalo\\projects\\demo", home)).toBe(
      "/home/ctescalo/projects/demo",
    );
    expect(translatePath("//wsl.localhost/Ubuntu/home/ctescalo/work", home)).toBe("/home/ctescalo/work");
    expect(translatePath("\\\\wsl.localhost\\Ubuntu", home)).toBe("/");
  });

  it("translates Windows drive paths (C:\\... or D:/...) to /mnt/<drive>/...", () => {
    expect(translatePath("C:\\Users\\ctescalo\\projects\\app", home)).toBe("/mnt/c/Users/ctescalo/projects/app");
    expect(translatePath("D:/work/repo", home)).toBe("/mnt/d/work/repo");
    expect(translatePath("c:\\", home)).toBe("/mnt/c");
  });

  it("returns null for non-path inputs or relative paths", () => {
    expect(translatePath("", home)).toBeNull();
    expect(translatePath("relative/folder", home)).toBeNull();
    expect(translatePath("./app", home)).toBeNull();
    expect(translatePath("https://github.com/me/app.git", home)).toBeNull();
  });
});

describe("listFolders", () => {
  it("lists subdirectories, marks git repos, hides dot-folders by default, and sorts git repos / alphabetically", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-"));
    const workDir = join(root, "work");
    const projDir = join(root, "projects");
    mkdirSync(workDir);
    mkdirSync(projDir);

    // Create child folders inside root
    const repoA = join(root, "alpha-repo");
    mkdirSync(join(repoA, ".git"), { recursive: true });

    const plainB = join(root, "beta-folder");
    mkdirSync(plainB);

    const hiddenDir = join(root, ".hidden-dir");
    mkdirSync(hiddenDir);

    // Regular file should never appear in folder list
    writeFileSync(join(root, "README.md"), "# hi\n");

    const res = listFolders({ path: root, home: root });
    expect(res.currentPath).toBe(root);
    expect(res.isGitRepo).toBe(false);
    expect(res.entries.map((e) => ({ name: e.name, isGitRepo: e.isGitRepo }))).toEqual([
      { name: "alpha-repo", isGitRepo: true },
      { name: "beta-folder", isGitRepo: false },
      { name: "projects", isGitRepo: false },
      { name: "work", isGitRepo: false },
    ]);

    // Quick-jump roots include Home, Work, Projects, WSL Root
    expect(res.roots.map((r) => r.label)).toContain("Home");
    expect(res.roots.map((r) => r.label)).toContain("Work");
    expect(res.roots.map((r) => r.label)).toContain("Projects");
  });

  it("includes dot-folders when showHidden is true (except .git)", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-hid-"));
    mkdirSync(join(root, ".config"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src"));

    const res = listFolders({ path: root, home: root, showHidden: true });
    expect(res.entries.map((e) => e.name)).toEqual([".config", "src"]);
    expect(res.isGitRepo).toBe(true);
  });

  it("accepts Windows WSL UNC paths and ~ in the browse path", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-wsl-"));
    const sub = join(root, "my-repo");
    mkdirSync(join(sub, ".git"), { recursive: true });

    const viaTilde = listFolders({ path: "~/my-repo", home: root });
    expect(viaTilde.currentPath).toBe(sub);
    expect(viaTilde.isGitRepo).toBe(true);

    const unc = `\\\\wsl.localhost\\Ubuntu${sub.replace(/\//g, "\\")}`;
    const viaUnc = listFolders({ path: unc, home: root });
    expect(viaUnc.currentPath).toBe(sub);
    expect(viaUnc.isGitRepo).toBe(true);
  });

  it("detects Windows drives mounted under /mnt", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-mnt-"));
    const fakeMnt = mkdtempSync(join(tmpdir(), "fake-mnt-"));
    mkdirSync(join(fakeMnt, "c"));
    mkdirSync(join(fakeMnt, "d"));
    mkdirSync(join(fakeMnt, "wslg")); // non-single-letter WSL system mount should be ignored

    const res = listFolders({ path: root, home: root, mntRoot: fakeMnt });
    const driveLabels = res.roots.filter((r) => r.kind === "drive").map((r) => r.label);
    expect(driveLabels).toEqual(["Windows C:", "Windows D:"]);
  });

  it("skips broken symlinks without crashing and throws ImportError for missing paths", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-err-"));
    symlinkSync(join(root, "does-not-exist"), join(root, "broken-link"));
    mkdirSync(join(root, "good-folder"));

    const res = listFolders({ path: root, home: root });
    expect(res.entries.map((e) => e.name)).toEqual(["good-folder"]);

    expect(() => listFolders({ path: join(root, "missing"), home: root })).toThrow(ImportError);
  });
});
