#!/usr/bin/env node
// `dae`             start the Daedalus server (apps/web/server.ts) through tsx
// `dae set-password` set or change the password (apps/web/src/cli/set-password.ts)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const commands = { "set-password": "src/cli/set-password.ts" };
const [sub] = process.argv.slice(2).filter((a) => a !== "--");
if (sub && !(sub in commands)) {
  console.error(`Unknown command "${sub}". Usage: dae [set-password]`);
  process.exit(2);
}
const script = join(appDir, sub ? commands[sub] : "server.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const child = spawn(process.execPath, [tsxCli, script], { cwd: appDir, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
