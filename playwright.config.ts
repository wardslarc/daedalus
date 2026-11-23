import { defineConfig, devices } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PASSWORD, E2E_PORT, E2E_PROJECTS_HOME, E2E_PROVIDERS_FILE } from "./e2e/env.js";

const baseURL = `http://127.0.0.1:${E2E_PORT}`;
// e2e runs against a production build: the dev server compiles pages on demand, which made
// roughly one run in three fail on a page that never hydrated. DAE_E2E_DEV=1 uses the dev server.
const devServer = process.env.DAE_E2E_DEV === "1";
const build = devServer ? "" : "pnpm --filter @daedalus/web build && ";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    // Build (unless DAE_E2E_DEV=1), set a known password in a throwaway data dir, start dae on the e2e port.
    command: `${build}printf "%s\\n" "$DAE_E2E_PASSWORD" | pnpm dae set-password && pnpm dae`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      DAE_PORT: String(E2E_PORT),
      DAE_DATA_DIR: E2E_DATA_DIR,
      DAE_PROJECTS_HOME: E2E_PROJECTS_HOME,
      DAE_E2E_PASSWORD: E2E_PASSWORD,
      DAE_PROVIDERS_FILE: E2E_PROVIDERS_FILE,
      ...(devServer ? {} : { NODE_ENV: "production" }),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
