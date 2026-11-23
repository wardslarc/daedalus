import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_PROJECTS_HOME } from "./env.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo(): { dir: string; mainLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "e2e-import-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  writeFileSync(join(dir, "README.md"), "# fixture\nuncommitted\n");
  return { dir, mainLog: git(dir, "log", "--format=%H", "main") };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator("form[data-hydrated='true']").waitFor();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** POST JSON from the page, with the CSRF header the server requires. */
function post(page: Page, body: unknown) {
  return page.evaluate(async (b) => {
    const token = /(?:^|;\s*)dae_csrf=([0-9a-f]{64})/.exec(document.cookie)?.[1] ?? "";
    const r = await fetch("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify(b),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }, body);
}

test.describe("import project", () => {
  test("imports a repo: main unchanged, kit committed on daedalus/kit, row saved", async ({ page }) => {
    const { dir, mainLog } = fixtureRepo();
    await login(page);
    const res = await post(page, { source: dir, profile: "personal", name: "Fixture" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ project: { name: "Fixture", profile: "personal", localPath: dir }, kit: { status: "added" } });

    expect(git(dir, "log", "--format=%H", "main")).toBe(mainLog);
    expect(git(dir, "status", "--porcelain")).toBe("M README.md");
    expect(git(dir, "log", "-1", "--format=%s", "daedalus/kit")).toBe("Add Daedalus project kit");

    const again = await post(page, { source: dir, profile: "personal" });
    expect(again.status).toBe(409);
  });

  test("profile rules and input checks are enforced by the server", async ({ page }) => {
    const { dir } = fixtureRepo();
    await login(page);
    expect((await post(page, { source: dir, profile: "work", geminiAllowed: true })).status).toBe(403);
    expect((await post(page, { source: "/", profile: "personal" })).status).toBe(400);
    expect((await post(page, { source: "file:///etc", profile: "personal" })).status).toBe(400);
    expect((await post(page, { source: dir, profile: "hobby" })).status).toBe(403);
    expect(git(dir, "branch", "--list", "daedalus/kit")).toBe("");
  });

  test("import is refused without a session", async ({ request }) => {
    const r = await request.post("/api/projects/import", { data: { source: "/tmp", profile: "personal" } });
    expect([401, 403]).toContain(r.status());
  });

  test("imports a repo via a Windows File Explorer WSL UNC path (\\\\wsl.localhost\\Ubuntu\\...)", async ({ page }) => {
    const { dir } = fixtureRepo();
    const wslUncPath = `\\\\wsl.localhost\\Ubuntu${dir.replace(/\//g, "\\")}`;
    await login(page);
    const res = await post(page, { source: wslUncPath, profile: "personal", name: "WSL UNC Fixture" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      project: { name: "WSL UNC Fixture", profile: "personal", localPath: dir },
    });
  });

  test("folder explorer in Import dialog lets user browse and select a git repo without typing a path", async ({ page }) => {
    // Create a repo inside E2E_PROJECTS_HOME so it appears right under Home in the Folder Explorer
    mkdirSync(E2E_PROJECTS_HOME, { recursive: true });
    const repoDir = mkdtempSync(join(E2E_PROJECTS_HOME, "explorer-repo-"));
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "Fixture");
    git(repoDir, "config", "user.email", "fixture@example.com");
    writeFileSync(join(repoDir, "README.md"), "# explorer\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "fixture");
    const folderName = basename(repoDir);

    await login(page);
    await page.getByRole("button", { name: "Import project" }).click();
    const dialog = page.getByRole("dialog", { name: "Import project" });
    await expect(dialog).toBeVisible();

    // Open folder explorer
    await dialog.getByRole("button", { name: "Browse…" }).click();
    const explorer = dialog.getByRole("region", { name: "Folder explorer" });
    await expect(explorer).toBeVisible();
    await expect(explorer).toContainText(folderName);
    await expect(explorer).toContainText("Git repo");

    // Select the repo from the list
    await explorer.getByRole("button", { name: `Select ${folderName}` }).click();
    await expect(explorer).not.toBeVisible();
    await expect(dialog.getByLabel("Source")).toHaveValue(repoDir);

    // Finish importing
    await dialog.getByLabel("Personal").check();
    await dialog.getByLabel(/Name/).fill("Picked From Explorer");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("article", { name: "Picked From Explorer" })).toBeVisible();
  });
});
