import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { cliArgs, DEFAULT_PROMPT, resolveFolder } from "./shared.js";

describe("spikes/shared", () => {
  it("resolves relative folder against base cwd", () => {
    const base = process.env.INIT_CWD ?? process.cwd();
    const relative = "test-folder";
    const expected = resolve(base, relative);
    expect(resolveFolder(relative)).toBe(expected);
  });

  it("returns absolute path unchanged", () => {
    const absolute = resolve("/tmp/test-folder");
    expect(resolveFolder(absolute)).toBe(absolute);
  });

  it("filters out -- from cliArgs", () => {
    const origArgv = process.argv;
    try {
      process.argv = ["node", "script.js", "--", "arg1", "--", "arg2"];
      expect(cliArgs()).toEqual(["arg1", "arg2"]);
    } finally {
      process.argv = origArgv;
    }
  });

  it("defines default prompt string", () => {
    expect(typeof DEFAULT_PROMPT).toBe("string");
    expect(DEFAULT_PROMPT.length).toBeGreaterThan(0);
  });
});
