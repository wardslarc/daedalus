/**
 * Login, logout and the auth gate, wired onto Node's http types. Runs after the Host check
 * and before Next.js; the password never reaches Next.js code. See ADR 0007.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CSRF_COOKIE, CSRF_HEADER, checkCsrf, newCsrfToken } from "./csrf.js";
import { decide, HOME, LOGIN_API } from "./gate.js";
import { readAuth, verifyPassword } from "./password.js";
import { LoginLimiter } from "./rate-limit.js";
import { SESSION_COOKIE, SESSION_TTL_MS, SessionStore } from "./sessions.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export const LOGOUT_API = "/api/logout";
const MAX_BODY_BYTES = 4096;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  res.statusCode = status;
  appendCookies(res, cookies);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function appendCookies(res: ServerResponse, cookies: string[]): void {
  if (cookies.length === 0) return;
  const prev = res.getHeader("set-cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader("set-cookie", [...list, ...cookies]);
}

const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
const csrfCookie = (token: string): string => `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`;

const SETUP_PAGE = `<!doctype html><meta charset="utf-8"><title>Daedalus setup</title>
<body style="font:16px system-ui;max-width:36em;margin:4em auto;padding:0 1em">
<h1>Set a password first</h1><p>In a terminal, in the Daedalus repo, run:</p>
<pre>pnpm dae set-password</pre><p>Then reload this page.</p></body>`;

export type AuthOptions = { port: number; dataDir: string };

export function withAuth({ port, dataDir }: AuthOptions, next: Handler) {
  const sessions = new SessionStore();
  let limiter = new LoginLimiter();

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const wait = limiter.lockedForMs();
    if (wait > 0) {
      res.setHeader("retry-after", String(Math.ceil(wait / 1000)));
      return send(res, 429, { error: "locked", retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "too large" });
    let password: unknown;
    try {
      password = (JSON.parse(raw) as { password?: unknown }).password;
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const auth = readAuth(dataDir);
    if (typeof password !== "string" || !auth || !(await verifyPassword(auth.passwordHash, password))) {
      limiter.recordFailure();
      return send(res, 401, { error: "wrong password" });
    }
    limiter.recordSuccess();
    const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    sessions.revoke(old);
    return send(res, 200, { ok: true, redirect: HOME }, [sessionCookie(sessions.create())]);
  }

  const handler: Handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const method = (req.method ?? "GET").toUpperCase();
    const cookies = parseCookies(req.headers.cookie);
    const session = cookies[SESSION_COOKIE];
    const hasSession = sessions.isValid(session);

    // Hand out a CSRF token to any client that doesn't have one yet.
    const csrf = cookies[CSRF_COOKIE];
    if (!csrf || !/^[0-9a-f]{64}$/.test(csrf)) appendCookies(res, [csrfCookie(newCsrfToken())]);

    const decision = decide({
      method,
      path: url.pathname,
      hasSession,
      passwordSet: readAuth(dataDir) !== null,
      csrfOk: checkCsrf({
        origin: single(req.headers.origin),
        header: single(req.headers[CSRF_HEADER]),
        cookie: csrf,
        port,
      }),
    });

    switch (decision.kind) {
      case "setup":
        res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(SETUP_PAGE);
        return;
      case "status":
        return send(res, decision.status, { error: decision.status === 401 ? "sign in" : "forbidden" });
      case "redirect":
        res.writeHead(302, { location: decision.to, "cache-control": "no-store" });
        res.end();
        return;
      case "allow":
        if (method === "POST" && url.pathname === LOGIN_API) return handleLogin(req, res);
        if (method === "POST" && url.pathname === LOGOUT_API) {
          sessions.revoke(session);
          return send(res, 200, { ok: true }, [clearedSessionCookie]);
        }
        return next(req, res);
    }
  };

  return {
    handler,
    /** For tests only. */
    resetLimiter: () => {
      limiter = new LoginLimiter();
    },
  };
}
