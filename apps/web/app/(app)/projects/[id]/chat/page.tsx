"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";

export default function ProjectChatPage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Project chat</h1>
          <p className="header-summary">Start a project by talking it through: intake, spec, mock and plan.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Start a project by talking it through: intake, spec, mock and plan.
        </p>
        <span className="empty-state-milestone">Comes in M4</span>
      </div>
    </>
  );
}
