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

      // Acknowledge cross-review gate so task can be approved without running cross-review
      const db2 = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      const tRow = db2
        .prepare("SELECT id FROM tasks WHERE project_id = ? AND code = ?")
        .get(projectId, "T1.1") as { id: number };
      db2
        .prepare("INSERT INTO review_acks (task_id, gate, acked_at, note) VALUES (?, 'cross-review', ?, 'test ack')")
        .run(tRow.id, new Date().toISOString());
      db2.close();

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

  test("T6.2: run cross-review from Review center with fake agent, verify findings and triage buckets, and verify tampered notice for FAKE:write-file task", async ({ page }) => {
    const dir = fixtureRepo("review-center-cross-review");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(
      join(docsDir, "INTAKE.md"),
      "# Intake\n- **Problem:** Cross-review test\n- **Users:** Dev\n- **Constraints:** None\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "SPEC.md"),
      "# Spec\n## Overview\nCross-review spec overview\n## Verify\nVerify cross-review\n",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "mock.html"),
      "<!DOCTYPE html><html><body>Cross-review Mock</body></html>",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "PLAN.md"),
      `# Plan
## M1 — v1.0 Cross-Review Release
Done when: Both tasks pass.
- [ ] **T1.1 Standard Review Task** \`[claude]\` — [[SPEC#Overview]]
  A task with changes for cross-review.
  check: echo pass-t1.1

- [ ] **T1.2 Tampered Task FAKE:write-file** \`[claude]\` — [[SPEC#Overview]]
  A task with FAKE:write-file to test tamper detection in cross-review.
  check: echo pass-t1.2
`,
      "utf8",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add shaping docs with tasks");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Cross-Review Test",
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

      // Run T1.1 to in-review
      await page.goto(`/projects/${projectId}/pipeline`);
      const card1 = page.locator('[data-testid="task-card-T1.1"]');
      await expect(card1).toBeVisible();
      await card1.getByRole("button", { name: "Run" }).click();

      const inReviewColumn = page.locator(".pipeline-column", { hasText: "In review" });
      await expect(inReviewColumn.locator('[data-testid="task-card-T1.1"]')).toBeVisible({
        timeout: 30_000,
      });

      // Run T1.2 to in-review
      const card2 = page.locator('[data-testid="task-card-T1.2"]');
      await expect(card2).toBeVisible();
      await card2.getByRole("button", { name: "Run" }).click();
      await expect(inReviewColumn.locator('[data-testid="task-card-T1.2"]')).toBeVisible({
        timeout: 30_000,
      });

      // Go to Review Center
      await page.goto(`/projects/${projectId}/review`);
      await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();

      // --- Part 1: Test Happy Path on T1.1 ---
      // Select T1.1 in queue
      const queueCard1 = page.locator(".review-queue-card", { hasText: "T1.1" });
      await queueCard1.click();

      // Find "Run cross-review" button and click it
      const runCrossReviewBtn = page.getByRole("button", { name: "Run cross-review" });
      await expect(runCrossReviewBtn).toBeVisible();
      await runCrossReviewBtn.click();

      // Button should be disabled or text change while running
      await expect(
        page.getByRole("button", { name: /Running cross-review…|Run cross-review/ }),
      ).toBeVisible();

      // Wait for cross-review to complete and triage buckets to appear
      await expect(page.locator(".review-cross-review-status-line")).toContainText("done", {
        timeout: 30_000,
      });

      // Verify findings and triage buckets appear in Review center
      // Buckets: Must fix, Should fix, Nit
      await expect(page.getByRole("heading", { level: 4, name: "Must fix" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 4, name: "Should fix" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 4, name: "Nit" })).toBeVisible();

      // Verify finding badges
      await expect(page.locator(".badge-must-fix")).toBeVisible();
      await expect(page.locator(".badge-should-fix")).toBeVisible();
      await expect(page.locator(".badge-nit")).toBeVisible();

      // Verify finding details are rendered
      await expect(page.locator(".finding-claim").first()).toBeVisible();
      await expect(page.locator(".finding-proof").first()).toBeVisible();

      // --- Part 2: Test Tampered on T1.2 ---
      // Select T1.2 in queue
      const queueCard2 = page.locator(".review-queue-card", { hasText: "T1.2" });
      await queueCard2.click();

      // Click "Run cross-review" on T1.2
      const runCrossReviewBtn2 = page.getByRole("button", { name: "Run cross-review" });
      await expect(runCrossReviewBtn2).toBeVisible();
      await runCrossReviewBtn2.click();

      // Wait for status to show tampered and red notice to appear
      await expect(page.locator(".review-tampered-notice")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText("The reviewer changed files; its review was discarded."),
      ).toBeVisible();
      await expect(page.locator(".review-cross-review-status-line")).toContainText("tampered");
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
