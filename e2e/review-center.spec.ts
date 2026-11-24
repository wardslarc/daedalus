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
  const dir = mkdtempSync(join(tmpdir(), `e2e-review-${name}-`));
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

test.describe("Review Center (T6.1)", () => {
  test.beforeEach(() => {
    test.skip(notImplemented, "needs T5.2 task state machine");
  });

  test("drive a task to in-review, see it in the queue, approve, and check the release branch has the merge", async ({ page }) => {
    const dir = fixtureRepo("review-center-pass");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** Review test\n- **Users:** Dev\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nReview spec overview\n## Verify\nVerify item\n",
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
- [ ] **T1.1 Review Pass Task** \`[claude]\` — [[SPEC#Overview]]
  A task that succeeds and awaits review.
  check: echo pass-review-ok
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add shaping docs");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Review Center Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Record shaping approvals & start milestone
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO shaping_state (project_id, spec_approved_at, mock_approved_at, mock_artifact_url, mock_approved_by, plan_approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, now, now, "https://example.com/mock", "Tester", now);
      db.close();

      const startRes = await post(page, `/api/projects/${projectId}/chat/start-milestone`, {
        version: "v1.0",
        milestoneCode: "M1",
      });
      expect(startRes.status).toBe(200);

      // Navigate to pipeline page to run the task
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();

      const card = page.locator('[data-testid="task-card-T1.1"]');
      await expect(card).toBeVisible();
      const runBtn = card.getByRole("button", { name: "Run" });
      await expect(runBtn).toBeEnabled();

      await runBtn.click();

      // Wait for task to move to In review
      const inReviewColumn = page.locator(".pipeline-column", { hasText: "In review" });
      await expect(inReviewColumn.locator('[data-testid="task-card-T1.1"]')).toBeVisible({
        timeout: 30_000,
      });

      // Navigate to Review center
      await page.goto(`/projects/${projectId}/review`);
      await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();

      // See task in the review queue
      const queueCard = page.locator(".review-queue-card", { hasText: "T1.1" });
      await expect(queueCard).toBeVisible();

      // Verify diff, check result, and gates rendered
      await expect(page.getByText("Files changed")).toBeVisible();
      await expect(page.locator(".review-diff-pre")).toBeVisible();
      await expect(page.getByText("Check execution")).toBeVisible();
      await expect(page.getByText("Cross-review: comes in T6.2")).toBeVisible();

      // Approve button should be enabled (check passed, no secrets or dependencies touched)
      const approveBtn = page.getByRole("button", { name: "Approve & Merge" });
      await expect(approveBtn).toBeEnabled();

      await approveBtn.click();

      // After approval, queue should be empty
      await expect(page.getByText("Nothing waiting for review.")).toBeVisible({
        timeout: 15_000,
      });

      // Verify git: daedalus/release-v1.0 has the merge commit
      const releaseCommit = git(dir, "log", "-1", "--format=%s", "daedalus/release-v1.0");
      expect(releaseCommit).toContain("Merge task T1.1: Review Pass Task");
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
