/**
 * The project kit: the scaffold in /kit that every new or imported project gets.
 * Pure file reads; copying and committing happen in the import/new-project tasks.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/INTAKE.md",
  "docs/SPEC.md",
  "docs/PLAN.md",
  "docs/decisions/0001-record-decisions.md",
  ".editorconfig",
  ".claudeignore",
] as const;

export const KIT_PLACEHOLDERS = ["PROJECT_NAME", "PROFILE", "TODAY", "PROFILE_RULES"] as const;

export type KitVars = Record<(typeof KIT_PLACEHOLDERS)[number], string>;
export type KitFile = { path: (typeof KIT_FILES)[number]; content: string };

/** Absolute path of the repo's kit/ folder. */
export function kitDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "kit");
}

/** Every kit file with its placeholders filled. Values are inserted literally, in one pass. */
export function renderKit(vars: KitVars): KitFile[] {
  for (const key of KIT_PLACEHOLDERS) {
    if (typeof vars[key] !== "string") throw new Error(`renderKit: missing value for {{${key}}}`);
  }
  return KIT_FILES.map((path) => {
    const template = readFileSync(join(kitDir(), path), "utf8");
    const content = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
      if (!(KIT_PLACEHOLDERS as readonly string[]).includes(key)) {
        throw new Error(`renderKit: ${path} uses unknown placeholder ${whole}`);
      }
      return vars[key as keyof KitVars];
    });
    return { path, content };
  });
}

/** Kit files the project doesn't have yet. Existing files are never touched. */
export function missingKitFiles(projectDir: string): (typeof KIT_FILES)[number][] {
  return KIT_FILES.filter((path) => !existsSync(join(projectDir, path)));
}
