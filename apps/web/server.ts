/**
 * Daedalus custom server: one Node process on 127.0.0.1 that serves Next.js.
 * Later milestones mount the WebSocket, job queue, git, docs index and SQLite here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nextModule from "next";
import { isAllowedHost } from "./src/host-check.js";

/** Never configurable: Daedalus is local-only (AGENTS.md, SPEC#Security). */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

// next is CommonJS: under NodeNext its types put the factory on .default, while at
// runtime the default import may already be the factory. Accept either.
const createNext = (nextModule.default ?? nextModule) as typeof nextModule.default;

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
  const app = createNext({ dev, hostname: HOST, port, dir: dirname(fileURLToPath(import.meta.url)) });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = await listen(port, (req, res) => handle(req, res));
  console.log(`Daedalus ready on http://${HOST}:${port}${dev ? " (dev)" : ""}`);

  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
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
