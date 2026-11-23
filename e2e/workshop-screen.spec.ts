/**
 * T3.4: Workshop screen end to end:
 * start a session from the picker, type a prompt, see the reply in the console, stop it;
 * open a terminal, type pwd, see the project folder.
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-ws-screen-${name}-`));
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

test("Workshop screen: start session from picker, type prompt, see reply, stop; open terminal, type pwd, see folder", async ({
  page,
}) => {
  await login(page);
  const dir = fixtureRepo("workshop-screen");
  const imp = await post(page, "/api/projects/import", {
    source: dir,
    profile: "personal",
    name: "Workshop Screen Project",
  });
  expect(imp.status).toBe(201);
  const projectId = (imp.json.project as { id: number }).id;
  const folder = execFileSync("realpath", [dir], { encoding: "utf8" }).trim();

  try {
    await page.goto("/workshop");
    await expect(page.getByRole("heading", { level: 1, name: "Workshop" })).toBeVisible();

    // Empty state should be visible initially
    await expect(
      page.getByText("No live sessions. Start one from a project's Pipeline, or open a free session."),
    ).toBeVisible();
    await expect(page.getByText("Sessions 0 / 2")).toBeVisible();

    // 1. Start a session from the picker
    await page.getByRole("button", { name: "New session" }).first().click();

    const projectSelect = page.getByLabel("Project");
    await expect(projectSelect).toBeVisible();
    await projectSelect.selectOption(String(projectId));

    await page.getByRole("button", { name: "Claude" }).click();
    await page.getByRole("button", { name: "Start" }).click();

    // 2. Console for Claude session should appear
    const consoleSection = page.locator("section.workshop-console.console-claude");
    await expect(consoleSection).toBeVisible();
    await expect(page.getByText("Sessions 1 / 2")).toBeVisible();

    // 3. Type a prompt, see the reply in the console
    const input = consoleSection.getByLabel("Steer this session");
    await expect(input).toBeVisible();
    await input.fill("echo hello");
    await consoleSection.getByRole("button", { name: "Send" }).click();

    // Fake agent replies with "hello"
    await expect(consoleSection.locator(".xterm")).toContainText("hello", { timeout: 15000 });

    // 4. Stop the session
    const stopBtn = consoleSection.getByRole("button", { name: "Stop" });
    await stopBtn.click();
    await expect(consoleSection).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Sessions 0 / 2")).toBeVisible();

    // 5. Open a terminal, type pwd, see the project folder
    await page.getByRole("button", { name: "New session" }).first().click();
    await projectSelect.selectOption(String(projectId));
    await page.getByRole("button", { name: "Open terminal" }).click();

    const terminalSection = page.locator("section.workshop-console.console-terminal");
    await expect(terminalSection).toBeVisible();

    // Click into terminal and type pwd
    const termXterm = terminalSection.locator(".xterm");
    await termXterm.click();
    await page.keyboard.type("pwd\n");

    // Terminal output should show the project folder
    await expect(terminalSection.locator(".xterm")).toContainText(folder, { timeout: 15000 });

    // Close the terminal
    await terminalSection.getByRole("button", { name: "Close" }).click();
    await expect(terminalSection).not.toBeVisible({ timeout: 10000 });
  } finally {
    deleteProject(projectId);
  }
});
