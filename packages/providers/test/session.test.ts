import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileRuleError } from "@daedalus/core/profiles";
import type { ProviderEntry } from "../src/registry.js";
import { scrubEnv, SessionError, SessionManager, type AgentEvent, type AgentSession, type SessionProject } from "../src/session.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));

/** Registry entries that launch the fake agent under the real provider ids. */
const fake = (id: "claude" | "antigravity", allowedProfiles: ProviderEntry["allowedProfiles"] = ["work", "client", "personal"]): ProviderEntry => ({
  id,
  kind: "acp",
  command: process.execPath,
  args: [tsxCli, fakeAgent],
  roles: ["coder"],
  allowedProfiles: id === "antigravity" ? allowedProfiles.filter((p) => p !== "work") : allowedProfiles,
  version: "1.0.0",
});

const project = (profile = "personal", over: Partial<SessionProject> = {}): SessionProject => ({
  id: 1,
  name: "P",
  localPath: mkdtempSync(join(tmpdir(), "sess-proj-")),
  profile,
  geminiAllowed: false,
  ...over,
});

let manager: SessionManager;
afterEach(async () => {
  await manager?.stopAll();
});

function make(opts: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  manager = new SessionManager({ providers: [fake("claude"), fake("antigravity")], checkVersion: async () => "1.0.0", ...opts });
  return manager;
}

