"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";

export default function ReleaseGatePage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Release gate</h1>
          <p className="header-summary">UAT, security checks and your acceptance before a release ships.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      <div className="empty-state-panel">
        <p className="empty-state-text">
          UAT, security checks and your acceptance before a release ships.
        </p>
        <span className="empty-state-milestone">Comes in M6</span>
      </div>
    </>
  );
}
