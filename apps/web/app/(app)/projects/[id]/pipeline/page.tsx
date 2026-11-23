"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";
import { postJson } from "../../../../csrf-fetch";
import type { PipelineStage, ProjectPipelineInfo } from "../../../../../src/services";

const STAGES: PipelineStage[] = [
  "Intake",
  "Spec",
  "Mock",
  "Plan",
  "Build",
  "Review",
  "Verify",
  "Ship",
];

const COLUMNS = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "check-failed", label: "Check failed" },
  { id: "in-review", label: "In review" },
  { id: "done", label: "Done" },
] as const;

export default function PipelinePage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  const [data, setData] = useState<ProjectPipelineInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState<string>("all");

  const loadPipeline = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/projects/${id}/pipeline`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to load pipeline: ${res.statusText}`);
      }
      const json: ProjectPipelineInfo = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading pipeline");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadPipeline();
  }, [loadPipeline]);

  const handleSync = async () => {
    if (!id || isSyncing) return;
    try {
      setIsSyncing(true);
      const res = await postJson(`/api/projects/${id}/pipeline/sync`);
      if (res.ok) {
        const json: ProjectPipelineInfo = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error("Failed to sync PLAN.md", err);
    } finally {
      setIsSyncing(false);
    }
  };

  const currentStageIndex = data ? STAGES.indexOf(data.stage) : -1;

  const displayedMilestone = useMemo(() => {
    if (!data || data.milestones.length === 0) return null;
    if (selectedMilestone !== "all") {
      return data.milestones.find((m) => m.code === selectedMilestone) ?? null;
    }
    // If "all" is selected, show active milestone if present, or the first milestone
    if (data.activeMilestone?.version) {
      const v = data.activeMilestone.version.toLowerCase();
      const matched = data.milestones.find(
        (m) => m.code.toLowerCase() === v || m.title.toLowerCase().includes(v),
      );
      if (matched) return matched;
    }
    return data.milestones[0] ?? null;
  }, [data, selectedMilestone]);

  const displayedTasks = useMemo(() => {
    if (!data) return [];
    if (selectedMilestone === "all") return data.tasks;
    return data.tasks.filter((t) => t.milestoneCode === selectedMilestone);
  }, [data, selectedMilestone]);

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Pipeline</h1>
          <p className="header-summary">
            {data ? (
              <>
                <span className="pipeline-project-name">{data.project.name}</span>
                {data.activeMilestone ? (
                  <>
                    {" · "}
                    <span className="pipeline-milestone-tag">{data.activeMilestone.version}</span>
                    {" · "}
                    <code className="pipeline-branch-tag">{data.activeMilestone.branch}</code>
                  </>
                ) : (
                  <>
                    {" · "}
                    <span>Milestone not started</span>
                  </>
                )}
              </>
            ) : (
              "This milestone's tasks, by status."
            )}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={handleSync}
            disabled={isSyncing || loading}
          >
            {isSyncing ? "Syncing..." : "Sync PLAN.md"}
          </button>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      {loading && !data && (
        <div className="empty-state-panel">
          <p className="empty-state-text">Loading pipeline...</p>
        </div>
      )}

      {error && !data && (
        <div className="empty-state-panel">
          <p className="empty-state-text" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        </div>
      )}

      {data && (
        <div className="pipeline-container">
          {/* 8-segment stage bar */}
          <div className="pipeline-stage-progress-card">
            <div className="pipeline-stage-progress-header">
              <span className="pipeline-stage-progress-title">Pipeline Stage</span>
              <span className="pipeline-stage-current-badge">{data.stage}</span>
            </div>
            <div
              className="stage-bar"
              role="progressbar"
              aria-valuenow={currentStageIndex + 1}
              aria-valuemin={1}
              aria-valuemax={8}
            >
              {STAGES.map((s, idx) => {
                let state = "todo";
                if (idx < currentStageIndex) state = "done";
                else if (idx === currentStageIndex) state = "current";
                return <div key={s} className={`stage-segment ${state}`} title={s} />;
              })}
            </div>
            <div className="pipeline-stage-labels">
              {STAGES.map((s, idx) => (
                <span
                  key={s}
                  className={`pipeline-stage-label ${
                    idx === currentStageIndex
                      ? "current"
                      : idx < currentStageIndex
                        ? "done"
                        : "todo"
                  }`}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>

          {/* Milestone header bar */}
          {data.milestones.length > 0 && (
            <div className="pipeline-milestone-bar">
              {data.milestones.length > 1 && (
                <div className="pipeline-milestone-tabs" role="tablist" aria-label="Milestones">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedMilestone === "all"}
                    className={`pipeline-milestone-tab ${selectedMilestone === "all" ? "active" : ""}`}
                    onClick={() => setSelectedMilestone("all")}
                  >
                    All milestones
                  </button>
                  {data.milestones.map((m) => (
                    <button
                      key={m.code}
                      type="button"
                      role="tab"
                      aria-selected={selectedMilestone === m.code}
                      className={`pipeline-milestone-tab ${selectedMilestone === m.code ? "active" : ""}`}
                      onClick={() => setSelectedMilestone(m.code)}
                    >
                      {m.code}
                    </button>
                  ))}
                </div>
              )}

              {displayedMilestone && (
                <div className="pipeline-milestone-info">
                  <h2 className="pipeline-milestone-heading">{displayedMilestone.title}</h2>
                  {displayedMilestone.doneWhen.length > 0 && (
                    <div className="pipeline-done-when-section">
                      <span className="pipeline-done-when-label">Done when:</span>
                      <ul className="pipeline-done-when-list">
                        {displayedMilestone.doneWhen.map((item, idx) => (
                          <li key={idx} className="pipeline-done-when-item">
                            <span className="pipeline-done-when-check">✓</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 5-column Pipeline Board or Empty tasks state */}
          {data.tasks.length === 0 ? (
            <div className="pipeline-empty-tasks-card">
              <p className="pipeline-empty-tasks-text">
                No tasks in docs/PLAN.md yet ·{" "}
                <Link href={`/projects/${id}/chat`} className="pipeline-empty-chat-link">
                  Generate and approve a plan in Project chat
                </Link>
              </p>
            </div>
          ) : (
            <div className="pipeline-board" role="region" aria-label="Pipeline board">
              {COLUMNS.map((col) => {
                const colTasks = displayedTasks.filter((t) => t.status === col.id);
                return (
                  <div key={col.id} className="pipeline-column">
                    <div className="pipeline-column-header">
                      <h3 className="pipeline-column-title">{col.label} · {colTasks.length}</h3>
                    </div>
                    <div className="pipeline-column-cards">
                      {colTasks.map((task) => (
                        <div
                          key={task.id}
                          className="pipeline-card"
                          data-testid={`task-card-${task.code}`}
                        >
                          <div className="pipeline-card-header">
                            <span className="pipeline-card-code">{task.code}</span>
                            {task.tag === "claude" && (
                              <span className="provider-badge provider-badge-claude">Claude</span>
                            )}
                            {task.tag === "gemini" && (
                              <span className="provider-badge provider-badge-gemini">Antigravity</span>
                            )}
                            {task.tag === "you" && (
                              <span className="provider-badge provider-badge-you">You</span>
                            )}
                          </div>

                          <h4 className="pipeline-card-title">{task.title}</h4>

                          {task.description && (
                            <p className="pipeline-card-desc">{task.description}</p>
                          )}

                          {task.linkedSpecSections && task.linkedSpecSections.length > 0 && (
                            <div className="pipeline-card-specs">
                              {task.linkedSpecSections.map((sec) => (
                                <span key={sec} className="spec-pill">
                                  [[SPEC#{sec}]]
                                </span>
                              ))}
                            </div>
                          )}

                          {task.checkCommand && (
                            <div className="pipeline-card-check">
                              <code>check: {task.checkCommand}</code>
                            </div>
                          )}

                          {(task.branch || task.attempts > 0) && (
                            <div className="pipeline-card-footer">
                              {task.branch ? (
                                <code className="pipeline-card-branch">{task.branch}</code>
                              ) : (
                                <span />
                              )}
                              {task.attempts > 0 && (
                                <span className="pipeline-card-attempts">
                                  {task.attempts} {task.attempts === 1 ? "attempt" : "attempts"}
                                </span>
                              )}
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
      )}
    </>
  );
}