/** Collect events until `until` matches one. */
function waitFor(s: AgentSession, until: (e: AgentEvent) => boolean, timeoutMs = 15000): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen.map((e) => e.type))}`)), timeoutMs);
    const off = s.onEvent((e) => {
      seen.push(e);
      if (until(e)) {
        clearTimeout(timer);
        off();
        resolve(seen);
      }
    });
  });
}
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "message" ? [e.text] : [])).join("");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("SessionManager.start refusals (nothing is started)", () => {
  it("Work + antigravity is refused by the profile rules", async () => {
    await expect(make().start(project("work"), "antigravity")).rejects.toThrow(ProfileRuleError);
    expect(manager.list()).toHaveLength(0);
  });

  it("Client + antigravity needs the project's opt-in", async () => {
    await expect(make().start(project("client"), "antigravity")).rejects.toThrow(ProfileRuleError);
    const s = await manager.start(project("client", { geminiAllowed: true }), "antigravity");
    expect(s.providerId).toBe("antigravity");
  });

  it("unknown provider, provider not allowed for the profile, missing folder", async () => {
    await expect(make().start(project(), "gpt")).rejects.toMatchObject({ status: 404 });
    manager = new SessionManager({ providers: [fake("claude", ["personal"])], checkVersion: async () => "1.0.0" });
    await expect(manager.start(project("client"), "claude")).rejects.toMatchObject({ status: 403 });
    await expect(manager.start(project("personal", { localPath: "/definitely/missing" }), "claude")).rejects.toMatchObject({ status: 404 });
  });

  it("at most two sessions at once", async () => {
    make();
    await manager.start(project(), "claude");
    await manager.start(project(), "claude");
    await expect(manager.start(project(), "claude")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a provider whose installed version isn't the pinned one", async () => {
    make({ checkVersion: async () => "1.6.0" });
    await expect(manager.start(project(), "antigravity")).rejects.toThrow(/1\.6\.0.*1\.0\.0|1\.0\.0.*1\.6\.0/);
  });
});

describe("SessionManager.onChange", () => {
  it("fires when a session starts and when it ends", async () => {
    make();
    let calls = 0;
    const off = manager.onChange(() => calls++);
    const s = await manager.start(project(), "claude");
    expect(calls).toBe(1);
    await s.stop();
    expect(calls).toBe(2);
    off();
    await (await manager.start(project(), "claude")).stop();
    expect(calls).toBe(2);
  });
});

describe("AgentSession", () => {
  it("streams the reply and ends the turn", async () => {
    const s = await make().start(project(), "claude");
    const done = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("echo hello from the fake agent");
    const events = await done;
    expect(text(events)).toBe("hello from the fake agent");
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
  });

  it("runs the agent in the project folder", async () => {
    const p = project();
    const s = await make().start(p, "claude");
    const done = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("cwd");
    expect(text(await done)).toBe(execFileSync("realpath", [p.localPath], { encoding: "utf8" }).trim());
  });

  it("refuses a second prompt while one is running", async () => {
    const s = await make().start(project(), "claude");
    void s.prompt("sleep 1000");
    await expect(s.prompt("echo again")).rejects.toMatchObject({ status: 409 });
  });

  it("passes permission requests to the owner: Allow and Deny reach the agent", async () => {
    const s = await make().start(project(), "claude");
    for (const [choice, expected] of [["allow_once", "allowed"], ["reject_once", "denied"]] as const) {
      const asked = waitFor(s, (e) => e.type === "permission");
      const done = waitFor(s, (e) => e.type === "turn_end");
      void s.prompt("permission");
      const req = (await asked).at(-1) as Extract<AgentEvent, { type: "permission" }>;
      expect(req.title).toBe("Write a file");
      s.respondPermission(req.requestId, req.options.find((o) => o.kind === choice)!.optionId);
      expect(text(await done)).toBe(expected);
    }
  });

  it("never waits forever: an unanswered permission is cancelled after the timeout", async () => {
    const s = await make({ permissionTimeoutMs: 300 }).start(project(), "claude");
    const done = waitFor(s, (e) => e.type === "turn_end");
    void s.prompt("permission");
    expect(text(await done)).toBe("cancelled");
  });

  it("scrubs Daedalus settings and secret-looking variables from the agent's environment", async () => {
    process.env.DAE_PASSWORD_TEST = "x";
    process.env.SOME_API_KEY = "x";
    process.env.GITHUB_TOKEN = "x";
    try {
      const s = await make().start(project(), "claude");
      for (const [name, expected] of [["DAE_PASSWORD_TEST", "(unset)"], ["SOME_API_KEY", "(unset)"], ["GITHUB_TOKEN", "(unset)"], ["HOME", process.env.HOME]] as const) {
        const done = waitFor(s, (e) => e.type === "turn_end");
        await s.prompt(`env ${name}`);
        expect(text(await done), name).toBe(expected);
      }
    } finally {
      delete process.env.DAE_PASSWORD_TEST;
      delete process.env.SOME_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("stop() kills the agent and its children, even one that ignores SIGTERM, and cancels pending permissions", async () => {
    const s = await make().start(project(), "claude");
    const spawned = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("stubborn-child");
    const childPid = Number(text(await spawned));
    expect(alive(childPid)).toBe(true);
    const asked = waitFor(s, (e) => e.type === "permission");
    void s.prompt("permission");
    await asked;
    await s.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(childPid)).toBe(false);
    expect(manager.list()).toHaveLength(0);
  });

  it("an agent that exits on its own ends the session and frees its slot", async () => {
    const s = await make().start(project(), "claude");
    const exited = waitFor(s, (e) => e.type === "exit");
    void s.prompt("exit").catch(() => undefined);
    expect((await exited).at(-1)).toMatchObject({ type: "exit", code: 3 });
    expect(manager.list()).toHaveLength(0);
  });

  it("keeps a bounded backlog for reconnecting viewers", async () => {
    const s = await make({ backlogLimit: 50 }).start(project(), "claude");
    const done = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("flood 200");
    await done;
    expect(s.backlog().length).toBe(50);
    expect(s.backlog().at(-1)?.type).toBe("turn_end");
  });

  it("refuses to talk to a session that was stopped", async () => {
    const s = await make().start(project(), "claude");
    await s.stop();
    await expect(s.prompt("echo hi")).rejects.toBeInstanceOf(SessionError);
  });
});

describe("PermissionPolicy: read-only", () => {
  it("read-only policy: answers edit with reject, no kind with reject", async () => {
    const s = await make().start(project(), "claude", { permissionPolicy: "read-only" });
    expect(s.policy).toBe("read-only");
    expect(s.permissionPolicy).toBe("read-only");

    // edit request -> denied (reject_once)
    const doneEdit = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("permission-kind edit");
    expect(text(await doneEdit)).toBe("denied");

    // no kind -> denied (reject_once)
    const doneNone = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("permission-kind none");
    expect(text(await doneNone)).toBe("denied");
  });

  it("read-only policy: read inside allowed, read ../outside and symlink pointing outside rejected, read with no locations rejected, think rejected", async () => {
    const p = project();
    const insideFile = join(p.localPath, "inside.txt");
    writeFileSync(insideFile, "inside content\n");

    const outsideDir = mkdtempSync(join(tmpdir(), "outside-dir-"));
    const outsideFile = join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside content\n");

    const symlinkFile = join(p.localPath, "symlink-outside");
    symlinkSync(outsideFile, symlinkFile);

    try {
      const s = await make().start(p, "claude", { permissionPolicy: "read-only" });

      // read inside -> allowed
      const doneInside = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt(`permission-kind read ${insideFile}`);
      expect(text(await doneInside)).toBe("allowed");

      // read of ../outside -> rejected (denied)
      const doneOutside = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt("permission-kind read ../outside");
      expect(text(await doneOutside)).toBe("denied");

      // read of symlink pointing outside -> rejected (denied)
      const doneSymlink = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt(`permission-kind read ${symlinkFile}`);
      expect(text(await doneSymlink)).toBe("denied");

      // read with no locations -> rejected (denied)
      const doneNoLoc = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt("permission-kind read");
      expect(text(await doneNoLoc)).toBe("denied");

      // think with no locations -> rejected (denied)
      const doneThink = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt("permission-kind think");
      expect(text(await doneThink)).toBe("denied");

      // think with locations inside -> rejected (denied)
      const doneThinkLoc = waitFor(s, (e) => e.type === "turn_end");
      await s.prompt(`permission-kind think ${insideFile}`);
      expect(text(await doneThinkLoc)).toBe("denied");
    } finally {
      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(p.localPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("owner is never asked in read-only and respondPermission throws 409", async () => {
    const s = await make().start(project(), "claude", { permissionPolicy: "read-only" });
    const events: AgentEvent[] = [];
    s.onEvent((e) => events.push(e));

    const done = waitFor(s, (e) => e.type === "turn_end");
    await s.prompt("permission-kind edit");
    await done;

    // Both permission and permission_resolved events emitted
    expect(events.some((e) => e.type === "permission")).toBe(true);
    expect(events.some((e) => e.type === "permission_resolved")).toBe(true);

    // respondPermission throws 409
    expect(() => s.respondPermission("perm-1", "allow")).toThrow(SessionError);
    try {
      s.respondPermission("perm-1", "allow");
    } catch (err) {
      expect((err as SessionError).status).toBe(409);
    }
  });

  it("ask-owner policy is default and unchanged", async () => {
    const s = await make().start(project(), "claude");
    expect(s.policy).toBe("ask-owner");
    expect(s.permissionPolicy).toBe("ask-owner");

    const asked = waitFor(s, (e) => e.type === "permission");
    const done = waitFor(s, (e) => e.type === "turn_end");
    void s.prompt("permission");
    const req = (await asked).at(-1) as Extract<AgentEvent, { type: "permission" }>;
    s.respondPermission(req.requestId, req.options.find((o) => o.kind === "allow_once")!.optionId);
    expect(text(await done)).toBe("allowed");
  });
});

describe.skipIf(process.env.DAE_REAL_AGENTS !== "1")("real Claude (DAE_REAL_AGENTS=1, costs usage)", () => {
  it("answers one prompt", async () => {
    const { loadProviders, repoProvidersFile } = await import("../src/registry.js");
    manager = new SessionManager({ providers: loadProviders(repoProvidersFile()) });
    const s = await manager.start(project(), "claude");
    const done = waitFor(s, (e) => e.type === "turn_end", 120000);
    await s.prompt("Reply with exactly the word: pong. Do not use any tools.");
    expect(text(await done).toLowerCase()).toContain("pong");
  }, 150000);
});

describe("scrubEnv", () => {
  it("drops Daedalus settings, secret-named variables, auth sockets and URLs with credentials", () => {
    const out = scrubEnv({
      HOME: "/home/me",
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      DAE_PORT: "3000",
      GITHUB_TOKEN: "t",
      GH_PAT: "p",
      OPENAI_API_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      DB_PASSWORD: "p",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      NPM_AUTH: "a",
      BROWSER_COOKIE: "c",
      DATABASE_URL: "postgres://admin:hunter2@db.local/app",
      PROXY: "http://user:pw@proxy:8080",
      PUBLIC_URL: "https://example.com/app",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "LANG", "PATH", "PUBLIC_URL"]);
  });
});
