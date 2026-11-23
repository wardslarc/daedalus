/**
 * The Workshop channel contract (T3.3). Shared by the server's WebSocket handler and the
 * Workshop screen (T3.4, T3.5). Type-only imports from workspace packages, so Next.js can
 * bundle this file for the browser.
 *
 * Sessions are started, listed and stopped over REST (CSRF-checked like every POST):
 *   GET  /api/sessions              → { sessions: SessionInfo[] }
 *   POST /api/sessions              { projectId, providerId } → 201 { session: SessionInfo }
 *   POST /api/sessions/:id/stop     → { stopped: true }
 * Errors are `{ error: string }` with the HTTP status (403 profile rules, 404, 409 full/busy).
 *
 * Everything live goes over one WebSocket per browser tab, at WS_PATH:
 *   browser → server: ClientMessage (each with an `id` the server echoes in ack/error)
 *   server → browser: ServerMessage
 */
import type { AgentEvent } from "@daedalus/providers";

export type { AgentEvent };

export const WS_PATH = "/ws";
/** Largest message the server accepts from the browser (a prompt is the big one). */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

export type SessionInfo = {
  id: string;
  projectId: number;
  projectName: string;
  providerId: string;
  startedAt: string;
  /** A prompt is running. */
  busy: boolean;
};

export type ClientMessage =
  /** Start receiving a session's events: the backlog after `since` (seq), then live ones. */
  | { id: string; type: "subscribe"; sessionId: string; since?: number }
  | { id: string; type: "unsubscribe"; sessionId: string }
  | { id: string; type: "prompt"; sessionId: string; text: string }
  | { id: string; type: "cancel"; sessionId: string }
  /** Answer a `permission` event: one of its option ids, or "cancel". */
  | { id: string; type: "permission"; sessionId: string; requestId: string; optionId: string }
  /** Free terminal (T3.7): receive its output from `since` (an offset in its output stream), then live. */
  | { id: string; type: "terminal_attach"; terminalId: string; since?: number }
  | { id: string; type: "terminal_detach"; terminalId: string }
  /** The owner's keystrokes, sent as typed. */
  | { id: string; type: "terminal_input"; terminalId: string; data: string }
  | { id: string; type: "terminal_resize"; terminalId: string; cols: number; rows: number };

/** A free terminal (T3.7). Opened with POST /api/terminals {projectId}, closed with POST /api/terminals/:id/close. */
export type TerminalInfo = { id: string; projectId: number; projectName: string; startedAt: string };

export type ServerMessage =
  /** Sent on connect and whenever a session starts or ends. */
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "event"; sessionId: string; event: AgentEvent }
  /** Sent on connect and whenever a terminal opens or closes. */
  | { type: "terminals"; terminals: TerminalInfo[] }
  /** `offset` is where `data` starts in the terminal's output stream; attach with `since` to catch up. */
  | { type: "terminal_output"; terminalId: string; data: string; offset: number }
  | { type: "terminal_exit"; terminalId: string; code: number | null }
  | { type: "ack"; id: string }
  | { type: "error"; id?: string; status: number; message: string };

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function str(m: Record<string, unknown>, key: string, max = 200): string {
  const v = m[key];
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new ProtocolError(`"${key}" must be a non-empty string`);
  return v;
}

/** Parse and validate one message from the browser. Unknown types and fields are refused. */
export function parseClientMessage(raw: string): ClientMessage {
  if (new TextEncoder().encode(raw).length > MAX_CLIENT_MESSAGE_BYTES) throw new ProtocolError("Message is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Message isn't valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolError("Message must be a JSON object");
  const m = value as Record<string, unknown>;
  const id = str(m, "id", 64);
  if (!ID.test(id)) throw new ProtocolError(`"id" must be letters, digits, - or _`);
  // Each type: the id field it targets, and the other fields it may carry.
  const allowed: Record<string, [string, string[]]> = {
    subscribe: ["sessionId", ["since"]],
    unsubscribe: ["sessionId", []],
    prompt: ["sessionId", ["text"]],
    cancel: ["sessionId", []],
    permission: ["sessionId", ["requestId", "optionId"]],
    terminal_attach: ["terminalId", ["since"]],
    terminal_detach: ["terminalId", []],
    terminal_input: ["terminalId", ["data"]],
    terminal_resize: ["terminalId", ["cols", "rows"]],
  };
  const type = m.type;
  if (typeof type !== "string" || !Object.hasOwn(allowed, type)) throw new ProtocolError(`Unknown message type "${String(type)}"`);
  const [target, extra] = allowed[type]!;
  const fields = ["id", "type", target, ...extra];
  for (const k of Object.keys(m)) if (!fields.includes(k)) throw new ProtocolError(`Unknown field "${k}"`);
  const wholeOrUndefined = (key: string): number | undefined => {
    const v = m[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ProtocolError(`"${key}" must be a whole number`);
    return v;
  };

  if (target === "terminalId") {
    const terminalId = str(m, "terminalId", 64);
    switch (type) {
      case "terminal_attach": {
        const since = wholeOrUndefined("since");
        return since === undefined ? { id, type, terminalId } : { id, type, terminalId, since };
      }
      case "terminal_detach":
        return { id, type, terminalId };
      case "terminal_input": {
        if (typeof m.data !== "string" || m.data.length === 0) throw new ProtocolError(`"data" must be a non-empty string`);
        return { id, type, terminalId, data: m.data };
      }
      default: {
        const cols = wholeOrUndefined("cols");
        const rows = wholeOrUndefined("rows");
        if (cols === undefined || rows === undefined) throw new ProtocolError(`"cols" and "rows" are required`);
        return { id, type: "terminal_resize", terminalId, cols, rows };
      }
    }
  }
  const sessionId = str(m, "sessionId", 64);

  switch (type) {
    case "subscribe": {
      if (m.since === undefined) return { id, type, sessionId };
      if (typeof m.since !== "number" || !Number.isInteger(m.since) || m.since < 0) throw new ProtocolError(`"since" must be a whole number`);
      return { id, type, sessionId, since: m.since };
    }
    case "unsubscribe":
    case "cancel":
      return { id, type, sessionId };
    case "prompt": {
      if (typeof m.text !== "string" || m.text.trim() === "") throw new ProtocolError(`"text" must be a non-empty string`);
      return { id, type, sessionId, text: m.text };
    }
    default:
      return { id, type: "permission", sessionId, requestId: str(m, "requestId", 64), optionId: str(m, "optionId", 200) };
  }
}
