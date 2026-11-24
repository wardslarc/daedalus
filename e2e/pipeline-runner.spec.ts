import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-runner-${name}-`));
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

test.describe("Pipeline task runner (T5.3)", () => {
  test.beforeEach(() => {
    test.skip(notImplemented, "needs T5.2 task state machine");
  });

  test("a passing task lands in 'In review' with a commit on daedalus/<code>", async ({ page }) => {
    const dir = fixtureRepo("passing-task");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** Passing task\n- **Users:** Dev\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nPassing spec overview\n## Verify\nVerify item\n",
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
Done when: Task passes.
- [ ] **T1.1 Pass Task** \`[claude]\` — [[SPEC#Overview]]
  A task that succeeds.
  check: echo pass-ok
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add shaping docs");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Runner Pass Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Record approvals & start milestone
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      const now = new Date().toISOString();
      const planSha = createHash("sha256").update(readFileSync(join(docsDir, "PLAN.md"))).digest("hex");
      db.prepare(
        `INSERT OR REPLACE INTO shaping_state (project_id, spec_approved_at, mock_approved_at, mock_artifact_url, mock_approved_by, plan_approved_at, plan_approved_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(projectId, now, now, "https://example.com/mock", "Tester", now, planSha);
      db.close();

      const startRes = await post(page, `/api/projects/${projectId}/chat/start-milestone`, {
        version: "v1.0",
        milestoneCode: "M1",
      });
      expect(startRes.status).toBe(200);

      // Navigate to pipeline page
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();

      // Card should be in Queued with a Run button
      const card = page.locator('[data-testid="task-card-T1.1"]');
      await expect(card).toBeVisible();
      const runBtn = card.getByRole("button", { name: "Run" });
      await expect(runBtn).toBeEnabled();

      // Trigger run
      await runBtn.click();

      // Card should eventually move to In review
      const inReviewColumn = page.locator(".pipeline-column", { hasText: "In review" });
      await expect(inReviewColumn.locator('[data-testid="task-card-T1.1"]')).toBeVisible({
        timeout: 30_000,
      });

      // Verify commit on branch daedalus/t1.1
      const branchCommit = git(dir, "log", "-1", "--format=%s", "daedalus/t1.1");
      expect(branchCommit).toContain("T1.1: Pass Task (Daedalus task run)");
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing task lands in 'Check failed' with an inbox row", async ({ page }) => {
    const dir = fixtureRepo("failing-task");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** Failing task\n- **Users:** Dev\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nFailing spec overview\n## Verify\nVerify item\n",
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
Done when: Task fails.
- [ ] **T1.2 Fail Task** \`[claude]\` — [[SPEC#Overview]]
  A task whose check fails.
  check: exit 1
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add shaping docs");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Runner Fail Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      const now = new Date().toISOString();
      const planSha = createHash("sha256").update(readFileSync(join(docsDir, "PLAN.md"))).digest("hex");
      db.prepare(
        `INSERT OR REPLACE INTO shaping_state (project_id, spec_approved_at, mock_approved_at, mock_artifact_url, mock_approved_by, plan_approved_at, plan_approved_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(projectId, now, now, "https://example.com/mock", "Tester", now, planSha);
      db.close();

      const startRes = await post(page, `/api/projects/${projectId}/chat/start-milestone`, {
        version: "v1.0",
        milestoneCode: "M1",
      });
      expect(startRes.status).toBe(200);

      await page.goto(`/projects/${projectId}/pipeline`);
      const card = page.locator('[data-testid="task-card-T1.2"]');
      await expect(card).toBeVisible();
      const runBtn = card.getByRole("button", { name: "Run" });
      await expect(runBtn).toBeEnabled();

      await runBtn.click();

      // Card moves to Check failed column
      const failedColumn = page.locator(".pipeline-column", { hasText: "Check failed" });
      await expect(failedColumn.locator('[data-testid="task-card-T1.2"]')).toBeVisible({
        timeout: 30_000,
      });

      // Verify inbox item in sqlite
      const verifyDb = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      const inboxRow = verifyDb
        .prepare("SELECT * FROM inbox WHERE project_id = ? AND kind = 'failed_check'")
        .get(projectId) as { kind: string; link: string } | undefined;
      verifyDb.close();

      expect(inboxRow).toBeDefined();
      expect(inboxRow?.kind).toBe("failed_check");
      expect(inboxRow?.link).toBe(`/projects/${projectId}/pipeline#T1.2`);
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
