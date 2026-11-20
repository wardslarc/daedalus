import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const spikeDir = dirname(fileURLToPath(import.meta.url));

/** Args after the script name, without the `--` that pnpm may pass through. */
export function cliArgs(): string[] {
  return process.argv.slice(2).filter((a) => a !== "--");
}

/** Resolve a folder relative to where the user ran pnpm, not the spikes folder. */
export function resolveFolder(arg: string | undefined): string {
  if (!arg) {
    console.error("Usage: give a test folder path. Use a throwaway folder: the agent can read it.");
    process.exit(1);
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  return isAbsolute(arg) ? arg : resolve(base, arg);
}

/** A JSON-lines log in spikes/out/ (gitignored). */
export function openLog(name: string): { file: string; stream: WriteStream } {
  const dir = join(spikeDir, "out");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${name}-${stamp}.jsonl`);
  return { file, stream: createWriteStream(file) };
}

export const DEFAULT_PROMPT =
  "List the files in this folder and describe the project in two sentences. Do not modify any files.";
