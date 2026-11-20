import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** e2e runs its own server on its own port and data dir, never the owner's real ones. */
export const E2E_PORT = 4318;
export const E2E_PASSWORD = "e2e correct horse battery";
export const E2E_DATA_DIR =
  process.env.DAE_E2E_DATA_DIR ?? (process.env.DAE_E2E_DATA_DIR = mkdtempSync(join(tmpdir(), "dae-e2e-")));
export const E2E_PROJECTS_HOME =
  process.env.DAE_PROJECTS_HOME ?? (process.env.DAE_PROJECTS_HOME = mkdtempSync(join(tmpdir(), "dae-e2e-home-")));
