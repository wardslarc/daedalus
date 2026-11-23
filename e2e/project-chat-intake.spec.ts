import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-chat-${name}-`));
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

test.describe("project chat intake (T4.1)", () => {
  test("shows 4-step shaping stepper with provider badges and manages intake form and read-only preview", async ({
    page,
  }) => {
    const dir = fixtureRepo("personal");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Personal Chat Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // 1. Open project chat page
      await page.goto(`/projects/${projectId}/chat`);
      await expect(page.getByRole("heading", { level: 1, name: "Project chat" })).toBeVisible();

      const stepper = page.getByRole("navigation", { name: "Shaping steps" });
      await expect(stepper).toBeVisible();

      // Verify the 4 steps and provider badges
      const intakeStep = stepper.getByRole("button", { name: /Intake/i });
      const specStep = stepper.getByRole("button", { name: /Spec/i });
      const mockStep = stepper.getByRole("button", { name: /Mock/i });
      const planStep = stepper.getByRole("button", { name: /Plan/i });

      await expect(intakeStep).toBeVisible();
      await expect(specStep).toBeVisible();
      await expect(mockStep).toBeVisible();
      await expect(planStep).toBeVisible();

      // Provider badges:
      // Step 1: Owner
      await expect(intakeStep).toContainText("Owner");
      await expect(intakeStep).toContainText("docs/INTAKE.md");

      // Step 2: Claude
      await expect(specStep).toContainText("Claude");
      await expect(specStep).toContainText("docs/SPEC.md");

      // Step 3: Claude / Antigravity for Personal profile (gemini allowed)
      await expect(mockStep).toContainText("Claude / Antigravity");
      await expect(mockStep).toContainText("docs/mock.html");

      // Step 4: Claude
      await expect(planStep).toContainText("Claude");
      await expect(planStep).toContainText("docs/PLAN.md");

      // Spec, Mock, Plan are initially locked
      await expect(specStep).toBeDisabled();
      await expect(mockStep).toBeDisabled();
      await expect(planStep).toBeDisabled();

      // 2. Fill the Intake form
      await expect(page.getByRole("heading", { level: 2, name: /Step 1: Intake/i })).toBeVisible();
      await page.getByLabel(/Problem \/ Goal/i).fill("AI-assisted development is fragmented across multiple tools.");
      await page.getByLabel(/Target users & context/i).fill("Solo developer on Linux workstation.");
      await page.getByLabel(/Constraints \/ stack/i).fill("TypeScript, Next.js, local loopback 127.0.0.1 only.");
      await page.getByLabel(/Out of scope/i).fill("Multi-user hosting.");
      await page.getByLabel(/Must-haves/i).fill("Symlink-safe doc writes and 4-step shaping stepper.");

      // Click Save intake
      await page.getByRole("button", { name: "Save intake" }).click();

      // 3. Verify docs/INTAKE.md was created on disk in the repo
      const intakePath = join(dir, "docs", "INTAKE.md");
      await expect.poll(() => existsSync(intakePath)).toBe(true);
      const savedContent = readFileSync(intakePath, "utf8");
      expect(savedContent).toContain("# Intake — Personal Chat Test");
      expect(savedContent).toContain("- **Problem:** AI-assisted development is fragmented across multiple tools.");
      expect(savedContent).toContain("- **Users:** Solo developer on Linux workstation.");
      expect(savedContent).toContain("- **Constraints:** TypeScript, Next.js, local loopback 127.0.0.1 only.");

      // 4. Verify stepper advanced to Step 2: Spec
      await expect(page.getByRole("heading", { level: 2, name: /Step 2: Spec interview/i })).toBeVisible();
      await expect(intakeStep).toHaveClass(/completed/);
      await expect(specStep).not.toBeDisabled();

      // 5. Reopen Step 1 Intake read-only
      await intakeStep.click();

      // Verify read-only view
      await expect(page.getByRole("heading", { level: 2, name: /Step 1: Intake/i })).toBeVisible();
      await expect(page.getByText("AI-assisted development is fragmented across multiple tools.")).toBeVisible();
      await expect(page.getByText("Solo developer on Linux workstation.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit intake" })).toBeVisible();

      // Click "Edit intake" to open edit mode
      await page.getByRole("button", { name: "Edit intake" }).click();
      await expect(page.getByLabel(/Problem \/ Goal/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

      // Cancel edit mode
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("button", { name: "Edit intake" })).toBeVisible();
      await expect(page.getByText("AI-assisted development is fragmented across multiple tools.")).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Work profile project shows Claude provider badge for Mock step", async ({ page }) => {
    const dir = fixtureRepo("work");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "work",
      name: "Work Chat Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      await page.goto(`/projects/${projectId}/chat`);
      const stepper = page.getByRole("navigation", { name: "Shaping steps" });
      const mockStep = stepper.getByRole("button", { name: /Mock/i });

      // Work profile forbids Gemini, so Mock step provider is Claude only
      await expect(mockStep).toContainText("Claude");
      await expect(mockStep).not.toContainText("Antigravity");
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
