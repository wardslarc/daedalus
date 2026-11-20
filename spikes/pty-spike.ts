/**
 * M0 spike T0.3 — run `agy -p` headless inside a real pseudo-terminal, so it
 * can't hang waiting for a TTY.
 *
 *   pnpm spike:pty -- ../test-folder
 *   pnpm spike:pty -- ../test-folder "optional prompt"
 *
 * Set AGY_BIN if `agy` isn't on PATH (e.g. the full path to agy.exe on Windows).
 * Runs with --sandbox. Raw output is saved to spikes/out/*.jsonl.
 */
import * as pty from "node-pty";
import { cliArgs, DEFAULT_PROMPT, openLog, resolveFolder } from "./shared.js";

const [folderArg, ...promptWords] = cliArgs();
const folder = resolveFolder(folderArg);
const promptText = promptWords.length > 0 ? promptWords.join(" ") : DEFAULT_PROMPT;
const bin = process.env.AGY_BIN ?? (process.platform === "win32" ? "agy.exe" : "agy");
const TIMEOUT_MS = 3 * 60_000;

const log = openLog("pty-agy");
// -p takes the next argument as the prompt, so the prompt must come right after it.
const args = ["-p", promptText, "--sandbox"];

console.log(`[spike] ${bin} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
console.log(`[spike] folder: ${folder}`);
console.log(`[spike] log: ${log.file}\n`);

const term = pty.spawn(bin, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: folder,
  env: process.env as Record<string, string>,
});

const started = Date.now();
term.onData((data) => {
  process.stdout.write(data);
  log.stream.write(`${JSON.stringify({ t: Date.now() - started, data })}\n`);
});

const timer = setTimeout(() => {
  console.error(`\n[spike] agy still running after ${TIMEOUT_MS / 1000}s — killing it (this is the hang T0.3 checks for)`);
  term.kill();
  process.exit(2);
}, TIMEOUT_MS);

term.onExit(({ exitCode, signal }) => {
  clearTimeout(timer);
  log.stream.end();
  console.log(`\n[spike] agy exited · code=${exitCode} signal=${signal ?? "none"} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(exitCode);
});
