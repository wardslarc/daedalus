import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listen } from "../../server.js";
import { withAuth } from "./http.js";
import { hashPassword, writeAuth } from "./password.js";
import { MAX_FAILURES } from "./rate-limit.js";

const PASSWORD = "correct horse battery";

type Res = { status: number; headers: Headers; body: string };

describe("withAuth over HTTP", () => {
  let server: Server;
  let port: number;
  let base: string;
  let dataDir: string;
  let resetLimiter: () => void;

  async function free(): Promise<number> {
    const probe = await listen(0, (_q, r) => {
      r.end();
    });
    const p = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return p;
  }

  async function req(path: string, init: RequestInit & { cookies?: string } = {}): Promise<Res> {
    const headers = new Headers(init.headers);
    if (init.cookies) headers.set("cookie", init.cookies);
    const r = await fetch(base + path, { ...init, headers, redirect: "manual" });
    return { status: r.status, headers: r.headers, body: await r.text() };
  }

  /** GET /login to receive a CSRF cookie; returns its value. */
  async function csrf(): Promise<string> {
    const r = await req("/login");
    const m = /dae_csrf=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") ?? "");
    if (!m?.[1]) throw new Error("no csrf cookie");
    return m[1];
  }

  async function login(password: string, token: string, origin = base): Promise<Res> {
    return req("/api/login", {
      method: "POST",
      headers: { origin, "x-csrf-token": token, "content-type": "application/json" },
      cookies: `dae_csrf=${token}`,
      body: JSON.stringify({ password }),
    });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dae-http-"));
    port = await free();
    base = `http://127.0.0.1:${port}`;
    const auth = withAuth({ port, dataDir }, (_q, r) => {
      r.end("app");
    });
    resetLimiter = auth.resetLimiter;
    server = await listen(port, auth.handler);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => resetLimiter());

  it("serves only a setup notice before a password is set", async () => {
    const r = await req("/projects");
    expect(r.status).toBe(503);
    expect(r.body).toContain("pnpm dae set-password");
    writeAuth(dataDir, await hashPassword(PASSWORD));
  });

  it("redirects signed-out pages to /login and gives a CSRF cookie", async () => {
    const r = await req("/projects");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
    expect(r.headers.get("set-cookie")).toMatch(/dae_csrf=[0-9a-f]{64}; Path=\/; SameSite=Strict/);
  });

  it("rejects a wrong password with 401 and no session", async () => {
    const r = await login("wrong password!!", await csrf());
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie") ?? "").not.toContain("dae_session");
  });

  it("rejects login without CSRF header, or from a foreign Origin, with 403", async () => {
    const token = await csrf();
    const noHeader = await req("/api/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      cookies: `dae_csrf=${token}`,
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(noHeader.status).toBe(403);
    expect((await login(PASSWORD, token, "http://evil.example")).status).toBe(403);
  });

  it("locks login after repeated wrong passwords, even for the right one", async () => {
    const token = await csrf();
    for (let i = 0; i < MAX_FAILURES; i++) await login("wrong password!!", token);
    const r = await login(PASSWORD, token);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("logs in with the right password, then reaches the app; logout ends the session", async () => {
    const token = await csrf();
    const r = await login(PASSWORD, token);
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/dae_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800/);
    const session = /dae_session=([0-9a-f]{64})/.exec(setCookie)?.[1];
    const cookies = `dae_session=${session}; dae_csrf=${token}`;

    expect(await req("/projects", { cookies })).toMatchObject({ status: 200, body: "app" });
    expect((await req("/login", { cookies })).headers.get("location")).toBe("/projects");

    const out = await req("/api/logout", { method: "POST", headers: { origin: base, "x-csrf-token": token }, cookies });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("dae_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect((await req("/projects", { cookies })).status).toBe(302);
  });

  it("rejects oversized login bodies", async () => {
    const token = await csrf();
    const r = await login("x".repeat(10_000), token);
    expect(r.status).toBe(413);
  });
});
