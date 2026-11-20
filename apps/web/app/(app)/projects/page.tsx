"use client";

import { useProfile, type Profile } from "../../components/use-profile";

const PROFILES: Profile[] = ["All", "Work", "Client", "Personal"];

export default function ProjectsPage() {
  const [currentProfile, selectProfile] = useProfile();

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Projects</h1>
          <p className="header-summary">No projects yet</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn-secondary" disabled title="Comes in M2">
            Import project
          </button>
          <button type="button" className="btn-primary" disabled title="Comes in M2">
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
                {p} · 0
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
          />
        </label>
      </section>

      <div className="projects-body">
        <section className="projects-grid-area" aria-label="Projects list">
          <div className="projects-grid">
            <div className="empty-project-card">
              <span className="empty-project-title">No projects yet</span>
              <p className="empty-project-desc">
                Import a folder or a Git URL, or start a new project.
              </p>
            </div>
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
    </>
  );
}
