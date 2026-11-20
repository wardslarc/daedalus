export default function ReviewPage() {
  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Review</h1>
          <p className="header-summary">Nothing here yet</p>
        </div>
      </header>

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Changes waiting for review, with findings and your decision.
        </p>
        <span className="empty-state-milestone">Comes in M6</span>
      </div>
    </>
  );
}
