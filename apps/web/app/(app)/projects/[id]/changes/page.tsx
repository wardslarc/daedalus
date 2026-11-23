"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";

export default function ChangeRequestsPage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Change requests</h1>
          <p className="header-summary">Changes asked for after a milestone started, and what you decided.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Changes asked for after a milestone started, and what you decided.
        </p>
        <span className="empty-state-milestone">Comes in M6</span>
      </div>
    </>
  );
}
