import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-chat-spec-${name}-`));
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

test.describe("project chat spec interview (T4.2)", () => {
  test("guided Claude session drafts docs/SPEC.md live, requires ## Verify before Approve spec, and advances to Mock", async ({
    page,
  }) => {
    const dir = fixtureRepo("spec");
    await login(page);

    const imp = await post(page, "/api/projects/import", {
      source: dir,
      profile: "personal",
      name: "Spec Interview Test",
    });
    expect(imp.status).toBe(201);
    const projectId = (imp.json.project as { id: number }).id;

    try {
      // Save intake first so project advances to Step 2: Spec interview
      const intakeRes = await post(page, `/api/projects/${projectId}/chat/intake`, {
        fields: {
          problem: "Need guided spec interview that writes docs/SPEC.md live.",
          users: "Solo developer on Linux.",
          constraints: "TypeScript, Next.js, local-only 127.0.0.1.",
        },
      });
      expect(intakeRes.status).toBe(200);

      await page.goto(`/projects/${projectId}/chat`);
      await expect(page.getByRole("heading", { level: 2, name: /Step 2: Spec interview/i })).toBeVisible();

      const stepper = page.getByRole("navigation", { name: "Shaping steps" });
      const specStep = stepper.getByRole("button", { name: /Spec/i });
      const mockStep = stepper.getByRole("button", { name: /Mock/i });
      const approveBtn = page.getByRole("button", { name: "Approve spec" });

      // Initially Mock is locked and Approve spec is disabled
      await expect(mockStep).toBeDisabled();
      await expect(approveBtn).toBeDisabled();
      await expect(page.getByText("Requires ## Verify section")).toBeVisible();

      // 1. Start the guided Claude Spec interview
      await page.getByRole("button", { name: "Start spec interview" }).click();

      // Fake agent reads docs/INTAKE.md, writes an initial draft of docs/SPEC.md without ## Verify, and asks for ## Verify
      const specPath = join(dir, "docs", "SPEC.md");
      await expect.poll(() => existsSync(specPath), { timeout: 15000 }).toBe(true);
      await expect(page.getByTestId("spec-live-content")).toContainText("Need guided spec interview", {
        timeout: 15000,
      });

      // Because ## Verify is not in docs/SPEC.md yet, Approve spec remains disabled and Mock remains locked
      await expect(page.getByText("Requires ## Verify section")).toBeVisible();
      await expect(approveBtn).toBeDisabled();
      await expect(mockStep).toBeDisabled();

      // 2. Reply to Claude with the verification criteria so it adds ## Verify to docs/SPEC.md
      const replyInput = page.getByLabel("Reply to Claude");
      await expect(replyInput).toBeEnabled({ timeout: 15000 });
      await replyInput.fill("Run full e2e test from intake to approved spec.");
      await page.getByRole("button", { name: "Send" }).click();

      // Live preview updates with ## Verify and enables Approve spec
      await expect(page.getByTestId("spec-live-content")).toContainText("## Verify", { timeout: 15000 });
      await expect(page.getByTestId("spec-live-content")).toContainText(
        "Run full e2e test from intake to approved spec.",
      );
      await expect(page.getByText("## Verify section ready")).toBeVisible();
      await expect(approveBtn).toBeEnabled();

      // Verify docs/SPEC.md on disk contains ## Verify
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk).toContain("## Verify");
      expect(onDisk).toContain("Run full e2e test from intake to approved spec.");

      // 3. Click Approve spec -> advances to Step 3: Clickable HTML mock
      await approveBtn.click();
      await expect(page.getByRole("heading", { level: 2, name: /Step 3: Clickable HTML mock/i })).toBeVisible();
      await expect(specStep).toHaveClass(/completed/);
      await expect(mockStep).toBeEnabled();

      // 4. Reopen Step 2: Spec read-only
      await specStep.click();
      await expect(page.getByRole("heading", { level: 2, name: /Step 2: Spec interview/i })).toBeVisible();
      await expect(page.getByTestId("spec-readonly-content")).toContainText("## Verify");
      await expect(page.getByRole("button", { name: "Reopen interview" })).toBeVisible();
    } finally {
      deleteProject(projectId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
