"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "../../../../components/project-tabs";

export default function ReviewPage() {
  const params = useParams();
  const id = (params?.id as string) ?? "";

  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Review</h1>
          <p className="header-summary">Changes waiting for review, with findings and your decision.</p>
        </div>
      </header>

      <ProjectTabs projectId={id} />

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Changes waiting for review, with findings and your decision.
        </p>
        <span className="empty-state-milestone">Comes in M6</span>
      </div>
    </>
  );
}
