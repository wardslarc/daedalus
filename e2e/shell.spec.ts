import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { E2E_PASSWORD } from "./env.js";

const RAIL_ROUTES = [
  { path: "/projects", name: "projects", h1: "Projects", navLabel: "Projects" },
  { path: "/workshop", name: "workshop", h1: "Workshop", navLabel: "Workshop" },
  { path: "/providers", name: "providers", h1: "Providers & usage", navLabel: "Usage" },
] as const;

const PROJECT_ROUTES = [
  { path: "/projects/1/chat", name: "project-chat", h1: "Project chat", tabLabel: "Chat" },
  { path: "/projects/1/pipeline", name: "project-pipeline", h1: "Pipeline", tabLabel: "Pipeline" },
  { path: "/projects/1/review", name: "project-review", h1: "Review", tabLabel: "Review" },
  { path: "/projects/1/release", name: "project-release", h1: "Release gate", tabLabel: "Release gate" },
  { path: "/projects/1/changes", name: "project-changes", h1: "Change requests", tabLabel: "Change requests" },
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.locator("form[data-hydrated='true']").waitFor();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
}

test.describe("app shell", () => {
  test.beforeAll(() => {
    mkdirSync("test-results/screens", { recursive: true });
  });

  test("each of the rail routes shows its h1 and marks its rail item aria-current='page'", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await login(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();

    for (const r of RAIL_ROUTES) {
      await page.goto(r.path);
      await expect(page.getByRole("heading", { level: 1, name: r.h1 })).toBeVisible();

      const activeLink = nav.getByRole("link", { name: r.navLabel });
      await expect(activeLink).toHaveAttribute("aria-current", "page");

      // Verify other links do NOT have aria-current="page"
      for (const other of RAIL_ROUTES) {
        if (other.path !== r.path) {
          const otherLink = nav.getByRole("link", { name: other.navLabel });
          await expect(otherLink).not.toHaveAttribute("aria-current", "page");
        }
      }

      await page.screenshot({ path: `test-results/screens/${r.name}-1440.png`, fullPage: false });
    }
  });

  test("project screens show project tabs and highlight Projects in rail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await login(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    const projectsRailLink = nav.getByRole("link", { name: "Projects" });

    for (const pr of PROJECT_ROUTES) {
      await page.goto(pr.path);
      await expect(page.getByRole("heading", { level: 1, name: pr.h1 })).toBeVisible();

      // Rail highlights Projects
      await expect(projectsRailLink).toHaveAttribute("aria-current", "page");

      // Project tabs navigation
      const projectTabsNav = page.getByRole("navigation", { name: "Project sections" });
      await expect(projectTabsNav).toBeVisible();
      const activeTab = projectTabsNav.getByRole("link", { name: pr.tabLabel });
      await expect(activeTab).toHaveAttribute("aria-current", "page");
    }
  });

  test("projects h1 uses next/font font and does not fallback to system font", async ({ page }) => {
    await login(page);
    await page.goto("/projects");
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

    // The real Space Grotesk face must actually have loaded (status "loaded"), not just be
    // named in the CSS: if the font download fails, the browser silently uses the fallback.
    const realFaceLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((f) => /Space Grotesk/.test(f.family) && !/Fallback/.test(f.family) && f.status === "loaded");
    });
    expect(realFaceLoaded).toBe(true);

    const isFontLoaded = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const family = h1 ? getComputedStyle(h1).fontFamily : "";
      const firstFont = (family.split(",")[0] ?? "").replace(/"/g, "").trim();
      return document.fonts.check(`600 30px "${firstFont}"`);
    });
    expect(isFontLoaded).toBe(true);

    const fontFamily = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? getComputedStyle(h1).fontFamily : "";
    });
    const firstFont = (fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
    expect(["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "system-ui", "sans-serif"]).not.toContain(firstFont);
    expect(fontFamily).toContain("Space Grotesk Fallback");
  });

  test("sign out from the sidebar returns to /login", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await login(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    const signOutBtn = nav.getByRole("button", { name: "Sign out" });
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    await expect(page).toHaveURL(/\/login$/);
  });

  test("wordmark logo has aria-hidden and projects search field has visible label", async ({ page }) => {
    await login(page);
    await page.goto("/projects");

    const logoSvg = page.locator(".wordmark-logo");
    await expect(logoSvg).toHaveAttribute("aria-hidden", "true");

    const searchInput = page.getByLabel("Search");
    await expect(searchInput).toBeVisible();
    await expect(page.locator(".search-label")).toHaveText("Search");
  });

  test("no horizontal scroll at 400px wide on /projects and captures screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    await login(page);

    await page.goto("/projects");
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400);

    await page.screenshot({ path: "test-results/screens/projects-400.png", fullPage: false });
  });
});
