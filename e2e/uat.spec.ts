import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { NotImplementedError, transition } from "../packages/core/src/index.js";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

let notImplemented = false;
try {
  transition({ status: "queued", attempts: 0 }, { type: "start" });
} catch (err) {
  if (err instanceof NotImplementedError) {
    notImplemented = true;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-uat-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function ensureUatTables(db: DatabaseSync) {
  try {
    db.prepare("ALTER TABLE shaping_state ADD COLUMN active_milestone_verify_started_at text").run();
  } catch {
    // ignore
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS uat_items (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      position integer NOT NULL,
      text text NOT NULL,
      source text NOT NULL,
      created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uat_items_project_id_release_version_position_unique ON uat_items (project_id, release_version, position);
    CREATE TABLE IF NOT EXISTS uat_marks (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      item_id integer NOT NULL,
      result text NOT NULL,
      note text,
      kind text,
      head_sha text NOT NULL,
      session_id text,
      fix_task_id integer,
      finding_id integer,
      marked_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uat_app_config (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL UNIQUE,
      start_command text NOT NULL,
      app_url text NOT NULL,
      updated_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uat_sessions (
      id text PRIMARY KEY NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      head_sha text NOT NULL,
      status text NOT NULL,
      error text,
      started_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
      ended_at text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uat_sessions_active_project_unique ON uat_sessions (project_id) WHERE status IN ('starting', 'running');
    CREATE TABLE IF NOT EXISTS gate_runs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      head_sha text NOT NULL,
      status text NOT NULL,
      checks text,
      error text,
      started_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
      finished_at text
    );
    CREATE TABLE IF NOT EXISTS gate_findings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      check text NOT NULL,
      fingerprint text NOT NULL,
      severity text NOT NULL,
      title text NOT NULL,
      detail text,
      location text,
      blocking integer NOT NULL,
      state text DEFAULT 'open' NOT NULL,
      outcome text,
      reason text,
      fix_task_id integer,
      decided_at text,
      first_seen_run_id integer,
      last_seen_run_id integer,
      created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
  `);
}

function deleteProject(id: number) {
  try {
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

test.describe("UAT checklist with a recorded browser (T6.4)", () => {
  test.beforeEach(() => {
    test.skip(notImplemented, "needs T5.2 task state machine");
  });

  test("the release page shows frozen UAT items and saves a mark; trace and screenshots land under data folder", async ({
    page,
  }) => {
    const dir = fixtureRepo("uat-e2e");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** UAT e2e\n- **Users:** QA\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nUAT spec\n## Verify\n- End-to-end check passes\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "mock.html"),
      "<!DOCTYPE html><html><body>Mock</body></html>",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "PLAN.md"),
      `# Plan
## M1 — v1.0 Initial Release
Done when: Verify user can browse catalog
- Export catalog report
- [ ] **T1.1 Task** \`[claude]\` — [[SPEC#Overview]]
  Task description
  check: echo pass-check
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "shaping docs");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "UAT Test Project",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      ensureUatTables(db);

      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO shaping_state (project_id, spec_approved_at, mock_approved_at, mock_artifact_url, mock_approved_by, plan_approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, now, now, "https://example.com/mock", "Tester", now);

      // Start milestone
      const startRes = await post(page, `/api/projects/${projectId}/chat/start-milestone`, {
        version: "v1.0",
        milestoneCode: "M1",
      });
      expect(startRes.status).toBe(200);

      // Mark tasks done & set verify started
      db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(projectId);
      db.prepare("UPDATE shaping_state SET active_milestone_verify_started_at = ? WHERE project_id = ?").run(
        now,
        projectId,
      );

      // Seed UAT app config
      db.prepare(
        `INSERT OR REPLACE INTO uat_app_config (project_id, start_command, app_url)
         VALUES (?, ?, ?)`,
      ).run(projectId, "pnpm dev --port 5173", "http://127.0.0.1:5173");

      // Seed a completed session with trace and screenshots under E2E_DATA_DIR
      const sessionId = "e2e-session-1";
      const sessionDir = join(E2E_DATA_DIR, "uat", String(projectId), sessionId);
      mkdirSync(join(sessionDir, "screenshots"), { recursive: true });
      mkdirSync(join(sessionDir, "video"), { recursive: true });
      writeFileSync(join(sessionDir, "trace.zip"), "e2e-mock-trace-data");
      writeFileSync(join(sessionDir, "screenshots", "1.png"), "e2e-mock-screenshot");

      const headSha = git(dir, "rev-parse", "daedalus/release-v1.0");
      db.prepare(
        `INSERT INTO uat_sessions (id, project_id, release_version, head_sha, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sessionId, projectId, "v1.0", headSha, "stopped");

      db.close();

      // Navigate to Release gate page
      await page.goto(`/projects/${projectId}/release`);
      await expect(page.getByRole("heading", { level: 1, name: "Release gate" })).toBeVisible();

      // Confirm UAT Section is visible
      const uatHeading = page.getByRole("heading", { level: 2, name: "User Acceptance Testing (UAT)" });
      await expect(uatHeading).toBeVisible();

      // Confirm frozen Done when items from PLAN.md appear in the checklist
      await expect(page.getByText("Verify user can browse catalog")).toBeVisible();
      await expect(page.getByText("Export catalog report")).toBeVisible();

      // Save a mark: click "Pass" on the first item
      const itemCard = page.locator(".uat-item-card", { hasText: "Verify user can browse catalog" });
      const passBtn = itemCard.getByRole("button", { name: "Pass" });
      await passBtn.click();

      // Confirm item status updates to pass
      await expect(itemCard.locator(".uat-mark-badge-pass")).toBeVisible({ timeout: 10_000 });

      // Confirm recordings list shows the trace and screenshot under data folder
      await expect(page.getByText("trace.zip")).toBeVisible();
      await expect(page.getByText("screenshots/1.png")).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
