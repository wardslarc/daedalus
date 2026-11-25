import { describe, expect, it } from "vitest";
import { findSecretsInText, makeRedactor, redact, redactDeep } from "../src/redact.js";
import { PLANTED } from "./fixtures/secrets.js";

describe("redact", () => {
  it.each([
    ["Anthropic key", `key is ${PLANTED.anthropic} ok`],
    ["OpenAI-style key", `OPENAI ${PLANTED.openai}`],
    ["GitHub token", `token ${PLANTED.github}`],
    ["GitHub fine-grained token", PLANTED.githubPat],
    ["GitLab token", `remote uses ${PLANTED.gitlab}`],
    ["Slack token", PLANTED.slack],
    ["AWS access key", `aws ${PLANTED.aws}`],
    ["Google key", PLANTED.google],
    ["npm token", PLANTED.npm],
    ["JWT", `cookie=${PLANTED.jwt}`],
    ["high-entropy string", `blob ${PLANTED.entropy} end`],
  ])("removes a %s", (_, text) => {
    const out = redact(text);
    for (const v of Object.values(PLANTED)) expect(out).not.toContain(v);
    expect(out).toMatch(/\[REDACTED:[a-z-]+\]/);
  });

  it("removes credentials in URLs but keeps the host", () => {
    const out = redact(`git remote: https://dale:${PLANTED.urlPass}@gitlab.example.com/team/app.git`);
    expect(out).not.toContain(PLANTED.urlPass);
    expect(out).toContain("https://[REDACTED:userinfo]@gitlab.example.com/team/app.git");
  });

  it("removes Authorization headers", () => {
    expect(redact("Authorization: Bearer abc.def-ghi_123456")).toBe("Authorization: Bearer [REDACTED:bearer]");
    expect(redact("authorization: Basic ZGFsZTpodW50ZXIy")).toBe("authorization: Basic [REDACTED:basic]");
  });

  it("keeps the name in assignments and JSON, removes the value", () => {
    expect(redact(`DB_PASSWORD=${PLANTED.assigned}`)).toBe("DB_PASSWORD=[REDACTED:assignment]");
    expect(redact(`password: "${PLANTED.assigned}"`)).toBe('password: "[REDACTED:assignment]"');
    expect(redact(`{"api_key": "${PLANTED.assigned}", "name": "Bilyo"}`)).toBe('{"api_key": "[REDACTED:assignment]", "name": "Bilyo"}');
  });

  it("removes PEM private key blocks", () => {
    const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    const out = redact(`key:\n${pem}\ndone`);
    expect(out).toBe("key:\n[REDACTED:private-key]\ndone");
  });

  it("leaves ordinary output alone", () => {
    const normal = [
      "● Reading src/quotes/number.ts",
      "$ npm test -- magic-link  ✓ 6 passed",
      "commit 3a97650c1e4f2b9d8a7e6f5c4b3a2918d7e6f5c4 on main",
      "session 0f8c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      "/home/ctescalo/projects/bilyo/src/components/QuoteEditorPanel.tsx",
      "The token count is 1,234 and the password field is required.",
      "export const nextQuoteNumber = async (businessId: string) => {",
    ].join("\n");
    expect(redact(normal)).toBe(normal);
  });
});

describe("redactDeep", () => {
  it("reaches every string in nested objects and arrays", () => {
    const out = redactDeep({ type: "message", text: `see ${PLANTED.github}`, meta: { list: ["fine", PLANTED.aws] }, seq: 4 });
    expect(JSON.stringify(out)).not.toContain(PLANTED.github);
    expect(JSON.stringify(out)).not.toContain(PLANTED.aws);
    expect(out).toMatchObject({ type: "message", seq: 4, meta: { list: ["fine", expect.stringContaining("[REDACTED:")] } });
  });
});

describe("makeRedactor", () => {
  it("also removes the exact values of secret-named variables in the environment", () => {
    const shapeless = "plain-words-but-secret";
    const r = makeRedactor({ HOME: "/home/me", MY_SERVICE_TOKEN: shapeless, SHORT_KEY: "abc", PATH: "/usr/bin" });
    expect(r(`agent printed ${shapeless} and /home/me`)).toBe("agent printed [REDACTED:env] and /home/me");
    expect(r("abc stays: too short to be sure")).toBe("abc stays: too short to be sure");
  });
});

describe("findSecretsInText", () => {
  it("reports userinfo rule's credential (the user:pass part) as a hit", () => {
    const text = 'url = "https://bob:s3cr3tT0ken9x@example.com/repo.git"';
    const matches = findSecretsInText(text);
    const userinfoMatch = matches.find((m) => m.ruleId === "userinfo");
    expect(userinfoMatch).toBeDefined();
    expect(userinfoMatch?.value).toBe("bob:s3cr3tT0ken9x");
  });
});
