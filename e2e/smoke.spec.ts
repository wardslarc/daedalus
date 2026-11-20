import { test, expect } from "@playwright/test";

test.describe("web smoke test", () => {
  test("signed-out visitors land on the login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page).toHaveTitle(/Daedalus/);
  });
});
