"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";

export default function PipelinePage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Pipeline</h1>
          <p className="header-summary">This milestone&apos;s tasks, by status.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      <div className="empty-state-panel">
        <p className="empty-state-text">
          This milestone&apos;s tasks, by status.
        </p>
        <span className="empty-state-milestone">Comes in M5</span>
      </div>
    </>
  );
}
