/**
 * T3.7: the free terminal end to end: a real shell in the project folder, typed into over /ws.
 * REST opens and closes it; the page's own WebSocket carries keystrokes and output.
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-term-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function deleteProject(id: number) {
  const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"));
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
test("Free terminal: open on a project, type pwd over /ws, see the project folder, close", async ({ page }) => {
  await login(page);
  const dir = fixtureRepo("terminal");
  const imp = await post(page, "/api/projects/import", { source: dir, profile: "personal", name: "Term Project" });
  expect(imp.status).toBe(201);
  const projectId = (imp.json.project as { id: number }).id;
  const folder = execFileSync("realpath", [dir], { encoding: "utf8" }).trim();

  try {
    const opened = await post(page, "/api/terminals", { projectId });
    expect(opened.status).toBe(201);
    const terminalId = (opened.json.terminal as { id: string }).id;

    const output = await page.evaluate(
      ([id, want]) =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://${location.host}/ws`);
          let text = "";
          const timer = setTimeout(() => reject(new Error(`timed out with ${JSON.stringify(text)}`)), 15000);
          ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if (msg.type === "ack" && msg.id === "att") ws.send(JSON.stringify({ id: "in", type: "terminal_input", terminalId: id, data: "pwd\n" }));
            if (msg.type === "terminal_output") text += msg.data;
            if (text.includes(want as string)) {
              clearTimeout(timer);
              ws.close();
              resolve(text);
            }
          };
          ws.onopen = () => ws.send(JSON.stringify({ id: "att", type: "terminal_attach", terminalId: id }));
          ws.onerror = () => reject(new Error("socket error"));
        }),
      [terminalId, folder] as const,
    );
    expect(output).toContain(folder);

    expect((await post(page, `/api/terminals/${terminalId}/close`)).status).toBe(200);
    const list = await page.evaluate(async () => (await (await fetch("/api/terminals")).json()) as { terminals: unknown[] });
    expect(list.terminals).toEqual([]);
  } finally {
    deleteProject(projectId);
  }
});

test("the terminal API is unreachable without a session", async ({ page }) => {
  await page.goto("/login");
  const status = await page.evaluate(async () => (await fetch("/api/terminals")).status);
  expect(status).toBe(401);
});
