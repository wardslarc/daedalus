import { describe, expect, it } from "vitest";
import { ProfileRuleError } from "@daedalus/core/profiles";
import { ImportError } from "@daedalus/projects";
import { readJsonBody, toErrorResponse } from "./http.js";

const req = (body: string, type = "application/json") =>
  new Request("http://127.0.0.1:4317/api/x", { method: "POST", headers: { "content-type": type }, body });

describe("readJsonBody", () => {
  it("parses a JSON object", async () => {
    expect(await readJsonBody(req('{"a":1}'))).toEqual({ a: 1 });
  });

  it("rejects non-JSON content types, bad JSON, non-objects and oversized bodies with ImportError 400/413", async () => {
    await expect(readJsonBody(req("a=1", "application/x-www-form-urlencoded"))).rejects.toMatchObject({ status: 415 });
    await expect(readJsonBody(req("{nope"))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonBody(req("[1,2]"))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonBody(req(JSON.stringify({ s: "x".repeat(9000) })))).rejects.toMatchObject({ status: 413 });
  });
});

describe("toErrorResponse", () => {
  it("maps known errors to their status with a plain message", async () => {
    const r1 = toErrorResponse(new ImportError("Already a project", 409));
    expect(r1.status).toBe(409);
    expect(await r1.json()).toEqual({ error: "Already a project" });
    const r2 = toErrorResponse(new ProfileRuleError("Work can't use Gemini"));
    expect(r2.status).toBe(403);
    expect(await r2.json()).toEqual({ error: "Work can't use Gemini" });
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const r = toErrorResponse(new Error("ENOENT /home/secret/path"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
  });

  it("never caches error responses", () => {
    expect(toErrorResponse(new ImportError("x")).headers.get("cache-control")).toBe("no-store");
  });
});
