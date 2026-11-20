# 0007 — One password, server-side sessions, double-submit CSRF

- **Status:** accepted · 2026-11-20
- **Context:** Daedalus binds to 127.0.0.1 (ADR 0006), but any local browser tab or process could
  still drive it, and it can start agents and run commands. The Build Plan asks for one hashed
  password, a session cookie and CSRF protection.
- **Decision:**
  - The password is set from a terminal with `pnpm dae set-password`, never from a web page, so a
    first-run form can't be claimed by whatever reaches it first. Until it is set the server
    answers 503 with instructions.
  - argon2id (`@node-rs/argon2`, prebuilt, no install script), stored in
    `<data dir>/auth.json` with mode 0600. Data dir is `DAE_DATA_DIR` or `.daedalus-data/`.
  - Sessions are 32 random bytes in an `HttpOnly; SameSite=Strict` cookie, 7 days. The server
    keeps only their SHA-256, in memory: a restart signs everyone out.
  - Every non-GET/HEAD request needs our own `Origin` and an `x-csrf-token` header equal to the
    `dae_csrf` cookie. Login included.
  - 5 wrong passwords lock login for 60 s.
  - All of this runs in the custom server before Next.js (`apps/web/src/auth/`); the password
    never reaches Next.js code. Rules live in the pure `decide()` in `gate.ts`.
- **Consequences:** No accounts, no password reset: forgetting it means running
  `set-password` again from the terminal, which is the trust boundary anyway. Sessions don't
  survive restarts until there's a reason to persist them. No `Secure` cookie flag because the
  site is plain http on loopback. The M3 WebSocket must check the session cookie and Origin on
  `upgrade`. Next.js server actions, if used later, still go through this CSRF gate.
