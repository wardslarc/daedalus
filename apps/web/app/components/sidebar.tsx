"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoutButton } from "./logout-button";

export function Sidebar() {
  const pathname = usePathname();
  const [host, setHost] = useState("127.0.0.1:4317");

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.host) {
      setHost(window.location.host);
    }
  }, []);

  const isProjectsActive = pathname === "/projects" || pathname.startsWith("/projects/");
  const isWorkshopActive = pathname === "/workshop" || pathname.startsWith("/workshop/");
  const isUsageActive = pathname === "/providers" || pathname.startsWith("/providers/");

  return (
    <nav aria-label="Main" className="sidebar">
      {/* 1. Logo */}
      <Link href="/projects" className="rail-logo" aria-label="Daedalus home">
        <svg
          aria-hidden="true"
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="wordmark-logo"
        >
          <path d="M3 3h22v22H3V9" />
          <path d="M8 8h12v12H8v-6" />
          <path d="M13 13h2v2" />
        </svg>
      </Link>

      {/* 2. Three items: Projects, Workshop, Usage */}
      <div className="rail-items">
        <Link
          href="/projects"
          className={`rail-item ${isProjectsActive ? "active" : ""}`}
          aria-current={isProjectsActive ? "page" : undefined}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          <span className="rail-item-label">Projects</span>
        </Link>

        <Link
          href="/workshop"
          className={`rail-item ${isWorkshopActive ? "active" : ""}`}
          aria-current={isWorkshopActive ? "page" : undefined}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3" />
            <path d="M12 15h5" />
          </svg>
          <span className="rail-item-label">Workshop</span>
        </Link>

        <Link
          href="/providers"
          className={`rail-item ${isUsageActive ? "active" : ""}`}
          aria-current={isUsageActive ? "page" : undefined}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 20V10" />
            <path d="M10 20V4" />
            <path d="M16 20v-7" />
            <path d="M22 20H2" />
          </svg>
          <span className="rail-item-label">Usage</span>
        </Link>
      </div>

      {/* 3. Spacer */}
      <div className="rail-spacer" />

      {/* 4. Usage bars */}
      <div
        className="rail-usage"
        role="img"
        aria-label="Claude —, Antigravity —"
      >
        <div className="rail-usage-tracks">
          <div className="rail-usage-col">
            <div className="rail-usage-track">
              <div
                className="rail-usage-fill"
                style={{ height: "0%", backgroundColor: "var(--claude-bar)" }}
              />
            </div>
            <span style={{ color: "var(--claude)" }}>C</span>
          </div>
          <div className="rail-usage-col">
            <div className="rail-usage-track">
              <div
                className="rail-usage-fill"
                style={{ height: "0%", backgroundColor: "var(--gemini-bar)" }}
              />
            </div>
            <span style={{ color: "var(--gemini)" }}>A</span>
          </div>
        </div>
        <span className="rail-usage-empty">—</span>
      </div>

      {/* 5. Status */}
      <div className="rail-status" title={host}>
        <span>local</span>
        <span>only</span>
      </div>

      {/* 6. Sign out */}
      <LogoutButton className="rail-signout-btn" aria-label="Sign out">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </LogoutButton>
    </nav>
  );
}
