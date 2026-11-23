/**
 * T3.3: the Workshop channel end to end, with the fake ACP agent (see e2e/env.ts).
 * REST starts and stops the session; the page's own WebSocket streams the reply.
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-ws-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function deleteProject(id: number) {
  // The server writes to the same file; wait for its lock instead of failing.
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

test("Workshop channel: start over REST, chat over /ws, stop", async ({ page }) => {
  await login(page);
  const work = await post(page, "/api/projects/import", { source: fixtureRepo("work"), profile: "work", name: "WS Work" });
  const personal = await post(page, "/api/projects/import", { source: fixtureRepo("personal"), profile: "personal", name: "WS Personal" });
  expect(work.status).toBe(201);
  expect(personal.status).toBe(201);
  const workId = (work.json.project as { id: number }).id;
  const personalId = (personal.json.project as { id: number }).id;

  try {
    // A Work project can't start agy, whatever the request says.
    expect((await post(page, "/api/sessions", { projectId: workId, providerId: "antigravity" })).status).toBe(403);

    const started = await post(page, "/api/sessions", { projectId: personalId, providerId: "claude" });
    expect(started.status).toBe(201);
    const sessionId = (started.json.session as { id: string }).id;

    const reply = await page.evaluate(
      (id) =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://${location.host}/ws`);
          let text = "";
          const timer = setTimeout(() => reject(new Error(`timed out with "${text}"`)), 15000);
          ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if (msg.type === "ack" && msg.id === "sub") ws.send(JSON.stringify({ id: "p", type: "prompt", sessionId: id, text: "echo hello browser" }));
            if (msg.type === "event" && msg.event.type === "message") text += msg.event.text;
            if (msg.type === "event" && msg.event.type === "turn_end") {
              clearTimeout(timer);
              ws.close();
              resolve(text);
            }
          };
          ws.onopen = () => ws.send(JSON.stringify({ id: "sub", type: "subscribe", sessionId: id }));
          ws.onerror = () => reject(new Error("socket error"));
        }),
      sessionId,
    );
    expect(reply).toBe("hello browser");

    expect((await post(page, `/api/sessions/${sessionId}/stop`)).status).toBe(200);
    const list = await page.evaluate(async () => (await (await fetch("/api/sessions")).json()) as { sessions: unknown[] });
    expect(list.sessions).toEqual([]);
  } finally {
    deleteProject(workId);
    deleteProject(personalId);
  }
});

test("the channel is unreachable without a session", async ({ page }) => {
  await page.goto("/login");
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        ws.onopen = () => resolve("opened");
        ws.onerror = () => resolve("refused");
      }),
  );
  expect(outcome).toBe("refused");
});
