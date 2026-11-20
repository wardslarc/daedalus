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
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  const migrationsFolder =
    options?.migrationsFolder ??
    fileURLToPath(new URL("../migrations", import.meta.url));

  // Migrations that rebuild a table (DROP + RENAME) would cascade-delete child rows if
  // foreign keys were on, and drizzle runs migrations inside a transaction, where the
  // migration's own "PRAGMA foreign_keys=OFF" is ignored. So switch them off here, migrate,
  // verify every reference still resolves, and only then switch them back on.
  sqlite.pragma("foreign_keys = OFF");
  migrate(db, { migrationsFolder });
  const broken = sqlite.pragma("foreign_key_check") as unknown[];
  if (broken.length > 0) {
    sqlite.close();
    throw new Error(`Database migration left ${broken.length} broken foreign key reference(s); not opening ${dbPath}`);
  }
  sqlite.pragma("foreign_keys = ON");

  return db;
}

export * from "./schema.js";
export type DaedalusDb = ReturnType<typeof openDb>;
