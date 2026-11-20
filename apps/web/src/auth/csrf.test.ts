import { describe, expect, it } from "vitest";
import { checkCsrf, newCsrfToken } from "./csrf.js";

const port = 4317;
const token = newCsrfToken();

describe("newCsrfToken", () => {
  it("is 64 hex chars and random", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(newCsrfToken()).not.toBe(token);
  });
});

describe("checkCsrf", () => {
  const ok = { origin: `http://127.0.0.1:${port}`, header: token, cookie: token };

  it("passes with a same-origin Origin and matching header and cookie", () => {
    expect(checkCsrf({ ...ok, port })).toBe(true);
    expect(checkCsrf({ ...ok, origin: `http://localhost:${port}`, port })).toBe(true);
  });

  it("fails without an Origin or with a foreign one", () => {
    expect(checkCsrf({ ...ok, origin: undefined, port })).toBe(false);
    expect(checkCsrf({ ...ok, origin: "null", port })).toBe(false);
    expect(checkCsrf({ ...ok, origin: "http://evil.example", port })).toBe(false);
    expect(checkCsrf({ ...ok, origin: `https://127.0.0.1:${port}`, port })).toBe(false);
    expect(checkCsrf({ ...ok, origin: "http://127.0.0.1:9999", port })).toBe(false);
  });

  it("fails when the header is missing or does not match the cookie", () => {
    expect(checkCsrf({ ...ok, header: undefined, port })).toBe(false);
    expect(checkCsrf({ ...ok, cookie: undefined, port })).toBe(false);
    expect(checkCsrf({ ...ok, header: newCsrfToken(), port })).toBe(false);
    expect(checkCsrf({ ...ok, header: token.slice(0, 10), port })).toBe(false);
    expect(checkCsrf({ ...ok, header: "", cookie: "", port })).toBe(false);
  });
});
