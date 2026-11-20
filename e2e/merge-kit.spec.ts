import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-merge-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

function post(page: Page, path: string, body: unknown = {}) {
  return page.evaluate(
    async ([p, b]) => {
      const token = /(?:^|;\s*)dae_csrf=([0-9a-f]{64})/.exec(document.cookie)?.[1] ?? "";
      const r = await fetch(p as string, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify(b),
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    },
    [path, body] as const,
  );
}

test.describe("merge kit", () => {
  test("merges daedalus/kit into main once, then answers 409", async ({ page }) => {
    const dir = fixtureRepo();
    await login(page);
    const imp = await post(page, "/api/projects/import", { source: dir, profile: "personal" });
    expect(imp.status).toBe(201);
    const id = (imp.json.project as { id: number }).id;

    const merged = await post(page, `/api/projects/${id}/merge-kit`);
    expect(merged.status).toBe(200);
    expect(git(dir, "log", "-1", "--format=%s", "main")).toBe("Merge Daedalus project kit");
    expect(git(dir, "show", "main:CLAUDE.md")).toContain("@AGENTS.md");
    expect(git(dir, "branch", "--list", "daedalus/kit")).toBe("");

    expect((await post(page, `/api/projects/${id}/merge-kit`)).status).toBe(409);
  });

  test("rejects bad and unknown ids", async ({ page }) => {
    await login(page);
    expect((await post(page, "/api/projects/abc/merge-kit")).status).toBe(400);
    expect((await post(page, "/api/projects/0/merge-kit")).status).toBe(400);
    expect((await post(page, "/api/projects/999999/merge-kit")).status).toBe(404);
  });
});
