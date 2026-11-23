/**
 * T3.5: permission prompts in the Workshop console.
 * The fake agent's `permission` prompt asks to "Write a file" and replies with what it got back:
 * allowed / denied / cancelled. Checks: nothing runs without a click, and a denied request
 * reaches the agent as denied.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-ws-perm-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function deleteProject(id: number) {
  const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  db.close();
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

test("Workshop permissions: nothing runs without a click; Deny reaches the agent as denied, Allow once as allowed", async ({
  page,
}) => {
  await login(page);
  const dir = fixtureRepo("permission");
  const imp = await post(page, "/api/projects/import", { source: dir, profile: "personal", name: "Permission Project" });
  expect(imp.status).toBe(201);
  const projectId = (imp.json.project as { id: number }).id;

  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/workshop");
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByLabel("Project").selectOption(String(projectId));
    await page.getByRole("button", { name: "Claude" }).click();
    await page.getByRole("button", { name: "Start" }).click();

    const con = page.locator("section.workshop-console.console-claude");
    const output = con.locator(".xterm");
    const input = con.getByLabel("Steer this session");
    await expect(input).toBeEnabled();

    // 1. The agent asks; the panel shows and the console waits.
    await input.fill("permission");
    await con.getByRole("button", { name: "Send" }).click();
    const panel = con.getByRole("group", { name: "Claude asks to write a file" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Nothing runs until you choose. Stopping the session cancels this request.");
    await expect(panel).toContainText(/\d+:\d\d left before auto-cancel/);
    await expect(con.getByText("Waiting for you")).toBeVisible();
    await expect(con).toHaveClass(/console-waiting/);
    await page.screenshot({ path: "test-results/screens/workshop-permission-1440.png" });

    // 2. Nothing runs without a click: after a pause the agent has still had no answer.
    await page.waitForTimeout(2000);
    await expect(panel).toBeVisible();
    await expect(output).not.toContainText("denied");
    await expect(output).not.toContainText("allowed");
    await expect(input).toBeDisabled();

    // 3. Deny: the panel goes away and the agent reports it was denied.
    await panel.getByRole("button", { name: "Deny" }).click();
    await expect(panel).toBeHidden();
    await expect(output).toContainText("denied", { timeout: 15000 });
    await expect(con.getByText("Waiting for you")).toBeHidden();
    await expect(con).not.toHaveClass(/console-waiting/);
    await expect(output).not.toContainText("allowed");

    // 4. Allow once on a second request reaches the agent as allowed.
    await expect(input).toBeEnabled({ timeout: 15000 });
    await input.fill("permission");
    await con.getByRole("button", { name: "Send" }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Allow once" }).click();
    await expect(panel).toBeHidden();
    await expect(output).toContainText("allowed", { timeout: 15000 });

    await con.getByRole("button", { name: "Stop" }).click();
    await expect(con).toBeHidden({ timeout: 10000 });
  } finally {
    deleteProject(projectId);
  }
});
