import * as git from "@daedalus/git";
import type { GitOps } from "./import.js";

/** The real git implementation of GitOps (@daedalus/git: argument arrays, no shell). */
export const realGitOps: GitOps = {
  init: (dir, opts) => git.init(dir, opts),
  isRepo: git.isRepo,
  clone: (url, dest) => git.clone(url, dest),
  branchExists: git.branchExists,
  currentBranch: git.currentBranch,
  remoteUrl: (dir) => git.remoteUrl(dir),
  detectHost: git.detectHost,
  addWorktree: git.addWorktree,
  removeWorktree: git.removeWorktree,
  deleteBranch: git.deleteBranch,
  commitFiles: (dir, files, message, opts) => git.commitFiles(dir, files, message, opts),
};
