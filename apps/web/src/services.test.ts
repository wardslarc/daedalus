import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServices, getServices, initServices } from "./services.js";

describe("services", () => {
  afterEach(() => closeServices());

  it("throws a clear error when used before the server starts", () => {
    expect(() => getServices()).toThrow(/not initialised/);
  });

  it("opens the SQLite file in the data dir, migrated, with foreign keys on", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "svc-")), "data");
    const s = initServices({ dataDir: dir, repoRoot: "/srv/daedalus" });
    expect(existsSync(join(dir, "daedalus.db"))).toBe(true);
    expect(s.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(getServices()).toBe(s);
  });

  it("is idempotent: a second init (e.g. a dev reload) returns the same instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "svc-"));
    const a = initServices({ dataDir: dir, repoRoot: "/srv/daedalus" });
    expect(initServices({ dataDir: dir, repoRoot: "/srv/daedalus" })).toBe(a);
  });
});
