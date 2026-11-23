import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readRunLog } from "../src/runlog.js";
import type { ProviderEntry } from "../src/registry.js";
import { SessionManager, type AgentEvent, type AgentSession } from "../src/session.js";
import { PLANTED } from "./fixtures/secrets.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
const claude: ProviderEntry = { id: "claude", kind: "acp", command: process.execPath, args: [tsxCli, fakeAgent], roles: ["coder"], allowedProfiles: ["personal"], version: "1.0.0" };
const project = () => ({ id: 3, name: "Bilyo", localPath: mkdtempSync(join(tmpdir(), "runlog-proj-")), profile: "personal", geminiAllowed: false });

let manager: SessionManager | undefined;
afterEach(async () => {
  await manager?.stopAll();
  delete process.env.RUNLOG_TEST_TOKEN;
});

const turn = (s: AgentSession) => new Promise<void>((r) => { const off = s.onEvent((e: AgentEvent) => { if (e.type === "turn_end") { off(); r(); } }); });
const exited = (s: AgentSession) => new Promise<void>((r) => s.onEvent((e) => e.type === "exit" && r()));
const logFile = (dir: string) => {
  const day = readdirSync(dir)[0]!;
  const file = readdirSync(join(dir, day))[0]!;
  return { day: join(dir, day), file: join(dir, day, file) };
};

describe("run logs", () => {
  it("writes every event as redacted JSONL, private to the owner, and nothing secret-like reaches disk", async () => {
    const runLogDir = join(mkdtempSync(join(tmpdir(), "runlog-")), "runs");
    // A secret with no recognisable shape, known only because the server's env holds it.
    process.env.RUNLOG_TEST_TOKEN = "plain-words-only-the-server-knows";
    manager = new SessionManager({ providers: [claude], checkVersion: async () => "1.0.0", runLogDir });
    const s = await manager.start(project(), "claude");

    const secrets = [PLANTED.github, PLANTED.aws, `https://dale:${PLANTED.urlPass}@gitlab.example.com/x.git`, process.env.RUNLOG_TEST_TOKEN];
    for (const secret of secrets) {
      const done = turn(s);
      await s.prompt(`echo found ${secret} in the repo`);
      await done;
    }
    const gone = exited(s);
    await s.stop();
    await gone;

    const { day, file } = logFile(runLogDir);
    expect(file.endsWith(`${s.id}.jsonl`)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(day).mode & 0o777).toBe(0o700);

    const raw = readFileSync(file, "utf8");
    for (const v of [PLANTED.github, PLANTED.aws, PLANTED.urlPass, "plain-words-only-the-server-knows"]) expect(raw).not.toContain(v);
    expect(raw).toContain("[REDACTED:");

    const lines = readRunLog(runLogDir, s.id);
    expect(lines[0]).toMatchObject({ type: "session", sessionId: s.id, projectId: 3, projectName: "Bilyo", providerId: "claude" });
    const types = lines.map((l) => l.type);
    for (const t of ["prompt", "message", "turn_end", "exit"]) expect(types).toContain(t);
  });

  it("a log folder that can't be written never breaks the session", async () => {
    const parent = mkdtempSync(join(tmpdir(), "runlog-ro-"));
    chmodSync(parent, 0o500);
    try {
      manager = new SessionManager({ providers: [claude], checkVersion: async () => "1.0.0", runLogDir: join(parent, "runs") });
      const s = await manager.start(project(), "claude");
      const done = turn(s);
      await s.prompt("echo still works");
      await done;
      expect(s.backlog().some((e) => e.type === "message")).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("readRunLog returns nothing for an unknown session", () => {
    expect(readRunLog(mkdtempSync(join(tmpdir(), "runlog-none-")), "nope")).toEqual([]);
  });
});
