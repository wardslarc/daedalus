"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoutButton } from "./logout-button";
import { useProfile, type Profile } from "./use-profile";

const NAV_ITEMS = [
  { name: "Projects", path: "/projects" },
  { name: "Project chat", path: "/chat" },
  { name: "Pipeline", path: "/pipeline" },
  { name: "Workshop", path: "/workshop" },
  { name: "Review", path: "/review" },
  { name: "Providers & usage", path: "/providers" },
] as const;

const PROFILES: { id: Profile; label: string; colorVar: string }[] = [
  { id: "All", label: "All", colorVar: "var(--accent-soft-ink)" },
  { id: "Work", label: "Work", colorVar: "var(--profile-work)" },
  { id: "Client", label: "Client", colorVar: "var(--profile-client)" },
  { id: "Personal", label: "Personal", colorVar: "var(--profile-personal)" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [currentProfile, selectProfile] = useProfile();
  const [host, setHost] = useState("127.0.0.1:4317");

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.host) {
      setHost(window.location.host);
    }
  }, []);

  return (
    <nav aria-label="Main" className="sidebar">
      {/* 1. Wordmark */}
      <Link href="/projects" className="wordmark">
        <svg
          aria-hidden="true"
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="wordmark-logo"
        >
          <path d="M3 3h22v22H3V9" />
          <path d="M8 8h12v12H8v-6" />
          <path d="M13 13h2v2" />
        </svg>
        <span className="wordmark-title">Daedalus</span>
        <span className="version-chip">1.0</span>
      </Link>

      {/* 2. Profile switcher */}
      <div className="profile-switcher">
        <span className="sidebar-label">Profile</span>
        <div className="profile-grid">
          {PROFILES.map((p) => {
            const isSelected = currentProfile === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`profile-btn ${isSelected ? "selected" : ""}`}
                style={{ color: isSelected ? "var(--accent-soft-ink)" : p.colorVar }}
                aria-pressed={isSelected ? "true" : "false"}
                onClick={() => selectProfile(p.id)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Nav */}
      <div className="nav-list">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`nav-item ${isActive ? "active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <span>{item.name}</span>
            </Link>
          );
        })}
      </div>

      {/* 4. Spacer */}
      <div className="sidebar-spacer" />

      {/* 5. Usage panel */}
      <div className="usage-panel">
        <div className="meter-group">
          <div className="meter-header">
            <span style={{ color: "var(--claude)" }}>Claude · this week</span>
            <span className="meter-val">—</span>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: "0%", backgroundColor: "var(--claude-bar)" }} />
          </div>
        </div>

        <div className="meter-group">
          <div className="meter-header">
            <span style={{ color: "var(--gemini)" }}>Antigravity · weekly</span>
            <span className="meter-val">—</span>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: "0%", backgroundColor: "var(--gemini-bar)" }} />
          </div>
          <span className="meter-caption">Resets Mon 08:00</span>
        </div>
      </div>

      {/* 6. Status line */}
      <div className="status-line">
        <span className="status-dot" />
        <span className="status-text">{host} · local only</span>
      </div>

      {/* 7. Sign out */}
      <div className="sidebar-signout-wrapper">
        <LogoutButton className="sidebar-signout-btn" />
      </div>
    </nav>
  );
}
