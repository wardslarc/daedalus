import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-pipeline-${name}-`));
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

test.describe("Pipeline board screen (T5.1)", () => {
  test("shows empty tasks state when docs/PLAN.md has no tasks", async ({ page }) => {
    const dir = fixtureRepo("empty-plan");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Empty Pipeline Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();

      // Empty tasks card
      await expect(
        page.getByText("No tasks in docs/PLAN.md yet · Generate and approve a plan in Project chat"),
      ).toBeVisible();

      const chatLink = page.getByRole("link", { name: "Generate and approve a plan in Project chat" });
      await expect(chatLink).toBeVisible();
      await expect(chatLink).toHaveAttribute("href", `/projects/${projectId}/chat`);
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncs tasks from docs/PLAN.md into SQLite and renders 5-column Pipeline board with task cards", async ({
    page,
  }) => {
    const dir = fixtureRepo("active-plan");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    // Create docs/PLAN.md with multiple tasks
    const planContent = `# Plan — Active Project

## M1 — v1.0 Initial Release

Done when:
- Complete end-to-end integration works smoothly
- All pipeline stages are tested

- [ ] **T1.1 Core Engine** \`[claude]\` — [[SPEC#Engine]]
  Build core processing pipeline.
  check: \`pnpm test:engine\`

- [~] **T1.2 Realtime Sync** [gemini] — [[SPEC#Sync]]
  Implement SQLite and websocket sync.
  check: pnpm test:sync

- [ ] **T1.3 Security Review** [you] — [[SPEC#Security]]
  Audit role boundaries.
  check: pnpm test:security

- [ ] **T1.4 Review Gate** \`[claude]\` — [[SPEC#Review]]
  Automated review checks.
  check: pnpm test:review

- [x] **T1.5 Setup Scaffolding** [gemini] — [[SPEC#Setup]]
  Initial repo configuration.
  check: pnpm test:setup
`;
    writeFileSync(join(docsDir, "PLAN.md"), planContent, "utf8");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Pipeline Board Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Navigate to /projects/[id]/pipeline
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();

      // Check header summary
      await expect(page.getByText("Pipeline Board Test")).toBeVisible();

      // Check 8-segment stage bar
      await expect(page.getByText("Pipeline Stage", { exact: true })).toBeVisible();
      await expect(page.getByRole("progressbar")).toBeVisible();

      // Check Milestone header and "Done when" items
      await expect(page.getByRole("heading", { level: 2, name: "M1 — v1.0 Initial Release" })).toBeVisible();
      await expect(page.getByText("Complete end-to-end integration works smoothly")).toBeVisible();
      await expect(page.getByText("All pipeline stages are tested")).toBeVisible();

      // Check 5-column Pipeline board container
      const board = page.getByRole("region", { name: "Pipeline board" });
      await expect(board).toBeVisible();

      // Initially:
      // T1.1, T1.3, T1.4 are queued (markdownStatus: todo) -> Queued column
      // T1.2 is running (markdownStatus: in_progress) -> Running column
      // T1.5 is done (markdownStatus: done) -> Done column
      await expect(board.getByRole("heading", { level: 3, name: /Queued · 3/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Running · 1/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Check failed · 0/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /In review · 0/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Done · 1/i })).toBeVisible();

      // Verify task cards
      const cardT1 = page.getByTestId("task-card-T1.1");
      await expect(cardT1).toBeVisible();
      await expect(cardT1.getByText("T1.1")).toBeVisible();
      await expect(cardT1.getByText("Claude")).toBeVisible();
      await expect(cardT1.getByRole("heading", { level: 4, name: "Core Engine" })).toBeVisible();
      await expect(cardT1.getByText("Build core processing pipeline.")).toBeVisible();
      await expect(cardT1.getByText("[[SPEC#Engine]]")).toBeVisible();
      await expect(cardT1.getByText("check: pnpm test:engine")).toBeVisible();

      const cardT2 = page.getByTestId("task-card-T1.2");
      await expect(cardT2).toBeVisible();
      await expect(cardT2.getByText("Antigravity")).toBeVisible();
      await expect(cardT2.getByRole("heading", { level: 4, name: "Realtime Sync" })).toBeVisible();

      const cardT3 = page.getByTestId("task-card-T1.3");
      await expect(cardT3).toBeVisible();
      await expect(cardT3.getByText("You")).toBeVisible();

      // Now simulate runtime updates directly in SQLite:
      // Move T1.3 to "check-failed" with attempts = 2, branch = "daedalus/T1.3"
      // Move T1.4 to "in-review" with attempts = 1, branch = "daedalus/T1.4"
      const db = new DatabaseSync(join(E2E_DATA_DIR, "daedalus.db"), { timeout: 5000 });
      db.prepare(
        "UPDATE tasks SET status = 'check-failed', attempts = 2, branch = 'daedalus/T1.3' WHERE project_id = ? AND code = 'T1.3'",
      ).run(projectId);
      db.prepare(
        "UPDATE tasks SET status = 'in-review', attempts = 1, branch = 'daedalus/T1.4' WHERE project_id = ? AND code = 'T1.4'",
      ).run(projectId);
      db.close();

      // Click "Sync PLAN.md" button to re-fetch and verify column placement
      await page.getByRole("button", { name: "Sync PLAN.md" }).click();

      // Verify column counts:
      // Queued: 1 (T1.1)
      // Running: 1 (T1.2)
      // Check failed: 1 (T1.3)
      // In review: 1 (T1.4)
      // Done: 1 (T1.5)
      await expect(board.getByRole("heading", { level: 3, name: /Queued · 1/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Running · 1/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Check failed · 1/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /In review · 1/i })).toBeVisible();
      await expect(board.getByRole("heading", { level: 3, name: /Done · 1/i })).toBeVisible();

      // Verify card footer with branch and attempts
      await expect(cardT3.getByText("daedalus/T1.3")).toBeVisible();
      await expect(cardT3.getByText("2 attempts")).toBeVisible();

      const cardT4 = page.getByTestId("task-card-T1.4");
      await expect(cardT4.getByText("daedalus/T1.4")).toBeVisible();
      await expect(cardT4.getByText("1 attempt")).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shows error message on Pipeline page when PLAN.md has duplicate task codes", async ({ page }) => {
    const dir = fixtureRepo("dup-plan");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });

    const planContent = `# Plan — Dup Project

## M1 — v1.0 Initial Release

Done when:
- Complete end-to-end integration works smoothly

- [ ] **T1.1 Task One** \`[claude]\` — [[SPEC#Core]]
  check: \`pnpm test\`

- [ ] **T1.1 Task Duplicate** \`[gemini]\` — [[SPEC#Core]]
  check: \`pnpm test\`
`;
    writeFileSync(join(docsDir, "PLAN.md"), planContent, "utf8");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "plan with duplicate code");

    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Duplicate Pipeline Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      await page.goto(`/projects/${projectId}/pipeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
      await expect(page.getByText("docs/PLAN.md has task code T1.1 more than once.")).toBeVisible();
      // Keep the Sync PLAN.md button
      await expect(page.getByRole("button", { name: "Sync PLAN.md" })).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
