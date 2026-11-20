export default function PipelinePage() {
  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Pipeline</h1>
          <p className="header-summary">Nothing here yet</p>
        </div>
      </header>

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Tasks from the project&apos;s PLAN.md, by stage.
        </p>
        <span className="empty-state-milestone">Comes in M5</span>
      </div>
    </>
  );
}
