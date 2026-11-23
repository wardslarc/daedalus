/**
 * The free terminal (T3.7, SPEC#Security, ADR 0016): the one shell the spec allows. A real shell
 * in a project folder that only the signed-in owner types into, over the authenticated /ws
 * channel. Server-only.
 *
 * Deliberate differences from agent sessions:
 * - the environment keeps the owner's own variables (it is the owner typing, like any terminal);
 *   only Daedalus's DAE_* settings are removed;
 * - output is never written to run logs: it is the owner's own shell and may show anything;
 * - every terminal is closed when the login that could open it ends (logout) and on shutdown.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as pty from "node-pty";

export class TerminalError extends Error {
  override name = "TerminalError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
  }
}

export type TerminalProject = { id: number; name: string; localPath: string };
export type TerminalInfo = { id: string; projectId: number; projectName: string; startedAt: string };
export type TerminalEvent = { type: "output"; data: string; offset: number } | { type: "exit"; code: number | null };

export type TerminalOptions = {
  /** Shell to run. Default: $SHELL if it is an absolute path to an existing file, else /bin/bash. */
  shell?: string;
  /** Terminals at once. Default 2. */
  max?: number;
  /** Output kept for reconnecting tabs, in characters. Default 256 Ki. */
  bufferChars?: number;
  /** Time between SIGHUP and SIGKILL on close. Default 3 s. */
  killGraceMs?: number;
};

export const MAX_INPUT_CHARS = 64 * 1024;

type Live = {
  info: TerminalInfo;
  proc: pty.IPty;
  /** Output kept, and the offset of its first character in the whole stream. */
  buffer: string;
  start: number;
  listeners: Set<(e: TerminalEvent) => void>;
  exited: Promise<void>;
  done: boolean;
};

function defaultShell(): string {
  const s = process.env.SHELL;
  if (s && isAbsolute(s) && existsSync(s) && statSync(s).isFile()) return s;
  return "/bin/bash";
}

function ownerEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("DAE_")) out[k] = v;
  out.TERM = "xterm-256color";
  return out;
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
};

export class TerminalManager {
  private readonly terms = new Map<string, Live>();
  private readonly changeListeners = new Set<() => void>();
  private opening = 0;
  private readonly opts: Required<TerminalOptions>;

  constructor(options: TerminalOptions = {}) {
    this.opts = { shell: options.shell ?? defaultShell(), max: options.max ?? 2, bufferChars: options.bufferChars ?? 256 * 1024, killGraceMs: options.killGraceMs ?? 3000 };
  }

  async open(project: TerminalProject): Promise<TerminalInfo> {
    let folder: string;
    try {
      folder = await realpath(project.localPath);
      if (!(await stat(folder)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new TerminalError(`The project folder is missing: ${project.localPath}`, 404);
    }
    if (this.terms.size + this.opening >= this.opts.max) throw new TerminalError(`${this.opts.max} terminals are already open. Close one first.`, 409);
    this.opening++;
    try {
      let proc: pty.IPty;
      try {
        proc = pty.spawn(this.opts.shell, ["-l"], { name: "xterm-256color", cols: 80, rows: 24, cwd: folder, env: ownerEnv() });
      } catch (err) {
        throw new TerminalError(`Couldn't start the shell: ${err instanceof Error ? err.message : String(err)}`, 502);
      }
      const info: TerminalInfo = { id: randomUUID(), projectId: project.id, projectName: project.name, startedAt: new Date().toISOString() };
      let resolveExit!: () => void;
      const live: Live = { info, proc, buffer: "", start: 0, listeners: new Set(), exited: new Promise((r) => (resolveExit = r)), done: false };
      proc.onData((data) => {
        const offset = live.start + live.buffer.length;
        live.buffer += data;
        if (live.buffer.length > this.opts.bufferChars) {
          const cut = live.buffer.length - this.opts.bufferChars;
          live.buffer = live.buffer.slice(cut);
          live.start += cut;
        }
        this.emit(live, { type: "output", data, offset });
      });
      proc.onExit(({ exitCode }) => {
        live.done = true;
        killGroup(proc.pid, "SIGKILL"); // anything the shell left behind
        this.emit(live, { type: "exit", code: exitCode });
        live.listeners.clear();
        if (this.terms.delete(info.id)) this.changed();
        resolveExit();
      });
      this.terms.set(info.id, live);
      this.changed();
      return info;
    } finally {
      this.opening--;
    }
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info);
  }

  get(id: string): TerminalInfo | undefined {
    return this.terms.get(id)?.info;
  }

  pid(id: string): number | undefined {
    return this.terms.get(id)?.proc.pid;
  }

  /** Output from `since` (an offset in the whole stream) to now, and the offset after it. */
  backlog(id: string, since: number): { data: string; offset: number } {
    const t = this.live(id);
    const from = Math.max(since, t.start) - t.start;
    return { data: t.buffer.slice(from), offset: t.start + t.buffer.length };
  }

  onEvent(id: string, listener: (e: TerminalEvent) => void): () => void {
    const t = this.live(id);
    t.listeners.add(listener);
    return () => t.listeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** The owner's keystrokes. */
  write(id: string, data: string): void {
    const t = this.live(id);
    if (typeof data !== "string" || data.length > MAX_INPUT_CHARS) throw new TerminalError("Input is too large.", 400);
    t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.live(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 200) {
      throw new TerminalError("Terminal size must be 1–500 columns and 1–200 rows.", 400);
    }
    t.proc.resize(cols, rows);
  }

  /** SIGHUP to the shell's process group, SIGKILL after the grace period. */
  async close(id: string): Promise<void> {
    const t = this.terms.get(id);
    if (!t) throw new TerminalError("That terminal isn't open.", 404);
    if (t.done) return t.exited;
    killGroup(t.proc.pid, "SIGHUP");
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((r) => {
      timer = setTimeout(() => {
        killGroup(t.proc.pid, "SIGKILL");
        r();
      }, this.opts.killGraceMs);
    });
    await Promise.race([t.exited, grace]);
    clearTimeout(timer);
    await t.exited;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((t) => this.close(t.id).catch(() => undefined)));
  }

  private live(id: string): Live {
    const t = this.terms.get(id);
    if (!t || t.done) throw new TerminalError("That terminal isn't open.", 404);
    return t;
  }

  private emit(t: Live, e: TerminalEvent): void {
    for (const l of t.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private changed(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}
