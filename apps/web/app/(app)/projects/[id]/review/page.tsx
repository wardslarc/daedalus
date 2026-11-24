"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";
import { postJson } from "../../../../csrf-fetch";
import type { ReviewData } from "@daedalus/projects";

type InReviewTask = {
  id: number;
  projectId: number;
  code: string;
  title: string;
  tag: string | null;
  status: string;
  frozenAt: string | null;
  createdAt: string;
  branch: string | null;
  reviewNotes: string | null;
};

export default function ReviewPage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  const [tasks, setTasks] = useState<InReviewTask[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingReview, setLoadingReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Send back form state
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackNotes, setSendBackNotes] = useState("");
  const [sendBackSubmitting, setSendBackSubmitting] = useState(false);

  // Discard two-step button state
  const [discardStep, setDiscardStep] = useState<"idle" | "confirm" | "busy">("idle");

  // Approve state
  const [approveSubmitting, setApproveSubmitting] = useState(false);

  // Gate acknowledgement states: gateId -> note
  const [ackNotes, setAckNotes] = useState<Record<string, string>>({});
  const [ackSubmitting, setAckSubmitting] = useState<Record<string, boolean>>({});

  // Cross-review state
  const [crossReviewSubmitting, setCrossReviewSubmitting] = useState(false);

  const loadQueue = useCallback(
    async (preferredCode?: string) => {
      if (!id) return;
      try {
        setLoadingQueue(true);
        setError(null);
        const res = await fetch(`/api/projects/${id}/review`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to load review queue: ${res.statusText}`);
        }
        const json = (await res.json()) as { tasks: InReviewTask[] };
        const queueTasks = json.tasks || [];
        setTasks(queueTasks);

        if (queueTasks.length > 0) {
          const target = preferredCode
            ? queueTasks.find((t) => t.code.toLowerCase() === preferredCode.toLowerCase())?.code || queueTasks[0]!.code
            : queueTasks[0]!.code;
          setSelectedCode(target);
        } else {
          setSelectedCode(null);
          setReview(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error loading review queue");
      } finally {
        setLoadingQueue(false);
      }
    },
    [id],
  );

  const loadReview = useCallback(
    async (code: string) => {
      if (!id || !code) return;
      try {
        setLoadingReview(true);
        setActionError(null);
        setActionSuccess(null);
        const res = await fetch(`/api/projects/${id}/review/${code}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to load review for ${code}`);
        }
        const data = (await res.json()) as ReviewData;
        setReview(data);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Error loading review for ${code}`);
      } finally {
        setLoadingReview(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (selectedCode) {
      setSendBackOpen(false);
      setSendBackNotes("");
      setDiscardStep("idle");
      void loadReview(selectedCode);
    }
  }, [selectedCode, loadReview]);

  // Poll review GET every 3s while cross-review is running
  useEffect(() => {
    if (!selectedCode || review?.crossReview?.status !== "running") return;
    const interval = setInterval(() => {
      void loadReview(selectedCode);
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedCode, review?.crossReview?.status, loadReview]);

  const handleApprove = async () => {
    if (!id || !selectedCode || approveSubmitting) return;
    try {
      setApproveSubmitting(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/review/${selectedCode}/approve`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sha?: string };
      if (!res.ok) {
        setActionError(body.error || "Approval failed.");
      } else {
        setActionSuccess(`Task ${selectedCode} approved and merged (commit ${body.sha?.slice(0, 8)}).`);
        await loadQueue();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Approval request failed.");
    } finally {
      setApproveSubmitting(false);
    }
  };

  const handleSendBack = async () => {
    if (!id || !selectedCode || sendBackSubmitting) return;
    if (sendBackNotes.trim().length < 1 || sendBackNotes.length > 4000) {
      setActionError("Review notes must be between 1 and 4000 characters.");
      return;
    }
    try {
      setSendBackSubmitting(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/review/${selectedCode}/send-back`, {
        notes: sendBackNotes.trim(),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to send back task.");
      } else {
        setActionSuccess(`Task ${selectedCode} sent back with notes and requeued.`);
        setSendBackOpen(false);
        setSendBackNotes("");
        await loadQueue();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Send back request failed.");
    } finally {
      setSendBackSubmitting(false);
    }
  };

  const handleDiscard = async () => {
    if (!id || !selectedCode || discardStep === "busy") return;
    try {
      setDiscardStep("busy");
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/review/${selectedCode}/discard`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || "Failed to discard task.");
        setDiscardStep("idle");
      } else {
        setActionSuccess(`Task ${selectedCode} discarded, branch deleted, and requeued.`);
        setDiscardStep("idle");
        await loadQueue();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Discard request failed.");
      setDiscardStep("idle");
    }
  };

  const handleAckGate = async (gateId: string) => {
    if (!id || !selectedCode) return;
    const note = (ackNotes[gateId] ?? "").trim();
    if (note.length < 1 || note.length > 1000) {
      setActionError("Acknowledgement note must be between 1 and 1000 characters.");
      return;
    }
    try {
      setAckSubmitting((prev) => ({ ...prev, [gateId]: true }));
      setActionError(null);
      const res = await postJson(`/api/projects/${id}/review/${selectedCode}/ack-gate`, {
        gateId,
        note,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError(body.error || `Failed to acknowledge gate ${gateId}.`);
      } else {
        setAckNotes((prev) => ({ ...prev, [gateId]: "" }));
        await loadReview(selectedCode);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Acknowledgement failed.");
    } finally {
      setAckSubmitting((prev) => ({ ...prev, [gateId]: false }));
    }
  };

  const handleRunCrossReview = async () => {
    if (!id || !selectedCode || crossReviewSubmitting || review?.crossReview?.status === "running") return;
    try {
      setCrossReviewSubmitting(true);
      setActionError(null);
      setActionSuccess(null);
      const res = await postJson(`/api/projects/${id}/review/${selectedCode}/cross-review`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reviewId?: number };
      if (!res.ok) {
        setActionError(body.error || "Failed to start cross-review.");
      } else {
        await loadReview(selectedCode);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cross-review request failed.");
    } finally {
      setCrossReviewSubmitting(false);
    }
  };

  // Check locking conditions for Approve button
  const blockedGate = review?.gates.find((g) => g.status === "blocked");
  const unackedGate = review?.gates.find((g) => g.status === "needs-ack" && !g.ack);
  const isApproveLocked = Boolean(blockedGate || unackedGate);
  let lockReason = "";
  if (blockedGate) {
    lockReason = `Locked: gate '${blockedGate.id}' is blocked (${blockedGate.items.join(", ") || "check failed"}).`;
  } else if (unackedGate) {
    lockReason = `Locked: gate '${unackedGate.id}' requires acknowledgement before approval.`;
  }

  const crossReview = review?.crossReview;
  const isCrossReviewRunning = crossReview?.status === "running" || crossReviewSubmitting;
  const isTampered = crossReview?.status === "tampered";
  const findings = crossReview?.findings || [];
  const mustFixFindings = findings.filter((f) => f.bucket === "must-fix");
  const shouldFixFindings = findings.filter((f) => f.bucket === "should-fix");
  const nitFindings = findings.filter((f) => f.bucket === "nit");
  const untriagedFindings = findings.filter(
    (f) => !f.bucket || (f.bucket !== "must-fix" && f.bucket !== "should-fix" && f.bucket !== "nit"),
  );
  const findingGroups = [
    { title: "Must fix", bucket: "must-fix", items: mustFixFindings, badgeClass: "badge-must-fix" },
    { title: "Should fix", bucket: "should-fix", items: shouldFixFindings, badgeClass: "badge-should-fix" },
    { title: "Nit", bucket: "nit", items: nitFindings, badgeClass: "badge-nit" },
    { title: "Untriaged", bucket: "untriaged", items: untriagedFindings, badgeClass: "badge-untriaged" },
  ];

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Review</h1>
          <p className="header-summary">Changes waiting for review, with findings and your decision.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      {loadingQueue ? (
        <div className="review-loading-panel">
          <p className="review-loading-text">Loading review queue…</p>
        </div>
      ) : error ? (
        <div className="review-error-panel" role="alert">
          <p>{error}</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="empty-state-panel">
          <p className="empty-state-text">Nothing waiting for review.</p>
        </div>
      ) : (
        <div className="review-layout">
          {/* Left: Queue of in-review tasks */}
          <aside className="review-queue-column" aria-label="Tasks waiting for review">
            <div className="review-queue-header">
              <h2>Queue</h2>
              <span className="review-queue-count">{tasks.length} waiting</span>
            </div>

            <div className="review-queue-list">
              {tasks.map((t) => {
                const isSelected = selectedCode === t.code;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`review-queue-card ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedCode(t.code)}
                  >
                    <div className="review-queue-card-top">
                      <span className="review-queue-card-code">{t.code}</span>
                      {t.tag && (
                        <span className={`provider-badge provider-badge-${t.tag}`}>
                          {t.tag}
                        </span>
                      )}
                    </div>
                    <span className="review-queue-card-title">{t.title}</span>
                    <span className="review-queue-card-time">
                      Check passed {t.frozenAt ? new Date(t.frozenAt).toLocaleTimeString() : "recently"}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Right: Selected task review details */}
          <section className="review-detail-column" aria-label="Review details">
            {loadingReview ? (
              <div className="review-loading-detail">
                <p>Loading review details…</p>
              </div>
            ) : !review ? (
              <div className="review-loading-detail">
                <p>Select a task from the queue to review.</p>
              </div>
            ) : (
              <>
                <div className="review-detail-header">
                  <div className="review-detail-title-group">
                    <div className="review-detail-tag-row">
                      <span className="review-detail-code">{review.task.code}</span>
                      {review.task.tag && (
                        <span className={`provider-badge provider-badge-${review.task.tag}`}>
                          {review.task.tag}
                        </span>
                      )}
                    </div>
                    <h2>{review.task.title}</h2>
                    <p className="review-detail-branch">
                      Branch: <code>daedalus/{review.task.code.toLowerCase()}</code> → Merge target: <code>{review.releaseBranch}</code>
                    </p>
                  </div>
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

                {/* 1. File list with badges and counts */}
                <div className="review-section review-files-section">
                  <div className="review-section-header">
                    <h3>Files changed ({review.diff.files.length})</h3>
                  </div>
                  {review.diff.files.length === 0 ? (
                    <p className="review-muted-text">No changed files detected.</p>
                  ) : (
                    <ul className="review-files-list">
                      {review.diff.files.map((file, idx) => (
                        <li key={idx} className="review-file-item">
                          <span className={`review-file-status status-${file.status}`}>
                            {file.status}
                          </span>
                          <span className="review-file-path">
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          </span>
                          <span className="review-file-counts">
                            <span className="count-add">+{file.additions}</span>
                            <span className="count-del">-{file.deletions}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 2. Scrollable Patch Viewer */}
                <div className="review-section review-patch-section">
                  <div className="review-section-header">
                    <h3>Diff patch</h3>
                  </div>
                  <pre className="review-diff-pre" tabIndex={0}>
                    {review.diff.patch
                      ? review.diff.patch.split("\n").map((line, idx) => {
                          let lineClass = "diff-line";
                          if (line.startsWith("+") && !line.startsWith("+++")) {
                            lineClass += " diff-line-add";
                          } else if (line.startsWith("-") && !line.startsWith("---")) {
                            lineClass += " diff-line-del";
                          } else if (line.startsWith("@@ ")) {
                            lineClass += " diff-line-hunk";
                          }
                          return (
                            <span key={idx} className={lineClass}>
                              {line}
                            </span>
                          );
                        })
                      : "Empty diff."}
                  </pre>
                </div>

                {/* 3. Check result */}
                <div className="review-section review-check-section">
                  <div className="review-section-header">
                    <h3>Frozen check result</h3>
                    {review.check ? (
                      <span
                        className={`review-check-badge ${
                          review.check.ok ? "badge-pass" : "badge-fail"
                        }`}
                      >
                        {review.check.ok ? "Check Passed (exit 0)" : `Failed (exit ${review.check.exitCode ?? 1})`}
                      </span>
                    ) : (
                      <span className="review-check-badge badge-missing">Missing</span>
                    )}
                  </div>
                  <pre className="review-check-output" tabIndex={0}>
                    {review.check?.output || "No check output recorded."}
                  </pre>
                </div>

                {/* 4. Automatic Gates */}
                <div className="review-section review-gates-section">
                  <div className="review-section-header">
                    <h3>Automatic gates (no model)</h3>
                  </div>
                  <div className="review-gates-list">
                    {review.gates.map((gate) => {
                      const isNeedsAck = gate.status === "needs-ack";
                      const isAcked = Boolean(gate.ack);
                      const isSubmitting = Boolean(ackSubmitting[gate.id]);

                      return (
                        <div key={gate.id} className="review-gate-card">
                          <div className="review-gate-card-header">
                            <span className="review-gate-name">{formatGateName(gate.id)}</span>
                            <span
                              className={`gate-badge ${
                                gate.status === "pass"
                                  ? "gate-pass"
                                  : gate.status === "blocked"
                                    ? "gate-blocked"
                                    : isAcked
                                      ? "gate-acked"
                                      : "gate-needs-ack"
                              }`}
                            >
                              {gate.status === "pass"
                                ? "Pass"
                                : gate.status === "blocked"
                                  ? "Blocked"
                                  : isAcked
                                    ? "Acknowledged"
                                    : "Needs Ack"}
                            </span>
                          </div>

                          {gate.items.length > 0 ? (
                            <ul className="review-gate-items">
                              {gate.items.map((item, itemIdx) => (
                                <li key={itemIdx} className="review-gate-item">
                                  {item}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="review-gate-empty">No flagged items.</p>
                          )}

                          {isAcked && gate.ack && (
                            <div className="review-gate-ack-record">
                              <span className="review-gate-ack-label">Owner acknowledgement:</span>
                              <p className="review-gate-ack-note">"{gate.ack.note}"</p>
                              <span className="review-gate-ack-time">
                                {new Date(gate.ack.ackedAt).toLocaleString()}
                              </span>
                            </div>
                          )}

                          {isNeedsAck && !isAcked && (
                            <div className="review-gate-ack-form">
                              <label htmlFor={`ack-note-${gate.id}`} className="review-gate-ack-form-label">
                                Acknowledge this gate:
                              </label>
                              <textarea
                                id={`ack-note-${gate.id}`}
                                className="review-ack-textarea"
                                rows={2}
                                placeholder="Explain why this change is safe (1–1000 chars)"
                                value={ackNotes[gate.id] || ""}
                                onChange={(e) =>
                                  setAckNotes((prev) => ({ ...prev, [gate.id]: e.target.value }))
                                }
                              />
                              <div className="review-gate-ack-btn-row">
                                <button
                                  type="button"
                                  className="btn-secondary-sm"
                                  onClick={() => handleAckGate(gate.id)}
                                  disabled={isSubmitting || !(ackNotes[gate.id] || "").trim()}
                                >
                                  {isSubmitting ? "Saving…" : "Acknowledge gate"}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 5. Cross-review */}
                <div className="review-section review-cross-review-card">
                  <div className="review-section-header">
                    <h3>Cross-review</h3>
                    <button
                      type="button"
                      className="btn-secondary-sm"
                      disabled={isCrossReviewRunning}
                      onClick={handleRunCrossReview}
                    >
                      {isCrossReviewRunning ? "Running cross-review…" : "Run cross-review"}
                    </button>
                  </div>

                  {isTampered && (
                    <div className="review-tampered-notice" role="alert">
                      <p className="review-tampered-text">
                        The reviewer changed files; its review was discarded.
                      </p>
                    </div>
                  )}

                  {crossReview && (
                    <div className="review-cross-review-status-line">
                      <span>
                        Reviewer: <strong>{crossReview.reviewer}</strong>
                      </span>
                      <span> · </span>
                      <span>
                        Status:{" "}
                        <strong className={`status-text-${crossReview.status}`}>
                          {crossReview.status}
                        </strong>
                      </span>
                      {crossReview.finishedAt ? (
                        <span> · Finished {new Date(crossReview.finishedAt).toLocaleTimeString()}</span>
                      ) : crossReview.startedAt ? (
                        <span> · Started {new Date(crossReview.startedAt).toLocaleTimeString()}</span>
                      ) : null}
                    </div>
                  )}

                  {crossReview?.error && !isTampered && (
                    <div className="review-cross-review-error">
                      <p>{crossReview.error}</p>
                    </div>
                  )}

                  {!crossReview ? (
                    <p className="review-cross-review-placeholder review-muted-text">
                      Cross-review: comes in T6.2
                    </p>
                  ) : findings.length === 0 ? (
                    <p className="review-muted-text">
                      {crossReview.status === "running"
                        ? "Cross-review is running in a sandbox…"
                        : "No findings reported."}
                    </p>
                  ) : (
                    <div className="review-findings-groups">
                      {findingGroups.map((group) => {
                        if (group.items.length === 0) return null;
                        return (
                          <div key={group.bucket} className="review-findings-group">
                            <div className="review-findings-group-header">
                              <span className={`finding-group-badge ${group.badgeClass}`}>
                                {group.title} ({group.items.length})
                              </span>
                            </div>
                            <div className="review-findings-list">
                              {group.items.map((f, idx) => (
                                <div key={idx} className="review-finding-card">
                                  <div className="review-finding-card-header">
                                    <span className={`finding-severity-badge severity-${f.severity}`}>
                                      {f.severity}
                                    </span>
                                    <span className="finding-location">
                                      {f.file}
                                      {f.line !== null && f.line !== undefined ? `:${f.line}` : ""}
                                    </span>
                                  </div>
                                  <p className="finding-claim">{f.claim}</p>
                                  {f.proof && <pre className="finding-proof">{f.proof}</pre>}
                                  {f.reason && (
                                    <div className="finding-triage-reason">
                                      <span className="finding-triage-reason-label">Triage reason:</span>{" "}
                                      {f.reason}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 6. Review Actions */}
                <div className="review-actions-bar">
                  <div className="review-action-group">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={isApproveLocked || approveSubmitting}
                      onClick={handleApprove}
                    >
                      {approveSubmitting ? "Approving…" : "Approve & Merge"}
                    </button>
                    {isApproveLocked && (
                      <span className="review-lock-hint" role="note">
                        {lockReason}
                      </span>
                    )}
                  </div>

                  <div className="review-action-group">
                    {!sendBackOpen ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setSendBackOpen(true)}
                      >
                        Send back with notes
                      </button>
                    ) : (
                      <div className="review-sendback-panel">
                        <label htmlFor="sendback-notes" className="review-sendback-label">
                          Notes for the next run:
                        </label>
                        <textarea
                          id="sendback-notes"
                          className="review-sendback-textarea"
                          rows={4}
                          placeholder="What needs to be fixed? (1–4000 characters)"
                          value={sendBackNotes}
                          onChange={(e) => setSendBackNotes(e.target.value)}
                        />
                        <div className="review-sendback-actions">
                          <button
                            type="button"
                            className="btn-primary-sm"
                            disabled={sendBackSubmitting || !sendBackNotes.trim()}
                            onClick={handleSendBack}
                          >
                            {sendBackSubmitting ? "Sending back…" : "Send back"}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary-sm"
                            onClick={() => {
                              setSendBackOpen(false);
                              setSendBackNotes("");
                            }}
                            disabled={sendBackSubmitting}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="review-action-group">
                    {discardStep === "confirm" || discardStep === "busy" ? (
                      <div className="review-discard-confirm-panel">
                        <p className="review-discard-question">
                          Discard task {review.task.code}?
                        </p>
                        <p className="review-discard-note">
                          Deletes branch and worktree, clears review notes and requeues the task.
                        </p>
                        <div className="review-discard-actions">
                          <button
                            type="button"
                            className="btn-danger-sm"
                            disabled={discardStep === "busy"}
                            onClick={handleDiscard}
                          >
                            {discardStep === "busy" ? "Discarding…" : "Confirm Discard"}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary-sm"
                            disabled={discardStep === "busy"}
                            onClick={() => setDiscardStep("idle")}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary-sm review-discard-trigger"
                        onClick={() => setDiscardStep("confirm")}
                      >
                        Discard
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function formatGateName(gateId: string): string {
  switch (gateId) {
    case "secrets":
      return "Secret scan";
    case "dependencies":
      return "Dependency manifests";
    case "tests":
      return "Test changes";
    case "check":
      return "Check execution";
    default:
      return gateId;
  }
}
