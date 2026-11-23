import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager, type TerminalEvent } from "./terminal.js";

const project = (over: Partial<{ id: number; name: string; localPath: string }> = {}) => ({ id: 5, name: "Bilyo", localPath: mkdtempSync(join(tmpdir(), "term-proj-")), ...over });
const realpath = (p: string) => execFileSync("realpath", [p], { encoding: "utf8" }).trim();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let terms: TerminalManager;
afterEach(async () => {
  await terms?.closeAll();
  delete process.env.DAE_TERMINAL_TEST;
});

/** Wait until the terminal's output contains `text`. */
function waitFor(id: string, text: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = terms.backlog(id, 0).data;
    if (seen.includes(text)) return resolve(seen);
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${JSON.stringify(text)}; saw ${JSON.stringify(seen)}`)); }, timeoutMs);
    const off = terms.onEvent(id, (e: TerminalEvent) => {
      if (e.type !== "output") return;
      seen += e.data;
      if (seen.includes(text)) {
        clearTimeout(timer);
        off();
        resolve(seen);
      }
    });
  });
}

describe("TerminalManager", () => {
  it("opens a shell in the project folder and the owner's input reaches it", async () => {
    terms = new TerminalManager({ shell: "/bin/sh" });
    const p = project();
    const t = await terms.open(p);
    expect(t).toMatchObject({ projectId: 5, projectName: "Bilyo" });
    terms.write(t.id, "pwd\n");
    expect(await waitFor(t.id, realpath(p.localPath))).toContain(realpath(p.localPath));
  });

  it("drops Daedalus's own settings from the shell's environment", async () => {
    process.env.DAE_TERMINAL_TEST = "should-not-be-visible";
    terms = new TerminalManager({ shell: "/bin/sh" });
    const t = await terms.open(project());
    terms.write(t.id, 'echo "value=[${DAE_TERMINAL_TEST}]"\n');
    expect(await waitFor(t.id, "value=[]")).not.toContain("should-not-be-visible");
  });

  it("replays output from an offset for a reconnecting tab", async () => {
    terms = new TerminalManager({ shell: "/bin/sh" });
    const t = await terms.open(project());
    terms.write(t.id, "echo first-marker\n");
    await waitFor(t.id, "first-marker\r\n");
    const mark = terms.backlog(t.id, 0).offset;
    terms.write(t.id, "echo second-marker\n");
    await waitFor(t.id, "second-marker\r\n");
    const since = terms.backlog(t.id, mark);
    expect(since.data).toContain("second-marker");
    expect(since.data).not.toContain("first-marker");
  });

  it("keeps the backlog bounded", async () => {
    terms = new TerminalManager({ shell: "/bin/sh", bufferChars: 2000 });
    const t = await terms.open(project());
    terms.write(t.id, "i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); done; echo done-marker\n");
    await waitFor(t.id, "done-marker\r\n");
    expect(terms.backlog(t.id, 0).data.length).toBeLessThanOrEqual(2000);
  });

  it("refuses a third terminal, a missing folder, unknown ids, oversized input and odd sizes", async () => {
    terms = new TerminalManager({ shell: "/bin/sh" });
    await terms.open(project());
    await terms.open(project());
    await expect(terms.open(project())).rejects.toMatchObject({ status: 409 });
    await terms.closeAll();
    await expect(terms.open(project({ localPath: "/definitely/missing" }))).rejects.toMatchObject({ status: 404 });
    expect(() => terms.write("nope", "x")).toThrow(expect.objectContaining({ status: 404 }));
    const t = await terms.open(project());
    expect(() => terms.write(t.id, "x".repeat(64 * 1024 + 1))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => terms.resize(t.id, 0, 24)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => terms.resize(t.id, 501, 24)).toThrow(expect.objectContaining({ status: 400 }));
    terms.resize(t.id, 120, 40);
  });

  it("close and closeAll leave nothing running, and announce the exit", async () => {
    terms = new TerminalManager({ shell: "/bin/sh" });
    const a = await terms.open(project());
    const b = await terms.open(project());
    const pids = [terms.pid(a.id)!, terms.pid(b.id)!];
    const exited = new Promise<void>((r) => terms.onEvent(a.id, (e) => e.type === "exit" && r()));
    await terms.close(a.id);
    await exited;
    expect(terms.list().map((t) => t.id)).toEqual([b.id]);
    await terms.closeAll();
    expect(terms.list()).toEqual([]);
    expect(pids.map(alive)).toEqual([false, false]);
  });

  it("tells listeners when the list changes", async () => {
    terms = new TerminalManager({ shell: "/bin/sh" });
    let changes = 0;
    terms.onChange(() => changes++);
    const t = await terms.open(project());
    await terms.close(t.id);
    expect(changes).toBe(2);
  });
});
