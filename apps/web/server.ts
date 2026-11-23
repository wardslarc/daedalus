/**
 * Daedalus custom server: one Node process on 127.0.0.1 that serves Next.js.
 * Later milestones mount the WebSocket, job queue, git, docs index and SQLite here.
 */
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import createNext from "next";
import { withAuth } from "./src/auth/http.js";
import { APP_DIR, dataDir } from "./src/data-dir.js";
import { isAllowedHost } from "./src/host-check.js";
import { closeServices, initServices } from "./src/init-services.js";
import { attachWorkshop } from "./src/ws/upgrade.js";

/** Never configurable: Daedalus is local-only (AGENTS.md, SPEC#Security). */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Wrap a request handler with the Host header allowlist. */
export function guarded(port: number, handler: Handler): Handler {
  return (req, res) => {
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      res.end("Misdirected request: Daedalus only answers on 127.0.0.1 and localhost.\n");
      return;
    }
    return handler(req, res);
  };
}

/** Listen on HOST only. Resolves once the socket is bound. */
export function listen(port: number, handler: Handler): Promise<Server> {
  const server = createServer(guarded(port, handler));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DAE_PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Next.js dev HMR. `getUpgradeHandler()` on the custom-server wrapper reaches the render
 * server, which ignores HMR; Next's own auto-hook uses the router server's `upgradeHandler`
 * getter (next/dist/server/next.js, NextCustomServer). Checked against next 16.4.5.
 */
function nextHmrUpgrade(app: ReturnType<typeof createNext>): UpgradeHandler {
  const handler = (app as unknown as { upgradeHandler?: UpgradeHandler }).upgradeHandler;
  if (typeof handler !== "function") throw new Error("Next.js has no upgradeHandler: check nextHmrUpgrade against this Next version");
  return (req, socket, head) => handler(req, socket, head);
}

async function main(): Promise<void> {
  const port = parsePort(process.env.DAE_PORT);
  const dev = process.env.NODE_ENV !== "production";
  // Open the database (and run migrations) before serving anything.
  const services = initServices({ dataDir: dataDir(), repoRoot: join(APP_DIR, "..", "..") });
  // Next.js would add its own "upgrade" listener to the real server on the first request,
  // accepting WebSockets with no session check. Give it a server that never emits; our upgrade
  // handler forwards only HMR to Next, after its own checks (ADR 0011).
  const app = createNext({ dev, hostname: HOST, port, dir: APP_DIR, httpServer: new EventEmitter() as Server });
  await app.prepare();
  const handle = app.getRequestHandler();
  const auth = withAuth({ port, dataDir: dataDir() }, (req, res) => handle(req, res));
  const server = await listen(port, auth.handler);
  const workshop = attachWorkshop(server, {
    port,
    isSession: auth.isSession,
    onRevoke: auth.onRevoke,
    sessions: services.sessions,
    terminals: services.terminals,
    ...(dev ? { nextUpgrade: nextHmrUpgrade(app) } : {}),
  });
  console.log(`Daedalus ready on http://${HOST}:${port}${dev ? " (dev)" : ""}`);

  const stop = (): void => {
    // Agents get SIGTERM, then SIGKILL after 3 s: leave time for that before giving up.
    void workshop.close();
    server.close(() => {
      void closeServices().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
