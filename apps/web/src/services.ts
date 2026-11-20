/**
 * Process-wide services (today: the SQLite database), opened once by server.ts and read by
 * Next.js route handlers. Kept on globalThis under a Symbol.for key so Next's dev reloads,
 * which re-evaluate modules, still see the same instance.
 */
import { join } from "node:path";
import { openDb, type DaedalusDb } from "@daedalus/db";

export type Services = { db: DaedalusDb; dataDir: string; repoRoot: string };
export type ServicesOptions = { dataDir: string; repoRoot: string };

const KEY = Symbol.for("daedalus.services");
type Holder = { [KEY]?: Services };
const holder = globalThis as Holder;

export function initServices({ dataDir, repoRoot }: ServicesOptions): Services {
  const existing = holder[KEY];
  if (existing) return existing;
  const db = openDb(join(dataDir, "daedalus.db"));
  const services: Services = { db, dataDir, repoRoot };
  holder[KEY] = services;
  return services;
}

export function getServices(): Services {
  const services = holder[KEY];
  if (!services) throw new Error("Daedalus services are not initialised: start the app with `pnpm dae`.");
  return services;
}

/** Close the database and forget the instance (shutdown and tests). */
export function closeServices(): void {
  holder[KEY]?.db.$client.close();
  delete holder[KEY];
}
