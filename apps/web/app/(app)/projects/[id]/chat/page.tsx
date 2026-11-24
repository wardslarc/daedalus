"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";
import { postJson } from "../../../../csrf-fetch";
import { openPermissions, optionStyle } from "../../../../(app)/workshop/permissions";
import type { AgentEvent, ClientMessage, ServerMessage, SessionInfo } from "../../../../../src/ws/protocol";

type ShapingStepId = "intake" | "spec" | "mock" | "plan";

type StepInfo = {
  id: ShapingStepId;
  label: string;
  doc: string;
  provider: string;
  isAi: boolean;
  status: "current" | "completed" | "locked";
  exists: boolean;
};

type IntakeFields = {
  requester?: string;
  problem: string;
  users: string;
  mustHaves?: string;
  outOfScope?: string;
  constraints: string;
  deadline?: string;
};

type ProjectChatData = {
  project: {
    id: number;
    name: string;
    profile: string;
    geminiAllowed: boolean;
    defaultBranch: string;
    localPath: string;
  };
  rules: {
    label: string;
    gitHost: string;
    gemini: string;
    effectiveGemini: boolean;
  };
  currentStep: ShapingStepId;
  steps: StepInfo[];
  intake: {
    exists: boolean;
    content: string | null;
    fields: Partial<IntakeFields>;
  };
  spec: {
    exists: boolean;
    content: string | null;
    hasVerify: boolean;
    approved: boolean;
    approvedAt: string | null;
  };
  mock: {
    exists: boolean;
    content: string | null;
    approved: boolean;
    approval: {
      artifactUrl: string;
      approvedBy: string;
      approvedAt: string;
      providerId?: "claude" | "antigravity";
    } | null;
    allowedProviders: ("claude" | "antigravity")[];
  };
  plan: {
    exists: boolean;
    content: string | null;
    valid: boolean;
    approved: boolean;
    approvedAt: string | null;
    activeMilestone: {
      version: string;
      branch: string;
      startedAt: string;
      frozen: true;
    } | null;
  };
};

type ChatTurn =
  | { kind: "owner"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; title: string; status?: string }
  | { kind: "error"; message: string };

let msgSeq = 1;
function nextMsgId(prefix = "c"): string {
  return `${prefix}_${Date.now()}_${msgSeq++}`;
}

function buildTurnsFromEvents(events: readonly AgentEvent[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const ev of events) {
    if (ev.type === "prompt") {
      turns.push({ kind: "owner", text: ev.text });
    } else if (ev.type === "message") {
      const last = turns[turns.length - 1];
      if (last && last.kind === "agent") {
        last.text += ev.text;
      } else {
        turns.push({ kind: "agent", text: ev.text });
      }
    } else if (ev.type === "tool_call") {
      turns.push({ kind: "tool", title: ev.title, status: ev.status });
    } else if (ev.type === "error") {
      turns.push({ kind: "error", message: ev.message });
    }
  }
  return turns;
}

