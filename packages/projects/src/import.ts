/**
 * Import a project (T2.4): validate, clone if needed, put missing kit files on
 * daedalus/kit through a temporary worktree, save the row. ADR 0009.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, type DaedalusDb } from "@daedalus/db";
import { cloneRoot, gitHostWarning, profileRulesMarkdown, rulesFor, validateProjectSettings } from "@daedalus/core/profiles";
import { missingKitFiles, renderKit, type KitVars } from "@daedalus/kit";
import { folderNameFromUrl, ImportError, parseSource, validateLocalPath } from "./source.js";

export const KIT_BRANCH = "daedalus/kit";
const KIT_COMMIT_MESSAGE = "Add Daedalus project kit\n\nMissing kit files added by Daedalus on import. Review and merge when ready.";

/** The git operations import needs; @daedalus/git provides them, tests fake them. */
export type GitOps = {
  isRepo(dir: string): Promise<boolean>;
  clone(url: string, dest: string): Promise<void>;
  branchExists(dir: string, name: string): Promise<boolean>;
  currentBranch(dir: string): Promise<string>;
  remoteUrl(dir: string): Promise<string | null>;
  detectHost(url: string): "github" | "gitlab" | "other";
  addWorktree(repoDir: string, worktreeDir: string, opts: { branch: string; from: string }): Promise<void>;
  removeWorktree(repoDir: string, worktreeDir: string): Promise<void>;
  deleteBranch(repoDir: string, name: string): Promise<void>;
  commitFiles(dir: string, files: string[], message: string, opts?: { noVerify?: boolean }): Promise<string>;
};

export type KitResult = { status: "added"; branch: string; sha: string; files: string[] } | { status: "complete" } | { status: "exists"; branch: string };

/**
 * Add the kit files the project doesn't have, as one commit on daedalus/kit. Works in a
 * temporary worktree outside the repo, so the owner's checkout, working tree and branches
 * are never touched, even with uncommitted changes.
 */
export async function addKitOnBranch(
  repoDir: string,
  vars: KitVars,
  { git, tmpRoot, baseBranch }: { git: GitOps; tmpRoot: string; baseBranch: string },
): Promise<KitResult> {
  // Files the owner already has (committed or not) are theirs: never offered.
  const wanted = missingKitFiles(repoDir);
  if (wanted.length === 0) return { status: "complete" };
  if (await git.branchExists(repoDir, KIT_BRANCH)) return { status: "exists", branch: KIT_BRANCH };

  const worktree = join(mkdtempSync(join(tmpRoot, "daedalus-kit-")), "wt");
  await git.addWorktree(repoDir, worktree, { branch: KIT_BRANCH, from: baseBranch });
  let committed = false;
  try {
    // Also skip anything the base branch already tracks (e.g. deleted locally but committed).
    const files = wanted.filter((f) => !existsSync(join(worktree, f)));
    const rendered = renderKit(vars).filter((f) => files.includes(f.path));
    for (const f of rendered) {
      mkdirSync(dirname(join(worktree, f.path)), { recursive: true });
      writeFileSync(join(worktree, f.path), f.content);
    }
    if (rendered.length === 0) return { status: "complete" };
    const sha = await git.commitFiles(worktree, rendered.map((f) => f.path), KIT_COMMIT_MESSAGE, { noVerify: true });
    committed = true;
    return { status: "added", branch: KIT_BRANCH, sha, files: rendered.map((f) => f.path) };
  } finally {
    await git.removeWorktree(repoDir, worktree);
    rmSync(dirname(worktree), { recursive: true, force: true });
    if (!committed) await git.deleteBranch(repoDir, KIT_BRANCH).catch(() => undefined);
  }
}

export type ImportInput = { source: string; profile: string; name?: string; geminiAllowed?: unknown };
export type ImportDeps = {
  db: DaedalusDb;
  git: GitOps;
  home: string;
  /** Daedalus's own repo and data dir. */
  forbiddenRoots: string[];
  tmpRoot: string;
  today: string;
};

function cleanName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? "").trim() || fallback;
  if (name.length > 100) throw new ImportError("Project name is too long (100 characters max).");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ImportError("Project name can't contain control characters.");
  return name;
}

async function pickBaseBranch(dir: string, git: GitOps): Promise<string> {
  for (const b of ["main", "master"]) if (await git.branchExists(dir, b)) return b;
  return git.currentBranch(dir);
}

export async function importProject(input: ImportInput, deps: ImportDeps) {
  const { db, git } = deps;
  // 1. Rules first: a forbidden request touches nothing.
  const settings = validateProjectSettings(input.profile, { geminiAllowed: input.geminiAllowed });
  const source = parseSource(input.source);

  // 2. Where the project lives.
  let dir: string;
  let cloned = false;
  if (source.kind === "path") {
    dir = await validateLocalPath(source.path, {
      profile: settings.profile,
      home: deps.home,
      forbiddenRoots: deps.forbiddenRoots,
      isRepo: git.isRepo,
    });
  } else {
    dir = join(cloneRoot(settings.profile, deps.home), folderNameFromUrl(source.url));
    if (existsSync(dir)) throw new ImportError(`A folder already exists at ${dir}. Import that folder instead.`, 409);
  }
  const taken = db.select({ id: projects.id }).from(projects).where(eq(projects.localPath, dir)).get();
  if (taken) throw new ImportError("This folder is already a Daedalus project.", 409);
  const name = cleanName(input.name, basename(dir));

  if (source.kind === "url") {
    await git.clone(source.url, dir);
    cloned = true;
  }

  // 3. Kit, remote, row. A fresh clone is removed if anything after it fails.
  try {
    const baseBranch = await pickBaseBranch(dir, git);
    const kit = await addKitOnBranch(
      dir,
      { PROJECT_NAME: name, PROFILE: rulesFor(settings.profile).label, TODAY: deps.today, PROFILE_RULES: profileRulesMarkdown(settings.profile) },
      { git, tmpRoot: deps.tmpRoot, baseBranch },
    );
    const remote = await git.remoteUrl(dir);
    const warning = gitHostWarning(settings.profile, remote ?? undefined);
    const project = db
      .insert(projects)
      .values({
        name,
        localPath: dir,
        profile: settings.profile,
        gitRemote: remote,
        gitHost: remote ? git.detectHost(remote) : null,
        defaultBranch: baseBranch,
        geminiAllowed: settings.geminiAllowed,
      })
      .returning()
      .get();
    return { project, kit, warnings: warning ? [warning] : [] };
  } catch (err) {
    if (cloned) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
