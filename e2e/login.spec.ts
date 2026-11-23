import { test, expect } from "@playwright/test";
import { E2E_PASSWORD } from "./env.js";

test.describe("login", () => {
  test("a protected page redirects to /login when signed out", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in to Daedalus" })).toBeVisible();
  });

  test("wrong password is rejected and stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.locator("form[data-hydrated='true']").waitFor();
    await page.getByLabel("Password").fill("not the password at all");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#login-error")).toHaveText("Wrong password.");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("right password lands on Projects, and sign out ends the session", async ({ page, context }) => {
    await page.goto("/login");
    await page.locator("form[data-hydrated='true']").waitFor();
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    const session = (await context.cookies()).find((c) => c.name === "dae_session");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Strict");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a POST without the CSRF header is refused with 403", async ({ page, baseURL }) => {
    await page.goto("/login");
    const status = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "anything at all" }),
      });
      return r.status;
    }, baseURL);
    expect(status).toBe(403);
  });
});
