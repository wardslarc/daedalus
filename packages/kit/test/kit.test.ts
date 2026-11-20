import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_FILES, KIT_PLACEHOLDERS, kitDir, missingKitFiles, renderKit, type KitVars } from "../src/index.js";

const vars: KitVars = {
  PROJECT_NAME: "Sample Project",
  PROFILE: "Personal",
  TODAY: "2026-11-20",
  PROFILE_RULES: "- Rule one\n- Rule two",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [relative(kitDir(), full)];
  });
}

describe("kit manifest", () => {
  it("lists exactly the files in kit/", () => {
    expect([...KIT_FILES].sort()).toEqual(walk(kitDir()).sort());
  });

  it("includes the scaffold the plan asks for", () => {
    for (const f of [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/INTAKE.md",
      "docs/SPEC.md",
      "docs/PLAN.md",
      "docs/decisions/0001-record-decisions.md",
      ".editorconfig",
      ".claudeignore",
    ]) {
      expect(KIT_FILES).toContain(f);
    }
  });

  it("uses only known placeholders", () => {
    for (const f of KIT_FILES) {
      const text = readFileSync(join(kitDir(), f), "utf8");
      for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
        expect(KIT_PLACEHOLDERS, `${f} uses {{${m[1]}}}`).toContain(m[1]);
      }
    }
  });

  it("names no real project", () => {
    for (const f of KIT_FILES) {
      const text = readFileSync(join(kitDir(), f), "utf8");
      expect(text, f).not.toMatch(/daedalus|bilyo|relato|rmk|kollab/i);
    }
  });
});

describe("renderKit", () => {
  it("fills every placeholder and leaves no {{ behind", () => {
    const out = renderKit(vars);
    expect(out.map((f) => f.path).sort()).toEqual([...KIT_FILES].sort());
    for (const f of out) expect(f.content, f.path).not.toContain("{{");
    const agents = out.find((f) => f.path === "AGENTS.md")?.content ?? "";
    expect(agents).toContain("Sample Project");
    expect(agents).toContain("- Rule one\n- Rule two");
  });

  it("refuses to render with a missing variable", () => {
    expect(() => renderKit({ ...vars, PROFILE_RULES: undefined } as unknown as KitVars)).toThrow(/PROFILE_RULES/);
  });

  it("does not let a variable value inject another placeholder", () => {
    const out = renderKit({ ...vars, PROJECT_NAME: "{{TODAY}}" });
    const agents = out.find((f) => f.path === "AGENTS.md")?.content ?? "";
    expect(agents).toContain("{{TODAY}}");
  });
});

describe("missingKitFiles", () => {
  it("returns every kit file for an empty folder", () => {
    expect(missingKitFiles(mkdtempSync(join(tmpdir(), "kit-")))).toEqual([...KIT_FILES]);
  });

  it("skips files the project already has, never overwriting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-"));
    writeFileSync(join(dir, "AGENTS.md"), "my own rules");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "SPEC.md"), "my spec");
    const missing = missingKitFiles(dir);
    expect(missing).not.toContain("AGENTS.md");
    expect(missing).not.toContain("docs/SPEC.md");
    expect(missing).toContain("CLAUDE.md");
    expect(missing.length).toBe(KIT_FILES.length - 2);
  });
});
