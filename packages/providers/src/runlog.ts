/**
 * Run logs (T3.6, SPEC#Security): every session's events as JSONL under
 * `<dir>/<YYYY-MM-DD>/<sessionId>.jsonl`, redacted before writing. Folders are 0700 and files
 * 0600: logs can hold code and prompts, so only the owner may read them. A log that can't be
 * written is reported once and never stops the session.
 *
 * Streamed text (message, thought and stderr chunks) is joined before it is redacted: agents send
 * text in arbitrary pieces, and a secret cut across two chunks would slip past a per-chunk check.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { makeRedactor, redactDeep } from "./redact.js";
import type { AgentSession } from "./session.js";

export type RunLogLine = { type: string; [key: string]: unknown };

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const STREAMED = new Set(["message", "thought", "stderr"]);
const MAX_JOINED = 1024 * 1024;

type Pending = { type: string; text: string; seq: number; seqTo: number; at: string };

/** Start logging a session. Call before the session does any I/O so nothing is missed. */
export function attachRunLog(session: AgentSession, dir: string, redactor: (text: string) => string = makeRedactor(process.env)): void {
  let fd: number | null = null;
  let failed = false;
  const fail = (err: unknown) => {
    if (!failed) console.error(`[runlog] can't write the run log for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    }
  };
  const write = (line: RunLogLine) => {
    if (failed || fd === null) return;
    try {
      writeSync(fd, `${JSON.stringify(redactDeep(line, redactor))}\n`);
    } catch (err) {
      fail(err);
    }
  };

  try {
    const day = join(dir, session.startedAt.slice(0, 10));
    mkdirSync(day, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(day, 0o700);
    const file = join(day, `${session.id}.jsonl`);
    fd = openSync(file, "a", 0o600);
    chmodSync(file, 0o600);
  } catch (err) {
    fail(err);
    return;
  }

  write({
    type: "session",
    sessionId: session.id,
    projectId: session.project.id,
    projectName: session.project.name,
    providerId: session.providerId,
    startedAt: session.startedAt,
  });
  let pending: Pending | null = null;
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    write({ type: p.type, text: p.text, seq: p.seq, ...(p.seqTo !== p.seq ? { seqTo: p.seqTo } : {}), at: p.at });
  };
  const off = session.onEvent((event) => {
    if (STREAMED.has(event.type) && "text" in event) {
      if (pending && pending.type === event.type && pending.text.length < MAX_JOINED) {
        pending.text += event.text;
        pending.seqTo = event.seq;
      } else {
        flush();
        pending = { type: event.type, text: event.text, seq: event.seq, seqTo: event.seq, at: event.at };
      }
      return;
    }
    flush();
    write(event);
    if (event.type === "exit") {
      off();
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // nothing more to do
        }
        fd = null;
      }
    }
  });
}

/** A session's log lines (already redacted on disk), oldest first; [] if there is none. */
export function readRunLog(dir: string, sessionId: string): RunLogLine[] {
  if (!SESSION_ID.test(sessionId) || !existsSync(dir)) return [];
  for (const day of readdirSync(dir).sort().reverse()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const file = join(dir, day, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RunLogLine];
        } catch {
          return []; // a line cut short by a crash
        }
      });
  }
  return [];
}
