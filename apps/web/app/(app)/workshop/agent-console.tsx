"use client";

import { useEffect, useRef, useState, useId, type FormEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SessionInfo, AgentEvent } from "../../../src/ws/protocol";

export type AgentConsoleProps = {
  session: SessionInfo;
  projectProfile?: string;
  events: AgentEvent[];
  isReconnecting: boolean;
  reconnectedSeq?: number;
  onSendPrompt: (
    sessionId: string,
    text: string,
    callbacks: { clear: () => void; setError: (err: string) => void },
  ) => void;
  onCancel: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
};

function renderEventToTerm(term: Terminal, event: AgentEvent, providerId: string) {
  switch (event.type) {
    case "prompt": {
      const color = providerId === "antigravity" ? "\x1b[38;2;141;184;255m" : "\x1b[38;2;242;167;126m";
      term.writeln(`${color}> ${event.text}\x1b[0m`);
      break;
    }
    case "message": {
      term.write(event.text);
      break;
    }
    case "thought": {
      term.write(`\x1b[38;2;151;163;188m${event.text}\x1b[0m`);
      break;
    }
    case "tool_call": {
      term.writeln(`● ${event.title}`);
      break;
    }
    case "tool_call_update": {
      const icon = event.status === "failed" ? "✗" : "✓";
      const color = event.status === "failed" ? "\x1b[38;2;255;138;138m" : "\x1b[38;2;93;211;158m";
      term.writeln(`${color}${icon} ${event.title ?? "Tool call"}\x1b[0m`);
      break;
    }
    case "plan": {
      for (const entry of event.entries) {
        term.writeln(`[plan] ${entry.status}: ${entry.content}`);
      }
      break;
    }
    case "turn_end": {
      term.writeln(`\r\n\x1b[38;2;151;163;188m— turn ended (${event.stopReason})\x1b[0m`);
      break;
    }
    case "stderr": {
      term.write(`\x1b[38;2;151;163;188m${event.text}\x1b[0m`);
      break;
    }
    case "error": {
      term.writeln(`\r\n\x1b[38;2;255;138;138mError: ${event.message}\x1b[0m`);
      break;
    }
    case "exit": {
      const codeOrSig = event.code !== null ? event.code : event.signal !== null ? event.signal : "unknown";
      term.writeln(`\r\n\x1b[38;2;255;138;138mAgent exited (${codeOrSig})\x1b[0m`);
      break;
    }
    default:
      break;
  }
}

