"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { slug: "chat", label: "Chat" },
  { slug: "pipeline", label: "Pipeline" },
  { slug: "review", label: "Review" },
  { slug: "release", label: "Release gate" },
  { slug: "changes", label: "Change requests" },
] as const;

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Project sections" className="project-tabs">
      {TABS.map((tab) => {
        const href = `/projects/${projectId}/${tab.slug}`;
        const isActive = pathname === href;
        return (
          <Link
            key={tab.slug}
            href={href}
            className={`project-tab ${isActive ? "active" : ""}`}
            aria-current={isActive ? "page" : undefined}
          >
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
