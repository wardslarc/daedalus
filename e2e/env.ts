import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** e2e runs its own server on its own port and data dir, never the owner's real ones. */
export const E2E_PORT = Number(process.env.DAE_E2E_PORT ?? 4318);
export const E2E_PASSWORD = "e2e correct horse battery";
export const E2E_DATA_DIR =
  process.env.DAE_E2E_DATA_DIR ?? (process.env.DAE_E2E_DATA_DIR = mkdtempSync(join(tmpdir(), "dae-e2e-")));
export const E2E_PROJECTS_HOME =
  process.env.DAE_PROJECTS_HOME ?? (process.env.DAE_PROJECTS_HOME = mkdtempSync(join(tmpdir(), "dae-e2e-home-")));

/**
 * e2e never launches real agents: both provider ids run the fake ACP agent from
 * packages/providers/test/fixtures. Pinned to the running Node's version, which is what the
 * session manager's `--version` check sees.
 */
export const E2E_PROVIDERS_FILE = join(E2E_DATA_DIR, "providers.e2e.json");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const fakeAgent = fileURLToPath(new URL("../packages/providers/test/fixtures/fake-agent.ts", import.meta.url));
const fakeEntry = (id: string, allowedProfiles: string[]) => ({
  id,
  kind: "acp",
  command: process.execPath,
  args: [tsxCli, fakeAgent],
  roles: ["coder"],
  allowedProfiles,
  version: process.versions.node,
});
writeFileSync(
  E2E_PROVIDERS_FILE,
  JSON.stringify({ providers: [fakeEntry("claude", ["work", "client", "personal"]), fakeEntry("antigravity", ["client", "personal"])] }, null, 2),
);
