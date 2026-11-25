/**
 * E2E-only UAT fakes (used when DAE_UAT_FAKE=1 AND dataDir is an e2e temp folder).
 * Fails closed: if dataDir is not directly inside os.tmpdir() with a `dae-e2e-` prefix,
 * the flag is ignored so a real server can never pass UAT/Ship on fake replays.
 */
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { DaedalusDb } from "@daedalus/db";
import type { UatBrowserPage, UatDeps } from "@daedalus/projects";

const E2E_DATA_DIR_PREFIX = "dae-e2e-";

/**
 * Returns true iff `dataDir` exists as a directory whose realpath is directly inside
 * `realpathSync(os.tmpdir())` and whose folder name starts with `dae-e2e-`.
 */
export function isE2eTempDataDir(dataDir: string): boolean {
  try {
    const realDataDir = realpathSync(dataDir);
    const realTmpDir = realpathSync(tmpdir());
    if (!lstatSync(realDataDir).isDirectory()) {
      return false;
    }
    return (
      dirname(realDataDir) === realTmpDir &&
      basename(realDataDir).startsWith(E2E_DATA_DIR_PREFIX)
    );
  } catch {
    return false;
  }
}

/** Build deterministic fake UatDeps for e2e tests without importing playwright in apps/web. */
export function createE2eFakeUatDeps(db: DaedalusDb, dataDir: string): UatDeps {
  const makeFakePage = (): UatBrowserPage => ({
    goto: async () => null,
    screenshot: async () => Buffer.from(""),
  });

  return {
    db,
    dataDir,
    processRunner: async () => ({ pid: 0, kill: () => {} }),
    portProbe: async () => false,
    urlProbe: async () => true,
    browserLauncher: async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        tracing: { stop: async () => {} },
        newPage: async () => makeFakePage(),
      },
      page: makeFakePage(),
    }),
    codegenRunner: async (opts) => {
      writeFileSync(
        opts.outputFile,
        `import { test, expect } from '@playwright/test';\n\ntest('recorded uat check', async ({ page }) => {\n  await page.goto('${opts.appUrl}/');\n  await expect(page).toHaveURL(/./);\n});\n`,
        "utf8",
      );
      return { exitCode: 0 };
    },
    replayRunner: async (opts) => {
      const results = opts.scripts.map((s) => {
        if (
          s.rewrittenScriptText.includes("FAIL_UAT_REPLAY") ||
          s.rewrittenScriptText.includes("toBe(false)")
        ) {
          return {
            scriptId: s.id,
            status: "failed" as const,
            detail: "Fake replay failure: broken script",
            durationMs: 12,
          };
        }
        return {
          scriptId: s.id,
          status: "passed" as const,
          durationMs: 10,
        };
      });
      const anyFailed = results.some((r) => r.status !== "passed");
      return {
        status: anyFailed ? "failed" : "passed",
        results,
      };
    },
  };
}

/**
 * Resolve UAT dependencies once at startup.
 * Honours DAE_UAT_FAKE=1 only when `isE2eTempDataDir(dataDir)` holds; otherwise fails closed
 * to real dependencies and warns once.
 */
export function resolveUatDeps(db: DaedalusDb, dataDir: string): UatDeps {
  if (process.env.DAE_UAT_FAKE !== "1") {
    return { db, dataDir };
  }
  if (!isE2eTempDataDir(dataDir)) {
    console.warn(
      "[daedalus] Ignoring DAE_UAT_FAKE=1: dataDir is not directly inside os.tmpdir() with a dae-e2e- prefix.",
    );
    return { db, dataDir };
  }
  console.warn("[daedalus] UAT fakes are ON (DAE_UAT_FAKE=1) for e2e temp dataDir.");
  return createE2eFakeUatDeps(db, dataDir);
}
