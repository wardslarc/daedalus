import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-chat-plan-${name}-`));
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

test.describe("project chat plan generation and start milestone (T4.4)", () => {
  test("Claude generates docs/PLAN.md, supports chat changes, Approve plan saves docs/PLAN.md, and Start milestone creates daedalus/release-v1.0 in git", async ({
    page,
  }) => {
    const dir = fixtureRepo("plan");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Plan Milestone Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // 1. Complete Intake, Spec, and Mock approval
      await post(page, `/api/projects/${projectId}/chat/intake`, {
        fields: {
          problem: "Need milestone planning and release branch creation.",
          users: "Solo developer.",
          constraints: "Local Next.js + SQLite.",
        },
      });
      const docsDir = join(dir, "docs");
      writeFileSync(
        join(docsDir, "SPEC.md"),
        "# Spec — Plan Test\n\n## Overview\n- Release planning.\n\n## Verify\n- Creates release branch.\n",
        "utf8",
      );
      await post(page, `/api/projects/${projectId}/chat/spec`, { action: "approve" });
      writeFileSync(join(docsDir, "mock.html"), "<html><body><h1>Approved Mock</h1></body></html>", "utf8");
      await post(page, `/api/projects/${projectId}/chat/mock`, {
        action: "approve",
        artifactUrl: "https://claude.site/artifacts/plan-test-mock",
        approvedBy: "Carls",
      });

      // 2. Open /projects/[id]/chat -> lands on Step 4: Plan generation and Start milestone
      await page.goto(`/projects/${projectId}/chat`);
      await expect(
        page.getByRole("heading", { level: 2, name: /Step 4: Plan generation and Start milestone/i }),
      ).toBeVisible();

      const approvePlanBtn = page.getByRole("button", { name: "Approve plan" });
      await expect(approvePlanBtn).toBeDisabled();

      // 3. Start plan generation with Claude
      await page.getByRole("button", { name: "Start plan generation" }).click();

      const planPath = join(docsDir, "PLAN.md");
      await expect.poll(() => existsSync(planPath), { timeout: 15000 }).toBe(true);
      await expect(page.getByTestId("plan-live-content")).toContainText("## M1 — v1.0 Initial Release", {
        timeout: 15000,
      });
      await expect(page.getByText("Plan structure valid")).toBeVisible();
      await expect(approvePlanBtn).toBeEnabled();

      // 4. Ask Claude for changes in chat before approving the plan
      const chatInput = page.getByLabel("Ask Claude to change the plan");
      await expect(chatInput).toBeEnabled({ timeout: 15000 });
      await chatInput.fill("Add smoke test verification task");
      await page.getByRole("button", { name: "Send" }).click();

      await expect(page.getByTestId("plan-live-content")).toContainText("Add smoke test verification task", {
        timeout: 15000,
      });

      // 5. Click Approve plan -> saves docs/PLAN.md and shows Start milestone card
      await approvePlanBtn.click();
      await expect(page.getByRole("button", { name: "Start milestone" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("plan-readonly-content")).toContainText("Add smoke test verification task");

      const savedPlan = readFileSync(planPath, "utf8");
      expect(savedPlan).toContain("## M1 — v1.0 Initial Release");
      expect(savedPlan).toContain("Done when:");
      expect(savedPlan).toContain("Add smoke test verification task");

      // Approve plan alone has NOT created daedalus/release-v1.0 yet
      expect(git(dir, "branch", "--list", "daedalus/release-v1.0")).toBe("");

      // 6. Click Start milestone -> creates daedalus/release-v1.0 in git and freezes scope
      const versionInput = page.getByLabel("Release version");
      await expect(versionInput).toHaveValue("v1.0");
      await page.getByRole("button", { name: "Start milestone" }).click();

      await expect(page.getByTestId("milestone-active-card")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("milestone-branch-name")).toHaveText("daedalus/release-v1.0");
      await expect(page.getByTestId("milestone-frozen-badge")).toContainText("Scope frozen · daedalus/release-v1.0");

      // Verify git branch daedalus/release-v1.0 exists in the repository
      const gitBranches = git(dir, "branch", "--list", "daedalus/release-v1.0");
      expect(gitBranches).toContain("daedalus/release-v1.0");
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
