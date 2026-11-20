import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { E2E_PASSWORD } from "./env.js";

const ROUTES = [
  { path: "/projects", name: "projects", h1: "Projects", navLabel: "Projects" },
  { path: "/chat", name: "chat", h1: "Project chat", navLabel: "Project chat" },
  { path: "/pipeline", name: "pipeline", h1: "Pipeline", navLabel: "Pipeline" },
  { path: "/workshop", name: "workshop", h1: "Workshop", navLabel: "Workshop" },
  { path: "/review", name: "review", h1: "Review", navLabel: "Review" },
  { path: "/providers", name: "providers", h1: "Providers & usage", navLabel: "Providers & usage" },
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
}

test.describe("app shell", () => {
  test.beforeAll(() => {
    mkdirSync("test-results/screens", { recursive: true });
  });

  test("each of the six routes shows its h1 and marks its sidebar item aria-current='page'", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await login(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();

    for (const r of ROUTES) {
      await page.goto(r.path);
      await expect(page.getByRole("heading", { level: 1, name: r.h1 })).toBeVisible();

      const activeLink = nav.getByRole("link", { name: r.navLabel });
      await expect(activeLink).toHaveAttribute("aria-current", "page");

      // Verify other links do NOT have aria-current="page"
      for (const other of ROUTES) {
        if (other.path !== r.path) {
          const otherLink = nav.getByRole("link", { name: other.navLabel });
          await expect(otherLink).not.toHaveAttribute("aria-current", "page");
        }
      }

      await page.screenshot({ path: `test-results/screens/${r.name}-1440.png`, fullPage: false });
    }
  });

  test("projects h1 uses next/font font and does not fallback to system font", async ({ page }) => {
    await login(page);
    await page.goto("/projects");
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

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
