import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, providers as providersTable } from "@daedalus/db";
import { describe, expect, it } from "vitest";
import { loadProviders, parseProviders, ProviderConfigError, repoProvidersFile, syncProviders, type ProviderEntry } from "../src/registry.js";

const claude = {
  id: "claude",
  kind: "acp",
  command: "npx",
  args: ["-y", "@agentclientprotocol/claude-agent-acp@0.109.0"],
  roles: ["lead", "coder", "reviewer", "reader"],
  allowedProfiles: ["work", "client", "personal"],
  version: "0.109.0",
};
const agy = {
  id: "antigravity",
  kind: "acp",
  command: "agy",
  args: ["acp", "--sandbox"],
  roles: ["coder", "reviewer", "reader"],
  allowedProfiles: ["client", "personal"],
  version: "1.5.8",
};
const file = (entries: unknown[]) => ({ providers: entries });
const bad = (patch: Record<string, unknown>, base: Record<string, unknown> = claude) => () => parseProviders(file([{ ...base, ...patch }]));

describe("parseProviders", () => {
  it("accepts a valid file", () => {
    const list = parseProviders(file([claude, agy]));
    expect(list.map((p) => p.id)).toEqual(["claude", "antigravity"]);
    expect(list[1]).toMatchObject({ kind: "acp", command: "agy", args: ["acp", "--sandbox"] });
  });

  it("rejects bad shapes, naming the entry and field", () => {
    expect(() => parseProviders({})).toThrow(ProviderConfigError);
    expect(() => parseProviders(file([{ ...claude, extra: 1 }]))).toThrow(/claude.*extra/);
    expect(() => parseProviders(file([claude, claude]))).toThrow(/duplicate/i);
    expect(bad({ id: "Claude Code" })).toThrow(/id/);
    expect(bad({ kind: "http" })).toThrow(/kind/);
    expect(bad({ roles: [] })).toThrow(/roles/);
    expect(bad({ roles: ["boss"] })).toThrow(/boss/);
    expect(bad({ allowedProfiles: ["hobby"] })).toThrow(/hobby/);
  });

  it("only accepts plain launch commands, never something a shell would interpret", () => {
    expect(bad({ command: "sh -c" })).toThrow(/command/);
    expect(bad({ command: "../bin/agent" })).toThrow(/command/);
    expect(bad({ command: "agent;rm" })).toThrow(/command/);
    expect(bad({ command: "" })).toThrow(/command/);
    expect(() => parseProviders(file([{ ...agy, command: "/usr/local/bin/agy" }]))).not.toThrow();
    expect(bad({ args: ["ok", "two\nlines"] })).toThrow(/args/);
    expect(bad({ args: ["nul\u0000byte"] })).toThrow(/args/);
    expect(bad({ args: "acp --sandbox" })).toThrow(/args/);
  });

  it("requires an exact pinned version, and npx must run that same version", () => {
    for (const v of ["^0.109.0", "~0.109.0", "latest", "0.109.x", "*", "0.109", ""]) {
      expect(bad({ version: v }), v).toThrow(/version/);
    }
    expect(bad({ args: ["-y", "@agentclientprotocol/claude-agent-acp@0.110.0"] })).toThrow(/0\.110\.0/);
    expect(bad({ args: ["-y", "@agentclientprotocol/claude-agent-acp"] })).toThrow(/pin/i);
  });

  it("can't allow a Gemini provider on Work (agrees with the profile rules)", () => {
    expect(bad({ allowedProfiles: ["work", "personal"] }, agy)).toThrow(/Work/);
  });

  it("refuses providers whose model family the profile rules don't know", () => {
    expect(bad({ id: "gpt-agent" })).toThrow(/family/i);
  });
});

describe("the repo's providers.json", () => {
  it("is valid", () => {
    const list = loadProviders(repoProvidersFile());
    expect(list.map((p) => p.id).sort()).toEqual(["antigravity", "claude"]);
  });

  it("fails closed on a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    writeFileSync(join(dir, "p.json"), "{ not json");
    expect(() => loadProviders(join(dir, "p.json"))).toThrow(ProviderConfigError);
    expect(() => loadProviders(join(dir, "missing.json"))).toThrow(ProviderConfigError);
  });
});

describe("syncProviders", () => {
  it("inserts, updates, disables missing rows (never deletes) and is idempotent", () => {
    const db = openDb(":memory:");
    const both = parseProviders(file([claude, agy])) as ProviderEntry[];
    syncProviders(db, both);
    syncProviders(db, both);
    let rows = db.select().from(providersTable).all();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows.find((r) => r.name === "antigravity")!.launchCommand)).toEqual(["agy", "acp", "--sandbox"]);

    syncProviders(db, parseProviders(file([{ ...claude, roles: ["reader"] }])));
    rows = db.select().from(providersTable).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === "claude")).toMatchObject({ roles: ["reader"], enabled: true });
    expect(rows.find((r) => r.name === "antigravity")?.enabled).toBe(false);
  });
});
