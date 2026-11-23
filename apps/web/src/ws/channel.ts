/**
 * One Workshop channel per open WebSocket (T3.3, ADR 0011): relays agent session events to the
 * browser and the owner's prompts and permission answers to the agent. Only messages that pass
 * parseClientMessage reach a session. Server-only.
 */
import type { AgentSession, SessionManager } from "@daedalus/providers";
import type WebSocket from "ws";
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
  private readonly offChange: () => void;
  private badMessages = 0;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly sessions: SessionManager,
    private readonly opts: ChannelOptions,
  ) {
    this.offChange = sessions.onChange(() => this.sendSessions());
    ws.on("message", (data, isBinary) => this.onMessage(isBinary ? "" : String(data)));
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
    this.sendSessions();
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
        const known = (e.name === "SessionError" || e.name === "ProfileRuleError") && typeof e.message === "string";
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

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.offChange();
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
  }
}
