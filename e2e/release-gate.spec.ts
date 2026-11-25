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
  const dir = mkdtempSync(join(tmpdir(), `e2e-release-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function ensureE2ETables(db: DatabaseSync) {
  try {
    db.prepare("ALTER TABLE shaping_state ADD COLUMN active_milestone_verify_started_at text").run();
  } catch {
    // ignore if already exists
  }
  try {
    db.prepare("ALTER TABLE tasks ADD COLUMN description text").run();
  } catch {
    // ignore if already exists
  }
  db.exec(`
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
    CREATE UNIQUE INDEX IF NOT EXISTS gate_findings_project_id_release_version_fingerprint_unique ON gate_findings (project_id, release_version, fingerprint);
    CREATE TABLE IF NOT EXISTS security_tests (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      name text NOT NULL,
      path text NOT NULL,
      sha256 text NOT NULL,
      command text NOT NULL,
      created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ship_checklist_ticks (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id integer NOT NULL,
      release_version text NOT NULL,
      item_id text NOT NULL,
      ticked_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ship_checklist_ticks_project_id_release_version_item_id_unique ON ship_checklist_ticks (project_id, release_version, item_id);
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

test.describe("Release Gate and Security Checks (T6.3)", () => {
  test.beforeEach(() => {
    test.skip(notImplemented, "needs T5.2 task state machine");
  });

  test("milestone tasks done with planted secret in history: run checks, secret blocks, make fix task FIX-1, defer moderate finding with reason", async ({
    page,
  }) => {
    const dir = fixtureRepo("release-gate-e2e");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** Release Gate test\n- **Users:** QA\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nRelease Gate spec\n## Verify\nVerify item\n",
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
Done when: Release gate checks pass.
- [ ] **T1.1 Initial Release Task** \`[claude]\` — [[SPEC#Overview]]
  A task that builds the feature.
  check: echo pass-gate-ok
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add shaping docs");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Release Gate Test Project",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      ensureE2ETables(db);

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

      // Plant secret in release-branch history
      git(dir, "checkout", "daedalus/release-v1.0");
      writeFileSync(join(dir, "auth-secret.ts"), 'export const KEY = "sk-ant-e2esecretplanted1234567890abcdef";\n');
      git(dir, "add", "auth-secret.ts");
      git(dir, "commit", "-m", "planted secret commit");

      // Remove secret in next commit on release branch
      git(dir, "rm", "auth-secret.ts");
      git(dir, "commit", "-m", "revert planted secret");
      git(dir, "checkout", "main");

      // Mark milestone tasks as done and set verify started
      db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(projectId);
      db.prepare("UPDATE shaping_state SET active_milestone_verify_started_at = ? WHERE project_id = ?").run(
        now,
        projectId,
      );

      // Seed a moderate dependency finding
      db.prepare(
        `INSERT INTO gate_findings (project_id, release_version, check, fingerprint, severity, title, detail, location, blocking, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectId,
        "v1.0",
        "dependencies",
        "dependencies:minimist:GHSA-1234",
        "moderate",
        "Prototype Pollution in minimist",
        "Moderate vulnerability in minimist",
        "node_modules/minimist",
        0,
        "open",
      );

      db.close();

      // Navigate to Release gate page
      await page.goto(`/projects/${projectId}/release`);
      await expect(page.getByRole("heading", { level: 1, name: "Release gate" })).toBeVisible();

      // Click "Run checks"
      const runBtn = page.getByRole("button", { name: "Run checks" });
      await expect(runBtn).toBeVisible();
      await runBtn.click();

      // Wait for checks to complete and secret finding to appear
      await expect(page.locator(".release-finding-card", { hasText: "Secret detected" })).toBeVisible({
        timeout: 30_000,
      });

      // The secret finding shows as blocking
      const secretCard = page.locator(".release-finding-card", { hasText: "Secret detected" });
      await expect(secretCard.locator(".finding-blocking-badge")).toBeVisible();

      // "Make fix task" creates FIX-1
      const makeFixBtn = secretCard.getByRole("button", { name: "Make fix task" });
      await makeFixBtn.click();

      const input = secretCard.locator('input[type="text"]');
      await expect(input).toBeVisible();
      await input.fill("echo fix-secret-cmd");
      await secretCard.getByRole("button", { name: "Confirm" }).click();

      // Confirm FIX-1 task was created by checking Pipeline
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
      await expect(page.locator('[data-testid="task-card-FIX-1"]')).toBeVisible({ timeout: 15_000 });

      // Return to Release page to test deferring the moderate finding
      await page.goto(`/projects/${projectId}/release`);
      const modCard = page.locator(".release-finding-card", { hasText: "Prototype Pollution in minimist" });
      await expect(modCard).toBeVisible();

      // Moderate finding has Defer action
      const deferBtn = modCard.getByRole("button", { name: "Defer" });
      await expect(deferBtn).toBeVisible();
      await deferBtn.click();

      const textarea = modCard.locator("textarea");
      await expect(textarea).toBeVisible();

      // Confirm button is disabled or rejected if reason is too short (< 10 chars)
      await textarea.fill("short");
      await expect(modCard.getByRole("button", { name: "Confirm" })).toBeDisabled();

      // Provide valid 10+ character reason
      await textarea.fill("Will patch in the next release cycle");
      await modCard.getByRole("button", { name: "Confirm" }).click();

      // Verify finding is now deferred
      await expect(modCard.locator(".finding-outcome-badge", { hasText: "defer" })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
