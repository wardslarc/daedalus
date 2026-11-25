"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";
import { postJson } from "../../../../csrf-fetch";
import type { GateCheckStatus, ReleaseGateData } from "@daedalus/projects";

type FindingItem = ReleaseGateData["findings"][number];

export default function ReleaseGatePage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  const [gate, setGate] = useState<ReleaseGateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Run checks button state
  const [runningChecks, setRunningChecks] = useState(false);

  // Active dialog state: findingId -> { type: "fix" | "accept" | "defer", input: string, busy: boolean }
  const [activeDialog, setActiveDialog] = useState<{
    findingId: number;
    type: "fix" | "accept" | "defer";
    input: string;
    busy: boolean;
  } | null>(null);

  // Checklist item toggle state
  const [togglingItems, setTogglingItems] = useState<Record<string, boolean>>({});

  // UAT App config state
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configCmd, setConfigCmd] = useState("");
  const [configUrl, setConfigUrl] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  // UAT Session state
  const [sessionBusy, setSessionBusy] = useState(false);

  // UAT Fail mark dialog state
  const [markDialog, setMarkDialog] = useState<{
    itemId: number;
    itemText: string;
    note: string;
    kind: "bug" | "change";
    checkCommand: string;
    busy: boolean;
  } | null>(null);

  // Add from spec state
  const [specInput, setSpecInput] = useState("");
  const [addingSpecItem, setAddingSpecItem] = useState(false);

  // UAT Scripts state (T6.5)
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [expandedScripts, setExpandedScripts] = useState<Record<number, boolean>>({});
  const [scriptDialog, setScriptDialog] = useState<{
    scriptId: number;
    type: "replace" | "retire";
    reason: string;
    busy: boolean;
  } | null>(null);

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const loadGate = useCallback(
    async (showLoading = false) => {
      if (!id) return;
      try {
        if (showLoading) setLoading(true);
        setError(null);
        const res = await fetch(`/api/projects/${id}/release`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to load release gate: ${res.statusText}`);
        }
        const data = (await res.json()) as ReleaseGateData;
        setGate(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error loading release gate");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    loadGate(true);
  }, [loadGate]);

  // Polling every 3s while gate status is "running", runningChecks, session starting, recording, or replaying
  useEffect(() => {
    const isRunning =
      gate?.status === "running" ||
      runningChecks ||
      gate?.uat?.session?.status === "starting" ||
      Boolean(gate?.uat?.recording?.active) ||
      gate?.uat?.replay?.status === "running";
    if (isRunning) {
      pollTimerRef.current = setTimeout(() => {
        loadGate(false);
      }, 3000);
    } else {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [
    gate?.status,
    gate?.uat?.session?.status,
    gate?.uat?.recording?.active,
    gate?.uat?.replay?.status,
    runningChecks,
    loadGate,
  ]);

  useEffect(() => {
    if (gate?.uat?.config) {
      setConfigCmd(gate.uat.config.startCommand);
      setConfigUrl(gate.uat.config.appUrl);
    }
  }, [gate?.uat?.config]);

  // Handle UAT app config save
  const handleSaveConfig = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!id || savingConfig) return;
    try {
      setSavingConfig(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/config`, {
        startCommand: configCmd,
        appUrl: configUrl,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to save UAT app config.");
      } else {
        setActionSuccess("UAT app config saved.");
        setConfigModalOpen(false);
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save config.");
    } finally {
      setSavingConfig(false);
    }
  };

  // Handle UAT session start
  const handleStartUatSession = async () => {
    if (!id || sessionBusy) return;
    try {
      setSessionBusy(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/start`, {});
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to start UAT session.");
      } else {
        setActionSuccess("UAT browser session started.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start session.");
    } finally {
      setSessionBusy(false);
    }
  };

  // Handle UAT session stop
  const handleStopUatSession = async () => {
    if (!id || sessionBusy) return;
    try {
      setSessionBusy(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/stop`, {});
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to stop UAT session.");
      } else {
        setActionSuccess("UAT session stopped. Recordings saved.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to stop session.");
    } finally {
      setSessionBusy(false);
    }
  };

  // Handle UAT screenshot
  const handleTakeScreenshot = async () => {
    if (!id || sessionBusy) return;
    try {
      setSessionBusy(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/screenshot`, {});
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to capture screenshot.");
      } else {
        setActionSuccess(`Screenshot captured: ${body.name}`);
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to capture screenshot.");
    } finally {
      setSessionBusy(false);
    }
  };

  // Handle pass UAT item
  const handlePassItem = async (itemId: number) => {
    if (!id) return;
    const headSha = gate?.headSha ?? gate?.latestRun?.headSha ?? "";
    try {
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/items/${itemId}/mark`, {
        result: "pass",
        headSha,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to mark item pass.");
      } else {
        setActionSuccess("Item marked as pass.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to mark item pass.");
    }
  };

  // Handle fail UAT item submit
  const handleFailSubmit = async () => {
    if (!id || !markDialog || markDialog.busy) return;
    const headSha = gate?.headSha ?? gate?.latestRun?.headSha ?? "";
    if (!markDialog.note.trim()) {
      setActionError("Note is required for fail marks (1-2000 chars).");
      return;
    }
    if (markDialog.kind === "bug" && !markDialog.checkCommand.trim()) {
      setActionError("Check command is required for bug fix task.");
      return;
    }

    try {
      setMarkDialog((prev) => (prev ? { ...prev, busy: true } : null));
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/items/${markDialog.itemId}/mark`, {
        result: "fail",
        note: markDialog.note.trim(),
        kind: markDialog.kind,
        checkCommand: markDialog.kind === "bug" ? markDialog.checkCommand.trim() : undefined,
        headSha,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to record fail mark.");
      } else {
        setMarkDialog(null);
        setActionSuccess(
          markDialog.kind === "bug"
            ? "Fix task created for UAT item."
            : "Change request logged for UAT item.",
        );
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to record fail mark.");
    } finally {
      setMarkDialog((prev) => (prev ? { ...prev, busy: false } : null));
    }
  };

  // Handle add item from spec
  const handleAddSpecItem = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!id || addingSpecItem || !specInput.trim()) return;
    try {
      setAddingSpecItem(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/items`, {
        text: specInput.trim(),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to add item from spec.");
      } else {
        setSpecInput("");
        setActionSuccess("UAT item added from approved spec.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add item from spec.");
    } finally {
      setAddingSpecItem(false);
    }
  };

  // Handle Record script for a UAT item (T6.5)
  const handleRecordScript = async (itemId: number) => {
    if (!id || recordingBusy) return;
    try {
      setRecordingBusy(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/uat/scripts/record`, {
        itemId,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to start script recording.");
      } else {
        setActionSuccess("Playwright codegen started. Close the recorder window when done.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start script recording.");
    } finally {
      setRecordingBusy(false);
    }
  };

  // Handle Replace / Retire script dialog submit (T6.5)
  const handleScriptDialogSubmit = async () => {
    if (!id || !scriptDialog || scriptDialog.busy) return;
    const trimmed = scriptDialog.reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setActionError("Reason must be between 1 and 500 characters.");
      return;
    }

    try {
      setScriptDialog((prev) => (prev ? { ...prev, busy: true } : null));
      setActionError(null);
      setActionSuccess(null);

      const endpoint =
        scriptDialog.type === "replace"
          ? `/api/projects/${id}/release/uat/scripts/${scriptDialog.scriptId}/replace`
          : `/api/projects/${id}/release/uat/scripts/${scriptDialog.scriptId}/retire`;

      const res = await postJson(endpoint, { reason: trimmed });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || `Failed to ${scriptDialog.type} script.`);
      } else {
        const wasReplace = scriptDialog.type === "replace";
        setScriptDialog(null);
        setActionSuccess(
          wasReplace
            ? "Playwright codegen started for replacement script. Close the recorder window when done."
            : "UAT script retired.",
        );
        await loadGate(false);
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Failed to ${scriptDialog.type} script.`,
      );
    } finally {
      setScriptDialog((prev) => (prev ? { ...prev, busy: false } : null));
    }
  };

  // Handle "Run checks"
  const handleRunChecks = async () => {
    if (!id || runningChecks || gate?.status === "running") return;
    try {
      setRunningChecks(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/release/run`, {});
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to start checks.");
      } else {
        setActionSuccess("Gate checks started.");
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start checks.");
    } finally {
      setRunningChecks(false);
    }
  };

  // Handle checklist checkbox toggle
  const handleToggleChecklist = async (itemId: string, currentTicked: boolean) => {
    if (!id || togglingItems[itemId]) return;
    try {
      setTogglingItems((prev) => ({ ...prev, [itemId]: true }));
      setActionError(null);
      const res = await postJson(`/api/projects/${id}/release/checklist/${itemId}`, {
        ticked: !currentTicked,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to update checklist item.");
      } else {
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update checklist item.");
    } finally {
      setTogglingItems((prev) => ({ ...prev, [itemId]: false }));
    }
  };

  // Handle finding decision submission
  const handleDialogSubmit = async () => {
    if (!id || !activeDialog || activeDialog.busy) return;
    const { findingId, type, input } = activeDialog;

    if (type === "fix") {
      if (!input.trim()) {
        setActionError("Check command cannot be empty.");
        return;
      }
      if (input.trim().length > 500) {
        setActionError("Check command must be at most 500 characters.");
        return;
      }
    } else {
      if (input.trim().length < 10) {
        setActionError("Reason must be at least 10 characters.");
        return;
      }
    }

    try {
      setActiveDialog((prev) => (prev ? { ...prev, busy: true } : null));
      setActionError(null);
      setActionSuccess(null);

      const payload =
        type === "fix"
          ? { outcome: "fix-task", checkCommand: input.trim() }
          : { outcome: type, reason: input.trim() };

      const res = await postJson(`/api/projects/${id}/release/findings/${findingId}/decide`, payload);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to record decision.");
      } else {
        setActiveDialog(null);
        setActionSuccess(
          type === "fix"
            ? "Fix task created."
            : `Finding ${type === "accept" ? "accepted" : "deferred"}.`,
        );
        await loadGate(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to record decision.");
    } finally {
      setActiveDialog((prev) => (prev ? { ...prev, busy: false } : null));
    }
  };

  const isVerifyStage = gate?.stage === "verify";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Release gate</h1>
          <p className="header-summary">
            UAT, security checks and your acceptance before a release ships.
          </p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      {loading ? (
        <div className="review-loading-panel">
          <p>Loading release gate…</p>
        </div>
      ) : error ? (
        <div className="review-error-panel" role="alert">
          <p>{error}</p>
        </div>
      ) : !isVerifyStage ? (
        /* Before Verify stage: show short notice with count done/total */
        <div className="empty-state-panel">
          <p className="empty-state-text">
            Release moves to Verify when every task of{" "}
            {gate?.milestoneTasksSummary?.milestoneCode ?? "the active milestone"} is merged
            {gate?.milestoneTasksSummary
              ? ` (${gate.milestoneTasksSummary.done}/${gate.milestoneTasksSummary.total} tasks merged)`
              : ""}
            .
          </p>
          <span className="empty-state-milestone">Stage: Build</span>
        </div>
      ) : (
        /* In Verify stage: banner, run checks button, checks list, checklist, findings */
        <div className="release-layout">
          {/* 1. Status Banner */}
          <div className={`release-banner banner-${gate.status}`} role="status">
            <div>
              <div className="release-banner-title">{formatStatusTitle(gate.status)}</div>
              <div className="release-banner-subtitle">{gate.blockedReason ?? formatStatusSubtitle(gate.status)}</div>
            </div>
            <div className="release-banner-status-badge">{gate.status}</div>
          </div>

          {actionError && (
            <div className="review-alert review-alert-error" role="alert">
              {actionError}
            </div>
          )}
          {actionSuccess && (
            <div className="review-alert review-alert-success" role="status">
              {actionSuccess}
            </div>
          )}

          {/* 2. Actions & Head bar */}
          <div className="release-actions-bar">
            <div className="release-head-info">
              Release: <strong>{gate.version ?? "unknown"}</strong> · Branch:{" "}
              <code>{gate.branch ?? "unknown"}</code>
              {gate.latestRun && (
                <>
                  {" "}
                  · Head SHA: <code>{gate.latestRun.headSha.slice(0, 8)}</code>
                </>
              )}
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={runningChecks || gate.status === "running"}
              onClick={handleRunChecks}
            >
              {gate.status === "running" || runningChecks ? "Running checks…" : "Run checks"}
            </button>
          </div>

          {/* 3. Automatic Security Checks */}
          <section className="release-section" aria-label="Automatic security checks">
            <div className="release-section-header">
              <h2>Automatic checks</h2>
              {gate.latestRun?.finishedAt && (
                <span className="review-gate-ack-time">
                  Last run: {new Date(gate.latestRun.finishedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            <div className="release-checks-list">
              <CheckRow
                name="Secret scan"
                status={gate.checks?.secrets?.status}
                detail={gate.checks?.secrets?.detail}
              />
              <CheckRow
                name="Dependency audit"
                status={gate.checks?.dependencies?.status}
                detail={gate.checks?.dependencies?.detail}
              />
              <CheckRow
                name="Saved security tests"
                status={gate.checks?.securityTests?.status}
                detail={gate.checks?.securityTests?.detail}
              />
              <CheckRow
                name="Ship checklist"
                status={gate.checks?.checklist?.status}
                detail={gate.checks?.checklist?.detail}
              />
              <CheckRow
                name="UAT"
                status={gate.checks?.uat?.status ?? gate.uat?.gateLine?.status}
                detail={gate.checks?.uat?.detail ?? gate.uat?.gateLine?.detail}
              />
            </div>
          </section>

          {/* 4. Ship Checklist */}
          <section className="release-section" aria-label="Ship checklist">
            <div className="release-section-header">
              <h2>Ship checklist</h2>
              <span className="review-gate-ack-time">
                {gate.checklist.filter((c) => c.ticked).length} of {gate.checklist.length} completed
              </span>
            </div>

            <div className="release-checklist-group">
              {gate.checklist.length === 0 ? (
                <p className="review-muted-text">No checklist items defined for this profile.</p>
              ) : (
                gate.checklist.map((item) => {
                  const isBusy = Boolean(togglingItems[item.id]);
                  return (
                    <label
                      key={item.id}
                      className={`release-checklist-item ${item.ticked ? "ticked" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="release-checklist-checkbox"
                        checked={item.ticked}
                        disabled={isBusy}
                        onChange={() => handleToggleChecklist(item.id, item.ticked)}
                      />
                      <span className="release-checklist-label">{item.label}</span>
                    </label>
                  );
                })
              )}
            </div>
          </section>

          {/* 5. User Acceptance Testing (UAT) (T6.4, ADR 0021) */}
          <section className="release-section" aria-label="User Acceptance Testing">
            <div className="release-section-header">
              <h2>User Acceptance Testing (UAT)</h2>
              <span className="review-gate-ack-time">
                {gate.uat?.items.filter((i) => i.status === "pass").length ?? 0} of{" "}
                {gate.uat?.items.length ?? 0} passed
              </span>
            </div>

            {/* App Config Card */}
            <div className="uat-config-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="uat-config-label">App Configuration (Trust Boundary)</span>
                <button
                  type="button"
                  className="btn-secondary-sm"
                  onClick={() => setConfigModalOpen((v) => !v)}
                >
                  {configModalOpen ? "Close config" : gate.uat?.config ? "Edit config" : "Configure app"}
                </button>
              </div>

              {gate.uat?.config && !configModalOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div className="uat-config-row">
                    <span className="uat-config-label">Start command:</span>
                    <code className="uat-config-val">{gate.uat.config.startCommand}</code>
                  </div>
                  <div className="uat-config-row">
                    <span className="uat-config-label">App URL:</span>
                    <code className="uat-config-val">{gate.uat.config.appUrl}</code>
                  </div>
                </div>
              )}

              {(!gate.uat?.config || configModalOpen) && (
                <form
                  onSubmit={handleSaveConfig}
                  style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "6px" }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label className="release-dialog-label" htmlFor="uat-start-cmd">
                      Start command (1-500 chars, e.g. pnpm dev --port 5173):
                    </label>
                    <input
                      id="uat-start-cmd"
                      type="text"
                      className="release-dialog-input"
                      placeholder="e.g. pnpm install --frozen-lockfile && pnpm dev --port 5173"
                      value={configCmd}
                      onChange={(e) => setConfigCmd(e.target.value)}
                      required
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label className="release-dialog-label" htmlFor="uat-app-url">
                      App URL (http://127.0.0.1:&lt;port&gt; or http://localhost:&lt;port&gt;):
                    </label>
                    <input
                      id="uat-app-url"
                      type="text"
                      className="release-dialog-input"
                      placeholder="e.g. http://127.0.0.1:5173"
                      value={configUrl}
                      onChange={(e) => setConfigUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                    {gate.uat?.config && (
                      <button
                        type="button"
                        className="btn-secondary-sm"
                        onClick={() => setConfigModalOpen(false)}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="submit"
                      className="btn-primary-sm"
                      disabled={savingConfig || !configCmd.trim() || !configUrl.trim()}
                    >
                      {savingConfig ? "Saving…" : "Save configuration"}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Session Controls */}
            <div className="uat-session-bar">
              <div className="uat-session-status">
                <span style={{ fontWeight: 600 }}>Browser Session:</span>
                {gate.uat?.session?.status === "running" ? (
                  <span className="finding-badge finding-state-resolved">Running</span>
                ) : gate.uat?.session?.status === "starting" ? (
                  <span className="finding-badge finding-sev-moderate">Starting…</span>
                ) : (
                  <span className="finding-badge finding-state-badge">Stopped</span>
                )}
                {gate.uat?.session?.headSha && gate.uat.session.headSha !== "starting" && (
                  <span style={{ fontSize: "12px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                    Head: {gate.uat.session.headSha.slice(0, 8)}
                  </span>
                )}
              </div>

              <div className="uat-session-actions">
                {gate.uat?.session?.status === "running" ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary-sm"
                      disabled={sessionBusy}
                      onClick={handleTakeScreenshot}
                    >
                      {sessionBusy ? "Working…" : "Screenshot"}
                    </button>
                    <button
                      type="button"
                      className="btn-primary-sm"
                      disabled={sessionBusy}
                      onClick={handleStopUatSession}
                    >
                      {sessionBusy ? "Stopping…" : "Stop session"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={sessionBusy || !gate.uat?.config}
                    onClick={handleStartUatSession}
                    title={!gate.uat?.config ? "Configure start command first" : undefined}
                  >
                    {sessionBusy ? "Starting browser…" : "Start recorded browser"}
                  </button>
                )}
              </div>
            </div>

            {/* Earlier-Release Script Replay Status & Results (T6.5, ADR 0024) */}
            <div className="uat-replay-card">
              <div className="uat-item-header">
                <div className="uat-item-badges">
                  <span className="uat-config-label">Earlier-Release Script Replay</span>
                  <ReplayStatusBadge status={gate.uat?.replay?.status ?? "none"} />
                </div>
                {gate.uat?.replay?.latestRun && (
                  <span className="uat-recording-meta">
                    {gate.uat.replay.latestRun.passedScripts}/
                    {gate.uat.replay.latestRun.totalScripts} passed · Head{" "}
                    <code>{gate.uat.replay.latestRun.headSha.slice(0, 8)}</code>
                  </span>
                )}
              </div>

              {(!gate.uat?.replay ||
                (gate.uat.replay.earlierActiveCount === 0 && !gate.uat.replay.latestRun)) ? (
                <p className="review-muted-text">
                  No active scripts from earlier releases to replay.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {gate.uat.replay.latestRun?.error && (
                    <div className="release-finding-detail">{gate.uat.replay.latestRun.error}</div>
                  )}
                  {gate.uat.replay.results.length > 0 && (
                    <div className="uat-recordings-list">
                      {gate.uat.replay.results.map((r) => (
                        <div key={r.id} className="uat-replay-result-row">
                          <div className="uat-item-header">
                            <div className="uat-item-badges">
                              <ReplayStatusBadge status={r.status} />
                              <span className="finding-badge finding-check-badge">
                                #{r.scriptId} ({r.scriptReleaseVersion || "earlier"})
                              </span>
                              <span className="uat-recording-name">{r.itemText}</span>
                            </div>
                            {r.traceUrl && (
                              <a
                                href={r.traceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-secondary-sm"
                                download
                              >
                                Download trace
                              </a>
                            )}
                          </div>
                          {r.detail && <div className="release-finding-detail">{r.detail}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {gate.uat?.recording?.lastError && (
              <div className="review-alert review-alert-error" role="alert">
                Script recording error: {gate.uat.recording.lastError}
              </div>
            )}

            {/* Checklist Items */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: "14.5px", fontWeight: 600, color: "var(--ink-strong)" }}>
                  Checklist items
                </h3>
              </div>

              {!gate.uat?.items || gate.uat.items.length === 0 ? (
                <p className="review-muted-text">
                  No UAT items found for this release milestone.
                </p>
              ) : (
                <div className="uat-items-list">
                  {gate.uat.items.map((item) => {
                    const isMarkDialogOpen = markDialog?.itemId === item.id;
                    const draftScript = gate.uat?.scripts?.find(
                      (s) => s.itemId === item.id && s.status === "draft",
                    );
                    const isThisItemRecording =
                      Boolean(gate.uat?.recording?.active) &&
                      gate.uat?.recording?.itemId === item.id;
                    const markClass =
                      item.status === "pass"
                        ? "uat-mark-badge-pass"
                        : item.status === "fail"
                          ? "uat-mark-badge-fail"
                          : item.status === "re-test"
                            ? "uat-mark-badge-retest"
                            : "uat-mark-badge-untested";

                    return (
                      <div key={item.id} className="uat-item-card">
                        <div className="uat-item-header">
                          <div className="uat-item-badges">
                            <span className="finding-badge finding-state-badge">#{item.position}</span>
                            <span className="finding-badge finding-check-badge">{item.source}</span>
                            <span className={`finding-badge ${markClass}`}>
                              {item.status === "re-test" ? "Re-test" : item.status}
                            </span>
                          </div>
                          <div className="uat-item-actions">
                            {gate.uat?.session?.status === "running" && (
                              <button
                                type="button"
                                className="btn-secondary-sm"
                                disabled={
                                  recordingBusy || Boolean(gate.uat?.recording?.active)
                                }
                                onClick={() => handleRecordScript(item.id)}
                              >
                                {isThisItemRecording ? "Recording…" : "Record script"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-secondary-sm"
                              onClick={() => handlePassItem(item.id)}
                            >
                              Pass
                            </button>
                            <button
                              type="button"
                              className="btn-secondary-sm"
                              onClick={() =>
                                setMarkDialog({
                                  itemId: item.id,
                                  itemText: item.text,
                                  note: "",
                                  kind: "bug",
                                  checkCommand: "",
                                  busy: false,
                                })
                              }
                            >
                              Fail…
                            </button>
                          </div>
                        </div>

                        <div className="uat-item-text">{item.text}</div>

                        {draftScript && (
                          <div className="uat-script-draft-box">
                            <div className="uat-item-badges">
                              <span className="finding-badge uat-mark-badge-retest">
                                Draft script
                              </span>
                              <span className="uat-recording-meta">
                                Origin: {draftScript.recordedOrigin} · Click Pass to accept
                              </span>
                            </div>
                            <pre className="uat-script-pre">{draftScript.scriptText}</pre>
                          </div>
                        )}

                        {item.latestMark && (
                          <div className="release-finding-outcome-details">
                            <span>
                              <strong>Latest decision:</strong> {item.latestMark.result}
                              {item.latestMark.kind ? ` (${item.latestMark.kind})` : ""} ·{" "}
                              <span style={{ color: "var(--muted)" }}>
                                {new Date(item.latestMark.markedAt).toLocaleTimeString()}
                              </span>
                            </span>
                            {item.latestMark.note && <span>Note: {item.latestMark.note}</span>}
                            {item.latestMark.fixTaskCode && (
                              <span>
                                Fix task: <strong>{item.latestMark.fixTaskCode}</strong> (
                                {item.latestMark.fixTaskStatus ?? "queued"})
                              </span>
                            )}
                          </div>
                        )}

                        {/* Inline Fail Mark Dialog */}
                        {isMarkDialogOpen && (
                          <div className="release-dialog-panel">
                            <div className="release-dialog-title">
                              Mark Item #{item.position} as Failed
                            </div>

                            <div style={{ display: "flex", gap: "16px", margin: "4px 0" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name={`kind-${item.id}`}
                                  checked={markDialog.kind === "bug"}
                                  onChange={() =>
                                    setMarkDialog((prev) => (prev ? { ...prev, kind: "bug" } : null))
                                  }
                                />
                                <span>
                                  <strong>Bug</strong> (creates frozen fix task)
                                </span>
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name={`kind-${item.id}`}
                                  checked={markDialog.kind === "change"}
                                  onChange={() =>
                                    setMarkDialog((prev) => (prev ? { ...prev, kind: "change" } : null))
                                  }
                                />
                                <span>
                                  <strong>Change</strong> (logs gate finding)
                                </span>
                              </label>
                            </div>

                            <label className="release-dialog-label" htmlFor={`uat-note-${item.id}`}>
                              Note (required, 1-2000 chars):
                            </label>
                            <textarea
                              id={`uat-note-${item.id}`}
                              rows={3}
                              className="release-dialog-textarea"
                              placeholder="Describe what failed or differs..."
                              value={markDialog.note}
                              disabled={markDialog.busy}
                              onChange={(e) =>
                                setMarkDialog((prev) =>
                                  prev ? { ...prev, note: e.target.value } : null
                                )
                              }
                            />

                            {markDialog.kind === "bug" && (
                              <>
                                <label className="release-dialog-label" htmlFor={`uat-cmd-${item.id}`}>
                                  Check command for fix task (required, max 500 chars):
                                </label>
                                <input
                                  id={`uat-cmd-${item.id}`}
                                  type="text"
                                  className="release-dialog-input"
                                  placeholder="e.g. pnpm test"
                                  value={markDialog.checkCommand}
                                  disabled={markDialog.busy}
                                  onChange={(e) =>
                                    setMarkDialog((prev) =>
                                      prev ? { ...prev, checkCommand: e.target.value } : null
                                    )
                                  }
                                />
                              </>
                            )}

                            <div className="release-dialog-actions">
                              <button
                                type="button"
                                className="btn-secondary-sm"
                                disabled={markDialog.busy}
                                onClick={() => setMarkDialog(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="btn-primary-sm"
                                disabled={
                                  markDialog.busy ||
                                  !markDialog.note.trim() ||
                                  (markDialog.kind === "bug" && !markDialog.checkCommand.trim())
                                }
                                onClick={handleFailSubmit}
                              >
                                {markDialog.busy ? "Saving…" : "Submit failure"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Add item from spec */}
            <div className="uat-config-card" style={{ marginTop: "12px" }}>
              <span className="uat-config-label">Add item from approved SPEC.md</span>
              <form
                onSubmit={handleAddSpecItem}
                style={{ display: "flex", gap: "8px", marginTop: "6px" }}
              >
                <input
                  type="text"
                  className="release-dialog-input"
                  style={{ flex: 1 }}
                  placeholder="Enter exact item text from docs/SPEC.md ## Verify section..."
                  value={specInput}
                  onChange={(e) => setSpecInput(e.target.value)}
                  disabled={addingSpecItem}
                />
                <button
                  type="submit"
                  className="btn-secondary-sm"
                  disabled={addingSpecItem || !specInput.trim()}
                >
                  {addingSpecItem ? "Adding…" : "Add from spec"}
                </button>
              </form>
            </div>

            {/* Saved Scripts List (T6.5, ADR 0024) */}
            {(() => {
              const savedScripts = (gate.uat?.scripts ?? []).filter(
                (s) => s.status !== "draft",
              );
              const sessionRunning = gate.uat?.session?.status === "running";
              const isRecordingNow = Boolean(gate.uat?.recording?.active);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
                  <div className="release-section-header">
                    <h2>Saved UAT scripts ({savedScripts.length})</h2>
                  </div>

                  {savedScripts.length === 0 ? (
                    <p className="review-muted-text">
                      No saved UAT scripts yet. Record a script during a session and mark its item Pass to save it.
                    </p>
                  ) : (
                    <div className="uat-scripts-list">
                      {savedScripts.map((script) => {
                        const isExpanded = Boolean(expandedScripts[script.id]);
                        const isDialogOpen = scriptDialog?.scriptId === script.id;
                        const isReplacingThis =
                          isRecordingNow && gate.uat?.recording?.replaceScriptId === script.id;

                        return (
                          <div key={script.id} className="uat-script-card">
                            <div className="uat-item-header">
                              <div className="uat-item-badges">
                                <span className="finding-badge finding-state-badge">
                                  #{script.id}
                                </span>
                                <span className="finding-badge finding-check-badge">
                                  {script.releaseVersion}
                                </span>
                                <span
                                  className={`finding-badge ${
                                    script.status === "active"
                                      ? "uat-mark-badge-pass"
                                      : "finding-state-badge"
                                  }`}
                                >
                                  {script.status}
                                </span>
                                {script.lastResult && (
                                  <ReplayStatusBadge status={script.lastResult.status} />
                                )}
                                <span className="uat-recording-meta">{script.recordedOrigin}</span>
                              </div>

                              <div className="uat-item-actions">
                                <button
                                  type="button"
                                  className="btn-secondary-sm"
                                  onClick={() =>
                                    setExpandedScripts((prev) => ({
                                      ...prev,
                                      [script.id]: !isExpanded,
                                    }))
                                  }
                                >
                                  {isExpanded ? "Hide script" : "View script"}
                                </button>
                                {script.lastResult?.traceUrl && (
                                  <a
                                    href={script.lastResult.traceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn-secondary-sm"
                                    download
                                  >
                                    Download trace
                                  </a>
                                )}
                                {script.status === "active" && (
                                  <>
                                    <button
                                      type="button"
                                      className="btn-secondary-sm"
                                      disabled={!sessionRunning || isRecordingNow}
                                      title={
                                        !sessionRunning
                                          ? "Start a UAT session to record a replacement"
                                          : undefined
                                      }
                                      onClick={() =>
                                        setScriptDialog({
                                          scriptId: script.id,
                                          type: "replace",
                                          reason: "",
                                          busy: false,
                                        })
                                      }
                                    >
                                      {isReplacingThis ? "Recording…" : "Replace"}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-secondary-sm"
                                      onClick={() =>
                                        setScriptDialog({
                                          scriptId: script.id,
                                          type: "retire",
                                          reason: "",
                                          busy: false,
                                        })
                                      }
                                    >
                                      Retire
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="uat-item-text">{script.itemText}</div>

                            {script.status === "retired" && script.retiredReason && (
                              <div className="release-finding-outcome-details">
                                <span>
                                  <strong>Retired reason:</strong> {script.retiredReason}
                                </span>
                                {script.replacedBy && (
                                  <span>Replaced by script #{script.replacedBy}</span>
                                )}
                              </div>
                            )}

                            {script.lastResult?.detail && (
                              <div className="release-finding-detail">
                                {script.lastResult.detail}
                              </div>
                            )}

                            {isExpanded && (
                              <pre className="uat-script-pre">{script.scriptText}</pre>
                            )}

                            {isDialogOpen && scriptDialog && (
                              <div className="release-dialog-panel">
                                <div className="release-dialog-title">
                                  {scriptDialog.type === "replace"
                                    ? `Replace Script #${script.id}`
                                    : `Retire Script #${script.id}`}
                                </div>
                                <label
                                  className="release-dialog-label"
                                  htmlFor={`script-reason-${script.id}`}
                                >
                                  Reason (required, 1–500 characters):
                                </label>
                                <textarea
                                  id={`script-reason-${script.id}`}
                                  rows={2}
                                  maxLength={500}
                                  className="release-dialog-textarea"
                                  placeholder={
                                    scriptDialog.type === "replace"
                                      ? "Explain why the app behavior changed intentionally..."
                                      : "Explain why this script is being retired..."
                                  }
                                  value={scriptDialog.reason}
                                  disabled={scriptDialog.busy}
                                  onChange={(e) =>
                                    setScriptDialog((prev) =>
                                      prev ? { ...prev, reason: e.target.value } : null,
                                    )
                                  }
                                />
                                <div className="release-dialog-actions">
                                  <button
                                    type="button"
                                    className="btn-secondary-sm"
                                    disabled={scriptDialog.busy}
                                    onClick={() => setScriptDialog(null)}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-primary-sm"
                                    disabled={
                                      scriptDialog.busy ||
                                      scriptDialog.reason.trim().length < 1 ||
                                      scriptDialog.reason.trim().length > 500
                                    }
                                    onClick={handleScriptDialogSubmit}
                                  >
                                    {scriptDialog.busy
                                      ? "Submitting…"
                                      : scriptDialog.type === "replace"
                                        ? "Record replacement"
                                        : "Confirm retire"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Recordings List */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
              <div className="release-section-header">
                <h2>Recordings ({gate.uat?.recordings.length ?? 0})</h2>
              </div>

              {!gate.uat?.recordings || gate.uat.recordings.length === 0 ? (
                <p className="review-muted-text">
                  No recordings saved yet. Playwright trace, video, and screenshots will appear here after stopping a session.
                </p>
              ) : (
                <div className="uat-recordings-list">
                  {gate.uat.recordings.map((rec, idx) => (
                    <div key={`${rec.sessionId}-${rec.name}-${idx}`} className="uat-recording-row">
                      <div className="uat-recording-info">
                        <span className="finding-badge finding-check-badge">{rec.type}</span>
                        <span className="uat-recording-name">{rec.name}</span>
                        <span className="uat-recording-meta">
                          {(rec.size / 1024).toFixed(1)} KB ·{" "}
                          {new Date(rec.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <a
                        href={rec.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary-sm"
                        download={rec.type === "trace"}
                      >
                        {rec.type === "trace" ? "Download trace" : "View"}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* 5. Gate Findings */}
          <section className="release-section" aria-label="Gate findings">
            <div className="release-section-header">
              <h2>Findings ({gate.findings.length})</h2>
            </div>

            {gate.findings.length === 0 ? (
              <p className="review-muted-text">No findings reported for this release.</p>
            ) : (
              <div className="release-findings-list">
                {gate.findings.map((f) => (
                  <FindingCard
                    key={f.id}
                    finding={f}
                    activeDialog={activeDialog}
                    onOpenDialog={(type) =>
                      setActiveDialog({
                        findingId: f.id,
                        type,
                        input: "",
                        busy: false,
                      })
                    }
                    onCloseDialog={() => setActiveDialog(null)}
                    onInputChange={(val) =>
                      setActiveDialog((prev) => (prev ? { ...prev, input: val } : null))
                    }
                    onSubmitDialog={handleDialogSubmit}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function ReplayStatusBadge({ status }: { status: string }) {
  const badgeClass =
    status === "passed" || status === "none"
      ? "uat-mark-badge-pass"
      : status === "failed" || status === "error"
        ? "uat-mark-badge-fail"
        : status === "running" || status === "pending"
          ? "uat-mark-badge-retest"
          : "finding-state-badge";
  return <span className={`finding-badge ${badgeClass}`}>{status}</span>;
}

function CheckRow({
  name,
  status,
  detail,
}: {
  name: string;
  status?: GateCheckStatus;
  detail?: string;
}) {
  const statusLabel = status ?? "not-run";
  const badgeClass =
    status === "pass"
      ? "gate-pass"
      : status === "fail"
        ? "gate-blocked"
        : status === "error"
          ? "gate-blocked"
          : "review-check-badge badge-missing";

  return (
    <div className="release-check-row">
      <div className="release-check-info">
        <span className="release-check-name">{name}</span>
        {detail && <span className="release-check-detail">{detail}</span>}
      </div>
      <span className={`gate-badge ${badgeClass}`}>{statusLabel}</span>
    </div>
  );
}

function FindingCard({
  finding,
  activeDialog,
  onOpenDialog,
  onCloseDialog,
  onInputChange,
  onSubmitDialog,
}: {
  finding: FindingItem;
  activeDialog: {
    findingId: number;
    type: "fix" | "accept" | "defer";
    input: string;
    busy: boolean;
  } | null;
  onOpenDialog: (type: "fix" | "accept" | "defer") => void;
  onCloseDialog: () => void;
  onInputChange: (val: string) => void;
  onSubmitDialog: () => void;
}) {
  const isDialogOpen = activeDialog?.findingId === finding.id;
  const isBlocking = finding.blocking;
  const isOpen = finding.state === "open";

  return (
    <div
      className={`release-finding-card ${isBlocking ? "blocking-finding" : ""} ${
        finding.state === "resolved" ? "resolved-finding" : ""
      }`}
    >
      <div className="release-finding-header">
        <div className="release-finding-badges">
          <span className={`finding-badge finding-sev-${finding.severity}`}>
            {finding.severity}
          </span>
          <span className="finding-badge finding-check-badge">{finding.check}</span>
          {isBlocking && <span className="finding-badge finding-blocking-badge">Blocking</span>}
          <span
            className={`finding-badge ${
              finding.state === "resolved" ? "finding-state-resolved" : "finding-state-badge"
            }`}
          >
            {finding.state}
          </span>
          {finding.outcome && (
            <span className="finding-badge finding-outcome-badge">{finding.outcome}</span>
          )}
        </div>
      </div>

      <div className="release-finding-title">{finding.title}</div>
      {finding.location && (
        <div className="release-finding-location">Location: {finding.location}</div>
      )}
      {finding.detail && <div className="release-finding-detail">{finding.detail}</div>}

      {finding.outcome && (
        <div className="release-finding-outcome-details">
          <span>
            <strong>Outcome:</strong> {finding.outcome}
            {finding.decidedAt ? ` (decided ${new Date(finding.decidedAt).toLocaleTimeString()})` : ""}
          </span>
          {finding.reason && <span>Reason: {finding.reason}</span>}
          {finding.fixTaskId && <span>Fix task ID: {finding.fixTaskId}</span>}
        </div>
      )}

      {/* Action buttons for Open findings */}
      {isOpen && !isDialogOpen && (
        <div className="release-finding-actions">
          <button
            type="button"
            className="btn-primary-sm"
            onClick={() => onOpenDialog("fix")}
          >
            Make fix task
          </button>
          {!isBlocking && (
            <>
              <button
                type="button"
                className="btn-secondary-sm"
                onClick={() => onOpenDialog("accept")}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn-secondary-sm"
                onClick={() => onOpenDialog("defer")}
              >
                Defer
              </button>
            </>
          )}
        </div>
      )}

      {/* Inline dialog panel */}
      {isDialogOpen && activeDialog && (
        <div className="release-dialog-panel">
          <div className="release-dialog-title">
            {activeDialog.type === "fix"
              ? "Create Fix Task"
              : activeDialog.type === "accept"
                ? "Accept Finding"
                : "Defer Finding"}
          </div>

          {activeDialog.type === "fix" ? (
            <>
              <label className="release-dialog-label" htmlFor={`checkCommand-${finding.id}`}>
                Check command (required, max 500 chars):
              </label>
              <input
                id={`checkCommand-${finding.id}`}
                type="text"
                className="release-dialog-input"
                placeholder="e.g. pnpm test or npm audit"
                value={activeDialog.input}
                disabled={activeDialog.busy}
                onChange={(e) => onInputChange(e.target.value)}
              />
            </>
          ) : (
            <>
              <label className="release-dialog-label" htmlFor={`reason-${finding.id}`}>
                Reason (required, at least 10 characters):
              </label>
              <textarea
                id={`reason-${finding.id}`}
                rows={3}
                className="release-dialog-textarea"
                placeholder="Explain why this finding is acceptable or deferred..."
                value={activeDialog.input}
                disabled={activeDialog.busy}
                onChange={(e) => onInputChange(e.target.value)}
              />
            </>
          )}

          <div className="release-dialog-actions">
            <button
              type="button"
              className="btn-secondary-sm"
              disabled={activeDialog.busy}
              onClick={onCloseDialog}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary-sm"
              disabled={
                activeDialog.busy ||
                (activeDialog.type === "fix"
                  ? !activeDialog.input.trim()
                  : activeDialog.input.trim().length < 10)
              }
              onClick={onSubmitDialog}
            >
              {activeDialog.busy ? "Submitting…" : "Confirm"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatStatusTitle(status: string): string {
  switch (status) {
    case "not-ready":
      return "Verify stage not ready";
    case "needs-run":
      return "Checks need to run";
    case "running":
      return "Security checks in progress";
    case "blocked":
      return "Release gate is blocked";
    case "needs-decision":
      return "Findings need decisions";
    case "checklist":
      return "Ship checklist incomplete";
    case "pass":
      return "Release gate passed";
    default:
      return status;
  }
}

function formatStatusSubtitle(status: string): string {
  switch (status) {
    case "not-ready":
      return "Complete and merge all milestone tasks to enter Verify.";
    case "needs-run":
      return "Security checks have not yet been run on the current release branch head.";
    case "running":
      return "Automatic security checks and audits are currently executing...";
    case "blocked":
      return "One or more checks errored or blocking findings are open.";
    case "needs-decision":
      return "Non-blocking findings require an accepted, deferred, or fix task outcome.";
    case "checklist":
      return "All ship checklist items must be ticked before the release can ship.";
    case "pass":
      return "All automatic checks passed and ship checklist is satisfied.";
    default:
      return "";
  }
}
