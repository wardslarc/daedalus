import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-chat-mock-${name}-`));
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

test.describe("project chat mock build & approval gate (T4.3)", () => {
  test("Work project only offers Claude on Mock step and rejects direct antigravity start with 403", async ({
    page,
  }) => {
    const dir = fixtureRepo("work-mock");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "work",
      name: "Work Mock Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Setup approved intake
      const intakeRes = await post(page, `/api/projects/${projectId}/chat/intake`, {
        fields: {
          problem: "Need clickable mock under work profile.",
          users: "Enterprise users.",
          constraints: "GitLab, Claude only.",
        },
      });
      expect(intakeRes.status).toBe(200);

      // Write spec with ## Verify and approve
      const docsDir = join(dir, "docs");
      writeFileSync(
        join(docsDir, "SPEC.md"),
        "# Spec — Work Mock\n\n## Overview\n- Work project mock.\n\n## Verify\n- Passes E2E.\n",
        "utf8",
      );
      const specRes = await post(page, `/api/projects/${projectId}/chat/spec`, { action: "approve" });
      expect(specRes.status).toBe(200);

      await page.goto(`/projects/${projectId}/chat`);
      await expect(page.getByRole("heading", { level: 2, name: /Step 3: Clickable HTML mock/i })).toBeVisible();

      // Verify UI only offers Claude and displays policy note
      await expect(page.getByText(/Work projects: Claude only/i)).toBeVisible();
      await expect(page.getByRole("radio", { name: "Antigravity" })).toHaveCount(0);

      // Direct POST to start antigravity mock session returns 403
      const forbiddenRes = await post(page, `/api/projects/${projectId}/chat/mock`, {
        action: "start",
        providerId: "antigravity",
      });
      expect(forbiddenRes.status).toBe(403);
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds mock live, supports chat revisions, records approval metadata, unlocks Plan, and reopens read-only", async ({
    page,
  }) => {
    const dir = fixtureRepo("personal-mock");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Personal Mock Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // 1. Advance through Intake and Spec to Mock
      await post(page, `/api/projects/${projectId}/chat/intake`, {
        fields: {
          problem: "Interactive shaping mock gate.",
          users: "Solo developer.",
          constraints: "Local Next.js app.",
        },
      });
      const docsDir = join(dir, "docs");
      writeFileSync(
        join(docsDir, "SPEC.md"),
        "# Spec — Mock Flow\n\n## Overview\n- Clickable HTML mock.\n\n## Verify\n- Validated via Playwright.\n",
        "utf8",
      );
      await post(page, `/api/projects/${projectId}/chat/spec`, { action: "approve" });

      await page.goto(`/projects/${projectId}/chat`);
      await expect(page.getByRole("heading", { level: 2, name: /Step 3: Clickable HTML mock/i })).toBeVisible();

      const stepper = page.getByRole("navigation", { name: "Shaping steps" });
      const mockStep = stepper.getByRole("button", { name: /Mock/i });
      const planStep = stepper.getByRole("button", { name: /Plan/i });

      // Step 4 (Plan) is initially locked
      await expect(planStep).toBeDisabled();

      // Personal project allows selecting Antigravity or Claude
      const agyRadio = page.getByRole("radio", { name: "Antigravity" });
      await expect(agyRadio).toBeVisible();
      await agyRadio.check();
      await expect(agyRadio).toBeChecked();

      // Start mock session with Antigravity
      await page.getByRole("button", { name: "Start mock session" }).click();

      // Fake agent generates docs/mock.html
      const mockPath = join(docsDir, "mock.html");
      await expect.poll(() => existsSync(mockPath), { timeout: 15000 }).toBe(true);
      await expect(page.getByText("Mock ready")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("mock-live-iframe")).toBeVisible({ timeout: 15000 });

      // Even though mock.html exists, Plan stays locked until mock approval!
      await expect(planStep).toBeDisabled();

      // 2. Test free revision in same chat
      const replyInput = page.getByLabel("Reply or request revision");
      await expect(replyInput).toBeEnabled({ timeout: 15000 });
      await replyInput.fill("Add dark mode toggle and navigation links");
      await page.getByRole("button", { name: "Send" }).click();

      // Verify docs/mock.html on disk received revision
      await expect
        .poll(() => readFileSync(mockPath, "utf8"), { timeout: 15000 })
        .toContain("Add dark mode toggle and navigation links");

      // Toggle raw HTML preview to confirm live content
      await page.getByRole("button", { name: "Raw HTML" }).click();
      await expect(page.getByTestId("mock-raw-preview")).toContainText(
        "Add dark mode toggle and navigation links",
        { timeout: 15000 },
      );

      // 3. Mock Approval Gate form
      const approveBtn = page.getByRole("button", { name: "Approve mock" });
      const artifactInput = page.getByLabel("Published Claude artifact link");
      const approverInput = page.getByLabel("Approved by");

      // Initially disabled until both inputs are non-empty
      await expect(approveBtn).toBeDisabled();

      await artifactInput.fill("https://claude.site/artifacts/test-artifact-id-1234");
      await expect(approveBtn).toBeDisabled();

      await approverInput.fill("Carls");
      await expect(approveBtn).toBeEnabled();

      // Click Approve mock -> advances to Step 4: Plan
      await approveBtn.click();
      await expect(
        page.getByRole("heading", { level: 2, name: /Step 4: Plan generation/i }),
      ).toBeVisible({ timeout: 15000 });

      // Stepper shows Step 3 completed and Step 4 unlocked
      await expect(mockStep).toHaveClass(/completed/);
      await expect(planStep).toBeEnabled();

      // 4. Reopen Step 3 (Mock) read-only
      await mockStep.click();
      await expect(page.getByRole("heading", { level: 2, name: /Step 3: Clickable HTML mock/i })).toBeVisible();

      // Recorded approval details are displayed
      await expect(page.getByTestId("mock-approved-link")).toHaveText(
        "https://claude.site/artifacts/test-artifact-id-1234",
      );
      await expect(page.getByTestId("mock-approved-by")).toHaveText("Carls");
      await expect(page.getByTestId("mock-approved-at")).not.toBeEmpty();

      // Reopen mock button is visible
      await expect(page.getByRole("button", { name: "Reopen mock" })).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
