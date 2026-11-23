/** Server-only: builds the services object (server.ts calls this before serving). */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, projects } from "@daedalus/db";
import { branchExists } from "@daedalus/git";
import { createProject, ImportError, importProject, mergeKit, realGitOps } from "@daedalus/projects";
import { loadProviders, repoProvidersFile, SessionManager, syncProviders } from "@daedalus/providers";
import { SERVICES_KEY, type Services, type ServicesHolder } from "./services.js";

export type ServicesOptions = { dataDir: string; repoRoot: string };

const holder = globalThis as ServicesHolder;

export function initServices({ dataDir, repoRoot }: ServicesOptions): Services {
  const existing = holder[SERVICES_KEY];
  if (existing) return existing;
  // The providers file is the list of programs Daedalus may launch (T3.1). Validate it
  // before anything else: a broken file stops the server instead of half-loading.
  const providers = loadProviders(process.env.DAE_PROVIDERS_FILE || repoProvidersFile());
  const db = openDb(join(dataDir, "daedalus.db"));
  syncProviders(db, providers);
  const home = process.env.DAE_PROJECTS_HOME || homedir();
  const services: Services = {
    db,
    dataDir,
    repoRoot,
    providers,
    sessions: new SessionManager({ providers }),
    importProject: (input) =>
      importProject(input, {
        db,
        git: realGitOps,
        home,
        forbiddenRoots: [repoRoot, dataDir],
        tmpRoot: tmpdir(),
        today: new Date().toISOString().slice(0, 10),
      }),
    createProject: (input) =>
      createProject(input, {
        db,
        git: realGitOps,
        home,
        today: new Date().toISOString().slice(0, 10),
      }),
    listProjects: async () => {
      const rows = db.select().from(projects).all();
      return Promise.all(
        rows.map(async (p) => {
          let kitPending = false;
          if (existsSync(p.localPath)) {
            try {
              kitPending = await branchExists(p.localPath, "daedalus/kit");
            } catch {
              kitPending = false;
            }
          }
          return {
            ...p,
            kitPending,
          };
        }),
      );
    },
    mergeKit: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return mergeKit(project, { tmpRoot: tmpdir() });
    },
  };
  holder[SERVICES_KEY] = services;
  return services;
}

/** Stop every agent, close the database and forget the instance (shutdown and tests). */
export async function closeServices(): Promise<void> {
  const services = holder[SERVICES_KEY];
  delete holder[SERVICES_KEY];
  if (!services) return;
  try {
    await services.sessions.stopAll();
  } finally {
    services.db.$client.close();
  }
}
