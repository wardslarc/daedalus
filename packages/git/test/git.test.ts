import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneUnchecked } from "../src/clone.js";
import {
  addWorktree,
  branchExists,
  checkout,
  clone,
  commitAll,
  commitFiles,
  createBranch,
  currentBranch,
  detectHost,
  execGit,
  GitError,
  headSha,
  init,
  isRepo,
  log,
  remoteUrl,
  removeWorktree,
  validateRef,
} from "../src/index.js";

function makeTempDir(prefix = "git-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setGitUser(dir: string): void {
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
}

describe("@daedalus/git", () => {
  const dirsToCleanup: string[] = [];

  function tempDir(prefix = "git-test-"): string {
    const d = makeTempDir(prefix);
    dirsToCleanup.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirsToCleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    dirsToCleanup.length = 0;
  });

  describe("init + commit + log on a temp repo", () => {
    it("initializes a repo, commits files, and reads log", async () => {
      const dir = tempDir("init-log-");
      expect(await isRepo(dir)).toBe(false);

      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      expect(await isRepo(dir)).toBe(true);
      expect(await currentBranch(dir)).toBe("main");

      writeFileSync(join(dir, "file1.txt"), "hello world");
      const sha1 = await commitFiles(dir, ["file1.txt"], "feat: first commit");
      expect(sha1).toMatch(/^[0-9a-f]{40}$/);

      const entries = await log(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sha).toBe(sha1);
      expect(entries[0]?.subject).toBe("feat: first commit");

      writeFileSync(join(dir, "file2.txt"), "second file");
      const sha2 = await commitFiles(dir, ["file2.txt"], "feat: second commit", {
        author: "Other Dev <other@example.com>",
      });
      expect(sha2).toMatch(/^[0-9a-f]{40}$/);

      const logTwo = await log(dir, "HEAD", 2);
      expect(logTwo).toHaveLength(2);
      expect(logTwo[0]?.sha).toBe(sha2);
      expect(logTwo[0]?.subject).toBe("feat: second commit");
      expect(logTwo[1]?.sha).toBe(sha1);
      expect(logTwo[1]?.subject).toBe("feat: first commit");
    });
  });

  describe("createBranch leaves the current branch unchanged", () => {
    it("creates a branch without switching HEAD to it", async () => {
      const dir = tempDir("branch-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      writeFileSync(join(dir, "base.txt"), "base content");
      await commitFiles(dir, ["base.txt"], "initial commit");

      expect(await currentBranch(dir)).toBe("main");
      expect(await branchExists(dir, "feature-alpha")).toBe(false);

      await createBranch(dir, "feature-alpha");

      // Current branch MUST remain "main"
      expect(await currentBranch(dir)).toBe("main");
      expect(await branchExists(dir, "feature-alpha")).toBe(true);

      // Now checkout switches to feature-alpha
      await checkout(dir, "feature-alpha");
      expect(await currentBranch(dir)).toBe("feature-alpha");
    });

    it("can create a branch from a specific ref", async () => {
      const dir = tempDir("branch-from-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      writeFileSync(join(dir, "f1.txt"), "1");
      const sha1 = await commitFiles(dir, ["f1.txt"], "commit 1");

      writeFileSync(join(dir, "f2.txt"), "2");
      await commitFiles(dir, ["f2.txt"], "commit 2");

      await createBranch(dir, "from-commit-1", { from: sha1 });
      await checkout(dir, "from-commit-1");
      const branchLog = await log(dir);
      expect(branchLog).toHaveLength(1);
      expect(branchLog[0]?.sha).toBe(sha1);
    });
  });

  describe("commitFiles only commits the listed files", () => {
    it("stages and commits only the listed files, leaving unlisted modified files uncommitted", async () => {
      const dir = tempDir("commit-files-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      writeFileSync(join(dir, "a.txt"), "version 1 A");
      writeFileSync(join(dir, "b.txt"), "version 1 B");
      await commitFiles(dir, ["a.txt", "b.txt"], "initial commit");

      // Modify both files, and add a third unlisted file
      writeFileSync(join(dir, "a.txt"), "version 2 A");
      writeFileSync(join(dir, "b.txt"), "version 2 B");
      writeFileSync(join(dir, "c.txt"), "untracked C");

      // Commit only a.txt
      const sha = await commitFiles(dir, ["a.txt"], "update A only");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // Verify log has update A
      const headLog = await log(dir, "HEAD", 1);
      expect(headLog[0]?.subject).toBe("update A only");

      // Check git status to verify b.txt is still modified and c.txt is still untracked
      const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      expect(statusOut).toContain(" M b.txt");
      expect(statusOut).toContain("?? c.txt");
      expect(statusOut).not.toContain("a.txt");
    });
  });

  describe("remoteUrl", () => {
    it("returns null when no remote exists, and returns the remote url when configured", async () => {
      const dir = tempDir("remote-");
      await init(dir, { initialBranch: "main" });
      expect(await remoteUrl(dir)).toBeNull();

      execFileSync("git", ["remote", "add", "origin", "https://github.com/org/sample.git"], { cwd: dir });
      expect(await remoteUrl(dir)).toBe("https://github.com/org/sample.git");
      expect(await remoteUrl(dir, "upstream")).toBeNull();
    });

    it("strips user credentials from remote url", async () => {
      const dir = tempDir("remote-cred-");
      await init(dir, { initialBranch: "main" });
      execFileSync("git", ["remote", "add", "origin", "https://user:secret-token@github.com/org/sample.git"], {
        cwd: dir,
      });
      const url = await remoteUrl(dir);
      expect(url).toBe("https://github.com/org/sample.git");
      expect(url).not.toContain("secret-token");
    });
  });

  describe("detectHost", () => {
    it("detects github urls", () => {
      expect(detectHost("https://github.com/user/repo")).toBe("github");
      expect(detectHost("https://github.com/user/repo.git")).toBe("github");
      expect(detectHost("https://user:token@github.com/user/repo.git")).toBe("github");
      expect(detectHost("git@github.com:user/repo.git")).toBe("github");
    });

    it("detects gitlab urls (hosted and self-hosted)", () => {
      expect(detectHost("https://gitlab.com/group/project.git")).toBe("gitlab");
      expect(detectHost("git@gitlab.com:group/project.git")).toBe("gitlab");
      expect(detectHost("https://gitlab.corp.internal/group/project")).toBe("gitlab");
      expect(detectHost("git@gitlab.internal.corp:group/project.git")).toBe("gitlab");
    });

    it("returns other for third-party hosts", () => {
      expect(detectHost("https://bitbucket.org/user/repo.git")).toBe("other");
      expect(detectHost("git@bitbucket.org:user/repo.git")).toBe("other");
      expect(detectHost("https://git.sr.ht/~user/repo")).toBe("other");
      expect(detectHost("https://example.com/project.git")).toBe("other");
    });
  });

  describe("branch-name and URL validation rejections", () => {
    it("rejects invalid branch names via check-ref-format", async () => {
      const dir = tempDir("branch-val-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);
      writeFileSync(join(dir, "init.txt"), "init");
      await commitFiles(dir, ["init.txt"], "init");

      const badBranches = ["-oProxyCommand=x", "ext::sh -c x", "foo..bar", "foo~bar", "foo@{1}", "foo bar", ""];
      for (const bad of badBranches) {
        await expect(createBranch(dir, bad), `expected createBranch to reject ${bad}`).rejects.toThrow(GitError);
        await expect(checkout(dir, bad), `expected checkout to reject ${bad}`).rejects.toThrow(GitError);
      }
    });

    it("rejects invalid clone URLs", async () => {
      const dest = join(tempDir("dest-parent-"), "target");
      const badUrls = [
        "-oProxyCommand=x",
        "ext::sh -c x",
        "file:///etc",
        "file:///tmp/bare.git",
        "/tmp/bare.git",
        "https://github.com/foo /bar",
        "http://insecure.com/repo.git",
        "",
      ];

      for (const bad of badUrls) {
        await expect(clone(bad, dest), `expected clone to reject ${bad}`).rejects.toThrow(GitError);
      }
    });

    it("rejects clone when destination directory already exists", async () => {
      const existing = tempDir("existing-dest-");
      await expect(clone("https://github.com/org/repo.git", existing)).rejects.toThrow(GitError);
      await expect(clone("https://github.com/org/repo.git", existing)).rejects.toThrow(/already exists/i);
    });
  });

  describe("clone with cloneUnchecked and local bare repo", () => {
    it("rejects clone() from local bare path, but cloneUnchecked succeeds", async () => {
      const bareDir = tempDir("bare-repo-") + ".git";
      dirsToCleanup.push(bareDir);
      execFileSync("git", ["init", "--bare", "-b", "main", bareDir]);

      // Seed a commit into the bare repo using a temporary working repo
      const seedDir = tempDir("seed-");
      execFileSync("git", ["clone", bareDir, seedDir]);
      setGitUser(seedDir);
      writeFileSync(join(seedDir, "readme.md"), "# Hello from bare");
      execFileSync("git", ["add", "--", "readme.md"], { cwd: seedDir });
      execFileSync("git", ["commit", "-m", "initial seed"], { cwd: seedDir });
      execFileSync("git", ["push", "origin", "main"], { cwd: seedDir });

      const dest = join(tempDir("clone-dest-"), "cloned");

      // clone() MUST reject local bare path
      await expect(clone(bareDir, dest)).rejects.toThrow(GitError);
      await expect(clone(`file://${bareDir}`, dest)).rejects.toThrow(GitError);

      // cloneUnchecked bypasses URL check for internal use / testing
      await cloneUnchecked(bareDir, dest);
      expect(await isRepo(dest)).toBe(true);
      expect(readFileSync(join(dest, "readme.md"), "utf8")).toBe("# Hello from bare");
      const entries = await log(dest);
      expect(entries[0]?.subject).toBe("initial seed");
    });
  });

  describe("tokens stripped from error text", () => {
    it("strips user:token from GitError messages and stderr", () => {
      const err = new GitError("Failed to clone https://user:secretToken999@github.com/repo.git", {
        exitCode: 128,
        stderr: "fatal: authentication failed for 'https://bot:ghp_mySecretPass@gitlab.com/repo.git'",
      });
      expect(err.message).toBe("Failed to clone https://github.com/repo.git");
      expect(err.message).not.toContain("secretToken999");
      expect(err.stderr).toBe("fatal: authentication failed for 'https://gitlab.com/repo.git'");
      expect(err.stderr).not.toContain("ghp_mySecretPass");
    });

    it("strips user:token when git command fails with credential URL", async () => {
      const dest = join(tempDir("fail-clone-"), "target");
      // Use a nonexistent host that git cannot reach
      const url = "https://user:sensitiveTokenXYZ@127.0.0.1:9999/nonexistent/repo.git";
      let caught: unknown;
      try {
        await clone(url, dest);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GitError);
      const gitErr = caught as GitError;
      expect(gitErr.message).not.toContain("sensitiveTokenXYZ");
      expect(gitErr.stderr).not.toContain("sensitiveTokenXYZ");
    });

    it("rawStdout: true keeps userinfo in stdout, default strips it, stderr stripped in both", async () => {
      const dir = tempDir("exec-raw-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      const secretUrl = "https://bob:s3cr3tT0ken9x@example.com/repo.git";
      writeFileSync(join(dir, "url.txt"), `${secretUrl}\n`);
      await commitFiles(dir, ["url.txt"], "commit url");

      // Default strips userinfo from stdout
      const defaultRes = await execGit(["show", "HEAD:url.txt"], { cwd: dir });
      expect(defaultRes.stdout).toBe("https://example.com/repo.git\n");
      expect(defaultRes.stdout).not.toContain("s3cr3tT0ken9x");

      // rawStdout: true keeps userinfo in stdout
      const rawRes = await execGit(["show", "HEAD:url.txt"], { cwd: dir, rawStdout: true });
      expect(rawRes.stdout).toBe(`${secretUrl}\n`);
      expect(rawRes.stdout).toContain("s3cr3tT0ken9x");

      // stderr is stripped in both (default and rawStdout: true)
      let defaultErr: GitError | undefined;
      try {
        await execGit(["log", "--end-of-options", secretUrl], { cwd: dir });
      } catch (err) {
        defaultErr = err as GitError;
      }
      expect(defaultErr).toBeInstanceOf(GitError);
      expect(defaultErr?.stderr).not.toContain("s3cr3tT0ken9x");
      expect(defaultErr?.message).not.toContain("s3cr3tT0ken9x");

      let rawErr: GitError | undefined;
      try {
        await execGit(["log", "--end-of-options", secretUrl], { cwd: dir, rawStdout: true });
      } catch (err) {
        rawErr = err as GitError;
      }
      expect(rawErr).toBeInstanceOf(GitError);
      expect(rawErr?.stderr).not.toContain("s3cr3tT0ken9x");
      expect(rawErr?.message).not.toContain("s3cr3tT0ken9x");
    });
  });

  describe("Item 1: option injection prevention via validateRef and --end-of-options", () => {
    it("log(dir, '--output=' + tmpfile) throws GitError and the file is NOT created", async () => {
      const dir = tempDir("option-inj-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);
      writeFileSync(join(dir, "file.txt"), "hello");
      await commitFiles(dir, ["file.txt"], "initial");

      const pwnedFile = join(tempDir("pwned-"), "pwned.txt");
      await expect(log(dir, `--output=${pwnedFile}`)).rejects.toThrow(GitError);
      expect(existsSync(pwnedFile)).toBe(false);
    });

    it("createBranch rejects dangerous 'from' ref like --output", async () => {
      const dir = tempDir("branch-from-inj-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);
      writeFileSync(join(dir, "file.txt"), "hello");
      await commitFiles(dir, ["file.txt"], "initial");

      await expect(createBranch(dir, "new-branch", { from: "--output=/tmp/bad" })).rejects.toThrow(GitError);
    });

    it("validateRef rejects leading dash, whitespace, control chars, .., and invalid refs", async () => {
      const dir = tempDir("val-ref-");
      await init(dir, { initialBranch: "main" });

      const invalidRefs = ["-leading-dash", "has space", "control\x00char", "has..dots", "bad@{name}", ""];
      for (const r of invalidRefs) {
        await expect(validateRef(r, dir)).rejects.toThrow(GitError);
      }

      // Valid refs
      await expect(validateRef("HEAD", dir)).resolves.toBeUndefined();
      await expect(validateRef("main", dir)).resolves.toBeUndefined();
      await expect(validateRef("feature/test-1", dir)).resolves.toBeUndefined();
      await expect(validateRef("e04313fa4ef06d7ecdc1a646c24b9148d4db3b42", dir)).resolves.toBeUndefined();
    });
  });

  describe("Item 2: commitFiles only commits listed files even if index has other staged files", () => {
    it("leaves unlisted staged files in index and not in the commit", async () => {
      const dir = tempDir("commit-staged-");
      await init(dir, { initialBranch: "main" });
      setGitUser(dir);

      writeFileSync(join(dir, "init.txt"), "init");
      await commitFiles(dir, ["init.txt"], "init");

      // Stage an unlisted file using git add directly
      writeFileSync(join(dir, "unlisted.txt"), "staged unlisted");
      execFileSync("git", ["add", "--", "unlisted.txt"], { cwd: dir });

      // Call commitFiles with another file
      writeFileSync(join(dir, "target.txt"), "target content");
      const sha = await commitFiles(dir, ["target.txt"], "feat: only target");

      // Assert target is in the commit, unlisted is NOT in the commit
      const showOut = execFileSync("git", ["show", "--name-only", "--format=", sha], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(showOut.trim().split("\n").filter(Boolean)).toEqual(["target.txt"]);

      // Assert unlisted file is still staged
      const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      expect(statusOut).toContain("A  unlisted.txt");
    });
  });

  describe("Item 3: cloneUnchecked requires absolute destination", () => {
    it("rejects relative destination paths with GitError", async () => {
      await expect(cloneUnchecked("https://github.com/org/repo.git", "relative/path")).rejects.toThrow(GitError);
      await expect(cloneUnchecked("https://github.com/org/repo.git", "relative/path")).rejects.toThrow(
        /absolute path/i,
      );
      await expect(clone("https://github.com/org/repo.git", "./relative")).rejects.toThrow(GitError);
    });
  });

  describe("Item 4: detectHost exact host / subdomain / first-label matching", () => {
    it("rejects substring matches like notgithub.evil.com or github.evil.com", () => {
      expect(detectHost("https://notgithub.evil.com/user/repo")).toBe("other");
      expect(detectHost("https://github.evil.com/user/repo")).toBe("other");
      expect(detectHost("git@notgithub.evil.com:user/repo.git")).toBe("other");
      expect(detectHost("https://notgitlab.evil.com/group/project")).toBe("other");
      expect(detectHost("git@notgitlab.evil.com:group/project.git")).toBe("other");
      expect(detectHost("https://evil.gitlab.evil.com/group/project")).toBe("other");
    });

    it("matches github.com and *.github.com", () => {
      expect(detectHost("https://github.com/user/repo.git")).toBe("github");
      expect(detectHost("https://sub.github.com/user/repo.git")).toBe("github");
      expect(detectHost("git@github.com:user/repo.git")).toBe("github");
      expect(detectHost("git@sub.github.com:user/repo.git")).toBe("github");
    });

    it("matches gitlab.com, *.gitlab.com, and self-hosted with first label gitlab", () => {
      expect(detectHost("https://gitlab.com/user/repo.git")).toBe("gitlab");
      expect(detectHost("https://sub.gitlab.com/user/repo.git")).toBe("gitlab");
      expect(detectHost("https://gitlab.example.com/user/repo.git")).toBe("gitlab");
      expect(detectHost("git@gitlab.corp.local:user/repo.git")).toBe("gitlab");
    });
  });

  describe("Item 5: addWorktree, removeWorktree, headSha, commitFiles noVerify", () => {
    it("manages worktree lifecycle with uncommitted change in main", async () => {
      const repoDir = tempDir("wt-repo-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      writeFileSync(join(repoDir, "base.txt"), "base content\n");
      const mainInitSha = await commitFiles(repoDir, ["base.txt"], "initial main commit");

      // Make an uncommitted change in main checkout
      writeFileSync(join(repoDir, "base.txt"), "dirty uncommitted change in main\n");
      writeFileSync(join(repoDir, "untracked.txt"), "untracked in main\n");

      // Create a worktree on a new branch from main
      const wtDir = join(tempDir("wt-worktree-"), "worktree-dir");
      await addWorktree(repoDir, wtDir, { branch: "feat-wt", from: "main" });

      // In the worktree, commit a file
      setGitUser(wtDir);
      writeFileSync(join(wtDir, "wt-file.txt"), "worktree file content\n");
      const wtSha = await commitFiles(wtDir, ["wt-file.txt"], "commit in worktree", {
        noVerify: true,
      });

      expect(await headSha(wtDir)).toBe(wtSha);
      expect(await headSha(repoDir, "feat-wt")).toBe(wtSha);

      // Remove the worktree
      await removeWorktree(repoDir, wtDir);

      // Assert the main checkout's branch, HEAD sha, and uncommitted change are all unchanged
      expect(await currentBranch(repoDir)).toBe("main");
      expect(await headSha(repoDir)).toBe(mainInitSha);
      expect(readFileSync(join(repoDir, "base.txt"), "utf8")).toBe("dirty uncommitted change in main\n");
      expect(readFileSync(join(repoDir, "untracked.txt"), "utf8")).toBe("untracked in main\n");

      // Assert the new branch exists and has the commit
      expect(await branchExists(repoDir, "feat-wt")).toBe(true);
      const featLog = await log(repoDir, "feat-wt", 1);
      expect(featLog[0]?.sha).toBe(wtSha);
      expect(featLog[0]?.subject).toBe("commit in worktree");
    });

    it("addWorktree requires worktreeDir to be absolute and not exist", async () => {
      const repoDir = tempDir("wt-val-repo-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);
      writeFileSync(join(repoDir, "f.txt"), "init");
      await commitFiles(repoDir, ["f.txt"], "init");

      // Relative path rejected
      await expect(
        addWorktree(repoDir, "relative/path", { branch: "b1", from: "main" }),
      ).rejects.toThrow(GitError);

      // Existing path rejected
      const existingDir = tempDir("wt-exists-");
      await expect(
        addWorktree(repoDir, existingDir, { branch: "b2", from: "main" }),
      ).rejects.toThrow(GitError);
    });

    it("commitFiles supports noVerify option to bypass pre-commit hooks", async () => {
      const repoDir = tempDir("noverify-repo-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      writeFileSync(join(repoDir, "f.txt"), "v1");
      await commitFiles(repoDir, ["f.txt"], "initial");

      // Add a failing pre-commit hook
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
      execFileSync("chmod", ["+x", hookPath]);

      writeFileSync(join(repoDir, "f.txt"), "v2");

      // Without noVerify, commit fails because of hook
      await expect(commitFiles(repoDir, ["f.txt"], "failing commit")).rejects.toThrow(GitError);

      // With noVerify: true, commit succeeds
      const sha = await commitFiles(repoDir, ["f.txt"], "bypassed hook commit", { noVerify: true });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("commitAll", () => {
    it("stages all changes, commits them, and returns commit sha", async () => {
      const repoDir = tempDir("commit-all-repo-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      writeFileSync(join(repoDir, "a.txt"), "hello");
      writeFileSync(join(repoDir, "b.txt"), "world");

      const sha = await commitAll(repoDir, "T1.1: Core implementation (Daedalus task run)");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const entries = await log(repoDir, "HEAD", 1);
      expect(entries[0]?.sha).toBe(sha);
      expect(entries[0]?.subject).toBe("T1.1: Core implementation (Daedalus task run)");
    });

    it("returns null when nothing has changed", async () => {
      const repoDir = tempDir("commit-all-empty-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      writeFileSync(join(repoDir, "init.txt"), "initial");
      await commitAll(repoDir, "initial");

      const sha = await commitAll(repoDir, "T1.1: Nothing changed (Daedalus task run)");
      expect(sha).toBeNull();
    });

    it("never commits .env files even when written by agent", async () => {
      const repoDir = tempDir("commit-all-env-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      writeFileSync(join(repoDir, "code.ts"), "export const x = 1;");
      writeFileSync(join(repoDir, ".env"), "SECRET=planted");
      writeFileSync(join(repoDir, ".env.local"), "SECRET_LOCAL=planted");

      const subDir = join(repoDir, "subdir");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, ".env.production"), "SECRET_PROD=planted");
      writeFileSync(join(subDir, "nested.ts"), "export const y = 2;");

      const sha = await commitAll(repoDir, "T1.1: Task run (Daedalus task run)");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // Check log files committed using git ls-tree
      const entries = await log(repoDir, "HEAD", 1);
      expect(entries[0]?.sha).toBe(sha);

      const lsTreeRes = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      const committedFiles = lsTreeRes.trim().split("\n");

      expect(committedFiles).toContain("code.ts");
      expect(committedFiles).toContain("subdir/nested.ts");
      expect(committedFiles).not.toContain(".env");
      expect(committedFiles).not.toContain(".env.local");
      expect(committedFiles).not.toContain("subdir/.env.production");
    });

    it("rejects empty commit message", async () => {
      const repoDir = tempDir("commit-all-err-");
      await init(repoDir, { initialBranch: "main" });
      await expect(commitAll(repoDir, "")).rejects.toThrow(GitError);
    });

    it("bypasses pre-commit hook when noVerify is true", async () => {
      const repoDir = tempDir("commit-all-noverify-");
      await init(repoDir, { initialBranch: "main" });
      setGitUser(repoDir);

      const markerFile = join(repoDir, "hook-marker.txt");
      const hooksDir = join(repoDir, ".git", "hooks");
      const hookPath = join(hooksDir, "pre-commit");
      writeFileSync(
        hookPath,
        `#!/bin/sh\necho "hook ran" > "${markerFile}"\n`,
        { mode: 0o755 },
      );

      writeFileSync(join(repoDir, "file.txt"), "hello");
      const sha = await commitAll(repoDir, "Commit with no-verify", { noVerify: true });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(markerFile)).toBe(false);
    });
  });
});
