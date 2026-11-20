import type { ReactNode } from "react";
import { Sidebar } from "../components/sidebar";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
