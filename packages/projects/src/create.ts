/**
 * Create a new project from the Daedalus kit (T2.5):
 * validate settings and name, initialize git, render and commit all kit files, save row.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, type DaedalusDb } from "@daedalus/db";
import { cloneRoot, profileRulesMarkdown, rulesFor, validateProjectSettings } from "@daedalus/core/profiles";
import { renderKit, type KitVars } from "@daedalus/kit";
import type { GitOps } from "./import.js";
import { ImportError } from "./source.js";

export type CreateInput = {
  name: string;
  profile: string;
  geminiAllowed?: unknown;
};

export type CreateDeps = {
  db: DaedalusDb;
  git: GitOps;
  home: string;
  today: string;
};

/**
 * Derives a folder slug from a project name:
 * lowercase [a-z0-9._-], starts with [a-z0-9].
 */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    throw new ImportError("Project name must produce a valid folder name (letters and numbers).", 400);
  }
  return slug;
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new ImportError("Project name is required.", 400);
  const name = raw.trim();
  if (name.length === 0) throw new ImportError("Project name is required.", 400);
  if (name.length > 100) throw new ImportError("Project name is too long (100 characters max).", 400);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ImportError("Project name can't contain control characters.", 400);
  return name;
}

export async function createProject(input: CreateInput, deps: CreateDeps) {
  // 1. Rules first: a forbidden request touches nothing.
  const settings = validateProjectSettings(input.profile, { geminiAllowed: input.geminiAllowed });

  // 2. Validate name and slug.
  const name = cleanName(input.name);
  const slug = slugOf(name);

  // 3. Folder destination and conflict checks.
  const root = cloneRoot(settings.profile, deps.home);
  const folder = join(root, slug);

  if (existsSync(folder)) {
    throw new ImportError(`A folder already exists at ${folder}.`, 409);
  }
  const taken = deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.localPath, folder))
    .get();
  if (taken) {
    throw new ImportError("This folder is already a Daedalus project.", 409);
  }

  // 4. Create folder, initialize git repository, write kit files, commit, insert DB row.
  // The folder itself is created non-recursively: if it appeared after the check above,
  // mkdir fails instead of reusing it, so the cleanup below only ever removes a folder
  // this call created.
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ImportError(`A folder already exists at ${folder}.`, 409);
    }
    throw err;
  }
  try {
    if (!deps.git.init) {
      throw new Error("GitOps.init is required to create a project");
    }
    await deps.git.init(folder, { initialBranch: "main" });

    const kitVars: KitVars = {
      PROJECT_NAME: name,
      PROFILE: rulesFor(settings.profile).label,
      TODAY: deps.today,
      PROFILE_RULES: profileRulesMarkdown(settings.profile),
    };
    const kitFiles = renderKit(kitVars);

    const writtenPaths: string[] = [];
    for (const file of kitFiles) {
      const fullPath = join(folder, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf8");
      writtenPaths.push(file.path);
    }

    await deps.git.commitFiles(folder, writtenPaths, `Start ${name} from the Daedalus kit`);

    const project = deps.db
      .insert(projects)
      .values({
        name,
        localPath: folder,
        profile: settings.profile,
        gitRemote: null,
        gitHost: null,
        defaultBranch: "main",
        geminiAllowed: settings.geminiAllowed,
      })
      .returning()
      .get();

    return { project };
  } catch (err) {
    rmSync(folder, { recursive: true, force: true });
    throw err;
  }
}
