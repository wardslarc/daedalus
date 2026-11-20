/** The one Daedalus password: argon2id hash in <data dir>/auth.json (mode 0600). */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
const AUTH_FILE = "auth.json";

// @node-rs/argon2: Algorithm.Argon2id = 2. Passed as a literal because the package's
// const enum can't be imported under isolatedModules.
const ARGON2ID = 2;

export type AuthFile = { passwordHash: string; updatedAt: string };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return hash(password, { algorithm: ARGON2ID });
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

export function readAuth(dataDir: string): AuthFile | null {
  const file = join(dataDir, AUTH_FILE);
  if (!existsSync(file)) return null;
  let parsed: Partial<AuthFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AuthFile>;
  } catch {
    // Corrupted file: behave as if no password is set, so the server shows the setup notice.
    return null;
  }
  return typeof parsed.passwordHash === "string" && parsed.passwordHash.startsWith("$argon2id$")
    ? { passwordHash: parsed.passwordHash, updatedAt: String(parsed.updatedAt ?? "") }
    : null;
}

/** Write atomically: a temp file created 0600, then renamed over auth.json. */
export function writeAuth(dataDir: string, passwordHash: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, AUTH_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const body: AuthFile = { passwordHash, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
