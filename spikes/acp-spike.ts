/**
 * M0 spike T0.1 / T0.2 — start an ACP agent in a folder, send one prompt,
 * stream its updates, and stop cleanly.
 *
 *   pnpm spike:acp -- claude ../test-folder
 *   pnpm spike:acp -- antigravity ../test-folder "optional prompt"
 *
 * Read-only by design: every permission request is rejected, and the client
 * advertises no file-system or terminal capabilities.
 * Every session/update is logged to spikes/out/*.jsonl (look for usage_update: T0.4).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { cliArgs, DEFAULT_PROMPT, openLog, resolveFolder, spikeDir } from "./shared.js";

type ProviderEntry = { command: string; args: string[]; note?: string };

const [providerId = "claude", folderArg, ...promptWords] = cliArgs();
const folder = resolveFolder(folderArg);
const promptText = promptWords.length > 0 ? promptWords.join(" ") : DEFAULT_PROMPT;

const providers = JSON.parse(readFileSync(join(spikeDir, "providers.json"), "utf8")) as Record<
  string,
  ProviderEntry
>;
const provider = providers[providerId];
if (!provider || !provider.command) {
  console.error(`Provider "${providerId}" has no command in spikes/providers.json. ${provider?.note ?? ""}`);
  process.exit(1);
}

const log = openLog(`acp-${providerId}`);
const TIMEOUT_MS = 5 * 60_000;

console.log(`[spike] ${providerId}: ${provider.command} ${provider.args.join(" ")}`);
console.log(`[spike] folder: ${folder}`);
console.log(`[spike] log: ${log.file}\n`);

const child = spawn(provider.command, provider.args, {
  cwd: folder,
  stdio: ["pipe", "pipe", "pipe"],
  // npx and other .cmd shims need a shell on Windows.
  shell: process.platform === "win32",
});
child.stderr.on("data", (d: Buffer) => process.stderr.write(`[agent stderr] ${d.toString()}`));
child.on("exit", (code) => console.log(`\n[spike] agent process exited (${code ?? "signal"})`));

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

function render(update: acp.SessionNotification["update"]): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") process.stdout.write(update.content.text);
      break;
    case "tool_call":
      console.log(`\n● ${update.title}`);
      break;
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        console.log(`  ${update.status === "completed" ? "✓" : "✗"} ${update.title ?? update.toolCallId}`);
      }
      break;
    case "plan":
      console.log(`\n[plan] ${update.entries.map((e) => `${e.status}: ${e.content}`).join(" | ")}`);
      break;
    case "usage_update":
      console.log(`\n[usage] ${JSON.stringify(update)}`);
      break;
    default:
      break;
  }
}

const app = acp
  .client({ name: "daedalus-spike" })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    log.stream.write(`${JSON.stringify(params)}\n`);
    render(params.update);
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const reject = params.options.find((o) => o.kind === "reject_once");
    console.log(`\n[permission] ${params.toolCall.title ?? "tool call"} → rejected (spike is read-only)`);
    return reject
      ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" as const } };
  });

const timer = setTimeout(() => {
  console.error(`\n[spike] timed out after ${TIMEOUT_MS / 1000}s`);
  child.kill();
  process.exit(2);
}, TIMEOUT_MS);

let exitCode = 0;
try {
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    log.stream.write(`${JSON.stringify({ initialize: init })}\n`);
    console.log(`[init] protocol v${init.protocolVersion} · agent ${JSON.stringify(init.agentInfo ?? "unknown")}`);
    if (init.authMethods && init.authMethods.length > 0) {
      console.log(`[init] auth methods offered: ${init.authMethods.map((m) => m.id).join(", ")}`);
    }

    const session = await ctx.request(acp.methods.agent.session.new, { cwd: folder, mcpServers: [] });
    console.log(`[session] ${session.sessionId}\n`);

    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    log.stream.write(`${JSON.stringify({ promptResult: result })}\n`);
    console.log(`\n\n[done] stopReason=${result.stopReason}`);
  });
} catch (err) {
  exitCode = 1;
  console.error(`\n[spike] failed:`, err);
} finally {
  clearTimeout(timer);
  log.stream.end();
  child.kill();
}
process.exit(exitCode);
