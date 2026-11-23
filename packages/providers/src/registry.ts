/**
 * Provider registry (T3.1, SPEC#Providers, ADR 0003): the only programs Daedalus may launch
 * as agents. Validated strictly at startup; a broken file stops the server.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, notInArray } from "drizzle-orm";
import { providers as providersTable, type DaedalusDb } from "@daedalus/db";
import { PROFILES, providerFamily, ProfileRuleError, type Profile } from "@daedalus/core/profiles";

export const ROLES = ["lead", "coder", "reviewer", "reader"] as const;
export type Role = (typeof ROLES)[number];

export type ProviderEntry = {
  id: string;
  kind: "acp" | "cli";
  command: string;
  args: string[];
  roles: Role[];
  allowedProfiles: Profile[];
  version: string;
};

export class ProviderConfigError extends Error {
  override name = "ProviderConfigError";
}

const FIELDS = ["id", "kind", "command", "args", "roles", "allowedProfiles", "version"] as const;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const BARE_PROGRAM = /^[A-Za-z0-9._-]+$/;
const SAFE_ABS_PATH = /^\/[A-Za-z0-9._/-]+$/;

function fail(where: string, message: string): never {
  throw new ProviderConfigError(`providers.json, ${where}: ${message}`);
}

function stringList(value: unknown, where: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) fail(where, `"${field}" must be a list of strings`);
  return value as string[];
}

function parseEntry(raw: unknown, index: number): ProviderEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`entry ${index + 1}`, "must be an object");
  const e = raw as Record<string, unknown>;
  const where = typeof e.id === "string" && e.id ? `"${e.id}"` : `entry ${index + 1}`;

  for (const key of Object.keys(e)) {
    if (!(FIELDS as readonly string[]).includes(key)) fail(where, `unknown field "${key}"`);
  }
  if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) fail(where, `"id" must be lowercase letters, digits and dashes`);
  if (e.kind !== "acp" && e.kind !== "cli") fail(where, `"kind" must be "acp" or "cli"`);

  if (typeof e.command !== "string" || e.command.includes("..") || !(BARE_PROGRAM.test(e.command) || (isAbsolute(e.command) && SAFE_ABS_PATH.test(e.command)))) {
    fail(where, `"command" must be a program name or an absolute path, with no spaces or shell characters`);
  }
  const args = stringList(e.args, where, "args");
  for (const a of args) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(a)) fail(where, `"args" can't contain newlines or control characters`);
  }

  const roles = stringList(e.roles, where, "roles");
  if (roles.length === 0) fail(where, `"roles" can't be empty`);
  for (const r of roles) if (!(ROLES as readonly string[]).includes(r)) fail(where, `unknown role "${r}"`);

  const profiles = stringList(e.allowedProfiles, where, "allowedProfiles");
  for (const p of profiles) if (!(PROFILES as readonly string[]).includes(p)) fail(where, `unknown profile "${p}"`);

  if (typeof e.version !== "string" || !EXACT_SEMVER.test(e.version)) fail(where, `"version" must be an exact version like 1.2.3 (no ^, ~, x or latest)`);
  if (e.command === "npx") {
    const pkg = args.find((a) => !a.startsWith("-"));
    const at = pkg ? pkg.lastIndexOf("@") : -1;
    if (!pkg || at <= 0) fail(where, `npx package must be pinned, e.g. some-package@${e.version}`);
    const pinned = pkg.slice(at + 1);
    if (pinned !== e.version) fail(where, `npx runs ${pinned} but "version" says ${e.version}`);
  }

  // The registry may never widen what the profile rules forbid (ADR 0008).
  let family: string;
  try {
    family = providerFamily(e.id);
  } catch (err) {
    if (err instanceof ProfileRuleError) fail(where, "unknown model family; add it to the profile rules first");
    throw err;
  }
  if (family === "gemini" && profiles.includes("work")) fail(where, "Gemini providers can't be allowed on Work projects (company policy)");

  return {
    id: e.id,
    kind: e.kind,
    command: e.command,
    args,
    roles: roles as Role[],
    allowedProfiles: profiles as Profile[],
    version: e.version,
  };
}

/** Validate a parsed providers.json. Throws ProviderConfigError naming the entry and field. */
export function parseProviders(json: unknown): ProviderEntry[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { providers?: unknown }).providers)) {
    throw new ProviderConfigError(`providers.json must be an object with a "providers" list`);
  }
  const list = (json as { providers: unknown[] }).providers.map(parseEntry);
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) throw new ProviderConfigError(`providers.json: duplicate id "${p.id}"`);
    seen.add(p.id);
  }
  return list;
}

/** Read and validate a providers.json file. Missing or invalid → ProviderConfigError. */
export function loadProviders(path: string): ProviderEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ProviderConfigError(`Can't read providers file: ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderConfigError(`providers file isn't valid JSON: ${path}`);
  }
  return parseProviders(json);
}

/** The repo's own providers.json. */
export function repoProvidersFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "providers.json");
}

/** Mirror the registry into the providers table. Missing rows are disabled, never deleted. */
export function syncProviders(db: DaedalusDb, list: ProviderEntry[]): void {
  db.transaction((tx) => {
    for (const p of list) {
      const values = {
        kind: p.kind,
        launchCommand: JSON.stringify([p.command, ...p.args]),
        roles: p.roles,
        allowedProfiles: p.allowedProfiles,
        enabled: true,
      };
      const existing = tx.select({ id: providersTable.id }).from(providersTable).where(eq(providersTable.name, p.id)).get();
      if (existing) tx.update(providersTable).set(values).where(eq(providersTable.id, existing.id)).run();
      else tx.insert(providersTable).values({ name: p.id, ...values }).run();
    }
    const names = list.map((p) => p.id);
    const stale = names.length > 0 ? notInArray(providersTable.name, names) : undefined;
    tx.update(providersTable).set({ enabled: false }).where(stale).run();
  });
}
