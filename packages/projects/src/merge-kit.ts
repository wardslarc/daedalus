/**
 * Merge kit (T2.9): bring daedalus/kit into the project's default branch, only when the
 * owner asks. Never stashes, resets or forces; a conflict is aborted. ADR 0009.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import * as git from "@daedalus/git";
import { KIT_BRANCH } from "./import.js";
import { ImportError } from "./source.js";

const MESSAGE = "Merge Daedalus project kit";

export type MergeKitProject = { localPath: string; defaultBranch: string };

export async function mergeKit(
  project: MergeKitProject,
  { tmpRoot }: { tmpRoot: string },
): Promise<{ sha: string; branch: string }> {
  const repo = project.localPath;
  const target = project.defaultBranch;
  if (!(await git.isRepo(repo))) throw new ImportError(`The project folder isn't a git repo any more: ${repo}`, 404);
  if (!(await git.branchExists(repo, KIT_BRANCH))) throw new ImportError("Nothing to merge: there is no daedalus/kit branch.", 409);

  const checkedOut = await git.worktreeForBranch(repo, target);
  let workDir: string;
  let temp: string | null = null;
  if (checkedOut) {
    const changed = (await git.statusPorcelain(checkedOut)).filter((l) => !l.startsWith("??"));
    if (changed.length > 0) {
      throw new ImportError(`${target} has uncommitted changes in ${checkedOut}. Commit or stash them first, then merge the kit.`, 409);
    }
    workDir = checkedOut;
  } else {
    temp = join(mkdtempSync(join(tmpRoot, "daedalus-merge-")), "wt");
    await git.addWorktreeForBranch(repo, temp, target);
    workDir = temp;
  }

  try {
    let result: git.MergeResult;
    try {
      result = await git.mergeNoFf(workDir, KIT_BRANCH, MESSAGE);
    } catch (err) {
      // e.g. untracked files in the owner's checkout that the merge would overwrite.
      const detail = err instanceof git.GitError ? err.message.split("\n").slice(0, 6).join("\n") : "";
      throw new ImportError(`git refused the merge, nothing was changed.\n${detail}`.trim(), 409);
    }
    if (!result.ok) {
      throw new ImportError(
        `The kit conflicts with ${target} in: ${result.conflicts.join(", ")}. The merge was cancelled; merge daedalus/kit by hand.`,
        409,
      );
    }
    await git.deleteBranch(repo, KIT_BRANCH);
    return { sha: result.sha, branch: target };
  } finally {
    if (temp) {
      await git.removeWorktree(repo, temp);
      rmSync(dirname(temp), { recursive: true, force: true });
    }
  }
}
