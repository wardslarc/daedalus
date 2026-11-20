import { test, expect } from "@playwright/test";

test.describe("web smoke test", () => {
  test("loads landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Daedalus/);
  });
});
