import { describe, expect, it } from "vitest";
import { decide } from "./gate.js";

const base = { method: "GET", path: "/projects", hasSession: false, passwordSet: true, csrfOk: false };

describe("decide", () => {
  it("lets signed-in GETs through", () => {
    expect(decide({ ...base, hasSession: true })).toEqual({ kind: "allow" });
  });

  it("redirects signed-out page requests to /login", () => {
    expect(decide(base)).toEqual({ kind: "redirect", to: "/login" });
    expect(decide({ ...base, path: "/" })).toEqual({ kind: "redirect", to: "/login" });
  });

  it("answers 401 to signed-out API requests", () => {
    expect(decide({ ...base, path: "/api/anything" })).toEqual({ kind: "status", status: 401 });
  });

  it("lets the login page, static assets and favicon through without a session", () => {
    expect(decide({ ...base, path: "/login" }).kind).toBe("allow");
    expect(decide({ ...base, path: "/_next/static/chunks/app.js" }).kind).toBe("allow");
    expect(decide({ ...base, path: "/favicon.ico" }).kind).toBe("allow");
  });

  it("does not treat lookalike paths as public", () => {
    expect(decide({ ...base, path: "/login/../projects" }).kind).toBe("redirect");
    expect(decide({ ...base, path: "/loginx" }).kind).toBe("redirect");
    expect(decide({ ...base, path: "/_next/data/x.json" }).kind).toBe("redirect");
  });

  it("sends signed-in users away from /login", () => {
    expect(decide({ ...base, path: "/login", hasSession: true })).toEqual({ kind: "redirect", to: "/projects" });
  });

  it("requires CSRF on every non-GET, including login and for signed-in users", () => {
    expect(decide({ ...base, method: "POST", path: "/api/login" })).toEqual({ kind: "status", status: 403 });
    expect(decide({ ...base, method: "POST", path: "/api/login", csrfOk: true }).kind).toBe("allow");
    expect(decide({ ...base, method: "POST", path: "/api/x", hasSession: true })).toEqual({ kind: "status", status: 403 });
    expect(decide({ ...base, method: "DELETE", path: "/api/x", hasSession: true, csrfOk: true }).kind).toBe("allow");
  });

  it("still requires a session for non-login POSTs that pass CSRF", () => {
    expect(decide({ ...base, method: "POST", path: "/api/x", csrfOk: true })).toEqual({ kind: "status", status: 401 });
  });

  it("serves only the setup notice until a password is set", () => {
    const notSet = { ...base, passwordSet: false };
    expect(decide(notSet)).toEqual({ kind: "setup" });
    expect(decide({ ...notSet, path: "/login" })).toEqual({ kind: "setup" });
    expect(decide({ ...notSet, method: "POST", path: "/api/login", csrfOk: true })).toEqual({ kind: "setup" });
    expect(decide({ ...notSet, path: "/_next/static/a.js" }).kind).toBe("allow");
  });

  it("treats HEAD like GET", () => {
    expect(decide({ ...base, method: "HEAD", hasSession: true }).kind).toBe("allow");
  });
});
