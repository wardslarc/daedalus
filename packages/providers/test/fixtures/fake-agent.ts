/**
 * A tiny ACP agent for tests. Behaviour is chosen by the prompt text:
 *   echo <text>      reply with <text> (in two chunks)
 *   cwd              reply with the working directory
 *   env <NAME>       reply with that variable, or "(unset)"
 *   sleep <ms>       wait (cancellable), then reply "slept"
 *   permission       ask the client for permission; reply allowed / denied / cancelled
 *   stubborn-child   start a child that ignores SIGTERM; reply with its pid
 *   flood <n>        send n message chunks
 *   exit             exit the process with code 3
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let cancel: (() => void) | null = null;

const say = (client: acp.AgentContext, sessionId: string, text: string) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "fake-session" }))
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancel?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const first = params.prompt[0];
    const input = first && first.type === "text" ? first.text : "";
    const [cmd = "", ...rest] = input.split(" ");
    const arg = rest.join(" ");
    const sid = params.sessionId;

    switch (cmd) {
      case "echo":
        await say(client, sid, arg.slice(0, Math.ceil(arg.length / 2)));
        await say(client, sid, arg.slice(Math.ceil(arg.length / 2)));
        break;
      case "cwd":
        await say(client, sid, process.cwd());
        break;
      case "env":
        await say(client, sid, process.env[arg] ?? "(unset)");
        break;
      case "sleep": {
        const cancelled = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), Number(arg));
          cancel = () => {
            clearTimeout(t);
            resolve(true);
          };
        });
        cancel = null;
        if (cancelled) return { stopReason: "cancelled" as const };
        await say(client, sid, "slept");
        break;
      }
      case "permission": {
        const res = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: sid,
          toolCall: { toolCallId: "tool-1", title: "Write a file", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        const outcome = res.outcome.outcome === "cancelled" ? "cancelled" : res.outcome.optionId === "allow" ? "allowed" : "denied";
        await say(client, sid, outcome);
        break;
      }
      case "stubborn-child": {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        await say(client, sid, String(child.pid));
        break;
      }
      case "flood":
        for (let i = 0; i < Number(arg); i++) await say(client, sid, ".");
        break;
      case "exit":
        process.exit(3);
        break;
      default:
        await say(client, sid, `unknown: ${input}`);
    }
    return { stopReason: "end_turn" as const };
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
await app.connect(stream).closed;
process.exit(0);
