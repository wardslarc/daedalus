import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  commitFiles,
  execGit,
  GitError,
  mergeNoFf,
  resetRepoConfigCache,
  statusPorcelain,
} from "../src/index.js";
import { setPostListingHookForTest } from "../src/exec.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

describe("Repo config allowlist for Daedalus's git calls (ADR 0023)", () => {
  const dirsToCleanup: string[] = [];

  function makeTemp(prefix = "git-sec-"): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirsToCleanup.push(d);
    return d;
  }

  function makeScript(path: string, markerFile: string, content = ""): void {
    const script = `#!/bin/sh\necho "executed" >> "${markerFile}"\n${content}\n`;
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  function makeTestRepo(): { dir: string; markerFile: string; script: string } {
    const dir = makeTemp("git-allowlist-repo-");
    const markerDir = makeTemp("git-allowlist-marker-");
    const markerFile = join(markerDir, "marker.txt");
    const script = join(markerDir, "program.sh");
    makeScript(script, markerFile);

    g(dir, "init", "--initial-branch=main");
    g(dir, "config", "user.name", "Security Test");
    g(dir, "config", "user.email", "sec@example.com");
    writeFileSync(join(dir, "base.txt"), "base\n");
    g(dir, "add", ".");
    g(dir, "commit", "-m", "initial");
    return { dir, markerFile, script };
  }

  afterEach(() => {
    setPostListingHookForTest(null);
    resetRepoConfigCache();
    for (const d of dirsToCleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    dirsToCleanup.length = 0;
  });

  describe("disallowed keys in local config fail closed and do not run marker program", () => {
    const disallowedKeys: Array<{
      key: string;
      setup: (dir: string, marker: string, script: string) => void;
    }> = [
      {
        key: "core.hooksPath",
        setup: (dir, marker) => {
          const hooksDir = join(dir, "bad-hooks");
          mkdirSync(hooksDir, { recursive: true });
          makeScript(join(hooksDir, "post-checkout"), marker);
          g(dir, "config", "--local", "core.hooksPath", hooksDir);
        },
      },
      {
        key: "core.fsmonitor",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "core.fsmonitor", script);
        },
      },
      {
        key: "include.path",
        setup: (dir, _marker, script) => {
          const inc = join(dir, "inc.gitconfig");
          writeFileSync(inc, `[core]\nfsmonitor = ${script}\n`);
          g(dir, "config", "--local", "include.path", inc);
        },
      },
      {
        key: "includeIf.gitdir:/x/.path",
        setup: (dir, _marker, script) => {
          const inc = join(dir, "inc.gitconfig");
          writeFileSync(inc, `[core]\nfsmonitor = ${script}\n`);
          g(dir, "config", "--local", "includeIf.gitdir:/x/.path", inc);
        },
      },
      {
        key: "filter.x.clean",
        setup: (dir, _marker, script) => {
          writeFileSync(join(dir, ".gitattributes"), "* filter=x\n");
          g(dir, "config", "--local", "filter.x.clean", script);
        },
      },
      {
        key: "merge.x.driver",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "merge.x.driver", script);
        },
      },
      {
        key: "diff.x.textconv",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "diff.x.textconv", script);
        },
      },
      {
        key: "core.sshCommand",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "core.sshCommand", script);
        },
      },
      {
        key: "alias.st",
        setup: (dir) => {
          g(dir, "config", "--local", "alias.st", "status");
        },
      },
      {
        key: "submodule.c.update",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "submodule.c.update", script);
        },
      },
      {
        key: "core.worktree",
        setup: (dir) => {
          g(dir, "config", "--local", "core.worktree", dir);
        },
      },
      {
        key: "remote.origin.uploadpack",
        setup: (dir, _marker, script) => {
          g(dir, "config", "--local", "remote.origin.uploadpack", script);
        },
      },
    ];

    for (const { key, setup } of disallowedKeys) {
      it(`local config '${key}': statusPorcelain throws GitError naming the key and marker is not run`, async () => {
        const { dir, markerFile, script } = makeTestRepo();
        setup(dir, markerFile, script);

        let caught: unknown;
        try {
          await statusPorcelain(dir);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(GitError);
        const gitErr = caught as GitError;
        expect(gitErr.message.toLowerCase()).toContain(key.toLowerCase());
        expect(gitErr.message).toContain("which Daedalus doesn't allow (ADR 0023)");
        expect(existsSync(markerFile)).toBe(false);
      });
    }
  });

  it("a repo with only the keys seen in real repos: worktree add, commit, merge, diff all work", async () => {
    const { dir } = makeTestRepo();
    // core.* basics
    g(dir, "config", "--local", "core.bare", "false");
    g(dir, "config", "--local", "core.filemode", "true");
    g(dir, "config", "--local", "core.logallrefupdates", "true");
    g(dir, "config", "--local", "core.ignorecase", "false");
    // branch.main.remote/merge
    g(dir, "config", "--local", "branch.main.remote", "origin");
    g(dir, "config", "--local", "branch.main.merge", "refs/heads/main");
    // branch.m6/t6.1-review.vscode-merge-base
    g(dir, "config", "--local", "branch.m6/t6.1-review.vscode-merge-base", "main");
    // remote.origin.url/fetch
    g(dir, "config", "--local", "remote.origin.url", "https://github.com/example/repo.git");
    g(dir, "config", "--local", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    // user.name/email
    g(dir, "config", "--local", "user.name", "Security User");
    g(dir, "config", "--local", "user.email", "sec@example.com");
    // color.ui
    g(dir, "config", "--local", "color.ui", "auto");

    // 1. worktree add
    const wtDir = join(makeTemp("wt-real-"), "wt");
    await addWorktree(dir, wtDir, { branch: "feat-real", from: "main" });
    expect(existsSync(join(wtDir, "base.txt"))).toBe(true);

    // 2. commit
    writeFileSync(join(dir, "edit.txt"), "new content\n");
    const commitSha = await commitFiles(dir, ["edit.txt"], "commit in real repo");
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

    // 3. merge
    g(dir, "checkout", "-q", "-b", "branch-to-merge");
    writeFileSync(join(dir, "merge-me.txt"), "merge me\n");
    g(dir, "add", "merge-me.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "branch commit");
    g(dir, "checkout", "-q", "main");
    const mergeRes = await mergeNoFf(dir, "branch-to-merge", "merge branch into main");
    expect(mergeRes.ok).toBe(true);

    // 4. diff
    const diffRes = await execGit(["diff", "HEAD~1"], { cwd: dir });
    expect(diffRes.stdout).toContain("merge-me.txt");
  });

  it("extensions.worktreeConfig=true + disallowed key in config.worktree throws GitError", async () => {
    const { dir, markerFile, script } = makeTestRepo();
    g(dir, "config", "--local", "extensions.worktreeConfig", "true");
    g(dir, "config", "--worktree", "core.fsmonitor", script);

    let caught: unknown;
    try {
      await statusPorcelain(dir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitError);
    const gitErr = caught as GitError;
    expect(gitErr.message).toContain("core.fsmonitor");
    expect(gitErr.message).toContain("which Daedalus doesn't allow (ADR 0023)");
    expect(existsSync(markerFile)).toBe(false);
  });

  it("cache: allowed check, then git config --local core.fsmonitor x causes next call to throw", async () => {
    const { dir } = makeTestRepo();
    resetRepoConfigCache();

    // 1. Initial check on allowed repo succeeds and caches the config file stat and hash
    const initialStatus = await statusPorcelain(dir);
    expect(Array.isArray(initialStatus)).toBe(true);

    // 2. Modify config file directly with a disallowed key
    g(dir, "config", "--local", "core.fsmonitor", "fake-fsmonitor");

    // 3. Next call detects file stat/hash change, re-lists config, and throws GitError
    let caught: unknown;
    try {
      await statusPorcelain(dir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitError);
    const gitErr = caught as GitError;
    expect(gitErr.message).toContain("core.fsmonitor");
    expect(gitErr.message).toContain("which Daedalus doesn't allow (ADR 0023)");
  });

  it("object-only call (rev-parse) is also checked; init in an empty dir isn't", async () => {
    const { dir } = makeTestRepo();
    g(dir, "config", "--local", "core.fsmonitor", "bad-mon");

    // rev-parse on repo with disallowed key throws GitError
    await expect(execGit(["rev-parse", "HEAD"], { cwd: dir })).rejects.toThrow(GitError);

    // init in an empty directory is not checked and succeeds
    const emptyDir = makeTemp("git-empty-dir-");
    await expect(execGit(["init", "--initial-branch=main"], { cwd: emptyDir })).resolves.not.toThrow();
  });

  it("includeIf.onbranch:feature.path in local config throws GitError naming the key and marker is not run", async () => {
    const { dir, markerFile, script } = makeTestRepo();
    const incFile = join(dir, "feature.gitconfig");
    writeFileSync(incFile, `[filter "evil"]\nclean = ${script}\n`);
    g(dir, "config", "--local", "includeIf.onbranch:feature.path", incFile);

    let caught: unknown;
    try {
      await statusPorcelain(dir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitError);
    const gitErr = caught as GitError;
    expect(gitErr.message).toContain("includeif.onbranch:feature.path");
    expect(gitErr.message).toContain("which Daedalus doesn't allow (ADR 0023)");
    expect(existsSync(markerFile)).toBe(false);
  });

  it("cache does not record bytes changed between listing and hash (re-lists and throws on next call)", async () => {
    const { dir, markerFile, script } = makeTestRepo();
    resetRepoConfigCache();

    // Hook modifies config file between git config listing and post-listing snapshot
    setPostListingHookForTest(() => {
      g(dir, "config", "--local", "core.fsmonitor", script);
    });

    try {
      // First call: listing ran with clean config, but file changed before post-hash,
      // so before/after snapshots do not match and result is NOT cached.
      const initialStatus = await statusPorcelain(dir);
      expect(Array.isArray(initialStatus)).toBe(true);

      // Next call: since cache was not populated, it re-lists and throws GitError naming core.fsmonitor
      let caught: unknown;
      try {
        await statusPorcelain(dir);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitError);
      const gitErr = caught as GitError;
      expect(gitErr.message).toContain("core.fsmonitor");
      expect(gitErr.message).toContain("which Daedalus doesn't allow (ADR 0023)");
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      setPostListingHookForTest(null);
    }
  });

  describe("global options and env overrides before subcommand fail closed (Item 4)", () => {
    it("-C with disallowed key in target repo throws GitError and leaves marker unexecuted", async () => {
      const cleanRepo = makeTestRepo();
      const targetRepo = makeTestRepo();
      g(targetRepo.dir, "config", "--local", "core.fsmonitor", targetRepo.script);

      let caught: unknown;
      try {
        await execGit(["-C", targetRepo.dir, "status"], { cwd: cleanRepo.dir });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitError);
      const gitErr = caught as GitError;
      expect(gitErr.message).toBe("Daedalus doesn't pass git global options other than -c");
      expect(existsSync(targetRepo.markerFile)).toBe(false);
    });

    it("--git-dir= with disallowed key in target repo throws GitError and leaves marker unexecuted", async () => {
      const cleanRepo = makeTestRepo();
      const targetRepo = makeTestRepo();
      g(targetRepo.dir, "config", "--local", "core.fsmonitor", targetRepo.script);
      const targetGitDir = join(targetRepo.dir, ".git");

      let caught: unknown;
      try {
        await execGit([`--git-dir=${targetGitDir}`, "status"], { cwd: cleanRepo.dir });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitError);
      const gitErr = caught as GitError;
      expect(gitErr.message).toBe("Daedalus doesn't pass git global options other than -c");
      expect(existsSync(targetRepo.markerFile)).toBe(false);
    });

    it("GIT_DIR in env with disallowed key in target repo throws GitError and leaves marker unexecuted", async () => {
      const cleanRepo = makeTestRepo();
      const targetRepo = makeTestRepo();
      g(targetRepo.dir, "config", "--local", "core.fsmonitor", targetRepo.script);
      const targetGitDir = join(targetRepo.dir, ".git");

      let caught: unknown;
      try {
        await execGit(["status"], { cwd: cleanRepo.dir, env: { GIT_DIR: targetGitDir } });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitError);
      const gitErr = caught as GitError;
      expect(gitErr.message).toBe("Daedalus doesn't pass git global options other than -c");
      expect(existsSync(targetRepo.markerFile)).toBe(false);
    });
  });
});
