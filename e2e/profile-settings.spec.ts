import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-profile-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function deleteProject(id: number) {
  try {
    // The server writes to the same file; wait for its lock instead of failing.
    const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    db.close();
  } catch {
    // ignore
  }
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator("form[data-hydrated='true']").waitFor();
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
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    },
    [path, body] as const,
  );
}

function get(page: Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p as string);
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }, path);
}

test.describe("profile settings", () => {
  test("THE PLAN CHECK: Work settings policy, direct POST 403, UI disabled with policy text, and Escape closes", async ({
    page,
  }) => {
    const dir = fixtureRepo("work-plan");
    await login(page);
    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "work",
      name: "Plan Check Work",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Direct POST with forbidden setting { profile: "work", geminiAllowed: true } returns 403
      const res = await post(page, `/api/projects/${projectId}/settings`, {
        profile: "work",
        geminiAllowed: true,
      });
      expect(res.status).toBe(403);

      // Read it back from GET /api/projects: geminiAllowed is still false
      const list = await get(page, "/api/projects");
      expect(list.status).toBe(200);
      const projects = list.json.projects as Array<{ id: number; geminiAllowed: boolean }>;
      const proj = projects.find((p) => p.id === projectId);
      expect(proj).toBeDefined();
      expect(proj?.geminiAllowed).toBe(false);

      // The Work dialog shows the checkbox disabled with the policy text; Escape closes and focus returns
      await page.goto("/projects");
      const card = page.getByRole("article", { name: "Plan Check Work" });
      const settingsBtn = card.getByRole("button", { name: "Settings" });
      await settingsBtn.click();

      const dialog = page.getByRole("dialog", { name: "Project settings" });
      await expect(dialog).toBeVisible();

      const geminiCheckbox = dialog.getByLabel("Allow Gemini");
      await expect(geminiCheckbox).toBeDisabled();
      expect(await geminiCheckbox.isChecked()).toBe(false);
      await expect(dialog.getByText("Not allowed for Work projects (company policy)")).toBeVisible();

      // Escape closes dialog and focus returns to button
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(settingsBtn).toBeFocused();
    } finally {
      deleteProject(projectId);
    }
  });

  test("Client project can turn Gemini on through dialog and sticks after reload", async ({ page }) => {
    const dir = fixtureRepo("client-optin");
    await login(page);
    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "client",
      name: "Client Optin Proj",
      geminiAllowed: false,
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      await page.goto("/projects");
      const card = page.getByRole("article", { name: "Client Optin Proj" });
      const settingsBtn = card.getByRole("button", { name: "Settings" });
      await settingsBtn.click();

      const dialog = page.getByRole("dialog", { name: "Project settings" });
      await expect(dialog).toBeVisible();

      const geminiCheckbox = dialog.getByLabel("Allow Gemini");
      await expect(geminiCheckbox).toBeEnabled();
      expect(await geminiCheckbox.isChecked()).toBe(false);

      await geminiCheckbox.check();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).not.toBeVisible();

      // Change sticks after reload
      await page.reload();
      const reloadedCard = page.getByRole("article", { name: "Client Optin Proj" });
      await reloadedCard.getByRole("button", { name: "Settings" }).click();
      const reloadedDialog = page.getByRole("dialog", { name: "Project settings" });
      await expect(reloadedDialog).toBeVisible();
      expect(await reloadedDialog.getByLabel("Allow Gemini").isChecked()).toBe(true);
    } finally {
      deleteProject(projectId);
    }
  });
});
