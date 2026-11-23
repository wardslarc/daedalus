/**
 * Folder explorer and WSL/Windows path translator for the Import dialog.
 *
 * Because Daedalus runs inside WSL while the browser often runs on Windows (ADR 0002),
 * users may browse folders in the WSL filesystem, jump to Windows drives (/mnt/c),
 * or paste paths copied from Windows File Explorer (\\wsl.localhost\Distro\...,
 * \\wsl$\Distro\..., C:\..., or ~/...).
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { ImportError } from "./source.js";

const WSL_UNC_RE = /^(?:\\\\|\/\/)wsl(?:\.localhost|\$)[\\/][^\\/]+(?<rest>[\\/].*)?$/i;
const WIN_DRIVE_RE = /^(?<drive>[A-Za-z]):(?<rest>[\\/].*)?$/;

/**
 * Translate a Linux path, `~` path, Windows WSL UNC path (`\\wsl.localhost\Ubuntu\...` or
 * `\\wsl$\Ubuntu\...`), or Windows drive path (`C:\...`) into a normalized absolute WSL path.
 * Returns `null` if the string is not a recognized local/WSL/Windows path.
 */
export function translatePath(raw: string, home?: string): string | null {
  const value = raw.trim();
  if (!value || value.includes("\u0000")) return null;

  // 1. Tilde expansion (~ or ~/... or ~\...) when home is known
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    if (!home) return null;
    const sub = value.slice(1).replace(/\\/g, "/").replace(/^\/+/, "");
    return sub ? normalize(join(home, sub)) : normalize(home);
  }

  // 2. Windows File Explorer WSL UNC path: \\wsl.localhost\Ubuntu\home\me or \\wsl$\Ubuntu\...
  const uncMatch = WSL_UNC_RE.exec(value);
  if (uncMatch) {
    const rest = (uncMatch.groups?.rest ?? "").replace(/\\/g, "/");
    if (!rest || rest === "/") return "/";
    const cleaned = normalize(rest);
    return cleaned.length > 1 && cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  }

  // 3. Windows drive letter path: C:\Users\me\repo or D:/work
  const driveMatch = WIN_DRIVE_RE.exec(value);
  if (driveMatch) {
    const drive = (driveMatch.groups?.drive ?? "c").toLowerCase();
    const rest = (driveMatch.groups?.rest ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const target = rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
    const cleaned = normalize(target);
    return cleaned.length > 1 && cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  }

  // 4. Standard POSIX absolute path
  if (isAbsolute(value)) {
    const cleaned = normalize(value);
    return cleaned.length > 1 && cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  }

  return null;
}

export type FolderEntry = {
  name: string;
  path: string;
  isGitRepo: boolean;
};

export type FolderRoot = {
  label: string;
  path: string;
  kind: "wsl" | "drive";
};

export type BrowseResult = {
  currentPath: string;
  parentPath: string | null;
  isGitRepo: boolean;
  roots: FolderRoot[];
  entries: FolderEntry[];
};

export type BrowseOptions = {
  path?: string;
  home: string;
  showHidden?: boolean;
  /** Override `/mnt` for unit tests. */
  mntRoot?: string;
};

function hasGitMarker(dirPath: string): boolean {
  try {
    return existsSync(join(dirPath, ".git"));
  } catch {
    return false;
  }
}

function discoverRoots(home: string, mntRoot = "/mnt"): FolderRoot[] {
  const roots: FolderRoot[] = [];
  const normHome = normalize(home);
  if (existsSync(normHome)) {
    roots.push({ label: "Home", path: normHome, kind: "wsl" });
  }
  const workDir = join(normHome, "work");
  if (existsSync(workDir)) {
    roots.push({ label: "Work", path: workDir, kind: "wsl" });
  }
  const projectsDir = join(normHome, "projects");
  if (existsSync(projectsDir)) {
    roots.push({ label: "Projects", path: projectsDir, kind: "wsl" });
  }
  roots.push({ label: "WSL /", path: "/", kind: "wsl" });

  // Discover mounted Windows drives under /mnt/<letter>
  try {
    if (existsSync(mntRoot)) {
      const mntEntries = readdirSync(mntRoot, { withFileTypes: true });
      for (const entry of mntEntries) {
        if (/^[a-z]$/i.test(entry.name)) {
          const full = join(mntRoot, entry.name);
          try {
            if (statSync(full).isDirectory()) {
              roots.push({
                label: `Windows ${entry.name.toUpperCase()}:`,
                path: full,
                kind: "drive",
              });
            }
          } catch {
            // Skip unreadable mount points
          }
        }
      }
    }
  } catch {
    // Ignore if /mnt cannot be read
  }

  return roots;
}

/**
 * List child directories at `opts.path` (defaults to `opts.home`), marking git repositories
 * and discovering WSL + Windows drive roots for quick navigation.
 */
export function listFolders(opts: BrowseOptions): BrowseResult {
  const rawTarget = (opts.path ?? "").trim() || opts.home;
  const translated = translatePath(rawTarget, opts.home);
  if (!translated) {
    throw new ImportError("Use an absolute folder path, ~/..., a Windows drive (C:\\...), or a WSL path (\\\\wsl.localhost\\...).");
  }

  let currentPath: string;
  try {
    currentPath = realpathSync(translated);
  } catch {
    throw new ImportError(`That folder doesn't exist: ${rawTarget}`, 404);
  }

  let st;
  try {
    st = statSync(currentPath);
  } catch {
    throw new ImportError(`That folder doesn't exist: ${rawTarget}`, 404);
  }
  if (!st.isDirectory()) {
    throw new ImportError(`That's a file, not a folder: ${rawTarget}`, 400);
  }

  const parentPath = currentPath === "/" ? null : dirname(currentPath);
  const isGitRepo = hasGitMarker(currentPath);
  const showHidden = opts.showHidden === true;

  let dirEntries;
  try {
    dirEntries = readdirSync(currentPath, { withFileTypes: true });
  } catch {
    throw new ImportError(`Can't read that folder (permission denied): ${currentPath}`, 400);
  }

  const entries: FolderEntry[] = [];
  for (const dirent of dirEntries) {
    const name = dirent.name;
    if (name === ".git") continue;
    if (!showHidden && name.startsWith(".")) continue;

    const fullPath = join(currentPath, name);
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;

    entries.push({
      name,
      path: fullPath,
      isGitRepo: hasGitMarker(fullPath),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return {
    currentPath,
    parentPath,
    isGitRepo,
    roots: discoverRoots(opts.home, opts.mntRoot),
    entries,
  };
}
