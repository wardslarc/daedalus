import { describe, expect, it } from "vitest";
import { isAllowedHost } from "./host-check.js";

describe("isAllowedHost", () => {
  const port = 4317;

  it("allows loopback IPv4 and localhost on the server's port", () => {
    expect(isAllowedHost("127.0.0.1:4317", port)).toBe(true);
    expect(isAllowedHost("localhost:4317", port)).toBe(true);
  });

  it("ignores case in the hostname", () => {
    expect(isAllowedHost("LocalHost:4317", port)).toBe(true);
  });

  it("rejects a missing or empty Host header", () => {
    expect(isAllowedHost(undefined, port)).toBe(false);
    expect(isAllowedHost("", port)).toBe(false);
  });

  it("rejects the right hostname on the wrong port or with no port", () => {
    expect(isAllowedHost("127.0.0.1:80", port)).toBe(false);
    expect(isAllowedHost("127.0.0.1", port)).toBe(false);
    expect(isAllowedHost("localhost", port)).toBe(false);
  });

  it("rejects other hostnames, including rebinding-style lookalikes", () => {
    expect(isAllowedHost("evil.example:4317", port)).toBe(false);
    expect(isAllowedHost("localhost.evil.example:4317", port)).toBe(false);
    expect(isAllowedHost("127.0.0.1.nip.io:4317", port)).toBe(false);
    expect(isAllowedHost("0.0.0.0:4317", port)).toBe(false);
    expect(isAllowedHost("172.21.20.207:4317", port)).toBe(false);
  });

  it("rejects IPv6 loopback, since the server listens on IPv4 only", () => {
    expect(isAllowedHost("[::1]:4317", port)).toBe(false);
  });

  it("rejects userinfo and junk", () => {
    expect(isAllowedHost("user@127.0.0.1:4317", port)).toBe(false);
    expect(isAllowedHost("127.0.0.1:4317 ", port)).toBe(false);
    expect(isAllowedHost("127.0.0.1:4317/", port)).toBe(false);
  });
});
