import { LogoutButton } from "../components/logout-button";

export default function ProjectsPage() {
  return (
    <main style={{ maxWidth: 960, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Projects</h1>
        <LogoutButton />
      </header>
      <p>No projects yet. The full app shell arrives in T1.4.</p>
    </main>
  );
}
