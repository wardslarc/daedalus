import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, projects, type DaedalusDb } from "@daedalus/db";
import {
  approveMockDoc,
  approvePlanDoc,
  approveSpecDoc,
  beginMockSession,
  beginPlanSession,
  beginSpecInterview,
  buildMockPrompt,
  buildPlanPrompt,
  buildSpecInterviewPrompt,
  getShapingState,
  hasVerifySection,
  isValidPlanMarkdown,
  parseIntakeMarkdown,
  readShapingDoc,
  renderIntakeMarkdown,
  saveIntakeDoc,
  ShapingError,
  startMilestoneRelease,
  writeShapingDoc,
} from "../src/shaping.js";
import { ProfileRuleError } from "@daedalus/core/profiles";

describe("shaping service", () => {
  let rootDir: string;
  let db: DaedalusDb;
  let projectId: number;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "daedalus-shaping-test-"));
    db = openDb(":memory:");
    const [p] = db
      .insert(projects)
      .values({ name: "TestProj", localPath: rootDir, profile: "personal", geminiAllowed: true })
      .returning()
      .all();
    projectId = p!.id;
  });

  afterEach(() => {
    db.$client.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe("readShapingDoc", () => {
    it("returns exists: false when docs folder or file does not exist", () => {
      const result = readShapingDoc(rootDir, "docs/INTAKE.md");
      expect(result).toEqual({ exists: false, content: null });
    });

    it("reads valid file inside docs/", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(join(rootDir, "docs", "INTAKE.md"), "# Intake\n- **Problem:** none\n", "utf8");
      const result = readShapingDoc(rootDir, "docs/INTAKE.md");
      expect(result).toEqual({ exists: true, content: "# Intake\n- **Problem:** none\n" });
    });

    it("throws ShapingError if docs directory is a symlink", () => {
      const outside = mkdtempSync(join(tmpdir(), "daedalus-outside-"));
      try {
        writeFileSync(join(outside, "INTAKE.md"), "pwned", "utf8");
        symlinkSync(outside, join(rootDir, "docs"), "dir");

        expect(() => readShapingDoc(rootDir, "docs/INTAKE.md")).toThrow(ShapingError);
        expect(() => readShapingDoc(rootDir, "docs/INTAKE.md")).toThrow(/symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("throws ShapingError if target doc is a symlink", () => {
      mkdirSync(join(rootDir, "docs"));
      const outside = mkdtempSync(join(tmpdir(), "daedalus-outside-"));
      try {
        const secret = join(outside, "secret.txt");
        writeFileSync(secret, "secret", "utf8");
        symlinkSync(secret, join(rootDir, "docs", "INTAKE.md"));

        expect(() => readShapingDoc(rootDir, "docs/INTAKE.md")).toThrow(ShapingError);
        expect(() => readShapingDoc(rootDir, "docs/INTAKE.md")).toThrow(/symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("writeShapingDoc", () => {
    it("creates docs/ directory if missing and writes file", () => {
      writeShapingDoc(rootDir, "docs/INTAKE.md", "# Intake\nTest content\n");
      const filePath = join(rootDir, "docs", "INTAKE.md");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("# Intake\nTest content\n");
    });

    it("overwrites existing file cleanly when not a symlink", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(join(rootDir, "docs", "INTAKE.md"), "original", "utf8");
      writeShapingDoc(rootDir, "docs/INTAKE.md", "updated");
      expect(readFileSync(join(rootDir, "docs", "INTAKE.md"), "utf8")).toBe("updated");
    });

    it("refuses to write if docs is a symlink", () => {
      const outside = mkdtempSync(join(tmpdir(), "daedalus-outside-"));
      try {
        symlinkSync(outside, join(rootDir, "docs"), "dir");
        expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", "payload")).toThrow(ShapingError);
        expect(existsSync(join(outside, "INTAKE.md"))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses to overwrite if target file is a symlink", () => {
      mkdirSync(join(rootDir, "docs"));
      const outside = mkdtempSync(join(tmpdir(), "daedalus-outside-"));
      try {
        const target = join(outside, "target.txt");
        writeFileSync(target, "initial", "utf8");
        symlinkSync(target, join(rootDir, "docs", "INTAKE.md"));

        expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", "pwned")).toThrow(ShapingError);
        expect(readFileSync(target, "utf8")).toBe("initial");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses content with disallowed control characters", () => {
      expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", "hello\x00world")).toThrow(ShapingError);
      expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", "bad\x08char")).toThrow(/control character/i);
    });

    it("allows standard newlines, carriage returns, and tabs in content", () => {
      const valid = "# Title\r\n\t- Item with tab and CRLF\n";
      writeShapingDoc(rootDir, "docs/INTAKE.md", valid);
      expect(readFileSync(join(rootDir, "docs", "INTAKE.md"), "utf8")).toBe(valid);
    });

    it("refuses oversized content (>128KB)", () => {
      const huge = "a".repeat(129 * 1024);
      expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", huge)).toThrow(ShapingError);
      expect(() => writeShapingDoc(rootDir, "docs/INTAKE.md", huge)).toThrow(/too large/i);
    });

    it("refuses relative paths outside docs/ before writing anything", () => {
      const outsidePath = join(rootDir, "escaped.md");
      expect(() => writeShapingDoc(rootDir, "../escaped.md", "bad")).toThrow(ShapingError);
      expect(() => writeShapingDoc(rootDir, "docs/../escaped.md", "bad")).toThrow(ShapingError);
      expect(existsSync(outsidePath)).toBe(false);
    });
  });

  describe("parseIntakeMarkdown and renderIntakeMarkdown", () => {
    it("renders and parses intake markdown round-trip", () => {
      const md = renderIntakeMarkdown(
        "My Project",
        {
          problem: "The problem",
          users: "Developers on Linux",
          constraints: "Local only",
          outOfScope: "Cloud hosting",
          mustHaves: "Web UI",
          requester: "Carls",
          deadline: "2026-12-31",
        },
        { today: "2026-11-23", profile: "Personal" },
      );

      expect(md).toContain("# Intake — My Project");
      expect(md).toContain("- **Problem:** The problem");
      expect(md).toContain("- **Users:** Developers on Linux");
      expect(md).toContain("- **Constraints:** Local only");
      expect(md).toContain("- **Out of scope:** Cloud hosting");
      expect(md).toContain("profile: Personal");

      const parsed = parseIntakeMarkdown(md);
      expect(parsed.problem).toBe("The problem");
      expect(parsed.users).toBe("Developers on Linux");
      expect(parsed.constraints).toBe("Local only");
      expect(parsed.outOfScope).toBe("Cloud hosting");
      expect(parsed.mustHaves).toBe("Web UI");
      expect(parsed.requester).toBe("Carls");
      expect(parsed.deadline).toBe("2026-12-31");
    });
  });

  describe("getShapingState", () => {
    it("reports step 1 Intake as current when no files exist", () => {
      const state = getShapingState(db, projectId, rootDir, { name: "Test", profile: "work", geminiAllowed: false });
      expect(state.currentStep).toBe("intake");
      expect(state.steps[0]).toMatchObject({ id: "intake", status: "current", exists: false });
      expect(state.steps[1]).toMatchObject({ id: "spec", status: "locked", exists: false });
      expect(state.steps[2]).toMatchObject({ id: "mock", status: "locked", exists: false });
      expect(state.steps[3]).toMatchObject({ id: "plan", status: "locked", exists: false });
    });

    it("ignores forged docs/.shaping.json in project folder", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(
        join(rootDir, "docs", ".shaping.json"),
        JSON.stringify({
          mockApproval: {
            artifactUrl: "https://claude.site/artifacts/forged",
            approvedBy: "Attacker",
            approvedAt: "2020-01-01T00:00:00.000Z",
          },
          planApprovedAt: "2020-01-01T00:00:00.000Z",
          activeMilestone: {
            version: "v1.0",
            branch: "daedalus/release-v1.0",
            startedAt: "2020-01-01T00:00:00.000Z",
            frozen: false,
          },
        }),
        "utf8",
      );

      const state = getShapingState(db, projectId, rootDir, { name: "Test", profile: "personal", geminiAllowed: true });
      expect(state.mock.approved).toBe(false);
      expect(state.plan.approved).toBe(false);
      expect(state.plan.activeMilestone).toBeNull();
    });

    it("treats unedited kit scaffold docs as not yet completed", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(
        join(rootDir, "docs", "INTAKE.md"),
        "# Intake — Test\n\n- **Problem:** what is hard or missing today.\n- **Users:** who uses it, on what devices.\n",
        "utf8",
      );
      writeFileSync(
        join(rootDir, "docs", "SPEC.md"),
        "# Spec — Test\n\n## Overview\n- What the product does, in one or two lines.\n\n## Verify\n- How we know the whole thing works (the end-to-end check).\n",
        "utf8",
      );
      writeFileSync(
        join(rootDir, "docs", "PLAN.md"),
        "# Plan — Test\n\n- [ ] **T1.1 First task** `[claude]` — [[SPEC#Overview]]\n  What to build, in one or two lines.\n  check: `<command that passes when this is done>`\n",
        "utf8",
      );

      const state = getShapingState(db, projectId, rootDir, { name: "Test", profile: "personal", geminiAllowed: true });
      expect(state.currentStep).toBe("intake");
      expect(state.intake.exists).toBe(false);
      expect(state.intake.fields).toEqual({});
      expect(state.steps[0]).toMatchObject({ id: "intake", status: "current", exists: false });
      expect(state.steps[1]).toMatchObject({ id: "spec", status: "locked", exists: false });
      expect(state.steps[3]).toMatchObject({ id: "plan", status: "locked", exists: false });
    });

    it("advances to step 2 Spec when docs/INTAKE.md exists", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(join(rootDir, "docs", "INTAKE.md"), "# Intake\n- **Problem:** Real problem\n", "utf8");

      const state = getShapingState(db, projectId, rootDir, { name: "Test", profile: "work", geminiAllowed: false });
      expect(state.currentStep).toBe("spec");
      expect(state.steps[0]).toMatchObject({ id: "intake", status: "completed", exists: true });
      expect(state.steps[1]).toMatchObject({ id: "spec", status: "current", exists: false });
      expect(state.steps[2]).toMatchObject({ id: "mock", status: "locked", exists: false });
      expect(state.steps[3]).toMatchObject({ id: "plan", status: "locked", exists: false });
    });

    it("keeps currentStep at spec when docs exist without db approval records", () => {
      mkdirSync(join(rootDir, "docs"));
      writeFileSync(join(rootDir, "docs", "INTAKE.md"), "# Intake\n- **Problem:** Real problem\n", "utf8");
      writeFileSync(join(rootDir, "docs", "SPEC.md"), "# Spec\n## Overview\n- Real\n## Verify\n- Passes\n", "utf8");
      writeFileSync(join(rootDir, "docs", "mock.html"), "<html></html>", "utf8");
      writeFileSync(join(rootDir, "docs", "PLAN.md"), "# Plan\n", "utf8");

      const state = getShapingState(db, projectId, rootDir, { name: "Test", profile: "work", geminiAllowed: false });
      expect(state.currentStep).toBe("spec");
      expect(state.steps[0]!.status).toBe("completed");
      expect(state.steps[1]!.status).toBe("current");
      expect(state.steps[2]!.status).toBe("locked");
      expect(state.steps[3]!.status).toBe("locked");
      expect(state.spec.approved).toBe(false);
      expect(state.mock.approved).toBe(false);
      expect(state.plan.approved).toBe(false);
    });

    it("assigns provider badges according to profile rules", () => {
      // Work: Claude only for mock
      const workState = getShapingState(db, projectId, rootDir, { name: "Test", profile: "work", geminiAllowed: false });
      expect(workState.steps.find((s) => s.id === "mock")?.provider).toBe("Claude");

      // Client with geminiAllowed=false: Claude only
      const clientFalse = getShapingState(db, projectId, rootDir, { name: "Test", profile: "client", geminiAllowed: false });
      expect(clientFalse.steps.find((s) => s.id === "mock")?.provider).toBe("Claude");

      // Client with geminiAllowed=true: Claude / Antigravity
      const clientTrue = getShapingState(db, projectId, rootDir, { name: "Test", profile: "client", geminiAllowed: true });
      expect(clientTrue.steps.find((s) => s.id === "mock")?.provider).toBe("Claude / Antigravity");

      // Personal: Claude / Antigravity
      const personal = getShapingState(db, projectId, rootDir, { name: "Test", profile: "personal", geminiAllowed: false });
      expect(personal.steps.find((s) => s.id === "mock")?.provider).toBe("Claude / Antigravity");

      // Spec and Plan always Claude
      expect(workState.steps.find((s) => s.id === "spec")?.provider).toBe("Claude");
      expect(workState.steps.find((s) => s.id === "plan")?.provider).toBe("Claude");
    });
  });

  describe("saveIntakeDoc", () => {
    it("saves structured fields into docs/INTAKE.md", () => {
      const result = saveIntakeDoc(
        db,
        projectId,
        rootDir,
        {
          fields: {
            problem: "Need project chat",
            users: "Solo dev",
            constraints: "Next.js",
            outOfScope: "Mobile app",
          },
        },
        { name: "My Project", profile: "personal", geminiAllowed: true },
      );

      expect(result.ok).toBe(true);
      expect(result.currentStep).toBe("spec");
      expect(result.content).toContain("# Intake — My Project");
      expect(result.content).toContain("- **Problem:** Need project chat");

      const written = readFileSync(join(rootDir, "docs", "INTAKE.md"), "utf8");
      expect(written).toBe(result.content);
    });

    it("saves raw markdown content directly", () => {
      const raw = "# Custom Intake\n\n- **Problem:** Custom problem\n";
      const result = saveIntakeDoc(
        db,
        projectId,
        rootDir,
        { content: raw },
        { name: "My Project", profile: "personal", geminiAllowed: true },
      );

      expect(result.ok).toBe(true);
      expect(result.content).toBe(raw);
      expect(readFileSync(join(rootDir, "docs", "INTAKE.md"), "utf8")).toBe(raw);
    });
  });

  describe("Spec interview and approval (T4.2)", () => {
    const proj = { name: "SpecProj", profile: "personal", geminiAllowed: true };

    it("hasVerifySection requires a non-empty ## Verify section and rejects kit template", () => {
      expect(hasVerifySection(null)).toBe(false);
      expect(hasVerifySection("")).toBe(false);
      expect(hasVerifySection("# Spec\n\n## Overview\n- Fast app\n")).toBe(false);
      expect(hasVerifySection("# Spec\n\n## Verify\n\n## Next Section\n- Something\n")).toBe(false);
      expect(
        hasVerifySection(
          "# Spec — Test\n\n## Overview\n- What the product does, in one or two lines.\n\n## Verify\n- How we know the whole thing works (the end-to-end check).\n",
        ),
      ).toBe(false);
      expect(
        hasVerifySection("# Spec — SpecProj\n\n## Overview\n- Real feature\n\n## Verify\n- E2E test passes\n"),
      ).toBe(true);
    });

    it("buildSpecInterviewPrompt includes project name and INTAKE.md content", () => {
      const prompt = buildSpecInterviewPrompt("SpecProj", "# Intake — SpecProj\n- **Problem:** Slow builds");
      expect(prompt).toContain("[Spec interview] Project: SpecProj");
      expect(prompt).toContain("- **Problem:** Slow builds");
      expect(prompt).toContain("## Verify");
    });

    it("keeps currentStep on spec when docs/SPEC.md is updated live before approval", () => {
      saveIntakeDoc(
        db,
        projectId,
        rootDir,
        {
          fields: {
            problem: "Fragmented workflow",
            users: "Solo dev",
            constraints: "Local only",
          },
        },
        proj,
      );

      const started = beginSpecInterview(db, projectId, rootDir, proj);
      expect(started.prompt).toContain("Fragmented workflow");
      expect(started.state.currentStep).toBe("spec");

      // Agent writes a live draft of docs/SPEC.md without ## Verify
      writeFileSync(
        join(rootDir, "docs", "SPEC.md"),
        "# Spec — SpecProj\n\n## Overview\n- Guided workflow\n",
        "utf8",
      );

      const draftState = getShapingState(db, projectId, rootDir, proj);
      expect(draftState.currentStep).toBe("spec");
      expect(draftState.spec.exists).toBe(true);
      expect(draftState.spec.hasVerify).toBe(false);
      expect(draftState.spec.approved).toBe(false);
      expect(draftState.steps.find((s) => s.id === "spec")?.status).toBe("current");
      expect(draftState.steps.find((s) => s.id === "mock")?.status).toBe("locked");

      // Approving without ## Verify is refused
      expect(() => approveSpecDoc(db, projectId, rootDir, undefined, proj)).toThrow(ShapingError);
      expect(() => approveSpecDoc(db, projectId, rootDir, undefined, proj)).toThrow(/## Verify/i);

      // Agent updates docs/SPEC.md live with ## Verify
      writeFileSync(
        join(rootDir, "docs", "SPEC.md"),
        "# Spec — SpecProj\n\n## Overview\n- Guided workflow\n\n## Verify\n- Run e2e suite and confirm spec approval unlocks mock.\n",
        "utf8",
      );

      const readyState = getShapingState(db, projectId, rootDir, proj);
      expect(readyState.currentStep).toBe("spec");
      expect(readyState.spec.hasVerify).toBe(true);
      expect(readyState.spec.approved).toBe(false);

      // Owner clicks Approve spec -> advances to mock
      const approved = approveSpecDoc(db, projectId, rootDir, undefined, proj);
      expect(approved.ok).toBe(true);
      expect(approved.currentStep).toBe("mock");
      expect(approved.spec.approved).toBe(true);
      expect(approved.spec.approvedAt).toBeTruthy();
      expect(approved.steps.find((s) => s.id === "spec")?.status).toBe("completed");
      expect(approved.steps.find((s) => s.id === "mock")?.status).toBe("current");
    });

    it("refuses approveSpecDoc when Intake or SPEC.md is missing", () => {
      expect(() => approveSpecDoc(db, projectId, rootDir, undefined, proj)).toThrow(/Intake/i);

      saveIntakeDoc(
        db,
        projectId,
        rootDir,
        { fields: { problem: "P", users: "U", constraints: "C" } },
        proj,
      );
      expect(() => approveSpecDoc(db, projectId, rootDir, undefined, proj)).toThrow(/SPEC\.md does not exist/i);
    });
  });

  describe("Mock session and approval gate (T4.3)", () => {
    const personalProj = { name: "MockProj", profile: "personal", geminiAllowed: true };
    const workProj = { name: "WorkProj", profile: "work", geminiAllowed: false };
    const clientNoGemini = { name: "ClientNoGemini", profile: "client", geminiAllowed: false };

    function setupApprovedSpec(dir: string, proj = personalProj) {
      saveIntakeDoc(
        db,
        projectId,
        dir,
        { fields: { problem: "Need clickable mock", users: "Dev", constraints: "Web" } },
        proj,
      );
      beginSpecInterview(db, projectId, dir, proj);
      writeFileSync(
        join(dir, "docs", "SPEC.md"),
        "# Spec\n\n## Overview\n- Ready\n\n## Verify\n- Passes e2e\n",
        "utf8",
      );
      approveSpecDoc(db, projectId, dir, undefined, proj);
    }

    it("buildMockPrompt includes project name and SPEC.md content", () => {
      const prompt = buildMockPrompt("MockProj", "# Spec\n## Overview\n- UI mock");
      expect(prompt).toContain("[Mock build] Project: MockProj");
      expect(prompt).toContain("docs/mock.html");
      expect(prompt).toContain("## Overview");
    });

    it("refuses beginMockSession when spec is not approved", () => {
      expect(() => beginMockSession(db, projectId, rootDir, "claude", personalProj)).toThrow(ShapingError);
      expect(() => beginMockSession(db, projectId, rootDir, "claude", personalProj)).toThrow(/SPEC\.md/i);
    });

    it("enforces profile rules: refuses antigravity on Work project or Client without Gemini", () => {
      setupApprovedSpec(rootDir, workProj);
      expect(() => beginMockSession(db, projectId, rootDir, "antigravity", workProj)).toThrow(ProfileRuleError);
      expect(() => beginMockSession(db, projectId, rootDir, "antigravity", workProj)).toThrow(/Gemini/i);

      expect(() => beginMockSession(db, projectId, rootDir, "antigravity", clientNoGemini)).toThrow(ProfileRuleError);

      // Claude is allowed on Work project
      const session = beginMockSession(db, projectId, rootDir, "claude", workProj);
      expect(session.providerId).toBe("claude");
      expect(session.prompt).toContain("[Mock build]");
    });

    it("allows both claude and antigravity on Personal project", () => {
      setupApprovedSpec(rootDir, personalProj);

      const claudeSession = beginMockSession(db, projectId, rootDir, "claude", personalProj);
      expect(claudeSession.providerId).toBe("claude");

      const agySession = beginMockSession(db, projectId, rootDir, "antigravity", personalProj);
      expect(agySession.providerId).toBe("antigravity");
      expect(agySession.state.mock.allowedProviders).toEqual(["claude", "antigravity"]);
    });

    it("keeps currentStep as mock while docs/mock.html is revised live until approveMockDoc is called", () => {
      setupApprovedSpec(rootDir, personalProj);
      beginMockSession(db, projectId, rootDir, "claude", personalProj);

      // Initial state: currentStep is mock, Step 4 Plan is locked
      let state = getShapingState(db, projectId, rootDir, personalProj);
      expect(state.currentStep).toBe("mock");
      expect(state.steps.find((s) => s.id === "mock")?.status).toBe("current");
      expect(state.steps.find((s) => s.id === "plan")?.status).toBe("locked");
      expect(state.mock.exists).toBe(false);
      expect(state.mock.approved).toBe(false);

      // Agent generates docs/mock.html on disk
      writeFileSync(join(rootDir, "docs", "mock.html"), "<html><body>Initial mock</body></html>", "utf8");

      // Even with mock.html on disk, currentStep stays mock until approval!
      state = getShapingState(db, projectId, rootDir, personalProj);
      expect(state.currentStep).toBe("mock");
      expect(state.steps.find((s) => s.id === "mock")?.status).toBe("current");
      expect(state.steps.find((s) => s.id === "plan")?.status).toBe("locked");
      expect(state.mock.exists).toBe(true);
      expect(state.mock.approved).toBe(false);

      // Revisions in chat update docs/mock.html
      writeFileSync(join(rootDir, "docs", "mock.html"), "<html><body>Revised mock</body></html>", "utf8");
      state = getShapingState(db, projectId, rootDir, personalProj);
      expect(state.currentStep).toBe("mock");
      expect(state.mock.approved).toBe(false);
    });

    it("approveMockDoc validates inputs and records approval metadata", () => {
      setupApprovedSpec(rootDir, personalProj);
      beginMockSession(db, projectId, rootDir, "claude", personalProj);

      // Fails when mock.html is missing
      expect(() => approveMockDoc(db, projectId, rootDir, { artifactUrl: "https://claude.site/artifacts/123", approvedBy: "Carls" }, personalProj)).toThrow(/docs\/mock\.html/i);

      writeFileSync(join(rootDir, "docs", "mock.html"), "<html><body>Clickable mock</body></html>", "utf8");

      // Fails when artifactUrl is missing or invalid
      expect(() => approveMockDoc(db, projectId, rootDir, { approvedBy: "Carls" }, personalProj)).toThrow(/artifactUrl/i);
      expect(() => approveMockDoc(db, projectId, rootDir, { artifactUrl: "not-a-url", approvedBy: "Carls" }, personalProj)).toThrow(/valid/i);
      expect(() => approveMockDoc(db, projectId, rootDir, { artifactUrl: "javascript:alert(1)", approvedBy: "Carls" }, personalProj)).toThrow(/valid/i);

      // Fails when approvedBy is missing or whitespace
      expect(() => approveMockDoc(db, projectId, rootDir, { artifactUrl: "https://claude.site/artifacts/123", approvedBy: "   " }, personalProj)).toThrow(/approvedBy/i);

      // Valid approval succeeds and uses server time (ignores client approvedAt)
      const clientTimestamp = "2020-01-01T00:00:00.000Z";
      const result = approveMockDoc(
        db,
        projectId,
        rootDir,
        {
          artifactUrl: "https://claude.site/artifacts/abc-123",
          approvedBy: "Carls",
          approvedAt: clientTimestamp,
        } as unknown as Parameters<typeof approveMockDoc>[3],
        personalProj,
      );

      expect(result.ok).toBe(true);
      expect(result.currentStep).toBe("plan");
      expect(result.mock.approved).toBe(true);
      expect(result.mock.approval).toEqual({
        artifactUrl: "https://claude.site/artifacts/abc-123",
        approvedBy: "Carls",
        approvedAt: expect.any(String),
        providerId: "claude",
      });
      expect(result.mock.approval?.approvedAt).not.toBe(clientTimestamp);
      expect(result.steps.find((s) => s.id === "mock")?.status).toBe("completed");
      expect(result.steps.find((s) => s.id === "plan")?.status).toBe("current");
    });
  });

  describe("Plan generation and Start milestone (T4.4)", () => {
    const proj = { name: "PlanProj", profile: "personal", geminiAllowed: true };
    const samplePlan = [
      "# Plan — PlanProj",
      "",
      "## M1 — v1.0 Core Release",
      "",
      "Done when: a project can run end to end from intake to release branch.",
      "",
      "- [ ] **T1.1 Core feature** `[claude]` — [[SPEC#Overview]]",
      "  Build the core feature.",
      "  check: `pnpm test`",
      "- [ ] **T1.2 UI verification** `[gemini]` — [[SPEC#Verify]]",
      "  Verify the UI.",
      "  check: `pnpm test:e2e`",
      "",
    ].join("\n");

    function setupApprovedMock(dir: string) {
      saveIntakeDoc(
        db,
        projectId,
        dir,
        { fields: { problem: "Need plan & release branch", users: "Dev", constraints: "Local" } },
        proj,
      );
      beginSpecInterview(db, projectId, dir, proj);
      writeFileSync(
        join(dir, "docs", "SPEC.md"),
        "# Spec\n\n## Overview\n- Core\n\n## Verify\n- E2E passes\n",
        "utf8",
      );
      approveSpecDoc(db, projectId, dir, undefined, proj);
      beginMockSession(db, projectId, dir, "claude", proj);
      writeFileSync(join(dir, "docs", "mock.html"), "<html><body>Mock</body></html>", "utf8");
      approveMockDoc(
        db,
        projectId,
        dir,
        { artifactUrl: "https://claude.site/artifacts/mock-1", approvedBy: "Carls" },
        proj,
      );
    }

    it("isValidPlanMarkdown validates milestones, Done when items, tags, spec links, and check lines", () => {
      expect(isValidPlanMarkdown(null)).toBe(false);
      expect(isValidPlanMarkdown("# Plan\n")).toBe(false);
      // Kit template is rejected
      expect(
        isValidPlanMarkdown(
          "# Plan — Test\n\n## M1 — First milestone\n\n- [ ] **T1.1 First task** `[claude]` — [[SPEC#Overview]]\n  What to build, in one or two lines.\n  check: `<command that passes when this is done>`\n",
        ),
      ).toBe(false);
      // Missing Done when
      expect(
        isValidPlanMarkdown(
          "# Plan\n\n## M1 — v1.0\n\n- [ ] **T1.1 Task** `[claude]` — [[SPEC#Overview]]\n  check: `pnpm test`\n",
        ),
      ).toBe(false);
      // Valid plan
      expect(isValidPlanMarkdown(samplePlan)).toBe(true);
    });

    it("buildPlanPrompt includes project name, SPEC.md, and approved mock link", () => {
      const prompt = buildPlanPrompt("PlanProj", "# Spec\n## Overview\n- Feature", {
        artifactUrl: "https://claude.site/artifacts/mock-1",
        approvedBy: "Carls",
        approvedAt: "2026-11-23T00:00:00.000Z",
      });
      expect(prompt).toContain("[Plan generation] Project: PlanProj");
      expect(prompt).toContain("Done when:");
      expect(prompt).toContain("https://claude.site/artifacts/mock-1");
    });

    it("keeps plan unapproved during live edits until approvePlanDoc saves docs/PLAN.md", () => {
      setupApprovedMock(rootDir);
      const started = beginPlanSession(db, projectId, rootDir, proj);
      expect(started.prompt).toContain("[Plan generation]");
      expect(started.state.currentStep).toBe("plan");
      expect(started.state.plan.approved).toBe(false);

      // Agent writes docs/PLAN.md live
      writeFileSync(join(rootDir, "docs", "PLAN.md"), samplePlan, "utf8");
      const draftState = getShapingState(db, projectId, rootDir, proj);
      expect(draftState.plan.exists).toBe(true);
      expect(draftState.plan.valid).toBe(true);
      expect(draftState.plan.approved).toBe(false);
      expect(draftState.steps.find((s) => s.id === "plan")?.status).toBe("current");

      // Approving saves docs/PLAN.md and marks plan completed
      const approved = approvePlanDoc(db, projectId, rootDir, undefined, proj);
      expect(approved.ok).toBe(true);
      expect(approved.plan.approved).toBe(true);
      expect(approved.plan.approvedAt).toBeTruthy();
      expect(approved.steps.find((s) => s.id === "plan")?.status).toBe("completed");
      expect(readFileSync(join(rootDir, "docs", "PLAN.md"), "utf8")).toBe(samplePlan);
    });

    it("refuses approvePlanDoc when docs/PLAN.md has duplicate task codes", () => {
      setupApprovedMock(rootDir);
      beginPlanSession(db, projectId, rootDir, proj);

      const dupPlan = [
        "# Plan — PlanProj",
        "",
        "## M1 — v1.0 Core Release",
        "",
        "Done when: ready",
        "",
        "- [ ] **T1.1 Core feature** `[claude]` — [[SPEC#Overview]]",
        "  Build the core feature.",
        "  check: `pnpm test`",
        "- [ ] **T1.1 Duplicate code** `[gemini]` — [[SPEC#Verify]]",
        "  Verify the duplicate.",
        "  check: `pnpm test:e2e`",
        "",
      ].join("\n");

      writeFileSync(join(rootDir, "docs", "PLAN.md"), dupPlan, "utf8");

      expect(() => approvePlanDoc(db, projectId, rootDir, undefined, proj)).toThrow(
        "docs/PLAN.md has task code T1.1 more than once.",
      );
    });

    it("startMilestoneRelease creates daedalus/release-v1.0 from default branch in git and freezes scope", async () => {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git(rootDir, "init", "--initial-branch=main");
      git(rootDir, "config", "user.name", "Test");
      git(rootDir, "config", "user.email", "test@example.com");
      writeFileSync(join(rootDir, "README.md"), "# PlanProj\n", "utf8");
      git(rootDir, "add", ".");
      git(rootDir, "commit", "-m", "initial");

      setupApprovedMock(rootDir);
      beginPlanSession(db, projectId, rootDir, proj);
      writeFileSync(join(rootDir, "docs", "PLAN.md"), samplePlan, "utf8");

      // Cannot start milestone before approving plan
      await expect(startMilestoneRelease(db, projectId, rootDir, { version: "v1.0" }, proj)).rejects.toThrow(
        /Approve docs\/PLAN\.md/i,
      );

      approvePlanDoc(db, projectId, rootDir, undefined, proj);

      // Start milestone creates daedalus/release-v1.0 in git
      const started = await startMilestoneRelease(
        db,
        projectId,
        rootDir,
        { version: "v1.0", defaultBranch: "main" },
        proj,
      );
      expect(started.ok).toBe(true);
      expect(started.milestone.version).toBe("v1.0");
      expect(started.milestone.branch).toBe("daedalus/release-v1.0");
      expect(started.milestone.frozen).toBe(true);
      expect(started.plan.activeMilestone?.branch).toBe("daedalus/release-v1.0");

      const branches = git(rootDir, "branch", "--list", "daedalus/release-v1.0");
      expect(branches).toContain("daedalus/release-v1.0");

      // Starting the same milestone again answers 409
      await expect(
        startMilestoneRelease(db, projectId, rootDir, { version: "v1.0", defaultBranch: "main" }, proj),
      ).rejects.toMatchObject({ status: 409 });

      // Scope is frozen: approvePlanDoc and beginPlanSession are refused with 409
      expect(() => beginPlanSession(db, projectId, rootDir, proj)).toThrow(/frozen/i);
      expect(() => approvePlanDoc(db, projectId, rootDir, { content: samplePlan }, proj)).toThrow(/frozen/i);
    });
  });
});
