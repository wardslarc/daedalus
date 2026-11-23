import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SessionManager, type ProviderEntry } from "@daedalus/providers";
import type { ServerMessage } from "./protocol.js";
import { attachWorkshop, type Workshop } from "./upgrade.js";
import { TerminalManager } from "../terminal.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const fakeAgent = fileURLToPath(new URL("../../../../packages/providers/test/fixtures/fake-agent.ts", import.meta.url));
const fake = (id: "claude" | "antigravity"): ProviderEntry => ({
  id,
  kind: "acp",
  command: process.execPath,
  args: [tsxCli, fakeAgent],
  roles: ["coder"],
  allowedProfiles: id === "antigravity" ? ["client", "personal"] : ["work", "client", "personal"],
  version: "1.0.0",
});
const project = () => ({ id: 7, name: "P", localPath: mkdtempSync(join(tmpdir(), "ws-proj-")), profile: "personal", geminiAllowed: false });

const GOOD = "good-token";
let server: Server;
let port: number;
let workshop: Workshop;
let manager: SessionManager;
let terminals: TerminalManager;
let revoke: (token: string) => void;
let nextUpgrades: string[];

beforeEach(async () => {
  server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  manager = new SessionManager({ providers: [fake("claude"), fake("antigravity")], checkVersion: async () => "1.0.0" });
  nextUpgrades = [];
  terminals = new TerminalManager({ shell: "/bin/sh" });
  workshop = attachWorkshop(server, {
    terminals,
    port,
    isSession: (t) => t === GOOD,
    onRevoke: (l) => {
      revoke = l;
      return () => undefined;
    },
    sessions: manager,
    nextUpgrade: (req, socket) => {
      nextUpgrades.push(req.url ?? "");
      socket.destroy();
    },
  });
});

afterEach(async () => {
  await workshop.close();
  await manager.stopAll();
  await terminals.closeAll();
  await new Promise<void>((r) => server.close(() => r()));
});

type Opts = { path?: string; host?: string; origin?: string | null; cookie?: string | null };
function headers({ host = `127.0.0.1:${port}`, origin = `http://127.0.0.1:${port}`, cookie = `dae_session=${GOOD}` }: Opts) {
  const h: Record<string, string> = { host };
  if (origin !== null) h.origin = origin;
  if (cookie !== null) h.cookie = cookie;
  return h;
}

/** Try an upgrade; resolve with the HTTP status of a refusal, or 101. */
function tryUpgrade(opts: Opts = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: opts.path ?? "/ws",
      headers: { ...headers(opts), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** An open, allowed socket that records every message. */
async function connect(): Promise<{ ws: WebSocket; messages: ServerMessage[]; next: (pred: (m: ServerMessage) => boolean) => Promise<ServerMessage> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: headers({}) });
  const messages: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const found = messages.find(pred);
      if (found) {
        messages.splice(messages.indexOf(found), 1);
        return resolve(found);
      }
      const t = setTimeout(() => reject(new Error(`no matching message; saw ${JSON.stringify(messages)}`)), 10000);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          messages.splice(messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  return { ws, messages, next };
}
const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));

describe("WebSocket upgrade: refused before any socket opens", () => {
  it.each<[string, Opts, number]>([
    ["no session cookie", { cookie: null }, 401],
    ["an unknown session", { cookie: "dae_session=forged" }, 401],
    ["a foreign Origin", { origin: "http://evil.example" }, 403],
    ["Origin on another port", { origin: "http://127.0.0.1:1" }, 403],
    ["no Origin", { origin: null }, 403],
    ["a foreign Host (DNS rebinding)", { host: `evil.example:${port}` }, 421],
    ["an unknown path", { path: "/other" }, 404],
  ])("%s", async (_, opts, status) => {
    expect(await tryUpgrade(opts)).toBe(status);
  });

  it("a valid session, Origin and Host opens the socket and lists sessions", async () => {
    expect(await tryUpgrade()).toBe(101);
    const { ws, next } = await connect();
    expect(await next((m) => m.type === "sessions")).toEqual({ type: "sessions", sessions: [] });
    ws.close();
  });

  it("Next.js HMR upgrades reach Next only with an allowed Host and Origin", async () => {
    expect(await tryUpgrade({ path: "/_next/webpack-hmr", origin: "http://evil.example" })).toBe(403);
    expect(nextUpgrades).toEqual([]);
    await tryUpgrade({ path: "/_next/webpack-hmr", cookie: null }).catch(() => 0);
    expect(nextUpgrades).toEqual(["/_next/webpack-hmr"]);
  });

  it("logging out closes that session's sockets", async () => {
    const { ws } = await connect();
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    revoke(GOOD);
    expect(await closed).toBe(4401);
  });
});

