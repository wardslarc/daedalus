/**
 * Process-wide services, read by Next.js route handlers. Built once by server.ts (see
 * init-services.ts), which runs under tsx and loads the workspace packages directly.
 * This file has only type imports, so Next.js never bundles those packages; route
 * handlers reach them through this object on globalThis (Symbol.for key, so it also
 * survives Next's dev reloads).
 */
import type { DaedalusDb, projects } from "@daedalus/db";
import type { CreateInput, createProject, ImportInput, importProject } from "@daedalus/projects";

export type ProjectWithKit = typeof projects.$inferSelect & {
  kitPending: boolean;
};

export type Services = {
  db: DaedalusDb;
  dataDir: string;
  repoRoot: string;
  importProject(input: ImportInput): ReturnType<typeof importProject>;
  createProject(input: CreateInput): ReturnType<typeof createProject>;
  listProjects(): Promise<ProjectWithKit[]>;
};

export const SERVICES_KEY = Symbol.for("daedalus.services");
export type ServicesHolder = { [SERVICES_KEY]?: Services };

export function getServices(): Services {
  const services = (globalThis as ServicesHolder)[SERVICES_KEY];
  if (!services) throw new Error("Daedalus services are not initialised: start the app with `pnpm dae`.");
  return services;
}
