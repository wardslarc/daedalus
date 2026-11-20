import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export const DEFAULT_DATA_DIR = ".daedalus-data";
export const DEFAULT_DB_FILENAME = "daedalus.db";

export function getDefaultDbPath(): string {
  return path.join(process.cwd(), DEFAULT_DATA_DIR, DEFAULT_DB_FILENAME);
}

export interface OpenDbOptions {
  migrationsFolder?: string;
}

export function openDb(dbPath: string = getDefaultDbPath(), options?: OpenDbOptions) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  const migrationsFolder =
    options?.migrationsFolder ??
    fileURLToPath(new URL("../migrations", import.meta.url));

  migrate(db, { migrationsFolder });

  return db;
}

export * from "./schema.js";
export type DaedalusDb = ReturnType<typeof openDb>;
