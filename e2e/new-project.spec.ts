import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_PROJECTS_HOME } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** POST JSON from the page, with the CSRF header the server requires. */
function post(page: Page, body: unknown) {
  return page.evaluate(async (b) => {
    const token = /(?:^|;\s*)dae_csrf=([0-9a-f]{64})/.exec(document.cookie)?.[1] ?? "";
    const r = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify(b),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }, body);
}

test.describe("new project", () => {
  test("creates a project: 201, folder under DAE_PROJECTS_HOME has the kit and one commit", async ({ page }) => {
    await login(page);
    const res = await post(page, { name: "Alpha App", profile: "personal" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      project: { name: "Alpha App", profile: "personal" },
    });

    const expectedDir = join(E2E_PROJECTS_HOME, "projects", "alpha-app");
    expect(existsSync(expectedDir)).toBe(true);
    expect(existsSync(join(expectedDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(expectedDir, "docs/SPEC.md"))).toBe(true);

    expect(git(expectedDir, "branch", "--show-current")).toBe("main");
    expect(git(expectedDir, "log", "--oneline").split("\n").filter(Boolean)).toHaveLength(1);
    expect(git(expectedDir, "log", "-1", "--format=%s")).toBe("Start Alpha App from the Daedalus kit");
  });

  test("profile rules are enforced by the server: Work+Gemini -> 403", async ({ page }) => {
    await login(page);
    const res = await post(page, { name: "Work Omega", profile: "work", geminiAllowed: true });
    expect(res.status).toBe(403);
    const expectedDir = join(E2E_PROJECTS_HOME, "work", "work-omega");
    expect(existsSync(expectedDir)).toBe(false);
  });

  test("new project is refused without a session", async ({ request }) => {
    const r = await request.post("/api/projects/new", { data: { name: "Anon App", profile: "personal" } });
    expect([401, 403]).toContain(r.status());
  });
});
