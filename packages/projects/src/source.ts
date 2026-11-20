/**
 * Validating what the browser asks us to import. Everything here runs before any git
 * command, and every failure is an ImportError with a message the owner can act on.
 */
import { realpath as fsRealpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";

export class ImportError extends Error {
  override name = "ImportError";
  constructor(
    message: string,
    /** HTTP status the API should answer with. */
    readonly status: 400 | 404 | 409 | 413 | 415 = 400,
  ) {
    super(message);
  }
}

export type Source = { kind: "path"; path: string } | { kind: "url"; url: string };

const MAX_SOURCE = 2048;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/;
const SCP_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;

/** A local absolute path, or an https / git@host:path URL. Nothing else. */
export function parseSource(raw: string): Source {
  const value = raw.trim();
  if (value === "") throw new ImportError("Give a folder path or a Git URL.");
  if (value.length > MAX_SOURCE) throw new ImportError("That path or URL is too long.");
  if (value.startsWith("-")) throw new ImportError("That isn't a valid path or URL.");
  if (HTTPS_URL.test(value) || SCP_URL.test(value)) return { kind: "url", url: value };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new ImportError("Only https:// and git@host:path URLs can be imported.");
  }
  if (!isAbsolute(value)) {
    throw new ImportError("Use the folder's full path, starting with / (no ~ or relative paths).");
  }
  return { kind: "path", path: normalize(value) };
}

/** Folder name for a clone: the repo's name, lowercased, safe characters only. */
export function folderNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 100) {
    throw new ImportError("Couldn't work out a folder name from that URL.");
  }
  return name;
}

export type PathContext = {
  profile: string;
  home: string;
  /** Daedalus's own repo and data folder: never importable. */
  forbiddenRoots: string[];
  isRepo: (dir: string) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  statDir?: (p: string) => Promise<boolean>;
};

const SYSTEM_DIRS = ["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

async function defaultStatDir(p: string): Promise<boolean> {
  return (await stat(p)).isDirectory();
}

/** Check a local folder can be imported; returns its real path (symlinks resolved). */
export async function validateLocalPath(path: string, ctx: PathContext): Promise<string> {
  const realpath = ctx.realpath ?? fsRealpath;
  const statDir = ctx.statDir ?? defaultStatDir;

  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new ImportError(`That folder doesn't exist: ${path}`, 404);
  }
  if (!(await statDir(real).catch(() => false))) throw new ImportError(`That's a file, not a folder: ${path}`);

  if (SYSTEM_DIRS.includes(real)) throw new ImportError("Can't import the root or a system folder.");
  if (real === normalize(ctx.home)) throw new ImportError("Can't import your whole home folder; pick a project folder.");
  for (const root of ctx.forbiddenRoots) {
    if (within(real, root) || within(root, real)) {
      throw new ImportError("Can't import Daedalus's own folders.");
    }
  }
  if (ctx.profile === "work" && within(real, "/mnt")) {
    throw new ImportError("Work projects must live in the WSL file system (e.g. ~/work), not on a Windows drive under /mnt.");
  }
  if (!(await ctx.isRepo(real))) {
    throw new ImportError("That folder isn't a git repo. Run `git init` in it first, or import from a URL.");
  }
  return real;
}
