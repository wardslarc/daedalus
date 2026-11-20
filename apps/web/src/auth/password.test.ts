import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, hashPassword, readAuth, verifyPassword, writeAuth } from "./password.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "dae-auth-"));

describe("password hashing", () => {
  it("produces an argon2id hash that verifies only the right password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("correct horse battery");
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("rejects passwords shorter than the minimum", async () => {
    await expect(hashPassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(/at least/);
  });

  it("returns false (not throw) for a malformed stored hash", async () => {
    expect(await verifyPassword("not-a-hash", "whatever password")).toBe(false);
  });
});

describe("auth.json", () => {
  it("is missing until written", () => {
    expect(readAuth(tempDir())).toBeNull();
  });

  it("stores only the hash, readable by the owner only", async () => {
    const dir = tempDir();
    const hash = await hashPassword("correct horse battery");
    writeAuth(dir, hash);
    const file = join(dir, "auth.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("correct horse battery");
    expect(readAuth(dir)?.passwordHash).toBe(hash);
  });

  it("treats a corrupted or foreign auth.json as no password set", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "auth.json"), "{ not json");
    expect(readAuth(dir)).toBeNull();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ passwordHash: "plaintext!" }));
    expect(readAuth(dir)).toBeNull();
  });

  it("creates the data dir if needed", async () => {
    const dir = join(tempDir(), "nested", "data");
    writeAuth(dir, await hashPassword("correct horse battery"));
    expect(readAuth(dir)).not.toBeNull();
  });
});
