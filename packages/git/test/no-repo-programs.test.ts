import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDetachedWorktree,
  addWorktree,
  commitAll,
  execGit,
  GitError,
  headSha,
  mergeCommitNoFf,
  mergeNoFf,
  statusPorcelain,
} from "../src/index.js";
import {
  findSubcommand,
  lastSubmoduleNames,
  listingCounter,
  resetListingCounter,
  SKIP_LISTING_SUBCOMMANDS,
} from "../src/exec.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

describe("Daedalus git calls never run programs named in repo config (ADR 0022)", () => {
  const dirsToCleanup: string[] = [];

  function makeTemp(prefix = "git-sec-"): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirsToCleanup.push(d);
    return d;
  }

  function repo(): { dir: string; markerFile: string } {
    const dir = makeTemp("git-sec-repo-");
    const markerFile = join(makeTemp("git-sec-marker-"), "marker.txt");
    g(dir, "init", "--initial-branch=main");
    g(dir, "config", "user.name", "Security Test");
    g(dir, "config", "user.email", "sec@example.com");
    writeFileSync(join(dir, "base.txt"), "base\n");
    g(dir, "add", ".");
    g(dir, "commit", "-m", "initial");
    return { dir, markerFile };
  }

  function makeScript(path: string, markerFile: string, content = ""): void {
    const script = `#!/bin/sh\necho "executed" >> "${markerFile}"\n${content}\n`;
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
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

  it(".git/hooks/post-checkout: addDetachedWorktree and addWorktree leave no marker", async () => {
    const { dir, markerFile } = repo();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    makeScript(join(hooksDir, "post-checkout"), markerFile);

    const wt1 = join(makeTemp("wt1-"), "wt1");
    await addWorktree(dir, wt1, { branch: "branch-wt1", from: "main" });
    expect(existsSync(markerFile)).toBe(false);

    const sha = await headSha(dir);
    const wt2 = join(makeTemp("wt2-"), "wt2");
    await addDetachedWorktree(dir, wt2, sha);
    expect(existsSync(markerFile)).toBe(false);
  });

  it(".git/hooks/post-merge and post-commit: mergeNoFf, mergeCommitNoFf, and kit/task commit leave no marker", async () => {
    const { dir, markerFile } = repo();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    makeScript(join(hooksDir, "post-merge"), markerFile);
    makeScript(join(hooksDir, "post-commit"), markerFile);

    // Prepare branch for mergeNoFf
    g(dir, "checkout", "-q", "-b", "kit");
    writeFileSync(join(dir, "KIT.md"), "kit\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "KIT.md");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "kit commit");
    g(dir, "checkout", "-q", "main");

    const mergeRes = await mergeNoFf(dir, "kit", "Merge kit branch");
    expect(mergeRes.ok).toBe(true);
    expect(existsSync(markerFile)).toBe(false);

    // Prepare second branch for mergeCommitNoFf
    g(dir, "checkout", "-q", "-b", "kit2");
    writeFileSync(join(dir, "KIT2.md"), "kit 2\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "KIT2.md");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "kit2 commit");
    const kit2Sha = g(dir, "rev-parse", "HEAD");
    g(dir, "checkout", "-q", "main");

    const mergeCommitRes = await mergeCommitNoFf(dir, kit2Sha, "Merge kit2 commit");
    expect(mergeCommitRes.ok).toBe(true);
    expect(existsSync(markerFile)).toBe(false);

    // Task commit helper in index.ts
    writeFileSync(join(dir, "task.txt"), "task file\n");
    const taskSha = await commitAll(dir, "Task commit");
    expect(taskSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("core.fsmonitor=<script> in .git/config: statusPorcelain leaves no marker", async () => {
    const { dir, markerFile } = repo();
    const fsmonitorScript = join(makeTemp("fsmon-"), "fsmonitor.sh");
    makeScript(fsmonitorScript, markerFile);

    g(dir, "config", "core.fsmonitor", fsmonitorScript);

    const lines = await statusPorcelain(dir);
    expect(Array.isArray(lines)).toBe(true);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("commit.gpgSign=true + gpg.program=<script>: a Daedalus commit succeeds unsigned, no marker", async () => {
    const { dir, markerFile } = repo();
    const gpgScript = join(makeTemp("gpg-"), "fake-gpg.sh");
    // If invoked, writes marker and fails
    makeScript(gpgScript, markerFile, "exit 1");

    g(dir, "config", "commit.gpgSign", "true");
    g(dir, "config", "gpg.program", gpgScript);

    writeFileSync(join(dir, "change.txt"), "new content\n");
    const sha = await commitAll(dir, "Commit without gpg");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);

    // Commit exists and was not signed by gpg.program
    const signer = g(dir, "log", "-1", "--format=%G?");
    expect(signer).toBe("N"); // 'N' means no signature
  });

  it(".gitattributes *.txt filter=evil + filter.evil.smudge/clean/process=<script>: worktree add and commit leave no marker, and checked-out file has stored content", async () => {
    const { dir, markerFile } = repo();
    const filterScript = join(makeTemp("filter-"), "filter.sh");
    makeScript(filterScript, markerFile, "cat");

    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(dir, "file.txt"), "original stored content\n");
    g(dir, "add", ".gitattributes", "file.txt");
    g(dir, "commit", "-m", "add attributes and file");

    g(dir, "config", "filter.evil.clean", filterScript);
    g(dir, "config", "filter.evil.smudge", filterScript);
    g(dir, "config", "filter.evil.process", filterScript);
    g(dir, "config", "filter.evil.required", "true");

    const wt = join(makeTemp("wt-filter-"), "wt");
    await addWorktree(dir, wt, { branch: "wt-filter", from: "main" });
    expect(existsSync(markerFile)).toBe(false);
    expect(readFileSync(join(wt, "file.txt"), "utf8")).toBe("original stored content\n");

    // Commit in worktree also leaves no marker
    g(wt, "config", "user.name", "Security Test");
    g(wt, "config", "user.email", "sec@example.com");
    writeFileSync(join(wt, "file.txt"), "modified in worktree\n");
    const commitSha = await commitAll(wt, "update file in worktree");
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);

    const committedContent = g(wt, "show", "HEAD:file.txt");
    expect(committedContent).toBe("modified in worktree");
  });

  it("filter command path containing spaces and dots passes without error or marker execution", async () => {
    const { dir, markerFile } = repo();
    const spaceDir = join(makeTemp("filter spaces-"), "path with spaces");
    mkdirSync(spaceDir, { recursive: true });
    const filterScript = join(spaceDir, "custom.filter.v1.2.sh");
    makeScript(filterScript, markerFile, "cat");

    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=custom\n");
    writeFileSync(join(dir, "file.txt"), "stored content with spaces & dots\n");
    g(dir, "add", ".gitattributes", "file.txt");
    g(dir, "commit", "-m", "add attributes and file");

    g(dir, "config", "filter.custom.clean", filterScript);
    g(dir, "config", "filter.custom.smudge", filterScript);
    g(dir, "config", "filter.custom.process", filterScript);

    const wt = join(makeTemp("wt-spaces-"), "wt");
    await addWorktree(dir, wt, { branch: "wt-spaces", from: "main" });
    expect(existsSync(markerFile)).toBe(false);
    expect(readFileSync(join(wt, "file.txt"), "utf8")).toBe("stored content with spaces & dots\n");

    // Commit in worktree also succeeds and leaves no marker
    g(wt, "config", "user.name", "Security Test");
    g(wt, "config", "user.email", "sec@example.com");
    writeFileSync(join(wt, "file.txt"), "modified content\n");
    const commitSha = await commitAll(wt, "update file in worktree");
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("filter value containing a newline followed by filter.x y.smudge is not parsed as a key and succeeds", async () => {
    const { dir, markerFile } = repo();
    const filterScript = join(makeTemp("filter-nl-"), "filter.sh");
    makeScript(filterScript, markerFile, "cat");

    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=custom\n");
    writeFileSync(join(dir, "file.txt"), "hello newline test\n");
    g(dir, "add", ".gitattributes", "file.txt");
    g(dir, "commit", "-m", "attributes and file");

    // Value contains a newline and a pattern that would look like an invalid filter key if values were parsed
    const multilineValue = `${filterScript}\nfilter.x y.smudge ${filterScript}`;
    g(dir, "config", "filter.custom.clean", multilineValue);
    g(dir, "config", "filter.custom.smudge", multilineValue);

    const wt = join(makeTemp("wt-nl-"), "wt");
    // Must not create a bogus name or be refused because of the value
    await expect(addWorktree(dir, wt, { branch: "wt-nl", from: "main" })).resolves.not.toThrow();
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(markerFile)).toBe(false);
    expect(readFileSync(join(wt, "file.txt"), "utf8")).toBe("hello newline test\n");

    // Commit in worktree also succeeds and leaves no marker
    g(wt, "config", "user.name", "Security Test");
    g(wt, "config", "user.email", "sec@example.com");
    writeFileSync(join(wt, "file.txt"), "modified hello\n");
    const commitSha = await commitAll(wt, "commit in worktree");
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("filter name with a space or = in it: checkout-type call throws GitError and no worktree is created", async () => {
    const { dir } = repo();

    // Filter name with space
    g(dir, "config", "filter.evil space.clean", "cat");
    const wtSpace = join(makeTemp("wt-space-"), "wt-space");
    await expect(addWorktree(dir, wtSpace, { branch: "b-space", from: "main" })).rejects.toThrow(
      new GitError("Unsafe filter name in repo config"),
    );
    expect(existsSync(wtSpace)).toBe(false);

    // Filter name with =
    const { dir: dir2 } = repo();
    g(dir2, "config", "filter.evil=equal.clean", "cat");
    const wtEqual = join(makeTemp("wt-equal-"), "wt-equal");
    await expect(addWorktree(dir2, wtEqual, { branch: "b-equal", from: "main" })).rejects.toThrow(
      new GitError("Unsafe filter name in repo config"),
    );
    expect(existsSync(wtEqual)).toBe(false);
  });

  it("plain rev-parse call does not run git config --get-regexp (fast-path and observable counter)", async () => {
    const { dir } = repo();
    // Plant an unsafe filter name that would throw if config --get-regexp were run
    g(dir, "config", "filter.unsafe name.clean", "cat");

    resetListingCounter();
    expect(listingCounter).toBe(0);

    // Fast path: rev-parse is in SKIP_LISTING_SUBCOMMANDS, so it skips the listing call
    expect(findSubcommand(["rev-parse", "HEAD"])).toBe("rev-parse");
    expect(SKIP_LISTING_SUBCOMMANDS.has("rev-parse")).toBe(true);

    const sha = await headSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(listingCounter).toBe(0);

    const res = await execGit(["rev-parse", "--verify", "HEAD"], { cwd: dir });
    expect(res.stdout.trim()).toBe(sha);
    expect(listingCounter).toBe(0);

    // Confirm that a working-tree subcommand on the same repo DOES run the listing and detects the unsafe filter
    const wt = join(makeTemp("wt-fast-"), "wt");
    await expect(addWorktree(dir, wt, { branch: "b-test", from: "main" })).rejects.toThrow(
      new GitError("Unsafe filter name in repo config"),
    );
    expect(listingCounter).toBe(1);
  });

  it(".gitattributes * merge=evil + merge.evil.driver=<script>: mergeNoFf of a conflicting branch leaves no marker, reports conflict, checkout clean after abort", async () => {
    const { dir, markerFile } = repo();
    const mergeScript = join(makeTemp("merge-"), "merge.sh");
    makeScript(mergeScript, markerFile);

    writeFileSync(join(dir, ".gitattributes"), "* merge=evil\n");
    g(dir, "add", ".gitattributes");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "attributes");
    g(dir, "config", "merge.evil.driver", `${mergeScript} %O %A %B %L %P`);
    g(dir, "config", "merge.evil.name", "evil merge driver");

    // Create a branch with conflicting changes
    g(dir, "checkout", "-q", "-b", "conflict-branch");
    writeFileSync(join(dir, "base.txt"), "branch content\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "base.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "branch edit");

    // Back to main and make a conflicting edit
    g(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "base.txt"), "main content\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "base.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "main edit");

    const headBefore = g(dir, "rev-parse", "HEAD");

    const res = await mergeNoFf(dir, "conflict-branch", "merge conflicting");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflicts).toContain("base.txt");
    }
    expect(existsSync(markerFile)).toBe(false);
    // Checkout is clean after abort
    expect(g(dir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(g(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("main content\n");
  });

  it("* diff=evil + diff.evil.command=<script> + diff.evil.textconv=<script>: diff, log -p, and show leave no marker and output real content", async () => {
    const { dir, markerFile } = repo();
    const diffScript = join(makeTemp("diff-"), "diff.sh");
    makeScript(diffScript, markerFile);
    const textconvScript = join(makeTemp("tc-"), "textconv.sh");
    makeScript(textconvScript, markerFile);

    writeFileSync(join(dir, ".gitattributes"), "* diff=evil\n");
    writeFileSync(join(dir, "data.txt"), "line one\n");
    g(dir, "add", ".gitattributes", "data.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "add data");

    g(dir, "config", "diff.evil.command", diffScript);
    g(dir, "config", "diff.evil.textconv", textconvScript);

    writeFileSync(join(dir, "data.txt"), "line two\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "data.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "update data");

    // 1. execGit(["diff", "HEAD~1"])
    const diffRes = await execGit(["diff", "HEAD~1"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
    expect(diffRes.stdout).toContain("-line one");
    expect(diffRes.stdout).toContain("+line two");

    // 2. execGit(["log", "-p", "-1"])
    const logRes = await execGit(["log", "-p", "-1"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
    expect(logRes.stdout).toContain("+line two");

    // 3. execGit(["show", "HEAD"])
    const showRes = await execGit(["show", "HEAD"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
    expect(showRes.stdout).toContain("+line two");
  });

  it("* filter=evil + clean filter script, file modified in worktree: statusPorcelain leaves no marker", async () => {
    const { dir, markerFile } = repo();
    const filterScript = join(makeTemp("flt-"), "clean.sh");
    makeScript(filterScript, markerFile, "cat");

    writeFileSync(join(dir, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(dir, "tracked.txt"), "initial content\n");
    g(dir, "add", ".gitattributes", "tracked.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "add tracked");

    g(dir, "config", "filter.evil.clean", filterScript);
    g(dir, "config", "filter.evil.smudge", filterScript);
    g(dir, "config", "filter.evil.required", "true");

    // Modify the file in the working tree
    writeFileSync(join(dir, "tracked.txt"), "modified in working tree\n");

    const lines = await statusPorcelain(dir);
    expect(existsSync(markerFile)).toBe(false);
    expect(lines).toContain(" M tracked.txt");
  });

  it("blame inserts --no-textconv only, format-patch inserts both, and existing diff flags are not duplicated", async () => {
    const { dir, markerFile } = repo();
    const diffScript = join(makeTemp("diff-fp-"), "diff.sh");
    makeScript(diffScript, markerFile);
    const textconvScript = join(makeTemp("tc-blame-"), "textconv.sh");
    makeScript(textconvScript, markerFile);

    writeFileSync(join(dir, ".gitattributes"), "* diff=evil\n");
    writeFileSync(join(dir, "doc.txt"), "version 1\n");
    g(dir, "add", ".gitattributes", "doc.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "v1 commit");

    g(dir, "config", "diff.evil.command", diffScript);
    g(dir, "config", "diff.evil.textconv", textconvScript);

    writeFileSync(join(dir, "doc.txt"), "version 2\n");
    g(dir, "-c", "core.hooksPath=/dev/null", "add", "doc.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "v2 commit");

    // blame inserts --no-textconv only and leaves no marker
    const blameRes = await execGit(["blame", "doc.txt"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
    expect(blameRes.stdout).toContain("version 2");

    // format-patch inserts --no-ext-diff and --no-textconv and leaves no marker
    const fpRes = await execGit(["format-patch", "-1", "--stdout"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
    expect(fpRes.stdout).toContain("+version 2");

    // caller passing --no-ext-diff and --no-textconv does not duplicate flags
    const diffRes = await execGit(
      ["diff", "--no-ext-diff", "--no-textconv", "HEAD~1"],
      { cwd: dir },
    );
    expect(existsSync(markerFile)).toBe(false);
    expect(diffRes.stdout).toContain("+version 2");
  });

  it("unsafe merge or diff driver name in repo config fails closed with GitError", async () => {
    const { dir } = repo();
    g(dir, "config", "merge.evil driver.driver", "cat");
    await expect(execGit(["merge", "main"], { cwd: dir })).rejects.toThrow(
      new GitError("Unsafe filter name in repo config"),
    );

    const { dir: dir2 } = repo();
    g(dir2, "config", "diff.evil=diff.command", "cat");
    await expect(execGit(["diff", "HEAD"], { cwd: dir2 })).rejects.toThrow(
      new GitError("Unsafe filter name in repo config"),
    );
  });

  it("plain diff.* and merge.* settings without subsections do not block worktree add, merge, and diff", async () => {
    const { dir } = repo();
    g(dir, "config", "diff.noprefix", "true");
    g(dir, "config", "merge.ff", "false");
    g(dir, "config", "diff.renames", "copies");

    // 1. worktree add works
    const wt = join(makeTemp("wt-plain-"), "wt");
    await addWorktree(dir, wt, { branch: "branch-plain", from: "main" });
    expect(existsSync(join(wt, "base.txt"))).toBe(true);

    // 2. merge works
    g(dir, "checkout", "-q", "-b", "feature-plain");
    writeFileSync(join(dir, "feature.txt"), "feature content\n");
    g(dir, "add", "feature.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "feature commit");
    g(dir, "checkout", "-q", "main");

    const mergeRes = await mergeNoFf(dir, "feature-plain", "Merge feature branch");
    expect(mergeRes.ok).toBe(true);

    // 3. diff works
    const diffRes = await execGit(["diff", "HEAD~1"], { cwd: dir });
    expect(diffRes.stdout).toContain("feature.txt");
  });

  it("a filter driver whose name contains a dot (e.g. filter.a.b) is neutralised without running marker", async () => {
    const { dir, markerFile } = repo();
    const filterScript = join(makeTemp("flt-dot-"), "clean.sh");
    makeScript(filterScript, markerFile, "cat");

    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=a.b\n");
    writeFileSync(join(dir, "file.txt"), "dot filter initial content\n");
    g(dir, "add", ".gitattributes", "file.txt");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "initial with dot filter");

    g(dir, "config", "filter.a.b.clean", filterScript);
    g(dir, "config", "filter.a.b.smudge", filterScript);
    g(dir, "config", "filter.a.b.process", filterScript);
    g(dir, "config", "filter.a.b.required", "true");

    // worktree add checks out files -> smudge filter neutralized
    const wt = join(makeTemp("wt-dot-"), "wt");
    await addWorktree(dir, wt, { branch: "wt-dot", from: "main" });
    expect(existsSync(markerFile)).toBe(false);
    expect(readFileSync(join(wt, "file.txt"), "utf8")).toBe("dot filter initial content\n");

    // commit in worktree -> clean filter neutralized
    g(wt, "config", "user.name", "Security Test");
    g(wt, "config", "user.email", "sec@example.com");
    writeFileSync(join(wt, "file.txt"), "dot filter modified content\n");
    const commitSha = await commitAll(wt, "update dot filter in worktree");
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markerFile)).toBe(false);

    const committedContent = g(wt, "show", "HEAD:file.txt");
    expect(committedContent).toBe("dot filter modified content");
  });

  it("signed-looking commit with log.showSignature=true and gpg.program=<script>: log -1 and show HEAD leave no marker", async () => {
    const { dir, markerFile } = repo();
    const gpgScript = join(makeTemp("gpg-"), "fake-gpg.sh");
    makeScript(gpgScript, markerFile);

    const rawCommit = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd: dir, encoding: "utf8" });
    const separatorIdx = rawCommit.indexOf("\n\n");
    if (separatorIdx === -1) {
      throw new Error("Invalid commit format: missing separator");
    }
    const headers = rawCommit.slice(0, separatorIdx);
    const message = rawCommit.slice(separatorIdx + 2);
    const fakeSig = [
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " Version: fake",
      " ",
      " fake",
      " -----END PGP SIGNATURE-----",
    ].join("\n");
    const signedCommit = `${headers}\n${fakeSig}\n\n${message}`;

    const newSha = execFileSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      { cwd: dir, input: signedCommit, encoding: "utf8" },
    ).trim();
    g(dir, "update-ref", "HEAD", newSha);

    g(dir, "config", "log.showSignature", "true");
    g(dir, "config", "gpg.program", gpgScript);

    await execGit(["log", "-1"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);

    await execGit(["show", "HEAD"], { cwd: dir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("submodule: work tree clean filter leaves no marker on statusPorcelain and diff HEAD", async () => {
    const { dir: superDir, markerFile } = repo();

    const subSourceDir = makeTemp("git-sec-subsrc-");
    g(subSourceDir, "init", "--initial-branch=main");
    g(subSourceDir, "config", "user.name", "Security Test");
    g(subSourceDir, "config", "user.email", "sec@example.com");
    writeFileSync(join(subSourceDir, ".gitattributes"), "*.txt filter=sub\n");
    writeFileSync(join(subSourceDir, "subfile.txt"), "sub content\n");
    g(subSourceDir, "add", ".gitattributes", "subfile.txt");
    g(subSourceDir, "commit", "-m", "sub initial");

    g(superDir, "-c", "protocol.file.allow=always", "submodule", "add", subSourceDir, "mysub");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "add submodule");

    const subDir = join(superDir, "mysub");
    const filterScript = join(makeTemp("filter-sub-"), "clean.sh");
    makeScript(filterScript, markerFile, "cat");
    g(subDir, "config", "filter.sub.clean", filterScript);

    const subFile = join(subDir, "subfile.txt");
    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    await statusPorcelain(superDir);
    expect(existsSync(markerFile)).toBe(false);

    const future2 = new Date(Date.now() + 20_000);
    utimesSync(subFile, future2, future2);

    await execGit(["diff", "HEAD"], { cwd: superDir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("submodule bump still visible in diff --name-status HEAD~1", async () => {
    const { dir: superDir } = repo();

    const subSourceDir = makeTemp("git-sec-subsrc2-");
    g(subSourceDir, "init", "--initial-branch=main");
    g(subSourceDir, "config", "user.name", "Security Test");
    g(subSourceDir, "config", "user.email", "sec@example.com");
    writeFileSync(join(subSourceDir, "subfile.txt"), "sub content\n");
    g(subSourceDir, "add", "subfile.txt");
    g(subSourceDir, "commit", "-m", "sub initial");

    g(superDir, "-c", "protocol.file.allow=always", "submodule", "add", subSourceDir, "mysub");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "add submodule");

    const subDir = join(superDir, "mysub");
    writeFileSync(join(subDir, "subfile.txt"), "sub content bumped\n");
    g(subDir, "add", "subfile.txt");
    g(subDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "submodule commit 2");

    g(superDir, "add", "mysub");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "bump submodule in super");

    const res = await execGit(["diff", "--name-status", "HEAD~1"], { cwd: superDir });
    expect(res.stdout).toContain("M\tmysub");
  });

  function setupSubmoduleWithCleanFilter(options?: { subName?: string; subPath?: string }): {
    superDir: string;
    subDir: string;
    subFile: string;
    markerFile: string;
    subName: string;
  } {
    const { dir: superDir, markerFile } = repo();
    const subName = options?.subName ?? "mysub";
    const subPath = options?.subPath ?? subName;

    const subSourceDir = makeTemp("git-sec-subsrc-");
    g(subSourceDir, "init", "--initial-branch=main");
    g(subSourceDir, "config", "user.name", "Security Test");
    g(subSourceDir, "config", "user.email", "sec@example.com");
    writeFileSync(join(subSourceDir, ".gitattributes"), "*.txt filter=sub\n");
    writeFileSync(join(subSourceDir, "subfile.txt"), "sub content\n");
    g(subSourceDir, "add", ".gitattributes", "subfile.txt");
    g(subSourceDir, "commit", "-m", "sub initial");

    g(superDir, "-c", "protocol.file.allow=always", "submodule", "add", "--name", subName, subSourceDir, subPath);
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "add submodule");

    const subDir = join(superDir, ...subPath.split("/"));
    const filterScript = join(makeTemp("filter-sub-"), "clean.sh");
    makeScript(filterScript, markerFile, "cat");
    g(subDir, "config", "filter.sub.clean", filterScript);

    const subFile = join(subDir, "subfile.txt");
    return { superDir, subDir, subFile, markerFile, subName };
  }

  it(".gitmodules committed with submodule.<name>.ignore = none: statusPorcelain and diff HEAD leave no marker", async () => {
    const { superDir, subFile, markerFile, subName } = setupSubmoduleWithCleanFilter();

    g(superDir, "config", "--file", ".gitmodules", `submodule.${subName}.ignore`, "none");
    g(superDir, "add", ".gitmodules");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "set ignore=none in .gitmodules");

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    await statusPorcelain(superDir);
    expect(existsSync(markerFile)).toBe(false);

    const future2 = new Date(Date.now() + 20_000);
    utimesSync(subFile, future2, future2);

    await execGit(["diff", "HEAD"], { cwd: superDir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("repo config submodule.<name>.ignore=none (not in .gitmodules): statusPorcelain and diff HEAD leave no marker", async () => {
    const { superDir, subFile, markerFile, subName } = setupSubmoduleWithCleanFilter();

    g(superDir, "config", `submodule.${subName}.ignore`, "none");

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    await statusPorcelain(superDir);
    expect(existsSync(markerFile)).toBe(false);

    const future2 = new Date(Date.now() + 20_000);
    utimesSync(subFile, future2, future2);

    await execGit(["diff", "HEAD"], { cwd: superDir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("submodule whose name contains / (e.g. path libs/c) with ignore=none: no marker, no error", async () => {
    const { superDir, subFile, markerFile } = setupSubmoduleWithCleanFilter({
      subName: "libs/c",
      subPath: "libs/c",
    });

    g(superDir, "config", "--file", ".gitmodules", "submodule.libs/c.ignore", "none");
    g(superDir, "add", ".gitmodules");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "set ignore=none for libs/c");

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    await statusPorcelain(superDir);
    expect(existsSync(markerFile)).toBe(false);

    const future2 = new Date(Date.now() + 20_000);
    utimesSync(subFile, future2, future2);

    await execGit(["diff", "HEAD"], { cwd: superDir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("caller passes --ignore-submodules=none to execGit(['status', ...]): GitError, nothing run", async () => {
    const { superDir, subFile, markerFile } = setupSubmoduleWithCleanFilter();

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    await expect(
      execGit(["status", "--ignore-submodules=none"], { cwd: superDir }),
    ).rejects.toThrow(GitError);

    expect(existsSync(markerFile)).toBe(false);
  });

  it("caller passes bare --ignore-submodules or --ignore-submodules=untracked: throws GitError", async () => {
    const { dir } = repo();
    await expect(
      execGit(["status", "--ignore-submodules"], { cwd: dir }),
    ).rejects.toThrow(GitError);
    await expect(
      execGit(["diff", "--ignore-submodules=untracked", "HEAD"], { cwd: dir }),
    ).rejects.toThrow(GitError);
  });

  it("work-tree .gitmodules deleted, index and HEAD have submodule.<name>.ignore = none: leaves no marker and collects submodule name", async () => {
    const { superDir, subFile, markerFile, subName } = setupSubmoduleWithCleanFilter();

    g(superDir, "config", "--file", ".gitmodules", `submodule.${subName}.ignore`, "none");
    g(superDir, "add", ".gitmodules");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "set ignore=none in .gitmodules");

    // Delete work-tree .gitmodules
    rmSync(join(superDir, ".gitmodules"));

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    resetListingCounter();
    await execGit(["checkout", "--", "."], { cwd: superDir });

    expect(existsSync(markerFile)).toBe(false);
    expect(lastSubmoduleNames.has(subName)).toBe(true);

    const future2 = new Date(Date.now() + 20_000);
    utimesSync(subFile, future2, future2);
    await execGit(["reset", "--hard"], { cwd: superDir });
    expect(existsSync(markerFile)).toBe(false);
  });

  it("caller passes --ignore-sub=none throws GitError; diff with --ignore-submodules=dirty succeeds", async () => {
    const { superDir } = setupSubmoduleWithCleanFilter();

    await expect(
      execGit(["status", "--ignore-sub=none"], { cwd: superDir }),
    ).rejects.toThrow(GitError);

    await expect(
      execGit(["diff", "--ignore-submodules=dirty"], { cwd: superDir }),
    ).resolves.not.toThrow();
  });

  it("caller config -c: security-sensitive keys rejected with GitError, diff.external= empty allowed", async () => {
    const { dir } = repo();

    await expect(
      execGit(["-c", "core.hooksPath=/tmp/x", "status"], { cwd: dir }),
    ).rejects.toThrow(GitError);

    await expect(
      execGit(["-ccore.hooksPath=/tmp/x", "status"], { cwd: dir }),
    ).rejects.toThrow(GitError);

    await expect(
      execGit(["-c", "diff.external=", "status"], { cwd: dir }),
    ).resolves.not.toThrow();

    await expect(
      execGit(["-c", "diff.external=/tmp/x", "status"], { cwd: dir }),
    ).rejects.toThrow(GitError);

    await expect(
      execGit(["-c", "SUBMODULE.c.ignore=none", "status"], { cwd: dir }),
    ).rejects.toThrow(GitError);
  });

  it("a path literally named --ignore-sub=none after -- is allowed", async () => {
    const { dir } = repo();
    const weirdFile = join(dir, "--ignore-sub=none");
    writeFileSync(weirdFile, "content\n");

    await expect(
      execGit(["add", "--", "--ignore-sub=none"], { cwd: dir }),
    ).resolves.not.toThrow();

    await expect(
      execGit(["checkout", "--", "--ignore-sub=none"], { cwd: dir }),
    ).resolves.not.toThrow();
  });

  it("repo without .gitmodules in index, HEAD, or work-tree: execGit succeeds without error", async () => {
    const { dir } = repo();
    resetListingCounter();
    const res = await execGit(["status", "--porcelain"], { cwd: dir });
    expect(res.stdout).toBe("");
    expect(lastSubmoduleNames.size).toBe(0);
  });

  it("unborn branch with no commits: execGit succeeds without error", async () => {
    const dir = makeTemp("git-unborn-");
    g(dir, "init", "--initial-branch=main");
    resetListingCounter();
    const res = await execGit(["status", "--porcelain"], { cwd: dir });
    expect(res.stdout).toBe("");
    expect(lastSubmoduleNames.size).toBe(0);
  });

  it("submodule only in index (not in HEAD or worktree): collects submodule name from :.gitmodules", async () => {
    const { superDir, subFile, markerFile, subName } = setupSubmoduleWithCleanFilter();

    // Stage ignore=none in .gitmodules but do not commit it to HEAD
    g(superDir, "config", "--file", ".gitmodules", `submodule.${subName}.ignore`, "none");
    g(superDir, "add", ".gitmodules");
    // Remove from worktree so it only exists in index
    rmSync(join(superDir, ".gitmodules"));

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    resetListingCounter();
    await execGit(["checkout", "--", "."], { cwd: superDir });
    expect(lastSubmoduleNames.has(subName)).toBe(true);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("submodule only in HEAD (not in index or worktree): collects submodule name from HEAD:.gitmodules", async () => {
    const { superDir, subFile, markerFile, subName } = setupSubmoduleWithCleanFilter();

    g(superDir, "config", "--file", ".gitmodules", `submodule.${subName}.ignore`, "none");
    g(superDir, "add", ".gitmodules");
    g(superDir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "commit .gitmodules to HEAD");

    // Remove .gitmodules from index and worktree
    g(superDir, "rm", ".gitmodules");

    const future = new Date(Date.now() + 10_000);
    utimesSync(subFile, future, future);

    resetListingCounter();
    await execGit(["checkout", "--", "."], { cwd: superDir });
    expect(lastSubmoduleNames.has(subName)).toBe(true);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("conflicted .gitmodules in index: collects submodule names from conflicting stages 1-3", async () => {
    const { dir } = repo();

    // Create branch-a with .gitmodules having submodule "sub-side-a"
    g(dir, "checkout", "-q", "-b", "branch-a");
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "sub-side-a"]\n\tpath = sub-side-a\n\turl = https://example.com/sub-side-a\n',
    );
    g(dir, "-c", "core.hooksPath=/dev/null", "add", ".gitmodules");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "add sub-side-a on branch-a");

    // Create branch-b from main with conflicting .gitmodules having submodule "sub-side-b" with ignore = none
    g(dir, "checkout", "-q", "main");
    g(dir, "checkout", "-q", "-b", "branch-b");
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "sub-side-b"]\n\tpath = sub-side-b\n\turl = https://example.com/sub-side-b\n\tignore = none\n',
    );
    g(dir, "-c", "core.hooksPath=/dev/null", "add", ".gitmodules");
    g(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "add sub-side-b on branch-b");

    // Checkout branch-a and merge branch-b to create conflict on .gitmodules
    g(dir, "checkout", "-q", "branch-a");
    try {
      execFileSync("git", ["merge", "--no-ff", "branch-b"], { cwd: dir, stdio: "ignore" });
    } catch {
      // Expected merge conflict
    }

    try {
      // Work-tree .gitmodules replaced by a file without sub-side-b
      writeFileSync(
        join(dir, ".gitmodules"),
        '[submodule "unrelated"]\n\tpath = unrelated\n\turl = https://example.com/unrelated\n',
      );

      resetListingCounter();
      // Run status command which triggers driver and submodule discovery
      await execGit(["status", "--porcelain"], { cwd: dir });

      // The collected names include sub-side-b from stage 3
      expect(lastSubmoduleNames.has("sub-side-b")).toBe(true);
      expect(lastSubmoduleNames.has("sub-side-a")).toBe(true);
      expect(lastSubmoduleNames.has("unrelated")).toBe(true);
    } finally {
      // Abort the merge in the test cleanup
      try {
        g(dir, "merge", "--abort");
      } catch {
        // ignore
      }
    }
  });

  it("corrupt .gitmodules in work tree: throws GitError and nothing is run", async () => {
    const { superDir, markerFile } = setupSubmoduleWithCleanFilter();

    // Plant corrupt .gitmodules in the work tree
    writeFileSync(join(superDir, ".gitmodules"), '[submodule "c"\n');

    await expect(
      execGit(["checkout", "--", "."], { cwd: superDir }),
    ).rejects.toThrow(GitError);

    // Assert that the command did not execute anything
    expect(existsSync(markerFile)).toBe(false);
  });

  it("corrupt .gitmodules in work tree: execGit status throws GitError", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, ".gitmodules"), '[submodule "c"\n');

    await expect(
      execGit(["status"], { cwd: dir }),
    ).rejects.toThrow(GitError);
  });

  it("corrupt .gitmodules in index blob: throws GitError and nothing is run", async () => {
    const { superDir, markerFile } = setupSubmoduleWithCleanFilter();

    // Remove work-tree .gitmodules
    rmSync(join(superDir, ".gitmodules"));

    // Hash a corrupt .gitmodules blob and put it into index stage 0
    const corruptSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: superDir,
      input: '[submodule "c"\n',
      encoding: "utf8",
    }).trim();
    g(superDir, "update-index", "--add", "--cacheinfo", "100644", corruptSha, ".gitmodules");

    await expect(
      execGit(["checkout", "--", "."], { cwd: superDir }),
    ).rejects.toThrow(GitError);

    expect(existsSync(markerFile)).toBe(false);
  });

  it("corrupt repo config: driver listing throws GitError and nothing is run", async () => {
    const { superDir, markerFile } = setupSubmoduleWithCleanFilter();

    // Corrupt .git/config
    const configPath = join(superDir, ".git", "config");
    writeFileSync(configPath, '[filter "c"\n', { flag: "a" });

    await expect(
      execGit(["checkout", "--", "."], { cwd: superDir }),
    ).rejects.toThrow(GitError);

    expect(existsSync(markerFile)).toBe(false);
  });
});
