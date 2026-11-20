export default function ChatPage() {
  return (
    <>
      <header className="main-header">
        <div className="header-title-group">
          <h1>Project chat</h1>
          <p className="header-summary">Nothing here yet</p>
        </div>
      </header>

      <div className="empty-state-panel">
        <p className="empty-state-text">
          Start a project by talking it through: intake, mock, spec and plan.
        </p>
        <span className="empty-state-milestone">Comes in M4</span>
      </div>
    </>
  );
}
