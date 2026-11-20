import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS, SessionStore } from "./sessions.js";

describe("SessionStore", () => {
  it("issues a random 64-hex-char token that validates", () => {
    const store = new SessionStore();
    const a = store.create();
    const b = store.create();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(store.isValid(a)).toBe(true);
  });

  it("rejects unknown, empty and missing tokens", () => {
    const store = new SessionStore();
    store.create();
    expect(store.isValid("0".repeat(64))).toBe(false);
    expect(store.isValid("")).toBe(false);
    expect(store.isValid(undefined)).toBe(false);
  });

  it("does not keep the raw token in memory", () => {
    const store = new SessionStore();
    const token = store.create();
    expect(JSON.stringify([...store.debugKeys()])).not.toContain(token);
  });

  it("expires sessions after the TTL", () => {
    let now = 1_000_000;
    const store = new SessionStore(() => now);
    const token = store.create();
    now += SESSION_TTL_MS - 1;
    expect(store.isValid(token)).toBe(true);
    now += 2;
    expect(store.isValid(token)).toBe(false);
  });

  it("revokes a session", () => {
    const store = new SessionStore();
    const token = store.create();
    store.revoke(token);
    expect(store.isValid(token)).toBe(false);
  });
});
