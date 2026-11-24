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

  // Polling every 3s while gate status is "running" or runningChecks is true
  useEffect(() => {
    const isRunning = gate?.status === "running" || runningChecks;
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
  }, [gate?.status, runningChecks, loadGate]);

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
              <div className="release-banner-subtitle">{formatStatusSubtitle(gate.status)}</div>
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
