/**
 * One Workshop channel per open WebSocket (T3.3, ADR 0011): relays agent session events to the
 * browser and the owner's prompts and permission answers to the agent. Only messages that pass
 * parseClientMessage reach a session. Server-only.
 */
import type { AgentSession, SessionManager } from "@daedalus/providers";
import type WebSocket from "ws";
import type { TerminalManager } from "../terminal.js";
import { parseClientMessage, ProtocolError, type ClientMessage, type ServerMessage, type SessionInfo } from "./protocol.js";

export function toSessionInfo(s: AgentSession): SessionInfo {
  return { id: s.id, projectId: s.project.id, projectName: s.project.name, providerId: s.providerId, startedAt: s.startedAt, busy: s.isBusy };
}

export type ChannelOptions = {
  /** Re-checked on every message: an expired login stops the channel. */
  isLive: () => boolean;
  /** Close a socket whose unsent data grows past this (a stuck browser). Default 4 MiB. */
  maxBuffered?: number;
  /** Close after this many invalid messages. Default 20. */
  maxBadMessages?: number;
};

export class Channel {
  private readonly subscriptions = new Map<string, () => void>();
  private readonly terminalSubs = new Map<string, () => void>();
  private readonly offChange: () => void;
  private readonly offTerminals: () => void;
  private badMessages = 0;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly sessions: SessionManager,
    private readonly terminals: TerminalManager,
    private readonly opts: ChannelOptions,
  ) {
    this.offChange = sessions.onChange(() => this.sendSessions());
    this.offTerminals = terminals.onChange(() => this.sendTerminals());
    ws.on("message", (data, isBinary) => this.onMessage(isBinary ? "" : String(data)));
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
    this.sendSessions();
    this.sendTerminals();
  }

  private send(m: ServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > (this.opts.maxBuffered ?? 4 * 1024 * 1024)) {
      // The browser isn't keeping up. It reconnects and catches up with `since`.
      this.ws.close(1013, "Too far behind; reconnect");
      this.dispose();
      return;
    }
    this.ws.send(JSON.stringify(m));
  }

  private sendTerminals(): void {
    this.send({ type: "terminals", terminals: this.terminals.list() });
  }

  private sendSessions(): void {
    this.send({ type: "sessions", sessions: this.sessions.list().map(toSessionInfo) });
  }

  private onMessage(raw: string): void {
    if (!this.opts.isLive()) {
      this.ws.close(4401, "Signed out");
      return;
    }
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(raw);
    } catch (err) {
      this.send({ type: "error", status: 400, message: err instanceof ProtocolError ? err.message : "Bad message" });
      if (++this.badMessages >= (this.opts.maxBadMessages ?? 20)) this.ws.close(1008, "Too many bad messages");
      return;
    }
    void this.handle(msg).then(
      () => this.send({ type: "ack", id: msg.id }),
      (err: unknown) => {
        const e = err as { name?: string; status?: unknown; message?: unknown };
        const known = (e.name === "SessionError" || e.name === "ProfileRuleError" || e.name === "TerminalError") && typeof e.message === "string";
        const status = typeof e.status === "number" ? e.status : e.name === "ProfileRuleError" ? 403 : 500;
        if (!known) console.error("[ws] unexpected error:", err);
        this.send({ type: "error", id: msg.id, status: known ? status : 500, message: known ? String(e.message) : "Something went wrong on the Daedalus server." });
      },
    );
  }

  private session(id: string): AgentSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("That session isn't running."), { name: "SessionError", status: 404 });
    return s;
  }

  private async handle(msg: ClientMessage): Promise<void> {
    if ("terminalId" in msg) return this.handleTerminal(msg);
    const s = this.session(msg.sessionId);
    switch (msg.type) {
      case "subscribe": {
        this.subscriptions.get(s.id)?.();
        const since = msg.since ?? 0;
        for (const event of s.backlog()) if (event.seq > since) this.send({ type: "event", sessionId: s.id, event });
        this.subscriptions.set(
          s.id,
          s.onEvent((event) => this.send({ type: "event", sessionId: s.id, event })),
        );
        return;
      }
      case "unsubscribe":
        this.subscriptions.get(s.id)?.();
        this.subscriptions.delete(s.id);
        return;
      case "prompt": {
        // Acknowledged once accepted; the reply arrives as events. A refusal (busy) throws now.
        // prompt() rejects at once when refused; later failures also arrive as `error` events.
        const turn = s.prompt(msg.text);
        turn.catch(() => undefined);
        await Promise.race([turn, Promise.resolve()]);
        return;
      }
      case "cancel":
        await s.cancel();
        return;
      case "permission":
        s.respondPermission(msg.requestId, msg.optionId);
        return;
    }
  }

  /** Free terminal (T3.7): only the owner, signed in on this socket, types into it. */
  private handleTerminal(msg: Extract<ClientMessage, { terminalId: string }>): void {
    const id = msg.terminalId;
    switch (msg.type) {
      case "terminal_attach": {
        this.terminalSubs.get(id)?.();
        const caught = this.terminals.backlog(id, msg.since ?? 0);
        const start = caught.offset - caught.data.length;
        if (caught.data) this.send({ type: "terminal_output", terminalId: id, data: caught.data, offset: start });
        this.terminalSubs.set(
          id,
          this.terminals.onEvent(id, (e) => {
            if (e.type === "output") this.send({ type: "terminal_output", terminalId: id, data: e.data, offset: e.offset });
            else {
              this.send({ type: "terminal_exit", terminalId: id, code: e.code });
              this.terminalSubs.delete(id);
            }
          }),
        );
        return;
      }
      case "terminal_detach":
        this.terminalSubs.get(id)?.();
        this.terminalSubs.delete(id);
        return;
      case "terminal_input":
        this.terminals.write(id, msg.data);
        return;
      case "terminal_resize":
        this.terminals.resize(id, msg.cols, msg.rows);
        return;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.offChange();
    this.offTerminals();
    for (const off of this.terminalSubs.values()) off();
    this.terminalSubs.clear();
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
  }
}
