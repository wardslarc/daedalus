import type { AddressInfo } from "node:net";
import { request } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST, listen } from "../server.js";

function get(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path: "/", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("custom server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // The guard checks Host against the port it is given, so find a free port first.
    const probe = await listen(0, (_req, res) => {
      res.end();
    });
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    server = await listen(port, (_req, res) => {
      res.end("ok");
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("binds to 127.0.0.1 only", () => {
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    expect(addr.family).toBe("IPv4");
  });

  it("serves requests whose Host is loopback on our port", async () => {
    expect(await get(port, `127.0.0.1:${port}`)).toEqual({ status: 200, body: "ok" });
    expect((await get(port, `localhost:${port}`)).status).toBe(200);
  });

  it("answers 421 to any other Host, before the app handler runs", async () => {
    const res = await get(port, "evil.example");
    expect(res.status).toBe(421);
    expect(res.body).not.toContain("ok");
  });
});
