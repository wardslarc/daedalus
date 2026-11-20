import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/web */
export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where auth.json (and later SQLite) live: DAE_DATA_DIR, or <repo root>/.daedalus-data. */
export function dataDir(): string {
  const fromEnv = process.env.DAE_DATA_DIR;
  // A relative DAE_DATA_DIR is relative to where the user ran pnpm, not apps/web.
  if (fromEnv) return resolve(process.env.INIT_CWD ?? process.cwd(), fromEnv);
  return join(APP_DIR, "..", "..", ".daedalus-data");
}