export default function ProjectChatPage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";
  const numericProjectId = Number(id);

  const [data, setData] = useState<ProjectChatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Which step is currently viewed in the main card
  const [selectedStep, setSelectedStep] = useState<ShapingStepId>("intake");
  const [isEditingIntake, setIsEditingIntake] = useState(false);
  const [isEditingSpec, setIsEditingSpec] = useState(false);
  const [isEditingMock, setIsEditingMock] = useState(false);
  const [isEditingPlan, setIsEditingPlan] = useState(false);

  // Intake form state
  const [problem, setProblem] = useState("");
  const [users, setUsers] = useState("");
  const [constraints, setConstraints] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [mustHaves, setMustHaves] = useState("");
  const [requester, setRequester] = useState("");
  const [deadline, setDeadline] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // T4.2 Spec interview state
  const [specSession, setSpecSession] = useState<SessionInfo | null>(null);
  const [specEvents, setSpecEvents] = useState<AgentEvent[]>([]);
  const [specInput, setSpecInput] = useState("");
  const [startingInterview, setStartingInterview] = useState(false);
  const [approvingSpec, setApprovingSpec] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);

  // T4.3 Mock session state
  const [selectedMockProvider, setSelectedMockProvider] = useState<"claude" | "antigravity">("claude");
  const [mockSession, setMockSession] = useState<SessionInfo | null>(null);
  const [mockEvents, setMockEvents] = useState<AgentEvent[]>([]);
  const [mockInput, setMockInput] = useState("");
  const [startingMock, setStartingMock] = useState(false);
  const [approvingMock, setApprovingMock] = useState(false);
  const [mockError, setMockError] = useState<string | null>(null);
  const [artifactUrl, setArtifactUrl] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [mockPreviewMode, setMockPreviewMode] = useState<"rendered" | "raw">("rendered");

  // T4.4 Plan generation & Start milestone state
  const [planSession, setPlanSession] = useState<SessionInfo | null>(null);
  const [planEvents, setPlanEvents] = useState<AgentEvent[]>([]);
  const [planInput, setPlanInput] = useState("");
  const [startingPlan, setStartingPlan] = useState(false);
  const [approvingPlan, setApprovingPlan] = useState(false);
  const [startingMilestone, setStartingMilestone] = useState(false);
  const [milestoneVersion, setMilestoneVersion] = useState("v1.0");
  const [planError, setPlanError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeSpecSessionIdRef = useRef<string | null>(null);
  const activeMockSessionIdRef = useRef<string | null>(null);
  const activePlanSessionIdRef = useRef<string | null>(null);
  const lastSpecSeqRef = useRef<number>(0);
  const lastMockSeqRef = useRef<number>(0);
  const lastPlanSeqRef = useRef<number>(0);

  activeSpecSessionIdRef.current = specSession?.id ?? null;
  activeMockSessionIdRef.current = mockSession?.id ?? null;
  activePlanSessionIdRef.current = planSession?.id ?? null;

  const refreshChatState = useCallback(async (targetProjectId: string, syncStep = false) => {
    const res = await fetch(`/api/projects/${targetProjectId}/chat`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load project chat (${res.status})`);
    }
    const json: ProjectChatData = await res.json();
    setData(json);

    if (syncStep) {
      const f = json.intake.fields || {};
      setProblem(f.problem || "");
      setUsers(f.users || "");
      setConstraints(f.constraints || "");
      setOutOfScope(f.outOfScope || "");
      setMustHaves(f.mustHaves || "");
      setRequester(f.requester || "Owner");
      setDeadline(f.deadline || "[OPEN]");

      if (!json.intake.exists) {
        setSelectedStep("intake");
        setIsEditingIntake(true);
      } else {
        setSelectedStep(json.currentStep);
        setIsEditingIntake(false);
        setIsEditingSpec(!json.spec.approved);
        setIsEditingMock(!json.mock.approved);
        setIsEditingPlan(!json.plan.approved);
      }

      if (json.mock.approval) {
        setArtifactUrl(json.mock.approval.artifactUrl || "");
        setApprovedBy(json.mock.approval.approvedBy || "");
      }
      if (json.plan.activeMilestone) {
        setMilestoneVersion(json.plan.activeMilestone.version);
      }
    }
    return json;
  }, []);

  const loadChat = useCallback(
    async (targetProjectId: string) => {
      try {
        setLoading(true);
        setFetchError(null);
        await refreshChatState(targetProjectId, true);
      } catch (err: unknown) {
        setFetchError(err instanceof Error ? err.message : "Failed to load project chat");
      } finally {
        setLoading(false);
      }
    },
    [refreshChatState],
  );

  useEffect(() => {
    if (id) {
      loadChat(id);
    }
  }, [id, loadChat]);

  const sendWs = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // Connect to /ws so Spec interview streams live agent events and refreshes SPEC.md on turn_end
  useEffect(() => {
    if (!id || Number.isNaN(numericProjectId)) return;
    let disposed = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      if (activeSpecSessionIdRef.current) {
        sendWs({
          id: nextMsgId("sub"),
          type: "subscribe",
          sessionId: activeSpecSessionIdRef.current,
          since: lastSpecSeqRef.current,
        });
      }
      if (activeMockSessionIdRef.current) {
        sendWs({
          id: nextMsgId("sub"),
          type: "subscribe",
          sessionId: activeMockSessionIdRef.current,
          since: lastMockSeqRef.current,
        });
      }
      if (activePlanSessionIdRef.current) {
        sendWs({
          id: nextMsgId("sub"),
          type: "subscribe",
          sessionId: activePlanSessionIdRef.current,
          since: lastPlanSeqRef.current,
        });
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === "sessions") {
          // Spec session check
          if (activeSpecSessionIdRef.current && !msg.sessions.some((s) => s.id === activeSpecSessionIdRef.current)) {
            activeSpecSessionIdRef.current = null;
            setSpecSession(null);
          }
          // Mock session check
          if (activeMockSessionIdRef.current && !msg.sessions.some((s) => s.id === activeMockSessionIdRef.current)) {
            activeMockSessionIdRef.current = null;
            setMockSession(null);
          }
          // Plan session check
          if (activePlanSessionIdRef.current && !msg.sessions.some((s) => s.id === activePlanSessionIdRef.current)) {
            activePlanSessionIdRef.current = null;
            setPlanSession(null);
          }
        } else if (msg.type === "event") {
          if (msg.sessionId === activeSpecSessionIdRef.current) {
            lastSpecSeqRef.current = msg.event.seq;
            setSpecEvents((prev) =>
              prev.some((e) => e.seq === msg.event.seq) ? prev : [...prev, msg.event],
            );
            if (msg.event.type === "prompt") {
              setSpecSession((prev) => (prev ? { ...prev, busy: true } : prev));
            } else if (msg.event.type === "turn_end" || msg.event.type === "tool_call_update") {
              if (msg.event.type === "turn_end") {
                setSpecSession((prev) => (prev ? { ...prev, busy: false } : prev));
              }
              void refreshChatState(id, false).catch(() => undefined);
            } else if (msg.event.type === "exit") {
              setSpecSession(null);
              activeSpecSessionIdRef.current = null;
              void refreshChatState(id, false).catch(() => undefined);
            }
          } else if (msg.sessionId === activeMockSessionIdRef.current) {
            lastMockSeqRef.current = msg.event.seq;
            setMockEvents((prev) =>
              prev.some((e) => e.seq === msg.event.seq) ? prev : [...prev, msg.event],
            );
            if (msg.event.type === "prompt") {
              setMockSession((prev) => (prev ? { ...prev, busy: true } : prev));
            } else if (msg.event.type === "turn_end" || msg.event.type === "tool_call_update") {
              if (msg.event.type === "turn_end") {
                setMockSession((prev) => (prev ? { ...prev, busy: false } : prev));
              }
              void refreshChatState(id, false).catch(() => undefined);
            } else if (msg.event.type === "exit") {
              setMockSession(null);
              activeMockSessionIdRef.current = null;
              void refreshChatState(id, false).catch(() => undefined);
            }
          } else if (msg.sessionId === activePlanSessionIdRef.current) {
            lastPlanSeqRef.current = msg.event.seq;
            setPlanEvents((prev) =>
              prev.some((e) => e.seq === msg.event.seq) ? prev : [...prev, msg.event],
            );
            if (msg.event.type === "prompt") {
              setPlanSession((prev) => (prev ? { ...prev, busy: true } : prev));
            } else if (msg.event.type === "turn_end" || msg.event.type === "tool_call_update") {
              if (msg.event.type === "turn_end") {
                setPlanSession((prev) => (prev ? { ...prev, busy: false } : prev));
              }
              void refreshChatState(id, false).catch(() => undefined);
            } else if (msg.event.type === "exit") {
              setPlanSession(null);
              activePlanSessionIdRef.current = null;
              void refreshChatState(id, false).catch(() => undefined);
            }
          }
        } else if (msg.type === "error") {
          if (selectedStep === "mock") {
            setMockError(msg.message);
          } else if (selectedStep === "plan") {
            setPlanError(msg.message);
          } else {
            setSpecError(msg.message);
          }
        }
      } catch {
        // ignore malformed message
      }
    };

    return () => {
      disposed = true;
      ws.close();
      wsRef.current = null;
    };
  }, [id, numericProjectId, refreshChatState, sendWs]);

  const handleStepClick = (step: StepInfo) => {
    if (step.status === "locked") return;
    setSelectedStep(step.id);
    if (step.id === "intake") {
      // Reopen finished steps read-only per SPEC
      setIsEditingIntake(false);
    } else if (step.id === "spec" && data?.spec.approved) {
      setIsEditingSpec(false);
    } else if (step.id === "mock" && data?.mock.approved) {
      setIsEditingMock(false);
    } else if (step.id === "plan" && data?.plan.approved) {
      setIsEditingPlan(false);
    }
  };

  const handleSaveIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!problem.trim() || !users.trim() || !constraints.trim()) {
      setSaveError("Please fill in Problem / Goal, Target users & context, and Constraints / stack.");
      return;
    }

    try {
      setSaving(true);
      setSaveError(null);

      const res = await postJson(`/api/projects/${id}/chat/intake`, {
        fields: {
          problem: problem.trim(),
          users: users.trim(),
          constraints: constraints.trim(),
          outOfScope: outOfScope.trim(),
          mustHaves: mustHaves.trim(),
          requester: requester.trim() || "Owner",
          deadline: deadline.trim() || "[OPEN]",
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to save intake (${res.status})`);
      }

      await loadChat(id);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to save intake");
    } finally {
      setSaving(false);
    }
  };

  const handleStartSpecInterview = async () => {
    try {
      setStartingInterview(true);
      setSpecError(null);
      const res = await postJson(`/api/projects/${id}/chat/spec`, { action: "start" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to start spec interview (${res.status})`);
      }
      const json = (await res.json()) as { session: SessionInfo; state: ProjectChatData };
      setSpecSession(json.session);
      activeSpecSessionIdRef.current = json.session.id;
      lastSpecSeqRef.current = 0;
      setSpecEvents([]);
      sendWs({ id: nextMsgId("sub"), type: "subscribe", sessionId: json.session.id, since: 0 });
      await refreshChatState(id, false);
    } catch (err: unknown) {
      setSpecError(err instanceof Error ? err.message : "Failed to start spec interview");
    } finally {
      setStartingInterview(false);
    }
  };

  const handleSendSpecPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = specInput.trim();
    if (!text || !specSession || specSession.busy) return;
    setSpecError(null);
    setSpecInput("");
    sendWs({ id: nextMsgId("pr"), type: "prompt", sessionId: specSession.id, text });
  };

  const handleAnswerPermission = (requestId: string, optionId: string) => {
    if (!specSession) return;
    sendWs({
      id: nextMsgId("perm"),
      type: "permission",
      sessionId: specSession.id,
      requestId,
      optionId,
    });
  };

  const handleApproveSpec = async () => {
    try {
      setApprovingSpec(true);
      setSpecError(null);
      const res = await postJson(`/api/projects/${id}/chat/spec`, { action: "approve" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to approve spec (${res.status})`);
      }
      setIsEditingSpec(false);
      await refreshChatState(id, true);
    } catch (err: unknown) {
      setSpecError(err instanceof Error ? err.message : "Failed to approve spec");
    } finally {
      setApprovingSpec(false);
    }
  };

  const handleStartMockSession = async () => {
    try {
      setStartingMock(true);
      setMockError(null);
      const res = await postJson(`/api/projects/${id}/chat/mock`, {
        action: "start",
        providerId: selectedMockProvider,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to start mock session (${res.status})`);
      }
      const json = (await res.json()) as { session: SessionInfo; state: ProjectChatData };
      setMockSession(json.session);
      activeMockSessionIdRef.current = json.session.id;
      lastMockSeqRef.current = 0;
      setMockEvents([]);
      sendWs({ id: nextMsgId("sub"), type: "subscribe", sessionId: json.session.id, since: 0 });
      await refreshChatState(id, false);
    } catch (err: unknown) {
      setMockError(err instanceof Error ? err.message : "Failed to start mock session");
    } finally {
      setStartingMock(false);
    }
  };

  const handleSendMockPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = mockInput.trim();
    if (!text || !mockSession || mockSession.busy) return;
    setMockError(null);
    setMockInput("");
    sendWs({ id: nextMsgId("pr"), type: "prompt", sessionId: mockSession.id, text });
  };

  const handleAnswerMockPermission = (requestId: string, optionId: string) => {
    if (!mockSession) return;
    sendWs({
      id: nextMsgId("perm"),
      type: "permission",
      sessionId: mockSession.id,
      requestId,
      optionId,
    });
  };

  const handleApproveMock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!artifactUrl.trim() || !approvedBy.trim()) {
      setMockError("Please fill in both the published Claude artifact link and the approver name.");
      return;
    }
    try {
      setApprovingMock(true);
      setMockError(null);
      const res = await postJson(`/api/projects/${id}/chat/mock`, {
        action: "approve",
        artifactUrl: artifactUrl.trim(),
        approvedBy: approvedBy.trim(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to approve mock (${res.status})`);
      }
      setIsEditingMock(false);
      await refreshChatState(id, true);
    } catch (err: unknown) {
      setMockError(err instanceof Error ? err.message : "Failed to approve mock");
    } finally {
      setApprovingMock(false);
    }
  };

  const handleStartPlanSession = async () => {
    try {
      setStartingPlan(true);
      setPlanError(null);
      const res = await postJson(`/api/projects/${id}/chat/plan`, { action: "start" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to start plan session (${res.status})`);
      }
      const json = (await res.json()) as { session: SessionInfo; state: ProjectChatData };
      setPlanSession(json.session);
      activePlanSessionIdRef.current = json.session.id;
      lastPlanSeqRef.current = 0;
      setPlanEvents([]);
      sendWs({ id: nextMsgId("sub"), type: "subscribe", sessionId: json.session.id, since: 0 });
      await refreshChatState(id, false);
    } catch (err: unknown) {
      setPlanError(err instanceof Error ? err.message : "Failed to start plan session");
    } finally {
      setStartingPlan(false);
    }
  };

  const handleSendPlanPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = planInput.trim();
    if (!text || !planSession || planSession.busy) return;
    setPlanError(null);
    setPlanInput("");
    sendWs({ id: nextMsgId("pr"), type: "prompt", sessionId: planSession.id, text });
  };

  const handleAnswerPlanPermission = (requestId: string, optionId: string) => {
    if (!planSession) return;
    sendWs({
      id: nextMsgId("perm"),
      type: "permission",
      sessionId: planSession.id,
      requestId,
      optionId,
    });
  };

  const handleApprovePlan = async () => {
    try {
      setApprovingPlan(true);
      setPlanError(null);
      const res = await postJson(`/api/projects/${id}/chat/plan`, { action: "approve" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to approve plan (${res.status})`);
      }
      setIsEditingPlan(false);
      await refreshChatState(id, true);
    } catch (err: unknown) {
      setPlanError(err instanceof Error ? err.message : "Failed to approve plan");
    } finally {
      setApprovingPlan(false);
    }
  };

  const handleStartMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setStartingMilestone(true);
      setPlanError(null);
      const res = await postJson(`/api/projects/${id}/chat/plan`, {
        action: "start-milestone",
        version: milestoneVersion.trim() || "v1.0",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to start milestone (${res.status})`);
      }
      await refreshChatState(id, true);
    } catch (err: unknown) {
      setPlanError(err instanceof Error ? err.message : "Failed to start milestone");
    } finally {
      setStartingMilestone(false);
    }
  };

  const providerBadgeClass = (provider: string) => {
    if (provider.includes("/")) return "provider-badge-mixed";
    if (provider === "Claude") return "provider-badge-claude";
    if (provider === "Antigravity") return "provider-badge-gemini";
    return "provider-badge-owner";
  };

  const chatTurns = useMemo(() => buildTurnsFromEvents(specEvents), [specEvents]);
  const pendingPermissions = useMemo(() => openPermissions(specEvents), [specEvents]);
  const mockChatTurns = useMemo(() => buildTurnsFromEvents(mockEvents), [mockEvents]);
  const pendingMockPermissions = useMemo(() => openPermissions(mockEvents), [mockEvents]);
  const planChatTurns = useMemo(() => buildTurnsFromEvents(planEvents), [planEvents]);
  const pendingPlanPermissions = useMemo(() => openPermissions(planEvents), [planEvents]);

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Project chat</h1>
          <p className="header-summary">
            {data
              ? `${data.project.name} · ${data.rules.label} profile (${data.rules.effectiveGemini ? "Claude + Gemini allowed" : "Claude only"})`
              : "Start a project by talking it through: intake, spec, mock and plan."}
          </p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      {loading && (
        <div className="empty-state-panel">
          <p className="empty-state-text">Loading project chat...</p>
        </div>
      )}

      {fetchError && (
        <div className="empty-state-panel" style={{ borderColor: "var(--danger)" }}>
          <p className="empty-state-text" style={{ color: "var(--danger)" }}>{fetchError}</p>
          <button type="button" className="btn-secondary" onClick={() => loadChat(id)}>Retry</button>
        </div>
      )}

      {!loading && !fetchError && data && (
        <div className="shaping-container">
          {/* 4-step Shaping Stepper */}
          <nav aria-label="Shaping steps" className="shaping-stepper">
            {data.steps.map((step, idx) => {
              const isSelected = selectedStep === step.id;
              const isCompleted = step.status === "completed";
              const isLocked = step.status === "locked";

              let btnClass = "shaping-step-btn";
              if (isSelected) btnClass += " active";
              if (isCompleted) btnClass += " completed";

              return (
                <button
                  key={step.id}
                  type="button"
                  className={btnClass}
                  disabled={isLocked}
                  onClick={() => handleStepClick(step)}
                  aria-current={isSelected ? "step" : undefined}
                >
                  <div className="shaping-step-indicator">
                    {isCompleted ? "✓" : idx + 1}
                  </div>
                  <div className="shaping-step-body">
                    <div className="shaping-step-heading">
                      <span className="shaping-step-title">{step.label}</span>
                      <span className={`provider-badge ${providerBadgeClass(step.provider)}`}>
                        {step.provider}
                      </span>
                    </div>
                    <span className="shaping-step-doc">{step.doc}</span>
                  </div>
                </button>
              );
            })}
          </nav>

          {/* Active Step Panel: Step 1 Intake */}
          {selectedStep === "intake" && (
            <div className="shaping-content-card">
              <div className="shaping-header-row">
                <div className="shaping-title-group">
                  <h2>Step 1: Intake</h2>
                  <p className="shaping-target-file">Target file: docs/INTAKE.md</p>
                </div>
                <div>
                  {data.intake.exists && !isEditingIntake ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setIsEditingIntake(true)}
                    >
                      Edit intake
                    </button>
                  ) : (
                    <span className="shaping-status-badge shaping-status-current">
                      {data.intake.exists ? "Editing" : "In Progress"}
                    </span>
                  )}
                </div>
              </div>

              {/* Edit Mode / New Intake Form */}
              {isEditingIntake || !data.intake.exists ? (
                <form onSubmit={handleSaveIntake} className="intake-form-grid">
                  <div className="intake-field">
                    <label className="intake-label" htmlFor="intake-problem">
                      Problem / Goal
                      <span className="intake-label-desc">— what is hard, missing, or needs to be built</span>
                    </label>
                    <textarea
                      id="intake-problem"
                      className="intake-textarea"
                      value={problem}
                      onChange={(e) => setProblem(e.target.value)}
                      placeholder="e.g. AI-assisted development is fragmented across multiple tools..."
                      required
                      rows={3}
                    />
                  </div>

                  <div className="intake-field">
                    <label className="intake-label" htmlFor="intake-users">
                      Target users &amp; context
                      <span className="intake-label-desc">— who uses it, on what devices</span>
                    </label>
                    <textarea
                      id="intake-users"
                      className="intake-textarea"
                      value={users}
                      onChange={(e) => setUsers(e.target.value)}
                      placeholder="e.g. Solo developer on Linux / WSL..."
                      required
                      rows={2}
                    />
                  </div>

                  <div className="intake-field">
                    <label className="intake-label" htmlFor="intake-constraints">
                      Constraints / stack
                      <span className="intake-label-desc">— stack, hosting, data, policy</span>
                    </label>
                    <textarea
                      id="intake-constraints"
                      className="intake-textarea"
                      value={constraints}
                      onChange={(e) => setConstraints(e.target.value)}
                      placeholder="e.g. Next.js + Node + TypeScript, local-only (127.0.0.1)..."
                      required
                      rows={2}
                    />
                  </div>

                  <div className="intake-field">
                    <label className="intake-label" htmlFor="intake-out-of-scope">
                      Out of scope
                      <span className="intake-label-desc">— what is explicitly deferred</span>
                    </label>
                    <textarea
                      id="intake-out-of-scope"
                      className="intake-textarea"
                      value={outOfScope}
                      onChange={(e) => setOutOfScope(e.target.value)}
                      placeholder="e.g. Multi-user accounts, cloud hosting..."
                      rows={2}
                    />
                  </div>

                  <div className="intake-field">
                    <label className="intake-label" htmlFor="intake-must-haves">
                      Must-haves
                      <span className="intake-label-desc">— key non-negotiables</span>
                    </label>
                    <textarea
                      id="intake-must-haves"
                      className="intake-textarea"
                      value={mustHaves}
                      onChange={(e) => setMustHaves(e.target.value)}
                      placeholder="e.g. Guided project chat, approval gates, task runner..."
                      rows={2}
                    />
                  </div>

                  {saveError && (
                    <div style={{ color: "var(--danger)", fontSize: "13px" }}>{saveError}</div>
                  )}

                  <div className="shaping-form-actions">
                    {data.intake.exists && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setIsEditingIntake(false);
                          setSaveError(null);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                    <button type="submit" className="btn-primary" disabled={saving}>
                      {saving ? "Saving..." : "Save intake"}
                    </button>
                  </div>
                </form>
              ) : (
                /* Read-only View of Intake */
                <div className="intake-readonly-grid">
                  <div className="intake-readonly-item">
                    <span className="intake-readonly-key">Problem / Goal</span>
                    <span className="intake-readonly-value">{problem || "—"}</span>
                  </div>
                  <div className="intake-readonly-item">
                    <span className="intake-readonly-key">Target users &amp; context</span>
                    <span className="intake-readonly-value">{users || "—"}</span>
                  </div>
                  <div className="intake-readonly-item">
                    <span className="intake-readonly-key">Constraints / stack</span>
                    <span className="intake-readonly-value">{constraints || "—"}</span>
                  </div>
                  {outOfScope && (
                    <div className="intake-readonly-item">
                      <span className="intake-readonly-key">Out of scope</span>
                      <span className="intake-readonly-value">{outOfScope}</span>
                    </div>
                  )}
                  {mustHaves && (
                    <div className="intake-readonly-item">
                      <span className="intake-readonly-key">Must-haves</span>
                      <span className="intake-readonly-value">{mustHaves}</span>
                    </div>
                  )}

                  <div className="shaping-form-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => setSelectedStep("spec")}
                    >
                      Advance to Spec interview →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Spec Interview Panel (T4.2) */}
          {selectedStep === "spec" && (
            <div className="shaping-content-card">
              <div className="shaping-header-row">
                <div className="shaping-title-group">
                  <h2>Step 2: Spec interview</h2>
                  <p className="shaping-target-file">Target file: docs/SPEC.md</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span className="provider-badge provider-badge-claude">Claude</span>
                  {data.spec.approved && !isEditingSpec ? (
                    <>
                      <span className="shaping-status-badge shaping-status-completed">Approved</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setIsEditingSpec(true)}
                      >
                        Reopen interview
                      </button>
                    </>
                  ) : (
                    <span className="shaping-status-badge shaping-status-current">In Progress</span>
                  )}
                </div>
              </div>

              {specError && (
                <div className="form-error" role="alert">
                  {specError}
                </div>
              )}

              {/* Read-only view when Spec has already been approved and is reopened */}
              {data.spec.approved && !isEditingSpec ? (
                <div className="intake-readonly-grid">
                  <div className="intake-readonly-item">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="intake-readonly-key">Approved specification (docs/SPEC.md)</span>
                      <span className="shaping-status-badge shaping-status-completed">## Verify section ready</span>
                    </div>
                    <pre className="spec-live-preview" data-testid="spec-readonly-content">
                      {data.spec.content || ""}
                    </pre>
                  </div>
                  <div className="shaping-form-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => setSelectedStep("mock")}
                    >
                      Advance to Mock →
                    </button>
                  </div>
                </div>
              ) : (
                /* Active Spec Interview + Live docs/SPEC.md Preview */
                <div className="spec-interview-grid">
                  {/* Left: Guided Claude session */}
                  <div className="spec-chat-pane">
                    <div className="spec-pane-header">
                      <span className="intake-readonly-key">Guided Claude interview</span>
                      {specSession && (
                        <span className="shaping-target-file">
                          {specSession.busy ? "Claude is working…" : "Waiting for your reply"}
                        </span>
                      )}
                    </div>

                    {!specSession ? (
                      <div className="spec-chat-empty">
                        <p style={{ color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
                          Start a guided Claude session in this project&apos;s folder. Claude reads{" "}
                          <code>docs/INTAKE.md</code>, interviews you, and updates <code>docs/SPEC.md</code> live.
                        </p>
                        <div>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={startingInterview}
                            onClick={handleStartSpecInterview}
                          >
                            {startingInterview ? "Starting Claude…" : "Start spec interview"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="spec-chat-transcript" role="log" aria-label="Spec interview transcript">
                          {chatTurns.length === 0 && (
                            <p style={{ color: "var(--muted)", fontSize: "13px", margin: 0 }}>
                              Starting interview from docs/INTAKE.md…
                            </p>
                          )}
                          {chatTurns.map((turn, idx) => (
                            <div
                              key={idx}
                              className={`spec-chat-bubble spec-chat-bubble-${turn.kind}`}
                            >
                              <span className="spec-chat-author">
                                {turn.kind === "owner"
                                  ? "You"
                                  : turn.kind === "agent"
                                    ? "Claude"
                                    : turn.kind === "tool"
                                      ? "Tool"
                                      : "Error"}
                              </span>
                              <div className="spec-chat-text">
                                {turn.kind === "tool"
                                  ? turn.title
                                  : turn.kind === "error"
                                    ? turn.message
                                    : turn.text}
                              </div>
                            </div>
                          ))}
                        </div>

                        {pendingPermissions.map((perm) => (
                          <div key={perm.requestId} className="permission-panel" role="group" aria-label={`Permission request: ${perm.title}`}>
                            <p className="permission-title">Claude asks to {perm.title}</p>
                            <div className="permission-actions">
                              {perm.options.map((opt) => {
                                const { label, variant } = optionStyle(opt);
                                const cls =
                                  variant === "primary"
                                    ? "btn-primary"
                                    : variant === "danger"
                                      ? "btn-danger-outline"
                                      : "btn-secondary";
                                return (
                                  <button
                                    key={opt.optionId}
                                    type="button"
                                    className={cls}
                                    onClick={() => handleAnswerPermission(perm.requestId, opt.optionId)}
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}

                        <form onSubmit={handleSendSpecPrompt} className="spec-chat-input-row">
                          <label htmlFor="spec-interview-input" className="sr-only">
                            Reply to Claude
                          </label>
                          <input
                            id="spec-interview-input"
                            type="text"
                            className="intake-input"
                            value={specInput}
                            onChange={(e) => setSpecInput(e.target.value)}
                            disabled={specSession.busy}
                            placeholder={
                              specSession.busy
                                ? "Claude is updating the spec…"
                                : "Answer Claude or ask for changes to docs/SPEC.md…"
                            }
                          />
                          <button
                            type="submit"
                            className="btn-primary"
                            disabled={specSession.busy || !specInput.trim()}
                          >
                            Send
                          </button>
                        </form>
                      </>
                    )}
                  </div>

                  {/* Right: Live docs/SPEC.md preview and ## Verify gate */}
                  <div className="spec-preview-pane">
                    <div className="spec-pane-header">
                      <span className="intake-readonly-key">Live docs/SPEC.md</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {data.spec.hasVerify ? (
                          <span className="shaping-status-badge shaping-status-completed">
                            ## Verify section ready
                          </span>
                        ) : (
                          <span className="shaping-status-badge shaping-status-locked">
                            Requires ## Verify section
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn-secondary-sm"
                          onClick={() => void refreshChatState(id, false)}
                        >
                          Refresh
                        </button>
                      </div>
                    </div>

                    {data.spec.exists && data.spec.content ? (
                      <pre className="spec-live-preview" data-testid="spec-live-content">
                        {data.spec.content}
                      </pre>
                    ) : (
                      <div className="spec-preview-empty">
                        <p style={{ color: "var(--muted)", margin: 0, fontSize: "13px" }}>
                          <code>docs/SPEC.md</code> will appear here live as Claude drafts it during the interview.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(!data.spec.approved || isEditingSpec) && (
                <div className="shaping-form-actions" style={{ justifyContent: "space-between" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setSelectedStep("intake");
                      setIsEditingIntake(false);
                    }}
                  >
                    Review Intake (read-only)
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    {data.spec.approved && isEditingSpec && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setIsEditingSpec(false)}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!data.spec.exists || !data.spec.hasVerify || approvingSpec}
                      onClick={handleApproveSpec}
                    >
                      {approvingSpec ? "Approving…" : "Approve spec"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Clickable HTML mock (T4.3) */}
          {selectedStep === "mock" && (
            <div className="shaping-content-card">
              <div className="shaping-header-row">
                <div className="shaping-title-group">
                  <h2>Step 3: Clickable HTML mock</h2>
                  <p className="shaping-target-file">Target file: docs/mock.html</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span className={`provider-badge ${providerBadgeClass(data.steps.find((s) => s.id === "mock")?.provider || "Claude")}`}>
                    {data.steps.find((s) => s.id === "mock")?.provider}
                  </span>
                  {data.mock.approved && !isEditingMock ? (
                    <>
                      <span className="shaping-status-badge shaping-status-completed">Approved</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setIsEditingMock(true)}
                      >
                        Reopen mock
                      </button>
                    </>
                  ) : (
                    <span className="shaping-status-badge shaping-status-current">
                      {data.mock.exists ? "In Progress" : "Waiting to build"}
                    </span>
                  )}
                </div>
              </div>

              {mockError && (
                <div className="form-error" role="alert">
                  {mockError}
                </div>
              )}

              {/* Read-only view when Mock is already approved and reopened */}
              {data.mock.approved && !isEditingMock ? (
                <div className="intake-readonly-grid">
                  <div className="mock-approval-summary">
                    <div className="intake-readonly-item">
                      <span className="intake-readonly-key">Published Claude artifact link</span>
                      <a
                        href={data.mock.approval?.artifactUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="mock-approved-link"
                        style={{ color: "var(--accent)", textDecoration: "underline", wordBreak: "break-all" }}
                      >
                        {data.mock.approval?.artifactUrl}
                      </a>
                    </div>
                    <div className="intake-readonly-item">
                      <span className="intake-readonly-key">Approved by</span>
                      <span data-testid="mock-approved-by" className="intake-readonly-value">
                        {data.mock.approval?.approvedBy}
                      </span>
                    </div>
                    <div className="intake-readonly-item">
                      <span className="intake-readonly-key">Approved at</span>
                      <span data-testid="mock-approved-at" className="intake-readonly-value">
                        {data.mock.approval?.approvedAt
                          ? new Date(data.mock.approval.approvedAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                  </div>

                  <div className="intake-readonly-item">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <span className="intake-readonly-key">Approved mock (docs/mock.html)</span>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="button"
                          className="btn-secondary-sm"
                          onClick={() => setMockPreviewMode((m) => (m === "rendered" ? "raw" : "rendered"))}
                        >
                          {mockPreviewMode === "rendered" ? "Show raw HTML" : "Show rendered preview"}
                        </button>
                      </div>
                    </div>
                    {mockPreviewMode === "rendered" ? (
                      <iframe
                        data-testid="mock-readonly-iframe"
                        className="mock-iframe-preview"
                        srcDoc={data.mock.content || ""}
                        sandbox=""
                        title="Approved mock preview"
                      />
                    ) : (
                      <pre className="spec-live-preview" data-testid="mock-readonly-raw">
                        {data.mock.content || ""}
                      </pre>
                    )}
                  </div>

                  <div className="shaping-form-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => setSelectedStep("plan")}
                    >
                      Advance to Plan →
                    </button>
                  </div>
                </div>
              ) : (
                /* Active Mock Builder: Two-pane Mock builder & live preview + Approval gate form */
                <>
                  <div className="spec-interview-grid">
                    {/* Left pane: Guided Mock chat session */}
                    <div className="spec-chat-pane">
                      <div className="spec-pane-header">
                        <span className="intake-readonly-key">Mock builder session</span>
                        {mockSession && (
                          <span className="shaping-target-file">
                            {mockSession.busy ? "Agent is working…" : "Waiting for your reply"}
                          </span>
                        )}
                      </div>

                      {!mockSession ? (
                        <div className="spec-chat-empty">
                          <p style={{ color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
                            Build a clickable HTML mock (<code>docs/mock.html</code>) from{" "}
                            <code>docs/SPEC.md</code>. Free revisions in this chat until you approve.
                          </p>

                          {/* Provider Selector */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <span className="intake-label-desc">Choose provider:</span>
                            {data.mock.allowedProviders.length === 1 ? (
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <span className="provider-badge provider-badge-claude">Claude</span>
                                <span style={{ color: "var(--muted)", fontSize: "12px" }}>
                                  {data.project.profile === "work"
                                    ? "Work projects: Claude only (Gemini off by policy)"
                                    : "Claude only (Gemini disabled for this client)"}
                                </span>
                              </div>
                            ) : (
                              <div className="provider-selector-group" role="radiogroup" aria-label="Provider choice">
                                <label className={`provider-radio-option ${selectedMockProvider === "claude" ? "selected" : ""}`}>
                                  <input
                                    type="radio"
                                    name="mockProvider"
                                    value="claude"
                                    checked={selectedMockProvider === "claude"}
                                    onChange={() => setSelectedMockProvider("claude")}
                                  />
                                  <span>Claude</span>
                                </label>
                                <label className={`provider-radio-option ${selectedMockProvider === "antigravity" ? "selected" : ""}`}>
                                  <input
                                    type="radio"
                                    name="mockProvider"
                                    value="antigravity"
                                    checked={selectedMockProvider === "antigravity"}
                                    onChange={() => setSelectedMockProvider("antigravity")}
                                  />
                                  <span>Antigravity</span>
                                </label>
                              </div>
                            )}
                          </div>

                          <div>
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={startingMock}
                              onClick={handleStartMockSession}
                            >
                              {startingMock ? "Starting session…" : "Start mock session"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="spec-chat-transcript" role="log" aria-label="Mock chat transcript">
                            {mockChatTurns.length === 0 && (
                              <p style={{ color: "var(--muted)", fontSize: "13px", margin: 0 }}>
                                Generating initial clickable HTML mock in docs/mock.html…
                              </p>
                            )}
                            {mockChatTurns.map((turn, idx) => (
                              <div
                                key={idx}
                                className={`spec-chat-bubble spec-chat-bubble-${turn.kind}`}
                              >
                                <span className="spec-chat-author">
                                  {turn.kind === "owner"
                                    ? "You"
                                    : turn.kind === "agent"
                                      ? mockSession.providerId === "antigravity"
                                        ? "Antigravity"
                                        : "Claude"
                                      : turn.kind === "tool"
                                        ? "Tool"
                                        : "Error"}
                                </span>
                                <div className="spec-chat-text">
                                  {turn.kind === "tool"
                                    ? turn.title
                                    : turn.kind === "error"
                                      ? turn.message
                                      : turn.text}
                                </div>
                              </div>
                            ))}
                          </div>

                          {pendingMockPermissions.map((perm) => (
                            <div key={perm.requestId} className="permission-panel" role="group" aria-label={`Permission request: ${perm.title}`}>
                              <p className="permission-title">Agent asks to {perm.title}</p>
                              <div className="permission-actions">
                                {perm.options.map((opt) => {
                                  const { label, variant } = optionStyle(opt);
                                  const cls =
                                    variant === "primary"
                                      ? "btn-primary"
                                      : variant === "danger"
                                        ? "btn-danger-outline"
                                        : "btn-secondary";
                                  return (
                                    <button
                                      key={opt.optionId}
                                      type="button"
                                      className={cls}
                                      onClick={() => handleAnswerMockPermission(perm.requestId, opt.optionId)}
                                    >
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}

                          <form onSubmit={handleSendMockPrompt} className="spec-chat-input-row">
                            <label htmlFor="mock-chat-input" className="sr-only">
                              Reply or request revision
                            </label>
                            <input
                              id="mock-chat-input"
                              type="text"
                              className="intake-input"
                              value={mockInput}
                              onChange={(e) => setMockInput(e.target.value)}
                              disabled={mockSession.busy}
                              placeholder={
                                mockSession.busy
                                  ? "Agent is revising the mock…"
                                  : "Ask for revisions to docs/mock.html…"
                              }
                            />
                            <button
                              type="submit"
                              className="btn-primary"
                              disabled={mockSession.busy || !mockInput.trim()}
                            >
                              Send
                            </button>
                          </form>
                        </>
                      )}
                    </div>

                    {/* Right pane: Live docs/mock.html preview */}
                    <div className="spec-preview-pane">
                      <div className="spec-pane-header">
                        <span className="intake-readonly-key">Live docs/mock.html</span>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {data.mock.exists ? (
                            <span className="shaping-status-badge shaping-status-completed">
                              Mock ready
                            </span>
                          ) : (
                            <span className="shaping-status-badge shaping-status-locked">
                              Awaiting build
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn-secondary-sm"
                            onClick={() => setMockPreviewMode((m) => (m === "rendered" ? "raw" : "rendered"))}
                          >
                            {mockPreviewMode === "rendered" ? "Raw HTML" : "Preview"}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary-sm"
                            onClick={() => void refreshChatState(id, false)}
                          >
                            Refresh
                          </button>
                        </div>
                      </div>

                      {data.mock.exists && data.mock.content ? (
                        mockPreviewMode === "rendered" ? (
                          <iframe
                            data-testid="mock-live-iframe"
                            className="mock-iframe-preview"
                            srcDoc={data.mock.content}
                            sandbox=""
                            title="Live mock preview"
                          />
                        ) : (
                          <pre className="spec-live-preview" data-testid="mock-raw-preview">
                            <code>{data.mock.content}</code>
                          </pre>
                        )
                      ) : (
                        <div className="spec-preview-empty">
                          <p style={{ color: "var(--muted)", margin: 0, fontSize: "13px" }}>
                            <code>docs/mock.html</code> will appear here live once generated by the agent.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Mock Approval Gate Form */}
                  <form onSubmit={handleApproveMock} className="mock-approval-gate-card">
                    <div className="mock-approval-gate-header">
                      <div>
                        <div className="mock-approval-gate-title">Mock Approval Gate</div>
                        <p style={{ color: "var(--muted)", fontSize: "12px", margin: "2px 0 0 0" }}>
                          Publish the mock as a Claude artifact, paste the link and record who approved it. Build and Plan stay locked until approved.
                        </p>
                      </div>
                      {!data.mock.exists && (
                        <span className="shaping-status-badge shaping-status-locked">
                          Requires docs/mock.html
                        </span>
                      )}
                    </div>

                    <div className="mock-approval-form-grid">
                      <div>
                        <label className="intake-label" htmlFor="mock-artifact-url">
                          Published Claude artifact link
                        </label>
                        <input
                          id="mock-artifact-url"
                          type="url"
                          className="intake-input"
                          placeholder="https://claude.site/artifacts/..."
                          value={artifactUrl}
                          onChange={(e) => setArtifactUrl(e.target.value)}
                          required
                        />
                      </div>
                      <div>
                        <label className="intake-label" htmlFor="mock-approved-by">
                          Approved by
                        </label>
                        <input
                          id="mock-approved-by"
                          type="text"
                          className="intake-input"
                          placeholder="e.g. Carls"
                          value={approvedBy}
                          onChange={(e) => setApprovedBy(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="shaping-form-actions" style={{ justifyContent: "space-between" }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setSelectedStep("spec")}
                      >
                        ← Back to Spec
                      </button>
                      <div style={{ display: "flex", gap: "10px" }}>
                        {data.mock.approved && isEditingMock && (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setIsEditingMock(false)}
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          type="submit"
                          className="btn-primary"
                          disabled={
                            !data.mock.exists ||
                            !artifactUrl.trim() ||
                            !approvedBy.trim() ||
                            approvingMock
                          }
                        >
                          {approvingMock ? "Recording approval…" : "Approve mock"}
                        </button>
                      </div>
                    </div>
                  </form>
                </>
              )}
            </div>
          )}

          {/* Step 4: Plan Panel (T4.4) */}
          {selectedStep === "plan" && (
            <div className="shaping-content-card">
              <div className="shaping-header-row">
                <div className="shaping-title-group">
                  <h2>Step 4: Plan generation and Start milestone</h2>
                  <p className="shaping-target-file">Target file: docs/PLAN.md</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span className="provider-badge provider-badge-claude">Claude</span>
                  {data.plan.activeMilestone ? (
                    <span className="shaping-status-badge shaping-status-completed" data-testid="milestone-frozen-badge">
                      Scope frozen · {data.plan.activeMilestone.branch}
                    </span>
                  ) : data.plan.approved && !isEditingPlan ? (
                    <>
                      <span className="shaping-status-badge shaping-status-completed">Plan approved</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setIsEditingPlan(true)}
                      >
                        Reopen plan
                      </button>
                    </>
                  ) : (
                    <span className="shaping-status-badge shaping-status-current">
                      {data.plan.exists ? "In Progress" : "Waiting to generate"}
                    </span>
                  )}
                </div>
              </div>

              {planError && (
                <div className="form-error" role="alert">
                  {planError}
                </div>
              )}

              {/* Approved Plan & Start Milestone View */}
              {data.plan.approved && !isEditingPlan ? (
                <div className="intake-readonly-grid">
                  {data.plan.activeMilestone ? (
                    <div className="mock-approval-gate-card" data-testid="milestone-active-card">
                      <div className="mock-approval-gate-header">
                        <div>
                          <div className="mock-approval-gate-title">
                            Milestone {data.plan.activeMilestone.version} active — Scope frozen
                          </div>
                          <p style={{ color: "var(--ink-2)", fontSize: "13px", margin: "4px 0 0 0" }}>
                            Release branch{" "}
                            <code data-testid="milestone-branch-name">{data.plan.activeMilestone.branch}</code> created
                            from <code>{data.project.defaultBranch}</code>. Further changes go through Change requests.
                          </p>
                        </div>
                        <a href={`/projects/${id}/pipeline`} className="btn-primary">
                          Open pipeline →
                        </a>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleStartMilestone} className="mock-approval-gate-card">
                      <div className="mock-approval-gate-header">
                        <div>
                          <div className="mock-approval-gate-title">Start milestone</div>
                          <p style={{ color: "var(--muted)", fontSize: "12px", margin: "2px 0 0 0" }}>
                            Creates release branch{" "}
                            <code>
                              daedalus/release-
                              {(milestoneVersion.trim() || "v1.0").startsWith("v")
                                ? milestoneVersion.trim() || "v1.0"
                                : `v${milestoneVersion.trim()}`}
                            </code>{" "}
                            from <code>{data.project.defaultBranch}</code> and freezes this milestone&apos;s scope.
                          </p>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "flex-end", gap: "12px", flexWrap: "wrap" }}>
                        <div style={{ flex: "1 1 220px" }}>
                          <label className="intake-label" htmlFor="milestone-version-input">
                            Release version
                          </label>
                          <input
                            id="milestone-version-input"
                            type="text"
                            className="intake-input"
                            value={milestoneVersion}
                            onChange={(e) => setMilestoneVersion(e.target.value)}
                            placeholder="v1.0"
                            required
                          />
                        </div>
                        <button
                          type="submit"
                          className="btn-primary"
                          disabled={startingMilestone || !milestoneVersion.trim()}
                        >
                          {startingMilestone ? "Starting milestone…" : "Start milestone"}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="intake-readonly-item">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="intake-readonly-key">Approved plan (docs/PLAN.md)</span>
                      <span className="shaping-status-badge shaping-status-completed">Saved in repo</span>
                    </div>
                    <pre className="spec-live-preview" data-testid="plan-readonly-content">
                      {data.plan.content || ""}
                    </pre>
                  </div>
                </div>
              ) : (
                /* Active Plan Generation + Live docs/PLAN.md Preview */
                <>
                  <div className="spec-interview-grid">
                    {/* Left pane: Guided Claude Plan Session */}
                    <div className="spec-chat-pane">
                      <div className="spec-pane-header">
                        <span className="intake-readonly-key">Guided Claude plan session</span>
                        {planSession && (
                          <span className="shaping-target-file">
                            {planSession.busy ? "Claude is working…" : "Waiting for your reply"}
                          </span>
                        )}
                      </div>

                      {!planSession ? (
                        <div className="spec-chat-empty">
                          <p style={{ color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
                            Claude writes <code>docs/PLAN.md</code> grouped into milestones (one milestone = one
                            release), each with &ldquo;Done when&rdquo; UAT items and tasks tagged{" "}
                            <code>[claude]</code>, <code>[gemini]</code>, or <code>[you]</code>.
                          </p>
                          <div>
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={startingPlan}
                              onClick={handleStartPlanSession}
                            >
                              {startingPlan ? "Starting Claude…" : "Start plan generation"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="spec-chat-transcript" role="log" aria-label="Plan chat transcript">
                            {planChatTurns.length === 0 && (
                              <p style={{ color: "var(--muted)", fontSize: "13px", margin: 0 }}>
                                Generating docs/PLAN.md from docs/SPEC.md…
                              </p>
                            )}
                            {planChatTurns.map((turn, idx) => (
                              <div
                                key={idx}
                                className={`spec-chat-bubble spec-chat-bubble-${turn.kind}`}
                              >
                                <span className="spec-chat-author">
                                  {turn.kind === "owner"
                                    ? "You"
                                    : turn.kind === "agent"
                                      ? "Claude"
                                      : turn.kind === "tool"
                                        ? "Tool"
                                        : "Error"}
                                </span>
                                <div className="spec-chat-text">
                                  {turn.kind === "tool"
                                    ? turn.title
                                    : turn.kind === "error"
                                      ? turn.message
                                      : turn.text}
                                </div>
                              </div>
                            ))}
                          </div>

                          {pendingPlanPermissions.map((perm) => (
                            <div
                              key={perm.requestId}
                              className="permission-panel"
                              role="group"
                              aria-label={`Permission request: ${perm.title}`}
                            >
                              <p className="permission-title">Claude asks to {perm.title}</p>
                              <div className="permission-actions">
                                {perm.options.map((opt) => {
                                  const { label, variant } = optionStyle(opt);
                                  const cls =
                                    variant === "primary"
                                      ? "btn-primary"
                                      : variant === "danger"
                                        ? "btn-danger-outline"
                                        : "btn-secondary";
                                  return (
                                    <button
                                      key={opt.optionId}
                                      type="button"
                                      className={cls}
                                      onClick={() => handleAnswerPlanPermission(perm.requestId, opt.optionId)}
                                    >
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}

                          <form onSubmit={handleSendPlanPrompt} className="spec-chat-input-row">
                            <label htmlFor="plan-chat-input" className="sr-only">
                              Ask Claude to change the plan
                            </label>
                            <input
                              id="plan-chat-input"
                              type="text"
                              className="intake-input"
                              value={planInput}
                              onChange={(e) => setPlanInput(e.target.value)}
                              disabled={planSession.busy}
                              placeholder={
                                planSession.busy
                                  ? "Claude is updating docs/PLAN.md…"
                                  : "Ask Claude to change milestones or tasks in docs/PLAN.md…"
                              }
                            />
                            <button
                              type="submit"
                              className="btn-primary"
                              disabled={planSession.busy || !planInput.trim()}
                            >
                              Send
                            </button>
                          </form>
                        </>
                      )}
                    </div>

                    {/* Right pane: Live docs/PLAN.md preview */}
                    <div className="spec-preview-pane">
                      <div className="spec-pane-header">
                        <span className="intake-readonly-key">Live docs/PLAN.md</span>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {data.plan.valid ? (
                            <span className="shaping-status-badge shaping-status-completed">
                              Plan structure valid
                            </span>
                          ) : (
                            <span className="shaping-status-badge shaping-status-locked">
                              Requires milestones, Done when &amp; tasks
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn-secondary-sm"
                            onClick={() => void refreshChatState(id, false)}
                          >
                            Refresh
                          </button>
                        </div>
                      </div>

                      {data.plan.exists && data.plan.content ? (
                        <pre className="spec-live-preview" data-testid="plan-live-content">
                          {data.plan.content}
                        </pre>
                      ) : (
                        <div className="spec-preview-empty">
                          <p style={{ color: "var(--muted)", margin: 0, fontSize: "13px" }}>
                            <code>docs/PLAN.md</code> will appear here live as Claude drafts milestones and tasks.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="shaping-form-actions" style={{ justifyContent: "space-between" }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setSelectedStep("mock");
                        setIsEditingMock(false);
                      }}
                    >
                      ← Back to Mock
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      {data.plan.approved && isEditingPlan && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setIsEditingPlan(false)}
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!data.plan.exists || !data.plan.valid || approvingPlan}
                        onClick={handleApprovePlan}
                      >
                        {approvingPlan ? "Saving plan…" : "Approve plan"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