describe("Workshop channel", () => {
  it("subscribe, prompt: the reply streams back and the turn ends", async () => {
    const { ws, next } = await connect();
    const s = await manager.start(project(), "claude");
    expect(await next((m) => m.type === "sessions" && m.sessions.length === 1)).toMatchObject({
      sessions: [{ id: s.id, projectId: 7, projectName: "P", providerId: "claude", busy: false }],
    });
    send(ws, { id: "a", type: "subscribe", sessionId: s.id });
    await next((m) => m.type === "ack" && m.id === "a");
    send(ws, { id: "b", type: "prompt", sessionId: s.id, text: "echo hi there" });
    await next((m) => m.type === "ack" && m.id === "b");
    const end = await next((m) => m.type === "event" && m.event.type === "turn_end");
    expect(end).toMatchObject({ sessionId: s.id, event: { stopReason: "end_turn" } });
    ws.close();
  });

  it("since: a reconnecting viewer gets only the events it missed", async () => {
    const s = await manager.start(project(), "claude");
    const done = new Promise<void>((r) => s.onEvent((e) => e.type === "turn_end" && r()));
    await s.prompt("echo abcd");
    await done;
    const lastSeq = s.backlog().at(-1)!.seq;
    const { ws, next, messages } = await connect();
    send(ws, { id: "a", type: "subscribe", sessionId: s.id, since: lastSeq - 1 });
    await next((m) => m.type === "ack");
    expect(messages.filter((m) => m.type === "event").map((m) => (m.type === "event" ? m.event.seq : 0))).toEqual([lastSeq]);
    ws.close();
  });

  it("a permission answer reaches the agent", async () => {
    const { ws, next } = await connect();
    const s = await manager.start(project(), "claude");
    send(ws, { id: "a", type: "subscribe", sessionId: s.id });
    send(ws, { id: "b", type: "prompt", sessionId: s.id, text: "permission" });
    const ask = await next((m) => m.type === "event" && m.event.type === "permission");
    const ev = ask.type === "event" && ask.event.type === "permission" ? ask.event : null;
    const deny = ev!.options.find((o) => o.kind === "reject_once")!;
    send(ws, { id: "c", type: "permission", sessionId: s.id, requestId: ev!.requestId, optionId: deny.optionId });
    await next((m) => m.type === "ack" && m.id === "c");
    const reply = await next((m) => m.type === "event" && m.event.type === "message");
    expect(reply).toMatchObject({ event: { text: "denied" } });
    ws.close();
  });

  it("bad messages get an error and the socket stays open; unknown sessions are 404; busy is 409", async () => {
    const { ws, next } = await connect();
    ws.send("{nope");
    expect(await next((m) => m.type === "error")).toMatchObject({ status: 400 });
    send(ws, { id: "x", type: "subscribe", sessionId: "missing" });
    expect(await next((m) => m.type === "error")).toMatchObject({ id: "x", status: 404 });
    const s = await manager.start(project(), "claude");
    send(ws, { id: "p1", type: "prompt", sessionId: s.id, text: "sleep 2000" });
    await next((m) => m.type === "ack" && m.id === "p1");
    send(ws, { id: "p2", type: "prompt", sessionId: s.id, text: "echo again" });
    expect(await next((m) => m.type === "error" && m.id === "p2")).toMatchObject({ status: 409 });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("the session list is re-sent when a session ends", async () => {
    const { ws, next } = await connect();
    const s = await manager.start(project(), "claude");
    await next((m) => m.type === "sessions" && m.sessions.length === 1);
    await s.stop();
    await next((m) => m.type === "sessions" && m.sessions.length === 0);
    ws.close();
  });
});

describe("Workshop channel: free terminal", () => {
  it("lists terminals on connect; attach, type pwd, see the project folder", async () => {
    const p = project();
    const t = await terminals.open(p);
    const { ws, next } = await connect();
    expect(await next((m) => m.type === "terminals")).toMatchObject({ terminals: [{ id: t.id, projectId: 7 }] });
    send(ws, { id: "a", type: "terminal_attach", terminalId: t.id });
    await next((m) => m.type === "ack" && m.id === "a");
    send(ws, { id: "b", type: "terminal_input", terminalId: t.id, data: "pwd\n" });
    await next((m) => m.type === "ack" && m.id === "b");
    const real = (await import("node:fs")).realpathSync(p.localPath);
    let seen = "";
    await next((m) => {
      if (m.type === "terminal_output") seen += m.data;
      return seen.includes(real);
    });
    ws.close();
  });

  it("unknown terminals are 404, bad payloads 400, and the socket stays open", async () => {
    const { ws, next } = await connect();
    send(ws, { id: "x", type: "terminal_input", terminalId: "nope", data: "ls\n" });
    expect(await next((m) => m.type === "error" && m.id === "x")).toMatchObject({ status: 404 });
    send(ws, { id: "y", type: "terminal_resize", terminalId: "nope", cols: 80 });
    expect(await next((m) => m.type === "error")).toMatchObject({ status: 400 });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("logging out closes every terminal", async () => {
    const t = await terminals.open(project());
    const pid = terminals.pid(t.id)!;
    const gone = new Promise<void>((r) => terminals.onEvent(t.id, (e) => e.type === "exit" && r()));
    const { ws } = await connect();
    revoke(GOOD);
    await gone;
    expect(terminals.list()).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
    ws.close();
  });
});
