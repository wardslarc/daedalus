/**
 * Daedalus custom server: one Node process on 127.0.0.1 that serves Next.js.
 * Later milestones mount the WebSocket, job queue, git, docs index and SQLite here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import createNext from "next";
import { withAuth } from "./src/auth/http.js";
import { APP_DIR, dataDir } from "./src/data-dir.js";
import { isAllowedHost } from "./src/host-check.js";
import { closeServices, initServices } from "./src/init-services.js";

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

async function main(): Promise<void> {
  const port = parsePort(process.env.DAE_PORT);
  const dev = process.env.NODE_ENV !== "production";
  // Open the database (and run migrations) before serving anything.
  initServices({ dataDir: dataDir(), repoRoot: join(APP_DIR, "..", "..") });
  const app = createNext({ dev, hostname: HOST, port, dir: APP_DIR });
  await app.prepare();
  const handle = app.getRequestHandler();
  const auth = withAuth({ port, dataDir: dataDir() }, (req, res) => handle(req, res));
  const server = await listen(port, auth.handler);
  console.log(`Daedalus ready on http://${HOST}:${port}${dev ? " (dev)" : ""}`);

  const stop = (): void => {
    // Agents get SIGTERM, then SIGKILL after 3 s: leave time for that before giving up.
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
