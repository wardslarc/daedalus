import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(name: string): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `e2e-hub-${name}-`));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return { dir };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator("form[data-hydrated='true']").waitFor();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

test.describe("projects hub", () => {
  test("full projects hub workflow: dialogs, three imports, filtering, search, screenshots", async ({ page }) => {
    // 1. Log in
    await login(page);

    // Wait for client hydration
    await expect(page.locator("[data-hydrated='true']")).toBeVisible();
    await expect(page.getByRole("radio", { name: /^All · \d+$/ })).toBeVisible();

    // 2. Keyboard usability and error handling in Import dialog
    const importBtn = page.getByRole("button", { name: "Import project" });
    await importBtn.click();

    const importDialog = page.getByRole("dialog", { name: "Import project" });
    await expect(importDialog).toBeVisible();
    const sourceInput = page.getByLabel("Source");
    await expect(sourceInput).toBeFocused();

    // Test import error (e.g. source "/")
    await sourceInput.fill("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importDialog.getByRole("alert")).toBeVisible();

    // Escape closes and focus returns to button
    await page.keyboard.press("Escape");
    await expect(importDialog).not.toBeVisible();
    await expect(importBtn).toBeFocused();

    // 3. New project dialog: creates a project from the kit (T2.5 is merged), and is keyboard-usable
    const newBtn = page.getByRole("button", { name: "New project" });
    await newBtn.click();
    const newDialog = page.getByRole("dialog", { name: "New project" });
    await expect(newDialog).toBeVisible();
    const newNameInput = page.getByLabel("Name", { exact: true });
    await expect(newNameInput).toBeFocused();

    await newNameInput.fill("Kit Started");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(newDialog).not.toBeVisible();
    await expect(page.getByRole("article", { name: "Kit Started" })).toBeVisible();

    await newBtn.click();
    await expect(newDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(newDialog).not.toBeVisible();
    await expect(newBtn).toBeFocused();

    // 4. Create three fixture repos
    const repoWork = fixtureRepo("work-project");
    const repoClient = fixtureRepo("client-project");
    const repoPersonal = fixtureRepo("personal-project");

    // Import Repo 1: Work
    await importBtn.click();
    await importDialog.getByLabel("Source").fill(repoWork.dir);
    await importDialog.getByLabel("Work").check();
    await importDialog.getByLabel(/Name/).fill("Hub Work");
    await importDialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importDialog).not.toBeVisible();

    // Card 1 appears
    const workCard = page.getByRole("article", { name: "Hub Work" });
    await expect(workCard).toBeVisible();
    await expect(workCard.getByText("Work", { exact: true })).toBeVisible();

    // Import Repo 2: Client with Gemini allowed
    await importBtn.click();
    await importDialog.getByLabel("Source").fill(repoClient.dir);
    await importDialog.getByLabel("Client").check();
    const geminiCheckbox = importDialog.getByLabel("Allow Gemini");
    await expect(geminiCheckbox).toBeVisible();
    await geminiCheckbox.check();
    await importDialog.getByLabel(/Name/).fill("Hub Client");
    await importDialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importDialog).not.toBeVisible();

    // Card 2 appears
    const clientCard = page.getByRole("article", { name: "Hub Client" });
    await expect(clientCard).toBeVisible();
    await expect(clientCard.getByText("Client", { exact: true })).toBeVisible();

    // Import Repo 3: Personal
    await importBtn.click();
    await importDialog.getByLabel("Source").fill(repoPersonal.dir);
    await importDialog.getByLabel("Personal").check();
    await importDialog.getByLabel(/Name/).fill("Hub Personal");
    await importDialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importDialog).not.toBeVisible();

    // Card 3 appears
    const personalCard = page.getByRole("article", { name: "Hub Personal" });
    await expect(personalCard).toBeVisible();
    await expect(personalCard.getByText("Personal", { exact: true })).toBeVisible();

    // All three cards show kit pending state and running agents
    for (const card of [workCard, clientCard, personalCard]) {
      await expect(card.getByText("Kit ready on daedalus/kit — review and merge it in your repo")).toBeVisible();
      await expect(card.getByText("No agents running")).toBeVisible();
      await expect(card.getByText(/main/)).toBeVisible();
    }

    // 5. Live counts on profile pills
    await expect(page.getByRole("radio", { name: /^All · ([3-9]|[1-9]\d+)$/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Work · [1-9]\d*$/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Client · [1-9]\d*$/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Personal · [1-9]\d*$/ })).toBeVisible();

    // 6. Profile filtering
    await page.getByRole("radio", { name: /^Work · / }).click();
    await expect(workCard).toBeVisible();
    await expect(clientCard).not.toBeVisible();
    await expect(personalCard).not.toBeVisible();

    await page.getByRole("radio", { name: /^Client · / }).click();
    await expect(workCard).not.toBeVisible();
    await expect(clientCard).toBeVisible();
    await expect(personalCard).not.toBeVisible();

    await page.getByRole("radio", { name: /^Personal · / }).click();
    await expect(workCard).not.toBeVisible();
    await expect(clientCard).not.toBeVisible();
    await expect(personalCard).toBeVisible();

    await page.getByRole("radio", { name: /^All · / }).click();
    await expect(workCard).toBeVisible();
    await expect(clientCard).toBeVisible();
    await expect(personalCard).toBeVisible();

    // 7. Search filtering
    const searchInput = page.getByLabel("Search");
    await searchInput.fill("Hub Client");
    await expect(workCard).not.toBeVisible();
    await expect(clientCard).toBeVisible();
    await expect(personalCard).not.toBeVisible();

    await searchInput.fill("Hub");
    await expect(workCard).toBeVisible();
    await expect(clientCard).toBeVisible();
    await expect(personalCard).toBeVisible();

    // 8. Screenshots
    mkdirSync("test-results/screens", { recursive: true });

    // Desktop 1440x960
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/screens/projects-hub-1440.png" });

    // Mobile 400x900
    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForTimeout(300);

    // Verify no horizontal scroll at 400px
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    await page.screenshot({ path: "test-results/screens/projects-hub-400.png" });
  });
});
