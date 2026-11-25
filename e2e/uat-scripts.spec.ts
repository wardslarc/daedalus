import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-uat-scripts-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function ensureUatScriptTables(db: DatabaseSync) {
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
    CREATE TABLE IF NOT EXISTS uat_scripts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      item_id integer,
      item_text text NOT NULL,
      release_version text NOT NULL,
      recorded_origin text NOT NULL,
      head_sha text NOT NULL,
      session_id text,
      script_text text NOT NULL,
      sha256 text NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      retired_reason text,
      replaced_by integer,
      created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
      updated_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uat_replay_runs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      session_id text,
      release_version text NOT NULL,
      head_sha text NOT NULL,
      kind text DEFAULT 'full' NOT NULL,
      status text NOT NULL,
      total_scripts integer DEFAULT 0 NOT NULL,
      passed_scripts integer DEFAULT 0 NOT NULL,
      failed_scripts integer DEFAULT 0 NOT NULL,
      error text,
      started_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
      finished_at text
    );
    CREATE TABLE IF NOT EXISTS uat_replay_results (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      run_id integer NOT NULL,
      project_id integer NOT NULL,
      script_id integer NOT NULL,
      status text NOT NULL,
      detail text,
      trace_path text,
      duration_ms integer,
      created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gate_runs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      head_sha text NOT NULL,
      default_sha text,
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
    CREATE UNIQUE INDEX IF NOT EXISTS gate_findings_project_id_release_version_fingerprint_unique ON gate_findings (project_id, release_version, fingerprint);
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

test.describe("Saved UAT scripts and replay (T6.5)", () => {
  test.beforeEach(() => {
    test.skip(notImplemented, "needs T5.2 task state machine");
  });

  test("an accepted item's script is saved and replayed on the next release; a broken script blocks the gate", async ({
    page,
  }) => {
    const dir = fixtureRepo("uat-scripts-e2e");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** UAT scripts e2e\n- **Users:** QA\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nUAT scripts spec\n## Verify\n- Smoke check passes\n",
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
Done when: User can sign in
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
      name: "UAT Scripts Test Project",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      ensureUatScriptTables(db);

      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO shaping_state (project_id, spec_approved_at, mock_approved_at, mock_artifact_url, mock_approved_by, plan_approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, now, now, "https://example.com/mock", "Tester", now);

      const startRes = await post(page, `/api/projects/${projectId}/chat/start-milestone`, {
        version: "v1.0",
        milestoneCode: "M1",
      });
      expect(startRes.status).toBe(200);

      db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(projectId);
      db.prepare("UPDATE shaping_state SET active_milestone_verify_started_at = ? WHERE project_id = ?").run(
        now,
        projectId,
      );
      db.prepare(
        `INSERT OR REPLACE INTO uat_app_config (project_id, start_command, app_url)
         VALUES (?, ?, ?)`,
      ).run(projectId, "pnpm dev --port 5173", "http://127.0.0.1:5173");
      db.close();

      // 1. Record a script on v1.0 and accept it via Pass
      await page.goto(`/projects/${projectId}/release`);
      await page.getByRole("button", { name: "Start recorded browser" }).click();
      await expect(page.locator(".uat-session-bar").getByText("Running")).toBeVisible({
        timeout: 15_000,
      });

      const itemCard = page.locator(".uat-item-card", { hasText: "User can sign in" });
      await itemCard.getByRole("button", { name: "Record script" }).click();
      await expect(itemCard.getByText("Draft script")).toBeVisible({ timeout: 10_000 });
      await expect(itemCard.locator(".uat-script-pre")).toContainText("@playwright/test");

      await itemCard.getByRole("button", { name: "Pass" }).click();
      await expect(itemCard.locator(".uat-mark-badge-pass")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("heading", { level: 2, name: /Saved UAT scripts \(1\)/ })).toBeVisible();

      await page.getByRole("button", { name: "Stop session" }).click();
      await expect(page.locator(".uat-session-bar").getByText("Stopped")).toBeVisible({
        timeout: 10_000,
      });

      // 2. Advance to release v1.1 and verify earlier script replays and passes
      git(dir, "branch", "daedalus/release-v1.1", "main");
      const headV11 = git(dir, "rev-parse", "daedalus/release-v1.1");
      const defaultSha = git(dir, "rev-parse", "main");

      const db2 = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      db2.prepare(
        `UPDATE shaping_state
         SET active_milestone_version = 'v1.1',
             active_milestone_code = 'M2',
             active_milestone_branch = 'daedalus/release-v1.1',
             active_milestone_verify_started_at = ?
         WHERE project_id = ?`,
      ).run(now, projectId);
      db2.prepare(
        `INSERT INTO uat_items (project_id, release_version, position, text, source)
         VALUES (?, 'v1.1', 1, 'New v1.1 item', 'plan')`,
      ).run(projectId);
      db2.prepare(
        `INSERT INTO gate_runs (project_id, release_version, head_sha, default_sha, status, checks)
         VALUES (?, 'v1.1', ?, ?, 'done', ?)`,
      ).run(
        projectId,
        headV11,
        defaultSha,
        JSON.stringify({
          secrets: { status: "pass" },
          dependencies: { status: "pass" },
          securityTests: { status: "pass" },
          checklist: { status: "pass" },
        }),
      );
      db2.close();

      await page.reload();
      await page.getByRole("button", { name: "Start recorded browser" }).click();
      await expect(page.locator(".uat-replay-card").getByText("passed").first()).toBeVisible({
        timeout: 15_000,
      });
      const v11Card = page.locator(".uat-item-card", { hasText: "New v1.1 item" });
      await v11Card.getByRole("button", { name: "Pass" }).click();
      await expect(v11Card.locator(".uat-mark-badge-pass")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "Stop session" }).click();
      await expect(page.locator(".uat-session-bar").getByText("Stopped")).toBeVisible({
        timeout: 10_000,
      });

      // 3. Seed a broken earlier-release script -> replay fails and blocks the gate
      const brokenText = `import { test, expect } from '@playwright/test';\ntest('broken', async () => { expect(true).toBe(false); });\n`;
      const brokenSha = createHash("sha256").update(brokenText, "utf8").digest("hex");
      const db3 = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      db3.prepare(
        `INSERT INTO uat_scripts (project_id, item_text, release_version, recorded_origin, head_sha, script_text, sha256, status)
         VALUES (?, 'Broken regression', 'v1.0', 'http://127.0.0.1:5173', 'oldsha', ?, ?, 'active')`,
      ).run(projectId, brokenText, brokenSha);
      db3.close();

      await page.getByRole("button", { name: "Start recorded browser" }).click();
      await expect(page.locator(".uat-replay-card").getByText("failed").first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator(".release-banner.banner-blocked")).toBeVisible();
      await expect(
        page.locator(".release-finding-card", { hasText: "Broken regression" }).first(),
      ).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
