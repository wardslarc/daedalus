/**
 * The WebSocket upgrade (T3.3, SPEC#Security, ADR 0011). Every check runs on the HTTP upgrade
 * request, before a socket opens: Host allowlist (DNS rebinding), exact loopback Origin
 * (cross-site pages), then a live session cookie. Refusals answer a plain HTTP status.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionManager } from "@daedalus/providers";
import type { TerminalManager } from "../terminal.js";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedOrigin } from "../auth/csrf.js";
import { parseCookies } from "../auth/http.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { isAllowedHost } from "../host-check.js";
import { Channel } from "./channel.js";
import { MAX_CLIENT_MESSAGE_BYTES, WS_PATH } from "./protocol.js";

export type WorkshopDeps = {
  port: number;
  isSession: (token: string | undefined) => boolean;
  onRevoke: (listener: (token: string) => void) => () => void;
  sessions: SessionManager;
  /** Free terminals (T3.7); all are closed when the login that opened them ends. */
  terminals: TerminalManager;
  /** Next.js dev HMR (`/_next/...`), reached after the Host and Origin checks. Omit in production. */
  nextUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  heartbeatMs?: number;
};

export type Workshop = { close(): Promise<void> };

const REASONS: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 421: "Misdirected Request" };

function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

export function attachWorkshop(server: Server, deps: WorkshopDeps): Workshop {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false });
  const byToken = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();

  const offRevoke = deps.onRevoke((token) => {
    for (const ws of byToken.get(token) ?? []) ws.close(4401, "Signed out");
    // A terminal must not outlive the login that could type into it.
    void deps.terminals.closeAll();
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    if (!isAllowedHost(single(req.headers.host), deps.port)) return refuse(socket, 421);
    if (!isAllowedOrigin(single(req.headers.origin), deps.port)) return refuse(socket, 403);
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (path.startsWith("/_next/") && deps.nextUpgrade) return deps.nextUpgrade(req, socket, head);

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!deps.isSession(token)) return refuse(socket, 401);
    if (path !== WS_PATH) return refuse(socket, 404);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const key = token!;
      let set = byToken.get(key);
      if (!set) byToken.set(key, (set = new Set()));
      set.add(ws);
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("close", () => {
        set.delete(ws);
        if (set.size === 0) byToken.delete(key);
      });
      new Channel(ws, deps.sessions, deps.terminals, { isLive: () => deps.isSession(key) });
    });
  };
  server.on("upgrade", onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, deps.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        offRevoke();
        server.off("upgrade", onUpgrade);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
