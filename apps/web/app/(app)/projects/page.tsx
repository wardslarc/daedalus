"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useProfile, type Profile } from "../../components/use-profile";
import { postJson } from "../../csrf-fetch";
import { MergeKitControl } from "./merge-kit-control";

const PROFILES: Profile[] = ["All", "Work", "Client", "Personal"];

type ProjectData = {
  id: number;
  name: string;
  localPath: string;
  profile: "work" | "client" | "personal";
  gitHost: string | null;
  gitRemote: string | null;
  defaultBranch: string;
  geminiAllowed: boolean;
  origin: "imported" | "created";
  createdAt: string;
  kitPending: boolean;
};

function formatGitHost(host: string | null): string {
  if (!host) return "Local";
  if (host === "github") return "GitHub";
  if (host === "gitlab") return "GitLab";
  return host.charAt(0).toUpperCase() + host.slice(1);
}

export default function ProjectsPage() {
  const [currentProfile, selectProfile] = useProfile();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [search, setSearch] = useState("");
  // Cards whose kit was just merged, so they can say so after the list reloads.
  const [mergedIds, setMergedIds] = useState<Set<number>>(() => new Set());
  const [isHydrated, setIsHydrated] = useState(false);

  // Dialog states
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isNewOpen, setIsNewOpen] = useState(false);

  // Import form state
  const [importSource, setImportSource] = useState("");
  const [importProfile, setImportProfile] = useState<"work" | "client" | "personal">("work");
  const [importName, setImportName] = useState("");
  const [importGemini, setImportGemini] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [isImportSubmitting, setIsImportSubmitting] = useState(false);

  // New project form state
  const [newName, setNewName] = useState("");
  const [newProfile, setNewProfile] = useState<"work" | "client" | "personal">("work");
  const [newGemini, setNewGemini] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [isNewSubmitting, setIsNewSubmitting] = useState(false);

  // Settings dialog state
  const [settingsProject, setSettingsProject] = useState<ProjectData | null>(null);
  const [settingsProfile, setSettingsProfile] = useState<"work" | "client" | "personal">("work");
  const [settingsGemini, setSettingsGemini] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSettingsSubmitting, setIsSettingsSubmitting] = useState(false);

  // DOM Refs
  const importBtnRef = useRef<HTMLButtonElement>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const importDialogRef = useRef<HTMLDialogElement>(null);
  const newDialogRef = useRef<HTMLDialogElement>(null);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const newNameInputRef = useRef<HTMLInputElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setIsHydrated(true);
    void loadProjects();
  }, [loadProjects]);

  // Dialog open side effects
  useEffect(() => {
    if (isImportOpen && importDialogRef.current) {
      if (!importDialogRef.current.open) {
        importDialogRef.current.showModal();
        sourceInputRef.current?.focus();
      }
    }
  }, [isImportOpen]);

  useEffect(() => {
    if (isNewOpen && newDialogRef.current) {
      if (!newDialogRef.current.open) {
        newDialogRef.current.showModal();
        newNameInputRef.current?.focus();
      }
    }
  }, [isNewOpen]);

  useEffect(() => {
    if (settingsProject && settingsDialogRef.current) {
      if (!settingsDialogRef.current.open) {
        settingsDialogRef.current.showModal();
        firstRadioRef.current?.focus();
      }
    }
  }, [settingsProject]);

  const openSettings = (p: ProjectData, triggerBtn: HTMLButtonElement) => {
    settingsBtnRef.current = triggerBtn;
    setSettingsProject(p);
    setSettingsProfile(p.profile);
    setSettingsGemini(p.geminiAllowed);
    setSettingsError(null);
  };

  const closeSettings = () => {
    setSettingsProject(null);
    setSettingsError(null);
    setTimeout(() => {
      settingsBtnRef.current?.focus();
    }, 0);
  };

  const openImport = () => {
    setImportError(null);
    setImportWarnings([]);
    setImportSource("");
    setImportName("");
    setImportGemini(false);
    if (currentProfile !== "All") {
      setImportProfile(currentProfile.toLowerCase() as "work" | "client" | "personal");
    }
    setIsImportOpen(true);
  };

  const closeImport = () => {
    setIsImportOpen(false);
    setImportError(null);
    setImportWarnings([]);
    setTimeout(() => {
      importBtnRef.current?.focus();
    }, 0);
  };

  const openNew = () => {
    setNewError(null);
    setNewName("");
    setNewGemini(false);
    if (currentProfile !== "All") {
      setNewProfile(currentProfile.toLowerCase() as "work" | "client" | "personal");
    }
    setIsNewOpen(true);
  };

  const closeNew = () => {
    setIsNewOpen(false);
    setNewError(null);
    setTimeout(() => {
      newBtnRef.current?.focus();
    }, 0);
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError(null);
    setImportWarnings([]);
    setIsImportSubmitting(true);
    try {
      const payload: {
        source: string;
        profile: string;
        name?: string;
        geminiAllowed?: boolean;
      } = {
        source: importSource.trim(),
        profile: importProfile,
      };
      if (importName.trim()) {
        payload.name = importName.trim();
      }
      if (importProfile === "client") {
        payload.geminiAllowed = importGemini;
      }

      const res = await postJson("/api/projects/import", payload);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setImportError(data.error ?? "Failed to import project.");
        return;
      }

      await loadProjects();

      if (data.warnings && Array.isArray(data.warnings) && data.warnings.length > 0) {
        setImportWarnings(data.warnings);
      } else {
        closeImport();
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import project.");
    } finally {
      setIsImportSubmitting(false);
    }
  };

  const handleNewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewError(null);
    setIsNewSubmitting(true);
    try {
      const payload: {
        name: string;
        profile: string;
        geminiAllowed?: boolean;
      } = {
        name: newName.trim(),
        profile: newProfile,
      };
      if (newProfile === "client") {
        payload.geminiAllowed = newGemini;
      }

      const res = await postJson("/api/projects/new", payload);
      if (res.status === 404) {
        setNewError("Creating new projects isn't available yet");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNewError(data.error ?? "Failed to create project.");
        return;
      }

      await loadProjects();
      closeNew();
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setIsNewSubmitting(false);
    }
  };

  const handleSettingsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsProject) return;
    setSettingsError(null);
    setIsSettingsSubmitting(true);
    try {
      const payload: { profile: string; geminiAllowed?: boolean } = {
        profile: settingsProfile,
      };
      if (settingsProfile === "client") {
        payload.geminiAllowed = settingsGemini;
      } else if (settingsProfile === "work") {
        payload.geminiAllowed = false;
      } else if (settingsProfile === "personal") {
        payload.geminiAllowed = true;
      }

      const res = await postJson(`/api/projects/${settingsProject.id}/settings`, payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSettingsError(data.error ?? "Failed to update project settings.");
        return;
      }

      await loadProjects();
      closeSettings();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to update project settings.");
    } finally {
      setIsSettingsSubmitting(false);
    }
  };

  // Live counts
  const counts: Record<Profile, number> = {
    All: projects.length,
    Work: projects.filter((p) => p.profile.toLowerCase() === "work").length,
    Client: projects.filter((p) => p.profile.toLowerCase() === "client").length,
    Personal: projects.filter((p) => p.profile.toLowerCase() === "personal").length,
  };

  // Filtered list
  const filteredProjects = projects.filter((p) => {
    if (currentProfile !== "All" && p.profile.toLowerCase() !== currentProfile.toLowerCase()) {
      return false;
    }
    if (search.trim()) {
      const query = search.trim().toLowerCase();
      if (!p.name.toLowerCase().includes(query)) {
        return false;
      }
    }
    return true;
  });

  const headerSummary =
    projects.length === 0
      ? "No projects yet"
      : `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;

  return (
    <>
      <header className="main-header" data-hydrated={isHydrated}>
        <div className="header-title-group">
          <h1>Projects</h1>
          <p className="header-summary">{headerSummary}</p>
        </div>
        <div className="header-actions">
          <button
            ref={importBtnRef}
            type="button"
            className="btn-secondary"
            onClick={openImport}
          >
            Import project
          </button>
          <button
            ref={newBtnRef}
            type="button"
            className="btn-primary"
            onClick={openNew}
          >
            New project
          </button>
        </div>
      </header>

      <section className="filter-row" aria-label="Filters">
        <div className="profile-pills" role="radiogroup" aria-label="Profile filter">
          {PROFILES.map((p) => {
            const isSelected = currentProfile === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`profile-pill ${isSelected ? "selected" : ""}`}
                onClick={() => selectProfile(p)}
              >
                {p} · {counts[p]}
              </button>
            );
          })}
        </div>
        <label htmlFor="projects-search" className="search-group">
          <span className="search-label">Search</span>
          <input
            id="projects-search"
            type="search"
            placeholder="Search…"
            className="search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </section>

      <div className="projects-body">
        <section className="projects-grid-area" aria-label="Projects list">
          <div className="projects-grid">
            {projects.length === 0 ? (
              <div className="empty-project-card">
                <span className="empty-project-title">No projects yet</span>
                <p className="empty-project-desc">
                  Import a folder or a Git URL, or start a new project.
                </p>
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="empty-project-card">
                <span className="empty-project-title">No matching projects</span>
                <p className="empty-project-desc">
                  Try clearing the search or choosing a different profile filter.
                </p>
              </div>
            ) : (
              filteredProjects.map((p) => (
                <article key={p.id} className="project-card" aria-label={p.name}>
                  <div className="project-card-header">
                    <h2 className="project-card-title">{p.name}</h2>
                    <span className={`profile-chip profile-chip-${p.profile.toLowerCase()}`}>
                      {p.profile.charAt(0).toUpperCase() + p.profile.slice(1)}
                    </span>
                  </div>
                  <div className="project-card-stage">
                    <span className="project-stage-name">
                      {p.origin === "created" ? "Created" : "Imported"}
                    </span>
                    {p.kitPending && (
                      <>
                        <p className="project-kit-pending">
                          Kit ready on daedalus/kit — review and merge it in your repo
                        </p>
                        <MergeKitControl
                          projectId={p.id}
                          localPath={p.localPath}
                          defaultBranch={p.defaultBranch}
                          onMerged={async () => {
                            setMergedIds((prev) => new Set(prev).add(p.id));
                            await loadProjects();
                          }}
                        />
                      </>
                    )}
                    {!p.kitPending && mergedIds.has(p.id) && (
                      <p className="merge-kit-done">Kit merged into {p.defaultBranch}.</p>
                    )}
                  </div>
                  <div className="project-card-agents">No agents running</div>
                  <footer className="project-card-footer">
                    <span className="project-git-meta">
                      {formatGitHost(p.gitHost)} · {p.defaultBranch}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary-sm"
                      onClick={(e) => openSettings(p, e.currentTarget)}
                    >
                      Settings
                    </button>
                  </footer>
                </article>
              ))
            )}
          </div>
        </section>

        <aside id="inbox" className="inbox-panel" aria-label="Waiting on you">
          <div className="inbox-header">
            <h2 className="inbox-title">Waiting on you</h2>
            <span className="inbox-badge">0</span>
          </div>
          <p className="inbox-empty">Nothing is waiting on you.</p>
        </aside>
      </div>

      {/* Import dialog */}
      {isImportOpen && (
        <dialog
          ref={importDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-dialog-title"
          className="modal-dialog"
          onCancel={(e) => {
            e.preventDefault();
            closeImport();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeImport();
            }
          }}
        >
          <div className="dialog-header">
            <h2 id="import-dialog-title" className="dialog-title">
              Import project
            </h2>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={closeImport}
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleImportSubmit} className="dialog-form">
            <div className="form-group">
              <label htmlFor="import-source" className="form-label">
                Source
              </label>
              <input
                id="import-source"
                ref={sourceInputRef}
                type="text"
                required
                placeholder="/path/to/repo or https://github.com/..."
                value={importSource}
                onChange={(e) => setImportSource(e.target.value)}
                className="form-input"
              />
            </div>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Profile</legend>
              <div className="radio-group" role="radiogroup" aria-label="Profile">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="import-profile"
                    value="work"
                    checked={importProfile === "work"}
                    onChange={() => setImportProfile("work")}
                  />
                  Work
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="import-profile"
                    value="client"
                    checked={importProfile === "client"}
                    onChange={() => setImportProfile("client")}
                  />
                  Client
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="import-profile"
                    value="personal"
                    checked={importProfile === "personal"}
                    onChange={() => setImportProfile("personal")}
                  />
                  Personal
                </label>
              </div>
            </fieldset>

            {importProfile === "client" && (
              <div className="form-group">
                <label htmlFor="import-gemini" className="checkbox-label">
                  <input
                    id="import-gemini"
                    type="checkbox"
                    checked={importGemini}
                    onChange={(e) => setImportGemini(e.target.checked)}
                  />
                  Allow Gemini
                </label>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="import-name" className="form-label">
                Name (optional)
              </label>
              <input
                id="import-name"
                type="text"
                placeholder="Project name"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                className="form-input"
              />
            </div>

            {importError && (
              <div role="alert" className="form-error">
                {importError}
              </div>
            )}

            {importWarnings.length > 0 && (
              <div role="status" className="form-warning">
                <h4>Import warnings</h4>
                <ul>
                  {importWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="dialog-actions">
              {importWarnings.length > 0 ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={closeImport}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeImport}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isImportSubmitting}
                    className="btn-primary"
                  >
                    {isImportSubmitting ? "Importing…" : "Import"}
                  </button>
                </>
              )}
            </div>
          </form>
        </dialog>
      )}

      {/* New project dialog */}
      {isNewOpen && (
        <dialog
          ref={newDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-dialog-title"
          className="modal-dialog"
          onCancel={(e) => {
            e.preventDefault();
            closeNew();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeNew();
            }
          }}
        >
          <div className="dialog-header">
            <h2 id="new-dialog-title" className="dialog-title">
              New project
            </h2>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={closeNew}
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleNewSubmit} className="dialog-form">
            <div className="form-group">
              <label htmlFor="new-name" className="form-label">
                Name
              </label>
              <input
                id="new-name"
                ref={newNameInputRef}
                type="text"
                required
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="form-input"
              />
            </div>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Profile</legend>
              <div className="radio-group" role="radiogroup" aria-label="Profile">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="new-profile"
                    value="work"
                    checked={newProfile === "work"}
                    onChange={() => setNewProfile("work")}
                  />
                  Work
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="new-profile"
                    value="client"
                    checked={newProfile === "client"}
                    onChange={() => setNewProfile("client")}
                  />
                  Client
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="new-profile"
                    value="personal"
                    checked={newProfile === "personal"}
                    onChange={() => setNewProfile("personal")}
                  />
                  Personal
                </label>
              </div>
            </fieldset>

            {newProfile === "client" && (
              <div className="form-group">
                <label htmlFor="new-gemini" className="checkbox-label">
                  <input
                    id="new-gemini"
                    type="checkbox"
                    checked={newGemini}
                    onChange={(e) => setNewGemini(e.target.checked)}
                  />
                  Allow Gemini
                </label>
              </div>
            )}

            {newError && (
              <div role="alert" className="form-error">
                {newError}
              </div>
            )}

            <div className="dialog-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeNew}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isNewSubmitting}
                className="btn-primary"
              >
                {isNewSubmitting ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </dialog>
      )}

      {/* Settings dialog */}
      {settingsProject && (
        <dialog
          ref={settingsDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          className="modal-dialog"
          onCancel={(e) => {
            e.preventDefault();
            closeSettings();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeSettings();
            }
          }}
        >
          <div className="dialog-header">
            <h2 id="settings-dialog-title" className="dialog-title">
              Project settings
            </h2>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={closeSettings}
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleSettingsSubmit} className="dialog-form">
            <fieldset className="form-fieldset">
              <legend className="form-legend">Profile</legend>
              <div className="radio-group" role="radiogroup" aria-label="Profile">
                <label className="radio-label">
                  <input
                    ref={firstRadioRef}
                    type="radio"
                    name="settings-profile"
                    value="work"
                    checked={settingsProfile === "work"}
                    onChange={() => setSettingsProfile("work")}
                  />
                  Work
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="settings-profile"
                    value="client"
                    checked={settingsProfile === "client"}
                    onChange={() => setSettingsProfile("client")}
                  />
                  Client
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="settings-profile"
                    value="personal"
                    checked={settingsProfile === "personal"}
                    onChange={() => setSettingsProfile("personal")}
                  />
                  Personal
                </label>
              </div>
            </fieldset>

            <div className="form-group">
              <label htmlFor="settings-gemini" className="checkbox-label">
                <input
                  id="settings-gemini"
                  type="checkbox"
                  checked={
                    settingsProfile === "work"
                      ? false
                      : settingsProfile === "personal"
                        ? true
                        : settingsGemini
                  }
                  disabled={settingsProfile !== "client"}
                  onChange={(e) => setSettingsGemini(e.target.checked)}
                />
                Allow Gemini
              </label>
              {settingsProfile === "work" && (
                <p className="settings-policy-note">
                  Not allowed for Work projects (company policy)
                </p>
              )}
              {settingsProfile === "personal" && (
                <p className="settings-policy-note">
                  Always allowed for Personal projects
                </p>
              )}
            </div>

            {settingsError && (
              <div role="alert" className="form-error">
                {settingsError}
              </div>
            )}

            <div className="dialog-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeSettings}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSettingsSubmitting}
                className="btn-primary"
              >
                {isSettingsSubmitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