export function AgentConsole({
  session,
  projectProfile = "personal",
  events,
  isReconnecting,
  reconnectedSeq,
  onSendPrompt,
  onCancel,
  onStop,
  onClose,
}: AgentConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const renderedCountRef = useRef<number>(0);
  const inputId = useId();

  const [inputText, setInputText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(session.busy);
  const [isExited, setIsExited] = useState(false);
  const [contextPct, setContextPct] = useState<number | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  const providerName = session.providerId === "antigravity" ? "Antigravity" : "Claude";
  const ariaLabel = `${providerName} session, Free session on ${session.projectName}`;

  // Sync busy state from session prop
  useEffect(() => {
    setIsBusy(session.busy);
  }, [session.busy]);

  // Scan events for state updates (usage, turn_end, exit, busy)
  useEffect(() => {
    for (const ev of events) {
      if (ev.type === "usage" && ev.size > 0) {
        setContextPct(Math.round((ev.used / ev.size) * 100));
      }
      if (ev.type === "prompt") {
        setIsBusy(true);
      }
      if (ev.type === "turn_end") {
        setIsBusy(false);
        setLiveAnnouncement(`Turn ended (${ev.stopReason})`);
      }
      if (ev.type === "permission") {
        setLiveAnnouncement(`Permission requested: ${ev.title}`);
      }
      if (ev.type === "exit") {
        setIsBusy(false);
        setIsExited(true);
      }
    }
  }, [events]);

  // Initialize xterm.js
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !containerRef.current) return;

      term = new Terminal({
        fontFamily: 'var(--font-mono), "JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.7,
        theme: {
          background: "#070B16",
          foreground: "#E8EDF7",
          cursor: "transparent",
        },
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch (err) {
        void err;
      }

      const ro = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch (err) {
          void err;
        }
      });
      if (containerRef.current) ro.observe(containerRef.current);

      termRef.current = term;

      // Render all events up to current
      while (renderedCountRef.current < events.length) {
        const ev = events[renderedCountRef.current];
        if (ev) renderEventToTerm(term, ev, session.providerId);
        renderedCountRef.current++;
      }
    }

    init();

    return () => {
      disposed = true;
      term?.dispose();
      termRef.current = null;
    };
  }, []);

  // Render incoming events
  useEffect(() => {
    if (!termRef.current) return;
    while (renderedCountRef.current < events.length) {
      const ev = events[renderedCountRef.current];
      if (ev) renderEventToTerm(termRef.current, ev, session.providerId);
      renderedCountRef.current++;
    }
  }, [events, session.providerId]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || isBusy) return;
    setInputError(null);
    onSendPrompt(session.id, text, {
      clear: () => setInputText(""),
      setError: (err) => setInputError(err),
    });
  }

  const profileLower = projectProfile.toLowerCase();
  const profileFormatted = projectProfile.charAt(0).toUpperCase() + projectProfile.slice(1);

  return (
    <section
      className={`workshop-console ${session.providerId === "antigravity" ? "console-antigravity" : "console-claude"}`}
      aria-label={ariaLabel}
    >
      {/* Reconnect Banner */}
      {isReconnecting && (
        <div className="reconnect-banner banner-reconnecting" role="status">
          Reconnecting…
        </div>
      )}
      {!isReconnecting && reconnectedSeq !== undefined && (
        <div className="reconnect-banner banner-reconnected" role="status">
          Reconnected · caught up from event {reconnectedSeq}
        </div>
      )}

      {/* Screen reader live region */}
      <div className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* Console Header */}
      <div className="console-header">
        <div className="console-header-left">
          <span
            className={`console-chip-provider ${
              session.providerId === "antigravity" ? "console-chip-antigravity" : "console-chip-claude"
            }`}
          >
            {providerName}
          </span>
          <span className="console-project-name">{session.projectName}</span>
          <span className={`profile-chip profile-chip-${profileLower}`}>{profileFormatted}</span>
          <span className="console-chip-session">Free session · project folder</span>
          <span className="console-context">
            {contextPct !== null ? `context ${contextPct}%` : "context —"}
          </span>
          <a
            href="#"
            className="run-log-link"
            onClick={(e) => e.preventDefault()}
            title="Run log"
          >
            Run log
          </a>
        </div>
        <div className="console-header-right">
          <button
            type="button"
            className="btn-secondary-sm"
            onClick={() => onCancel(session.id)}
            disabled={!isBusy}
          >
            Cancel turn
          </button>
          <button
            type="button"
            className="btn-danger-outline"
            onClick={() => onStop(session.id)}
          >
            Stop
          </button>
        </div>
      </div>

      {/* Output Console (xterm.js) */}
      <div className="console-output" ref={containerRef} />

      {/* T3.5 permission prompt panel location */}
      <div className="permission-panel-slot" />

      {/* Input or Session Ended */}
      {isExited ? (
        <div className="session-ended-panel">
          <span className="session-ended-text">Session ended</span>
          <button
            type="button"
            className="btn-secondary-sm"
            onClick={() => onClose(session.id)}
          >
            Close
          </button>
        </div>
      ) : (
        <div className="console-input-area">
          <label htmlFor={inputId} className="console-input-label">
            Steer this session
          </label>
          <form className="console-input-form" onSubmit={handleSubmit}>
            <input
              id={inputId}
              type="text"
              className="console-input"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isBusy}
              placeholder={
                isBusy
                  ? `${providerName} is working · you can type after this turn`
                  : "Type a prompt..."
              }
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={isBusy || !inputText.trim()}
            >
              Send
            </button>
            {isBusy && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onCancel(session.id)}
              >
                Cancel turn
              </button>
            )}
          </form>
          {inputError && (
            <div className="form-error" role="alert" style={{ marginTop: 6 }}>
              {inputError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
