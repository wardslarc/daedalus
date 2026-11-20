/**
 * Import a project (T2.4): validate, clone if needed, put missing kit files on
 * daedalus/kit through a temporary worktree, save the row. ADR 0009.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
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

export type KitResult =
  | { status: "added"; branch: string; sha: string; files: string[]; skipped: string[] }
  | { status: "complete"; skipped: string[] }
  | { status: "exists"; branch: string; skipped: string[] };

/**
 * Write one kit file inside root without ever following a symlink: every path part is
 * checked with lstat (a symlink, even a dangling one, or anything already there means
 * skip), folders are made one level at a time, the parent must still resolve inside root,
 * and the file is created exclusively ("wx"). Returns false when skipped.
 */
function safeWrite(root: string, rel: string, content: string): boolean {
  const parts = rel.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i] ?? "");
    let st: Stats | null;
    try {
      st = lstatSync(cur);
    } catch {
      st = null;
    }
    const last = i === parts.length - 1;
    if (st) {
      if (st.isSymbolicLink() || last || !st.isDirectory()) return false;
    } else if (!last) {
      mkdirSync(cur);
    }
  }
  const realRoot = realpathSync(root);
  const realParent = realpathSync(dirname(cur));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) return false;
  writeFileSync(cur, content, { flag: "wx" });
  return true;
}

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
  if (wanted.length === 0) return { status: "complete", skipped: [] };
  if (await git.branchExists(repoDir, KIT_BRANCH)) return { status: "exists", branch: KIT_BRANCH, skipped: [] };

  const worktree = join(mkdtempSync(join(tmpRoot, "daedalus-kit-")), "wt");
  await git.addWorktree(repoDir, worktree, { branch: KIT_BRANCH, from: baseBranch });
  let committed = false;
  try {
    // The worktree holds the base branch, which the imported repo controls: anything it
    // already has at a kit path (a tracked file, or a symlink that could point anywhere)
    // is left alone and never written through.
    const written: string[] = [];
    const skipped: string[] = [];
    for (const f of renderKit(vars).filter((k) => wanted.includes(k.path))) {
      (safeWrite(worktree, f.path, f.content) ? written : skipped).push(f.path);
    }
    if (written.length === 0) return { status: "complete", skipped };
    const sha = await git.commitFiles(worktree, written, KIT_COMMIT_MESSAGE, { noVerify: true });
    committed = true;
    return { status: "added", branch: KIT_BRANCH, sha, files: written, skipped };
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
    const warnings = warning ? [warning] : [];
    if (kit.skipped.length > 0) {
      warnings.push(`Skipped kit files that would have gone through a symlink or over an existing path: ${kit.skipped.join(", ")}.`);
    }
    return { project, kit, warnings };
  } catch (err) {
    if (cloned) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
