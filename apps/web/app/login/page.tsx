"use client";

import { useEffect, useState, type FormEvent } from "react";
import { postJson } from "../csrf-fetch";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Tests (and impatient clicks) wait for this: before hydration the form would submit as a plain GET.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    try {
      const res = await postJson("/api/login", { password });
      if (res.ok) {
        window.location.assign("/projects");
        return;
      }
      if (res.status === 429) {
        const body = (await res.json()) as { retryAfterSeconds?: number };
        setError(`Too many wrong tries. Try again in ${body.retryAfterSeconds ?? 60} seconds.`);
      } else if (res.status === 401) {
        setError("Wrong password.");
      } else {
        setError("Couldn't sign in. Reload the page and try again.");
      }
    } catch {
      setError("Couldn't reach the Daedalus server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: "15vh auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Sign in to Daedalus</h1>
      <form onSubmit={onSubmit} data-hydrated={hydrated ? "true" : "false"}>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          style={{ display: "block", width: "100%", fontSize: 16, padding: 10, margin: "6px 0 12px" }}
        />
        <button type="submit" disabled={busy} style={{ fontSize: 16, padding: "10px 18px" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p id="login-error" role="alert" style={{ color: "#b00020", minHeight: "1.5em" }}>
          {error}
        </p>
      </form>
    </main>
  );
}
