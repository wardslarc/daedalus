"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { postJson } from "../../csrf-fetch";
import type {
  SessionInfo,
  TerminalInfo,
  ClientMessage,
  ServerMessage,
  AgentEvent,
} from "../../../src/ws/protocol";
import { AgentConsole } from "./agent-console";
import { TerminalConsole } from "./terminal-console";

type ProjectItem = {
  id: number;
  name: string;
  profile: string;
  geminiAllowed: boolean;
};

let msgCounter = 1;
function nextId(prefix = "m"): string {
  return `${prefix}_${Date.now()}_${msgCounter++}`;
}

export default function WorkshopPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<"claude" | "antigravity">("claude");
  const [pickerError, setPickerError] = useState<string | null>(null);

  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectedBanners, setReconnectedBanners] = useState<Record<string, number>>({});

  const [sessionEvents, setSessionEvents] = useState<Record<string, AgentEvent[]>>({});
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string[]>>({});
  const [terminalExits, setTerminalExits] = useState<Record<string, number | null>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const sessionsRef = useRef<SessionInfo[]>([]);
  const terminalsRef = useRef<TerminalInfo[]>([]);
  const lastSeqMap = useRef<Map<string, number>>(new Map());
  const lastOffsetMap = useRef<Map<string, number>>(new Map());
  const pendingPrompts = useRef<Map<string, { clear: () => void; setError: (err: string) => void }>>(new Map());
  const subscribedSessions = useRef<Set<string>>(new Set());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  sessionsRef.current = sessions;
  terminalsRef.current = terminals;

  const sendWs = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // Fetch initial REST data
  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const [projRes, sessRes, termRes] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/sessions"),
          fetch("/api/terminals"),
        ]);

        if (projRes.ok && active) {
          const pData = (await projRes.json()) as { projects: ProjectItem[] };
          const projs = pData.projects ?? [];
          setProjects(projs);
          const first = projs[0];
          if (first) {
            setSelectedProjectId((prev) => prev ?? first.id);
            if (first.profile.toLowerCase() === "work") {
              setSelectedProvider("claude");
            }
          }
        }

        if (sessRes.ok && active) {
          const sData = (await sessRes.json()) as { sessions: SessionInfo[] };
          setSessions(sData.sessions ?? []);
        }

        if (termRes.ok && active) {
          const tData = (await termRes.json()) as { terminals: TerminalInfo[] };
          setTerminals(tData.terminals ?? []);
        }
      } catch (err) {
        console.error("Failed to load initial workshop data:", err);
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, []);

  // Set up WebSocket connection
  useEffect(() => {
    let disposed = false;

    function connectWs() {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }

        setIsReconnecting(false);

        // Re-subscribe / initial subscribe to all sessions
        for (const s of sessionsRef.current) {
          const lastSeq = lastSeqMap.current.get(s.id) ?? 0;
          sendWs({ id: nextId("sub"), type: "subscribe", sessionId: s.id, since: lastSeq });
          subscribedSessions.current.add(s.id);
          if (lastSeq > 0) {
            setReconnectedBanners((prev) => ({ ...prev, [s.id]: lastSeq }));
            setTimeout(() => {
              setReconnectedBanners((prev) => {
                const next = { ...prev };
                delete next[s.id];
                return next;
              });
            }, 4000);
          }
        }

        // Re-attach / initial attach to all terminals
        for (const t of terminalsRef.current) {
          const lastOffset = lastOffsetMap.current.get(t.id) ?? 0;
          sendWs({ id: nextId("att"), type: "terminal_attach", terminalId: t.id, since: lastOffset });
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          switch (msg.type) {
            case "sessions": {
              setSessions(msg.sessions);
              // Subscribe to new sessions
              for (const s of msg.sessions) {
                if (!subscribedSessions.current.has(s.id)) {
                  subscribedSessions.current.add(s.id);
                  const lastSeq = lastSeqMap.current.get(s.id) ?? 0;
                  sendWs({ id: nextId("sub"), type: "subscribe", sessionId: s.id, since: lastSeq });
                }
              }
              break;
            }
            case "terminals": {
              setTerminals(msg.terminals);
              break;
            }
            case "event": {
              const { sessionId, event: agEvent } = msg;
              lastSeqMap.current.set(sessionId, agEvent.seq);
              setSessionEvents((prev) => ({
                ...prev,
                [sessionId]: [...(prev[sessionId] ?? []), agEvent],
              }));
              break;
            }
            case "terminal_output": {
              const { terminalId, data, offset } = msg;
              lastOffsetMap.current.set(terminalId, offset + data.length);
              setTerminalOutputs((prev) => ({
                ...prev,
                [terminalId]: [...(prev[terminalId] ?? []), data],
              }));
              break;
            }
            case "terminal_exit": {
              setTerminalExits((prev) => ({
                ...prev,
                [msg.terminalId]: msg.code,
              }));
              break;
            }
            case "ack": {
              const p = pendingPrompts.current.get(msg.id);
              if (p) {
                p.clear();
                pendingPrompts.current.delete(msg.id);
              }
              break;
            }
            case "error": {
              if (msg.id) {
                const p = pendingPrompts.current.get(msg.id);
                if (p) {
                  p.setError(msg.message);
                  pendingPrompts.current.delete(msg.id);
                }
              }
              break;
            }
          }
        } catch (err) {
          console.error("Malformed message from server:", err);
        }
      };

      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4401) {
          window.location.href = "/login";
          return;
        }
        setIsReconnecting(true);
        reconnectTimeoutRef.current = setTimeout(connectWs, 1500);
      };

      ws.onerror = () => {
        // Handled by onclose
      };
    }

    connectWs();

    return () => {
      disposed = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sendWs]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  async function handleStartSession() {
    if (!selectedProjectId) return;
    setPickerError(null);
    try {
      const res = await postJson("/api/sessions", {
        projectId: selectedProjectId,
        providerId: selectedProvider,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPickerError(data.error ?? `Failed to start session (${res.status})`);
        return;
      }
      const data = (await res.json()) as { session?: SessionInfo };
      if (data.session) {
        const s = data.session;
        setSessions((prev) => (prev.some((item) => item.id === s.id) ? prev : [...prev, s]));
        if (!subscribedSessions.current.has(s.id)) {
          subscribedSessions.current.add(s.id);
          sendWs({ id: nextId("sub"), type: "subscribe", sessionId: s.id, since: 0 });
        }
      }
      setIsPickerOpen(false);
    } catch (err: unknown) {
      setPickerError(err instanceof Error ? err.message : "Failed to start session");
    }
  }

  async function handleOpenTerminal() {
    if (!selectedProjectId) return;
    setPickerError(null);
    try {
      const res = await postJson("/api/terminals", {
        projectId: selectedProjectId,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPickerError(data.error ?? `Failed to open terminal (${res.status})`);
        return;
      }
      const data = (await res.json()) as { terminal?: TerminalInfo };
      if (data.terminal) {
        const t = data.terminal;
        setTerminals((prev) => (prev.some((item) => item.id === t.id) ? prev : [...prev, t]));
      }
      setIsPickerOpen(false);
    } catch (err: unknown) {
      setPickerError(err instanceof Error ? err.message : "Failed to open terminal");
    }
  }

  async function handleStopSession(sessionId: string) {
    try {
      await postJson(`/api/sessions/${sessionId}/stop`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err) {
      console.error("Failed to stop session:", err);
    }
  }

  async function handleCloseTerminal(terminalId: string) {
    try {
      await postJson(`/api/terminals/${terminalId}/close`);
      setTerminals((prev) => prev.filter((t) => t.id !== terminalId));
    } catch (err) {
      console.error("Failed to close terminal:", err);
    }
  }

  function handleCancelTurn(sessionId: string) {
    sendWs({ id: nextId("cnc"), type: "cancel", sessionId });
  }

  function handleCloseEndedSession(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }

  function handleSendPrompt(
    sessionId: string,
    text: string,
    callbacks: { clear: () => void; setError: (err: string) => void },
  ) {
    const id = nextId("pr");
    pendingPrompts.current.set(id, callbacks);
    sendWs({ id, type: "prompt", sessionId, text });
  }

  function handlePermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    callbacks: { clear: () => void; setError: (err: string) => void },
  ) {
    const id = nextId("perm");
    pendingPrompts.current.set(id, callbacks);
    sendWs({ id, type: "permission", sessionId, requestId, optionId });
  }

  function handleTerminalInput(terminalId: string, data: string) {
    sendWs({ id: nextId("in"), type: "terminal_input", terminalId, data });
  }

  function handleTerminalResize(terminalId: string, cols: number, rows: number) {
    sendWs({ id: nextId("rsz"), type: "terminal_resize", terminalId, cols, rows });
  }

  function handleTerminalAttach(terminalId: string, since?: number) {
    sendWs({ id: nextId("att"), type: "terminal_attach", terminalId, since });
  }

  const isFull = sessions.length >= 2;

  return (
    <>
      {/* Header */}
      <header className="main-header">
        <div className="header-title-group">
          <h1>Workshop</h1>
          <p className="header-summary">Live agent sessions across projects</p>
        </div>
        <div className="workshop-header-actions">
          <span className="sessions-readout">Sessions {sessions.length} / 2</span>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setIsPickerOpen((v) => !v)}
          >
            New session
          </button>
        </div>
      </header>

      {/* New Session Picker Panel */}
      {isPickerOpen && (
        <div className="workshop-picker-panel" role="region" aria-label="New session picker">
          <div className="picker-row">
            <div className="form-group">
              <label htmlFor="project-select" className="form-label">
                Project
              </label>
              <select
                id="project-select"
                className="form-input picker-select"
                value={selectedProjectId ?? ""}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedProjectId(id);
                  const p = projects.find((item) => item.id === id);
                  if (p?.profile.toLowerCase() === "work") {
                    setSelectedProvider("claude");
                  }
                }}
              >
                {projects.map((p) => {
                  const prof = p.profile.charAt(0).toUpperCase() + p.profile.slice(1);
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} · {prof}
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="form-group">
              <span className="form-label">Provider</span>
              <div className="provider-pills">
                <button
                  type="button"
                  className={`provider-pill pill-claude ${
                    selectedProvider === "claude" ? "selected" : ""
                  }`}
                  onClick={() => setSelectedProvider("claude")}
                >
                  Claude
                </button>
                {selectedProject?.profile.toLowerCase() !== "work" && (
                  <button
                    type="button"
                    className={`provider-pill pill-antigravity ${
                      selectedProvider === "antigravity" ? "selected" : ""
                    }`}
                    onClick={() => setSelectedProvider("antigravity")}
                  >
                    Antigravity
                  </button>
                )}
              </div>
              <p className="picker-policy-note">
                Work projects: Claude only (Gemini off by policy)
              </p>
            </div>
          </div>

          {pickerError && (
            <div className="form-error" role="alert">
              {pickerError}
            </div>
          )}

          <div className="picker-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleOpenTerminal}
              disabled={!selectedProjectId}
            >
              Open terminal
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleStartSession}
              disabled={isFull || !selectedProjectId}
              title={isFull ? "2 of 2 sessions running · stop one first" : undefined}
            >
              {isFull ? "2 of 2 sessions running · stop one first" : "Start"}
            </button>
          </div>
        </div>
      )}

      {/* Main Body: Consoles or Empty State */}
      {sessions.length === 0 && terminals.length === 0 ? (
        <div className="empty-project-card workshop-empty-state">
          <p className="empty-project-desc">
            No live sessions. Start one from a project&apos;s Pipeline, or open a free session.
          </p>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setIsPickerOpen(true)}
            >
              New session
            </button>
          </div>
        </div>
      ) : (
        <div className="workshop-consoles">
          {/* Agent Consoles */}
          {sessions.map((session) => {
            const project = projects.find((p) => p.id === session.projectId);
            const events = sessionEvents[session.id] ?? [];
            return (
              <AgentConsole
                key={session.id}
                session={session}
                projectProfile={project?.profile}
                events={events}
                isReconnecting={isReconnecting}
                reconnectedSeq={reconnectedBanners[session.id]}
                onSendPrompt={handleSendPrompt}
                onPermission={handlePermission}
                onCancel={handleCancelTurn}
                onStop={handleStopSession}
                onClose={handleCloseEndedSession}
              />
            );
          })}

          {/* Terminal Consoles */}
          {terminals.map((terminal) => (
            <TerminalConsole
              key={terminal.id}
              terminal={terminal}
              outputChunks={terminalOutputs[terminal.id] ?? []}
              exitCode={terminalExits[terminal.id]}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
              onAttach={handleTerminalAttach}
              onClose={handleCloseTerminal}
            />
          ))}
        </div>
      )}
    </>
  );
}
