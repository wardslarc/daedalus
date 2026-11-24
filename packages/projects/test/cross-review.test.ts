import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  openDb,
  projects,
  providers,
  reviews,
  runs,
  tasks,
  type DaedalusDb,
} from "@daedalus/db";
import { SessionManager, syncProviders, type AgentSession, type ProviderEntry } from "@daedalus/providers";
import {
  extractWorktreeNameFromGitFile,
  hashGitCommonDir,
  parseFindings,
  parseTriage,
  recoverReviewsOnStartup,
  startCrossReview,
  type StartCrossReviewResult,
} from "../src/cross-review.js";
import { getReview } from "../src/review.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const fakeAgent = fileURLToPath(new URL("../../providers/test/fixtures/fake-agent.ts", import.meta.url));

const fake = (id: "claude" | "antigravity", allowedProfiles: ProviderEntry["allowedProfiles"] = ["work", "client", "personal"]): ProviderEntry => ({
  id,
  kind: "acp",
  command: process.execPath,
  args: [tsxCli, fakeAgent],
  roles: ["coder"],
  allowedProfiles: id === "antigravity" ? allowedProfiles.filter((p) => p !== "work") : allowedProfiles,
  version: "1.0.0",
});

describe("Cross-review (T6.2, SPEC#Review, ADR 0019)", () => {
  let testDir: string;
  let dataDir: string;
  let repoDir: string;
  let db: DaedalusDb;
  let manager: SessionManager;
  let testProviders: ProviderEntry[];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "daedalus-cross-review-test-"));
    dataDir = join(testDir, "data");
    mkdirSync(dataDir, { recursive: true });
    db = openDb(join(dataDir, "test.db"));

    repoDir = join(testDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.name", "Test User");
    git(repoDir, "config", "user.email", "test@example.com");

    writeFileSync(join(repoDir, "README.md"), "# Cross Review Repo\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit on main");
    git(repoDir, "branch", "daedalus/release-v1.0");

    testProviders = [fake("claude"), fake("antigravity")];
    syncProviders(db, testProviders);
    manager = new SessionManager({
      providers: testProviders,
      checkVersion: async () => "1.0.0",
    });
  });

  afterEach(async () => {
    try {
      await manager?.stopAll();
    } catch {
      // ignore
    }
    try {
      db.$client.close();
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("Parser (parseFindings and parseTriage)", () => {
    it("parses valid findings and takes the LAST json block", () => {
      const text = `Some commentary first
\`\`\`json
{"findings":[{"severity":"low","file":"old.ts","line":1,"claim":"old","proof":"old"}]}
\`\`\`
And then final response:
\`\`\`json
{
  "findings": [
    {
      "severity": "high",
      "file": "src/auth.ts",
      "line": 42,
      "claim": "Missing authorization check on admin endpoint",
      "proof": "No user role validation before running admin action.",
      "ignoredExtraField": "drop me"
    }
  ]
}
\`\`\``;

      const findings = parseFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        severity: "high",
        file: "src/auth.ts",
        line: 42,
        claim: "Missing authorization check on admin endpoint",
        proof: "No user role validation before running admin action.",
      });
      expect((findings[0] as unknown as Record<string, unknown>).ignoredExtraField).toBeUndefined();
    });

    it("redacts secrets inside claim and proof", () => {
      const secret = "sk-ant-api03-plantedsecretkey1234567890abcdef";
      const text = `\`\`\`json
{
  "findings": [
    {
      "severity": "high",
      "file": "src/api.ts",
      "line": 1,
      "claim": "Found token ${secret} in configuration",
      "proof": "Token value was ${secret}"
    }
  ]
}
\`\`\``;

      const findings = parseFindings(text);
      expect(findings[0]?.claim).toContain("[REDACTED:anthropic]");
      expect(findings[0]?.claim).not.toContain(secret);
      expect(findings[0]?.proof).toContain("[REDACTED:anthropic]");
      expect(findings[0]?.proof).not.toContain(secret);
    });

    it("rejects path traversal (../x, /etc/passwd)", () => {
      const makeBlock = (file: string) =>
        `\`\`\`json\n${JSON.stringify({ findings: [{ severity: "low", file, line: 1, claim: "c", proof: "p" }] })}\n\`\`\``;

      expect(() => parseFindings(makeBlock("../x"))).toThrow();
      expect(() => parseFindings(makeBlock("/etc/passwd"))).toThrow();
      expect(() => parseFindings(makeBlock("a/../../etc/passwd"))).toThrow();
      expect(() => parseFindings(makeBlock("a\\b"))).toThrow();
    });

    it("rejects > 50 findings", () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        severity: "low",
        file: `src/file${i}.ts`,
        line: 1,
        claim: `claim ${i}`,
        proof: `proof ${i}`,
      }));
      const text = `\`\`\`json\n{"findings":${JSON.stringify(items)}}\n\`\`\``;
      expect(() => parseFindings(text)).toThrow(/too many findings/i);
    });

    it("rejects wrong severity enum and overlong claim", () => {
      const badSeverity = `\`\`\`json\n{"findings":[{"severity":"critical","file":"a.ts","line":1,"claim":"c","proof":"p"}]}\n\`\`\``;
      expect(() => parseFindings(badSeverity)).toThrow(/invalid severity/i);

      const overlongClaim = "a".repeat(2001);
      const badClaim = `\`\`\`json\n{"findings":[{"severity":"low","file":"a.ts","line":1,"claim":"${overlongClaim}","proof":"p"}]}\n\`\`\``;
      expect(() => parseFindings(badClaim)).toThrow(/between 1 and 2000 characters/i);
    });

    it("parses triage and validates every index is present exactly once", () => {
      const triageText = `\`\`\`json
{
  "triage": [
    {"index": 0, "bucket": "must-fix", "reason": "Security vulnerability sk-ant-secret1234567890abcdef"},
    {"index": 1, "bucket": "should-fix", "reason": "Better input validation"},
    {"index": 2, "bucket": "nit", "reason": "Formatting"}
  ]
}
\`\`\``;

      const triage = parseTriage(triageText, 3);
      expect(triage).toHaveLength(3);
      expect(triage[0]?.bucket).toBe("must-fix");
      expect(triage[0]?.reason).toContain("[REDACTED:anthropic]");
      expect(triage[1]?.bucket).toBe("should-fix");
      expect(triage[2]?.bucket).toBe("nit");

      // Duplicate index throws
      const dupText = `\`\`\`json
{"triage":[{"index":0,"bucket":"must-fix","reason":"r"},{"index":0,"bucket":"nit","reason":"r"}]}
\`\`\``;
      expect(() => parseTriage(dupText, 2)).toThrow();

      // Count mismatch throws
      expect(() => parseTriage(triageText, 2)).toThrow(/does not match/i);
    });

    it("extractWorktreeNameFromGitFile extracts the review worktree name safely", () => {
      expect(extractWorktreeNameFromGitFile("gitdir: /path/to/.git/worktrees/review-1-task1-1\n")).toBe("review-1-task1-1");
      expect(extractWorktreeNameFromGitFile("gitdir: ../../.git/worktrees/review-2-task2-2")).toBe("review-2-task2-2");
      expect(extractWorktreeNameFromGitFile("gitdir: .git/worktrees/review-3/")).toBe("review-3");
      expect(extractWorktreeNameFromGitFile("invalid content")).toBeNull();
      expect(extractWorktreeNameFromGitFile("gitdir: /path/to/worktrees/..")).toBeNull();
      expect(extractWorktreeNameFromGitFile("gitdir: /path/to/worktrees/.")).toBeNull();
    });
  });

  describe("Provider selection rules", () => {
    it("reviewer is opposite provider of writer (claude -> antigravity, antigravity -> claude) on Personal", async () => {
      const [proj] = db.insert(projects).values({
        name: "Personal Project",
        localPath: repoDir,
        profile: "personal",
        defaultBranch: "main",
      }).returning().all();

      const provClaude = db.select().from(providers).where(eq(providers.name, "claude")).get()!;
      const provAgy = db.select().from(providers).where(eq(providers.name, "antigravity")).get()!;

      // Setup task branch daedalus/t1
      git(repoDir, "checkout", "-b", "daedalus/t1", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "code.ts"), "export const x = 1;\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "implement t1");
      git(repoDir, "checkout", "main");

      const [t1] = db.insert(tasks).values({
        projectId: proj!.id,
        code: "T1",
        title: "Task 1",
        status: "in-review",
        branch: "daedalus/t1",
      }).returning().all();

      // Writer was claude -> reviewer should be antigravity
      db.insert(runs).values({
        taskId: t1!.id,
        providerId: provClaude!.id,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res1 = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        proj!.id,
        "T1",
      );
      await res1.promise;

      const review1 = db.select().from(reviews).where(eq(reviews.id, res1.reviewId)).get();
      expect(review1?.reviewer).toBe("antigravity");
      expect(review1?.status).toBe("done");

      // Setup task branch daedalus/t2 with writer antigravity
      git(repoDir, "checkout", "-b", "daedalus/t2", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "code2.ts"), "export const y = 2;\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "implement t2");
      git(repoDir, "checkout", "main");

      const [t2] = db.insert(tasks).values({
        projectId: proj!.id,
        code: "T2",
        title: "Task 2",
        status: "in-review",
        branch: "daedalus/t2",
      }).returning().all();

      db.insert(runs).values({
        taskId: t2!.id,
        providerId: provAgy!.id,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res2 = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        proj!.id,
        "T2",
      );
      await res2.promise;

      const review2 = db.select().from(reviews).where(eq(reviews.id, res2.reviewId)).get();
      expect(review2?.reviewer).toBe("claude");
      expect(review2?.status).toBe("done");
    });

    it("Work: writer claude -> reviewer claude; runs row claiming antigravity on Work project -> still claude", async () => {
      const [workProj] = db.insert(projects).values({
        name: "Work Project",
        localPath: repoDir,
        profile: "work",
        defaultBranch: "main",
      }).returning().all();

      const provClaude = db.select().from(providers).where(eq(providers.name, "claude")).get()!;
      const provAgy = db.select().from(providers).where(eq(providers.name, "antigravity")).get()!;

      git(repoDir, "checkout", "-b", "daedalus/tw1", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "work1.ts"), "export const w = 1;\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "implement work1");
      git(repoDir, "checkout", "main");

      const [tw1] = db.insert(tasks).values({
        projectId: workProj!.id,
        code: "TW1",
        title: "Work Task 1",
        status: "in-review",
        branch: "daedalus/tw1",
      }).returning().all();

      // implement run says claude
      db.insert(runs).values({
        taskId: tw1!.id,
        providerId: provClaude!.id,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      let startedWith: string[] = [];
      const spyManager = {
        start: async (
          p: Parameters<SessionManager["start"]>[0],
          provId: string,
          opts?: Parameters<SessionManager["start"]>[2],
        ) => {
          startedWith.push(provId);
          return manager.start(p, provId, opts);
        },
        stopAll: () => manager.stopAll(),
      };

      const res1 = await startCrossReview(
        { db, dataDir, sessions: spyManager, providers: testProviders },
        workProj!.id,
        "TW1",
      );
      await res1.promise;

      const r1 = db.select().from(reviews).where(eq(reviews.id, res1.reviewId)).get();
      expect(r1?.reviewer).toBe("claude");
      expect(startedWith.includes("antigravity")).toBe(false);

      // Now a task where runs row claims antigravity on a Work project
      git(repoDir, "checkout", "-b", "daedalus/tw2", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "work2.ts"), "export const w2 = 2;\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "implement work2");
      git(repoDir, "checkout", "main");

      const [tw2] = db.insert(tasks).values({
        projectId: workProj!.id,
        code: "TW2",
        title: "Work Task 2",
        status: "in-review",
        branch: "daedalus/tw2",
      }).returning().all();

      db.insert(runs).values({
        taskId: tw2!.id,
        providerId: provAgy!.id,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      startedWith = [];
      const res2 = await startCrossReview(
        { db, dataDir, sessions: spyManager, providers: testProviders },
        workProj!.id,
        "TW2",
      );
      await res2.promise;

      const r2 = db.select().from(reviews).where(eq(reviews.id, res2.reviewId)).get();
      expect(r2?.reviewer).toBe("claude");
      expect(startedWith.includes("antigravity")).toBe(false);
    });
  });

  describe("Execution scenarios", () => {
    let projId: number;
    let provClaudeId: number;

    beforeEach(() => {
      const [proj] = db.insert(projects).values({
        name: "Test Personal",
        localPath: repoDir,
        profile: "personal",
        defaultBranch: "main",
      }).returning().all();
      projId = proj!.id;

      const prov = db.select().from(providers).where(eq(providers.name, "claude")).get()!;
      provClaudeId = prov.id;
    });

    it("FAKE:ask-write -> edit request was denied (finding proof says denied), read allowed", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-ask-write", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "test.ts"), "test\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-WRITE",
        title: "Test FAKE:ask-write permissions",
        status: "in-review",
        branch: "daedalus/t-ask-write",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-WRITE",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("done");
      expect(review?.findings).toContain("edit: denied, read: allowed");
    });

    it("FAKE:write-file -> status tampered, gate blocked, review worktree removed, task branch unchanged", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-tamper", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "file.txt"), "original\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "original commit");
      const branchShaBefore = git(repoDir, "rev-parse", "daedalus/t-tamper");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-TAMPER",
        title: "Test FAKE:write-file tampering",
        status: "in-review",
        branch: "daedalus/t-tamper",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-TAMPER",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      // Review worktree removed
      const expectedWorktreeDir = join(dataDir, "worktrees", `review-${projId}-t-tamper-${res.reviewId}`);
      expect(existsSync(expectedWorktreeDir)).toBe(false);

      // Task branch unchanged
      const branchShaAfter = git(repoDir, "rev-parse", "daedalus/t-tamper");
      expect(branchShaAfter).toBe(branchShaBefore);

      // Gate blocked
      const reviewData = await getReview(db, { id: projId, localPath: repoDir, profile: "personal", defaultBranch: "main", name: "P", geminiAllowed: true }, "T-TAMPER", { dataDir });
      const gate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(gate?.status).toBe("blocked");
      expect(gate?.items[0]).toContain("The reviewer changed files; its review was discarded.");
    });

    it("FAKE:write-and-stall with timeout -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-stall", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "file.txt"), "original\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "original commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-STALL",
        title: "Test FAKE:write-and-stall timeout tampering",
        status: "in-review",
        branch: "daedalus/t-stall",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        {
          db,
          dataDir,
          sessions: manager,
          providers: testProviders,
          reviewTimeoutMs: 300,
        },
        projId,
        "T-STALL",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-STALL");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("FAKE:delete-git -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-delgit", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "delgit.txt"), "delgit\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "delgit commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-DELGIT",
        title: "Test FAKE:delete-git tampering",
        status: "in-review",
        branch: "daedalus/t-delgit",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-DELGIT",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-DELGIT");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("FAKE:write-common-hook (writes <common-dir>/hooks/post-checkout) -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-hook", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "hook.txt"), "hook test\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "hook commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-HOOK",
        title: "Test FAKE:write-common-hook tampering",
        status: "in-review",
        branch: "daedalus/t-hook",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-HOOK",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-HOOK");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("FAKE:rewrite-git (rewrites cwd .git file to point elsewhere) -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-rewrgit", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "rewrgit.txt"), "rewrgit\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "rewrgit commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-REWRGIT",
        title: "Test FAKE:rewrite-git tampering",
        status: "in-review",
        branch: "daedalus/t-rewrgit",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-REWRGIT",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-REWRGIT");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("reviewer rewrites its own worktrees/<name>/commondir -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-rwcommondir", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "rwcommondir.txt"), "rwcommondir\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "rwcommondir commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-RWCOMMONDIR",
        title: "Test FAKE:rewrite-commondir tampering",
        status: "in-review",
        branch: "daedalus/t-rwcommondir",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-RWCOMMONDIR",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-RWCOMMONDIR");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("adding objects/info/alternates -> status tampered, gate blocked", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-alternates", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "alternates.txt"), "alternates\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "alternates commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-ALTERNATES",
        title: "Test FAKE:add-alternates tampering",
        status: "in-review",
        branch: "daedalus/t-alternates",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const proj = db.select().from(projects).where(eq(projects.id, projId)).get()!;

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-ALTERNATES",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("tampered");

      const reviewData = await getReview(db, proj, "T-ALTERNATES");
      const xrGate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(xrGate?.status).toBe("blocked");
      expect(xrGate?.items).toContain("The reviewer changed files; its review was discarded.");
    });

    it("moving or updating other worktrees during review does not read as tampering", async () => {
      // Create another worktree (e.g. for another task)
      const otherWorktreeDir = join(dataDir, "worktrees", "task-other");
      git(repoDir, "worktree", "add", otherWorktreeDir, "daedalus/release-v1.0");

      git(repoDir, "checkout", "-b", "daedalus/t-otherwt", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "otherwt.ts"), "other wt\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "other wt commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-OTHERWT",
        title: "Test other worktree move",
        status: "in-review",
        branch: "daedalus/t-otherwt",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      // Simulate task runner moving or touching the other worktree's admin dir (gitdir/commondir)
      const gitDir = join(repoDir, ".git");
      const otherAdminDir = join(gitDir, "worktrees", "task-other");
      if (existsSync(otherAdminDir)) {
        writeFileSync(join(otherAdminDir, "gitdir"), "/tmp/moved-task-other/.git\n");
      }

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-OTHERWT",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("done");
    });

    it("two startCrossReview calls started together -> one succeeds, the other is 409", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-race", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "race.txt"), "race test\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "race commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-RACE",
        title: "Race test",
        status: "in-review",
        branch: "daedalus/t-race",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const p1 = startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-RACE",
      );
      const p2 = startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-RACE",
      );

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<StartCrossReviewResult> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({
        status: 409,
        message: expect.stringMatching(/already running/i),
      });

      // Await background promise of the successful review
      await fulfilled[0]!.value.promise;
    });

    it("FAKE:bad-json -> status failed, gate needs-ack", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-badjson", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "file.txt"), "bad json test\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "bad json commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-BADJSON",
        title: "Test FAKE:bad-json output",
        status: "in-review",
        branch: "daedalus/t-badjson",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-BADJSON",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("failed");

      const reviewData = await getReview(db, { id: projId, localPath: repoDir, profile: "personal", defaultBranch: "main", name: "P", geminiAllowed: true }, "T-BADJSON", { dataDir });
      const gate = reviewData.gates.find((g) => g.id === "cross-review");
      expect(gate?.status).toBe("needs-ack");
    });

    it("happy path -> findings and triage stored in reviews, gate needs-ack (must-fix present); new commit makes gate stale", async () => {
      git(repoDir, "checkout", "-b", "daedalus/t-happy", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "happy.ts"), "export const happy = true;\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "happy commit");
      git(repoDir, "checkout", "main");

      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-HAPPY",
        title: "Happy Path Task",
        status: "in-review",
        branch: "daedalus/t-happy",
      }).returning().all();

      db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-HAPPY",
      );
      await res.promise;

      const review = db.select().from(reviews).where(eq(reviews.id, res.reviewId)).get();
      expect(review?.status).toBe("done");
      expect(review?.findings).toContain("Missing input validation in auth check");
      expect(review?.claudeTriage).toContain("must-fix");

      const projLike = { id: projId, localPath: repoDir, profile: "personal", defaultBranch: "main", name: "P", geminiAllowed: true };
      const reviewData1 = await getReview(db, projLike, "T-HAPPY", { dataDir });
      const gate1 = reviewData1.gates.find((g) => g.id === "cross-review");
      expect(gate1?.status).toBe("needs-ack");
      expect(gate1?.items.some((i) => i.includes("must-fix"))).toBe(true);

      // Now add a new commit on the task branch
      git(repoDir, "checkout", "daedalus/t-happy");
      writeFileSync(join(repoDir, "happy2.ts"), "new commit\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "new commit on task branch");
      git(repoDir, "checkout", "main");

      // Now the review is stale for the new head commit
      const reviewData2 = await getReview(db, projLike, "T-HAPPY", { dataDir });
      const gate2 = reviewData2.gates.find((g) => g.id === "cross-review");
      expect(gate2?.status).toBe("needs-ack");
      expect(gate2?.items).toContain("no cross-review for this commit");
    });

    it("review worktree is removed after success, failure and timeout", async () => {
      // 1. Success cleanup
      git(repoDir, "checkout", "-b", "daedalus/t-clean1", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "c1.ts"), "c1\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "c1");
      git(repoDir, "checkout", "main");

      const [t1] = db.insert(tasks).values({
        projectId: projId,
        code: "T-CLEAN1",
        title: "Clean Success",
        status: "in-review",
        branch: "daedalus/t-clean1",
      }).returning().all();

      db.insert(runs).values({
        taskId: t1!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res1 = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-CLEAN1",
      );
      await res1.promise;
      const wt1 = join(dataDir, "worktrees", `review-${projId}-t-clean1-${res1.reviewId}`);
      expect(existsSync(wt1)).toBe(false);

      // 2. Failure cleanup (bad-json)
      git(repoDir, "checkout", "-b", "daedalus/t-clean2", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "c2.ts"), "c2\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "c2");
      git(repoDir, "checkout", "main");

      const [t2] = db.insert(tasks).values({
        projectId: projId,
        code: "T-CLEAN2",
        title: "Clean Failure FAKE:bad-json",
        status: "in-review",
        branch: "daedalus/t-clean2",
      }).returning().all();

      db.insert(runs).values({
        taskId: t2!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const res2 = await startCrossReview(
        { db, dataDir, sessions: manager, providers: testProviders },
        projId,
        "T-CLEAN2",
      );
      await res2.promise;
      const wt2 = join(dataDir, "worktrees", `review-${projId}-t-clean2-${res2.reviewId}`);
      expect(existsSync(wt2)).toBe(false);

      // 3. Timeout cleanup: mock a session that sleeps or use short reviewTimeoutMs
      git(repoDir, "checkout", "-b", "daedalus/t-clean3", "daedalus/release-v1.0");
      writeFileSync(join(repoDir, "c3.ts"), "c3\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "c3");
      git(repoDir, "checkout", "main");

      const [t3] = db.insert(tasks).values({
        projectId: projId,
        code: "T-CLEAN3",
        title: "Clean Timeout",
        status: "in-review",
        branch: "daedalus/t-clean3",
      }).returning().all();

      db.insert(runs).values({
        taskId: t3!.id,
        providerId: provClaudeId,
        role: "implement",
        start: new Date().toISOString(),
      }).run();

      const timeoutSessions = {
        start: async (
          p: Parameters<SessionManager["start"]>[0],
          provId: string,
          opts?: Parameters<SessionManager["start"]>[2],
        ) => {
          const s = await manager.start(p, provId, opts);
          return {
            id: s.id,
            startedAt: s.startedAt,
            prompt: async () => {
              // Sleep longer than reviewTimeoutMs
              await new Promise((r) => setTimeout(r, 2000));
              return "end_turn";
            },
            cancel: () => s.cancel(),
            stop: () => s.stop(),
            onEvent: (l: Parameters<AgentSession["onEvent"]>[0]) => s.onEvent(l),
          };
        },
      };

      const res3 = await startCrossReview(
        {
          db,
          dataDir,
          sessions: timeoutSessions,
          providers: testProviders,
          reviewTimeoutMs: 100, // 100 ms timeout
        },
        projId,
        "T-CLEAN3",
      );
      await res3.promise;

      const r3 = db.select().from(reviews).where(eq(reviews.id, res3.reviewId)).get();
      expect(r3?.status).toBe("timed-out");
      const wt3 = join(dataDir, "worktrees", `review-${projId}-t-clean3-${res3.reviewId}`);
      expect(existsSync(wt3)).toBe(false);
    });

    it("recoverReviewsOnStartup marks running review failed and closes open review run with end set", () => {
      const [t] = db.insert(tasks).values({
        projectId: projId,
        code: "T-RECOVER",
        title: "Recover test",
        status: "in-review",
        branch: "daedalus/t-recover",
      }).returning().all();

      const [r] = db.insert(reviews).values({
        taskId: t!.id,
        reviewer: "claude",
        status: "running",
        headSha: "abcdef1234567890",
        findings: "[]",
        startedAt: new Date().toISOString(),
      }).returning().all();

      const [run] = db.insert(runs).values({
        taskId: t!.id,
        providerId: provClaudeId,
        role: "review",
        start: new Date().toISOString(),
      }).returning().all();

      expect(run?.end).toBeNull();

      recoverReviewsOnStartup(db);

      const updatedReview = db.select().from(reviews).where(eq(reviews.id, r!.id)).get();
      expect(updatedReview?.status).toBe("failed");
      expect(updatedReview?.error).toBe("server stopped");

      const updatedRun = db.select().from(runs).where(eq(runs.id, run!.id)).get();
      expect(updatedRun?.end).not.toBeNull();
      expect(updatedRun?.exitStatus).toBe(1);
    });
  });

  describe("hashGitCommonDir", () => {
    it("hashes every file under info/ and changes when any info file changes", () => {
      const gitDir = join(repoDir, ".git");
      const initialHash = hashGitCommonDir(gitDir);

      const infoDir = join(gitDir, "info");
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(join(infoDir, "exclude"), "# custom exclude\n*.tmp\n");

      const afterExcludeHash = hashGitCommonDir(gitDir);
      expect(afterExcludeHash).not.toBe(initialHash);

      writeFileSync(join(infoDir, "attributes"), "* text=auto\n");
      const afterAttrHash = hashGitCommonDir(gitDir);
      expect(afterAttrHash).not.toBe(afterExcludeHash);
    });

    it("hashes every worktrees/*/config.worktree and changes when config.worktree is added or modified", () => {
      const gitDir = join(repoDir, ".git");
      const initialHash = hashGitCommonDir(gitDir);

      const wt1 = join(gitDir, "worktrees", "wt-test-1");
      mkdirSync(wt1, { recursive: true });
      // creating worktree dir without config.worktree does not change hash
      expect(hashGitCommonDir(gitDir)).toBe(initialHash);

      // adding config.worktree changes hash
      const wtConfig = join(wt1, "config.worktree");
      writeFileSync(wtConfig, "[core]\n\tcheckStat = minimal\n");
      const withConfigHash = hashGitCommonDir(gitDir);
      expect(withConfigHash).not.toBe(initialHash);

      // modifying config.worktree changes hash
      writeFileSync(wtConfig, "[core]\n\tcheckStat = default\n");
      expect(hashGitCommonDir(gitDir)).not.toBe(withConfigHash);
    });

    it("refs other than the task branch stay out of commonDirHash on purpose", () => {
      const gitDir = join(repoDir, ".git");
      const hashBefore = hashGitCommonDir(gitDir);

      // Commit to main (moves refs/heads/main)
      writeFileSync(join(repoDir, "other.txt"), "owner commit during review\n");
      git(repoDir, "add", ".");
      git(repoDir, "commit", "-m", "owner commit on main");

      const hashAfter = hashGitCommonDir(gitDir);
      expect(hashAfter).toBe(hashBefore);
    });

    it("hashes objects/info/alternates and changes when alternates is added or modified", () => {
      const gitDir = join(repoDir, ".git");
      const initialHash = hashGitCommonDir(gitDir);

      const objInfoDir = join(gitDir, "objects", "info");
      mkdirSync(objInfoDir, { recursive: true });
      const alternatesFile = join(objInfoDir, "alternates");
      writeFileSync(alternatesFile, "/tmp/alt-objects\n");

      const withAltHash = hashGitCommonDir(gitDir);
      expect(withAltHash).not.toBe(initialHash);

      writeFileSync(alternatesFile, "/tmp/alt-objects-2\n");
      expect(hashGitCommonDir(gitDir)).not.toBe(withAltHash);
    });
  });
});
