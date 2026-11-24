/**
 * Profile rules (SPEC#Profiles). One pure module; the server calls these guards before it
 * starts an agent or saves settings, so the UI is never the only line of defence. ADR 0008.
 */
import { join } from "node:path";

export const PROFILES = ["work", "client", "personal"] as const;
export type Profile = (typeof PROFILES)[number];

export type ProfileRules = {
  label: string;
  gitHost: "gitlab" | "github";
  /** never: company policy, no override · opt-in: per project · allowed: always */
  gemini: "never" | "opt-in" | "allowed";
  skipPermissions: boolean;
  learningMode: boolean;
  changeRequestLog: boolean;
  deploy: "kollab-handoff" | null;
  cloneDir: "work" | "projects";
};

const RULES: Record<Profile, ProfileRules> = {
  work: {
    label: "Work",
    gitHost: "gitlab",
    gemini: "never",
    skipPermissions: false,
    learningMode: false,
    changeRequestLog: false,
    deploy: "kollab-handoff",
    cloneDir: "work",
  },
  client: {
    label: "Client",
    gitHost: "github",
    gemini: "opt-in",
    skipPermissions: true,
    learningMode: false,
    changeRequestLog: true,
    deploy: null,
    cloneDir: "projects",
  },
  personal: {
    label: "Personal",
    gitHost: "github",
    gemini: "allowed",
    skipPermissions: true,
    learningMode: true,
    changeRequestLog: false,
    deploy: null,
    cloneDir: "projects",
  },
};

/** A broken profile rule. The server maps it to 403 with `message` shown to the owner. */
export class ProfileRuleError extends Error {
  override name = "ProfileRuleError";
}

/** The fields of a project row these rules look at. */
export type ProjectLike = { name: string; profile: string; geminiAllowed: boolean };

function isProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

/** Rules for a profile. Unknown profiles fail closed. */
export function rulesFor(profile: string): ProfileRules {
  if (!isProfile(profile)) throw new ProfileRuleError(`Unknown profile "${profile}"`);
  return RULES[profile];
}

export type ProviderFamily = "claude" | "gemini";

/** Which model family a provider belongs to. Unknown providers are refused, not guessed. */
export function providerFamily(providerName: string): ProviderFamily {
  const n = providerName.trim().toLowerCase();
  if (n.startsWith("claude")) return "claude";
  if (n === "antigravity" || n === "agy" || n.startsWith("gemini")) return "gemini";
  throw new ProfileRuleError(`Unknown provider "${providerName}"`);
}

/** Whether Gemini may work on this project. The stored flag only matters for Client. */
export function effectiveGeminiAllowed(project: ProjectLike): boolean {
  switch (rulesFor(project.profile).gemini) {
    case "never":
      return false;
    case "allowed":
      return true;
    case "opt-in":
      return project.geminiAllowed === true;
  }
}

/** Call before starting any agent on a project. */
export function assertProviderAllowed(project: ProjectLike, providerName: string): void {
  const rules = rulesFor(project.profile);
  if (providerFamily(providerName) !== "gemini") return;
  if (effectiveGeminiAllowed(project)) return;
  throw new ProfileRuleError(
    rules.gemini === "never"
      ? `${rules.label} projects can't use Gemini (company policy). "${project.name}" stays with Claude.`
      : `Gemini isn't turned on for "${project.name}". Allow it in the project's settings first.`,
  );
}

/** Call before starting an agent with permission prompts turned off. */
export function assertSkipPermissionsAllowed(project: ProjectLike): void {
  const rules = rulesFor(project.profile);
  if (!rules.skipPermissions) {
    throw new ProfileRuleError(`${rules.label} projects can't run agents in skip-permissions mode.`);
  }
}

export type ProjectSettings = { profile: Profile; geminiAllowed: boolean };

/**
 * Validate settings sent by the UI or API. Asking for something the profile forbids is an
 * error, never silently changed, so the owner sees why.
 */
export function validateProjectSettings(profile: string, requested: { geminiAllowed?: unknown }): ProjectSettings {
  const rules = rulesFor(profile);
  const asked = requested.geminiAllowed;
  if (asked !== undefined && typeof asked !== "boolean") {
    throw new ProfileRuleError("geminiAllowed must be true or false");
  }
  if (rules.gemini === "never" && asked === true) {
    throw new ProfileRuleError(`${rules.label} projects can't allow Gemini (company policy).`);
  }
  const geminiAllowed = rules.gemini === "allowed" ? true : rules.gemini === "never" ? false : asked === true;
  return { profile: profile as Profile, geminiAllowed };
}

/** Folder that URL imports clone into: ~/work for Work, ~/projects otherwise. */
export function cloneRoot(profile: string, home: string): string {
  return join(home, rulesFor(profile).cloneDir);
}

function hostOf(remoteUrl: string): "github" | "gitlab" | null {
  const u = remoteUrl.toLowerCase();
  if (/(^|[@/.])github\.com[:/]/.test(u)) return "github";
  if (/gitlab/.test(u)) return "gitlab";
  return null;
}

/** A warning when the remote's host doesn't match the profile; null when fine or unknown. */
export function gitHostWarning(profile: string, remoteUrl: string | undefined): string | null {
  const rules = rulesFor(profile);
  if (!remoteUrl) return null;
  const host = hostOf(remoteUrl);
  if (host === null || host === rules.gitHost) return null;
  const want = rules.gitHost === "gitlab" ? "GitLab" : "GitHub";
  return `${rules.label} projects normally live on ${want}; this remote isn't on ${want}.`;
}

/** The profile's limits as a markdown list, for the kit's AGENTS.md ({{PROFILE_RULES}}). */
export function profileRulesMarkdown(profile: string): string {
  const r = rulesFor(profile);
  const lines = [
    `- Git host: ${r.gitHost === "gitlab" ? "GitLab" : "GitHub"}.`,
    r.gemini === "never"
      ? "- Gemini is not allowed on this project (company policy). Claude only."
      : r.gemini === "opt-in"
        ? "- Gemini is not allowed unless the owner turns it on for this project."
        : "- Claude and Gemini are both allowed.",
    r.skipPermissions
      ? "- Agents may run in skip-permissions mode when the owner chooses."
      : "- Never run agents in skip-permissions mode.",
  ];
  if (r.learningMode) lines.push("- Learning mode is on: `[you]` tasks are written by the owner; agents may only add tests and types for them.");
  if (r.changeRequestLog) lines.push("- Keep a change-request log: record every client request and its decision in docs/.");
  if (r.deploy === "kollab-handoff") lines.push("- Deploys are not done from here: finish with the deploy handoff checklist.");
  return lines.join("\n");
}

export type ShipChecklistItem = {
  id: string;
  label: string;
};

/**
 * Ship checklist items for a profile (T6.3, SPEC#Profiles, SPEC#Release gate, ADR 0020).
 * Work gets the Kollab handoff list; Client and Personal get release notes and changelog review.
 */
export function shipChecklist(profile: string): ShipChecklistItem[] {
  const p = profile.trim().toLowerCase();
  if (p === "work") {
    return [
      { id: "mr-opened", label: "GitLab merge request opened" },
      { id: "kollab-form", label: "Kollab handoff form filled" },
      { id: "release-notes", label: "Release notes attached to the handoff" },
      { id: "deploy-owner", label: "Deploy owner named in the handoff" },
    ];
  }
  if (p === "client" || p === "personal") {
    return [
      { id: "release-notes", label: "Release notes written" },
      { id: "changelog-reviewed", label: "Changes since the last release reviewed" },
    ];
  }
  throw new ProfileRuleError(`Unknown profile "${profile}"`);
}

