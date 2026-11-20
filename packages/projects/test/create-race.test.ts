import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@daedalus/db";
import { describe, expect, it, vi } from "vitest";

// Simulate a folder appearing between the "does it exist?" check and mkdir: existsSync
// says no for paths in `hidden`, while the folder really exists.
const hidden = new Set<string>();
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return { ...fs, existsSync: (p: import("node:fs").PathLike) => (hidden.has(String(p)) ? false : fs.existsSync(p)) };
});

const { createProject } = await import("../src/create.js");
const { realGitOps } = await import("../src/git-ops.js");

describe("createProject when the folder appears after the check", () => {
  it("answers 409 and never touches or deletes a folder it didn't create", async () => {
    const home = mkdtempSync(join(tmpdir(), "race-home-"));
    const folder = join(home, "projects", "raced");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "keep.txt"), "someone else's work\n");
    hidden.add(folder);

    await expect(
      createProject({ name: "Raced", profile: "personal" }, { db: openDb(":memory:"), git: realGitOps, home, today: "2026-11-20" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(folder, "keep.txt"), "utf8")).toBe("someone else's work\n");
  });
});
