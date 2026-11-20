/** Server-only: builds the services object (server.ts calls this before serving). */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@daedalus/db";
import { importProject, realGitOps } from "@daedalus/projects";
import { SERVICES_KEY, type Services, type ServicesHolder } from "./services.js";

export type ServicesOptions = { dataDir: string; repoRoot: string };

const holder = globalThis as ServicesHolder;

export function initServices({ dataDir, repoRoot }: ServicesOptions): Services {
  const existing = holder[SERVICES_KEY];
  if (existing) return existing;
  const db = openDb(join(dataDir, "daedalus.db"));
  const services: Services = {
    db,
    dataDir,
    repoRoot,
    importProject: (input) =>
      importProject(input, {
        db,
        git: realGitOps,
        home: homedir(),
        forbiddenRoots: [repoRoot, dataDir],
        tmpRoot: tmpdir(),
        today: new Date().toISOString().slice(0, 10),
      }),
  };
  holder[SERVICES_KEY] = services;
  return services;
}

/** Close the database and forget the instance (shutdown and tests). */
export function closeServices(): void {
  holder[SERVICES_KEY]?.db.$client.close();
  delete holder[SERVICES_KEY];
}
