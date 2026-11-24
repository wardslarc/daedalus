import { describe, expect, it } from "vitest";
import {
  PROFILES,
  ProfileRuleError,
  assertProviderAllowed,
  assertSkipPermissionsAllowed,
  cloneRoot,
  effectiveGeminiAllowed,
  gitHostWarning,
  profileRulesMarkdown,
  providerFamily,
  rulesFor,
  shipChecklist,
  validateProjectSettings,
  type ProjectLike,
} from "../src/profiles.js";

const project = (profile: string, geminiAllowed = false): ProjectLike => ({ name: "p", profile, geminiAllowed });

describe("providerFamily", () => {
  it("maps provider names to a family", () => {
    expect(providerFamily("claude")).toBe("claude");
    expect(providerFamily("Claude Code")).toBe("claude");
    expect(providerFamily("antigravity")).toBe("gemini");
    expect(providerFamily("agy")).toBe("gemini");
    expect(providerFamily("gemini-3.8-flash-medium")).toBe("gemini");
  });

  it("refuses unknown providers instead of guessing", () => {
    expect(() => providerFamily("gpt-oss")).toThrow(ProfileRuleError);
  });
});

describe("rules table (SPEC#Profiles)", () => {
  it("has exactly the three profiles", () => {
    expect([...PROFILES]).toEqual(["work", "client", "personal"]);
  });

  it("matches the spec for each profile", () => {
    expect(rulesFor("work")).toMatchObject({
      gitHost: "gitlab",
      gemini: "never",
      skipPermissions: false,
      learningMode: false,
      deploy: "kollab-handoff",
    });
    expect(rulesFor("client")).toMatchObject({ gitHost: "github", gemini: "opt-in", skipPermissions: true, changeRequestLog: true });
    expect(rulesFor("personal")).toMatchObject({ gitHost: "github", gemini: "allowed", skipPermissions: true, learningMode: true });
  });

  it("refuses an unknown profile", () => {
    expect(() => rulesFor("hobby")).toThrow(ProfileRuleError);
  });
});

describe("assertProviderAllowed", () => {
  it("a Work project can't be given to Gemini through the API", () => {
    expect(() => assertProviderAllowed(project("work"), "antigravity")).toThrow(ProfileRuleError);
  });

  it("refuses Gemini on Work even if the stored flag says allowed (e.g. a hand-edited DB row)", () => {
    expect(() => assertProviderAllowed(project("work", true), "antigravity")).toThrow(/Work/);
    expect(effectiveGeminiAllowed(project("work", true))).toBe(false);
  });

  it("allows Claude on every profile", () => {
    for (const p of PROFILES) expect(() => assertProviderAllowed(project(p), "claude")).not.toThrow();
  });

  it("Client uses Gemini only when the project opted in", () => {
    expect(() => assertProviderAllowed(project("client", false), "agy")).toThrow(ProfileRuleError);
    expect(() => assertProviderAllowed(project("client", true), "agy")).not.toThrow();
  });

  it("Personal allows Gemini whatever the flag", () => {
    expect(() => assertProviderAllowed(project("personal", false), "antigravity")).not.toThrow();
  });

  it("fails closed on an unknown profile", () => {
    expect(() => assertProviderAllowed(project("mystery", true), "claude")).toThrow(ProfileRuleError);
  });
});

describe("assertSkipPermissionsAllowed", () => {
  it("forbids skip-permissions mode on Work only", () => {
    expect(() => assertSkipPermissionsAllowed(project("work"))).toThrow(/skip-permissions/);
    expect(() => assertSkipPermissionsAllowed(project("client"))).not.toThrow();
    expect(() => assertSkipPermissionsAllowed(project("personal"))).not.toThrow();
  });
});

describe("validateProjectSettings", () => {
  it("rejects turning Gemini on for Work, rather than silently changing it", () => {
    expect(() => validateProjectSettings("work", { geminiAllowed: true })).toThrow(ProfileRuleError);
  });

  it("normalizes valid settings", () => {
    expect(validateProjectSettings("work", {})).toEqual({ profile: "work", geminiAllowed: false });
    expect(validateProjectSettings("client", { geminiAllowed: true })).toEqual({ profile: "client", geminiAllowed: true });
    expect(validateProjectSettings("client", {})).toEqual({ profile: "client", geminiAllowed: false });
    expect(validateProjectSettings("personal", {})).toEqual({ profile: "personal", geminiAllowed: true });
  });

  it("rejects an unknown profile or a non-boolean flag", () => {
    expect(() => validateProjectSettings("hobby", {})).toThrow(ProfileRuleError);
    expect(() => validateProjectSettings("client", { geminiAllowed: "yes" as unknown as boolean })).toThrow(ProfileRuleError);
  });
});

describe("cloneRoot", () => {
  it("puts Work in ~/work and the rest in ~/projects", () => {
    expect(cloneRoot("work", "/home/me")).toBe("/home/me/work");
    expect(cloneRoot("client", "/home/me")).toBe("/home/me/projects");
    expect(cloneRoot("personal", "/home/me")).toBe("/home/me/projects");
  });
});

describe("gitHostWarning", () => {
  it("warns (not errors) when the remote's host doesn't match the profile", () => {
    expect(gitHostWarning("work", "git@gitlab.com:team/app.git")).toBeNull();
    expect(gitHostWarning("work", "https://github.com/me/app.git")).toMatch(/GitLab/);
    expect(gitHostWarning("personal", "https://github.com/me/app")).toBeNull();
    expect(gitHostWarning("client", "https://gitlab.example.com/x/y.git")).toMatch(/GitHub/);
    expect(gitHostWarning("personal", undefined)).toBeNull();
  });
});

describe("profileRulesMarkdown", () => {
  it("states each profile's limits for the kit's AGENTS.md", () => {
    const work = profileRulesMarkdown("work");
    expect(work).toMatch(/^- /);
    expect(work).toMatch(/Gemini.*not allowed/i);
    expect(work).toMatch(/skip-permissions/i);
    expect(profileRulesMarkdown("personal")).toMatch(/learning mode/i);
    expect(profileRulesMarkdown("client")).toMatch(/change-request log/i);
  });
});

describe("shipChecklist (SPEC#Profiles, SPEC#Release gate)", () => {
  it("lists Kollab handoff items for work profile", () => {
    expect(shipChecklist("work")).toEqual([
      { id: "mr-opened", label: "GitLab merge request opened" },
      { id: "kollab-form", label: "Kollab handoff form filled" },
      { id: "release-notes", label: "Release notes attached to the handoff" },
      { id: "deploy-owner", label: "Deploy owner named in the handoff" },
    ]);
  });

  it("lists release notes and changelog review for client profile", () => {
    expect(shipChecklist("client")).toEqual([
      { id: "release-notes", label: "Release notes written" },
      { id: "changelog-reviewed", label: "Changes since the last release reviewed" },
    ]);
  });

  it("lists release notes and changelog review for personal profile", () => {
    expect(shipChecklist("personal")).toEqual([
      { id: "release-notes", label: "Release notes written" },
      { id: "changelog-reviewed", label: "Changes since the last release reviewed" },
    ]);
  });

  it("refuses an unknown profile", () => {
    expect(() => shipChecklist("unknown")).toThrow(ProfileRuleError);
  });
});

