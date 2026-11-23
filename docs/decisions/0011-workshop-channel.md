# 0011 — Workshop channel: REST for lifecycle, one WebSocket for live traffic

- **Status:** accepted · 2026-11-23
- **Context:** The Workshop (T3.4) needs agent output streamed to the browser and the owner's
  prompts and permission answers sent back (T3.3). A WebSocket is a new way into the server:
  browsers send cookies on cross-site WebSocket requests and no CORS preflight protects it,
  so it needs its own checks. Next.js 16 also adds its own `upgrade` listener to the HTTP
  server on the first request, which accepts any upgrade with no session check.
- **Decision:**
  - Starting, listing and stopping sessions is REST (`/api/sessions`, CSRF-checked like every
    POST). Live traffic (events, prompts, cancel, permission answers) uses one WebSocket at
    `/ws`. The contract is `apps/web/src/ws/protocol.ts`; browser messages are parsed strictly
    (unknown types or fields refused, 64 KiB max).
  - The upgrade handler checks, before any socket opens: Host allowlist (421), exact loopback
    Origin on our port (403, missing Origin too), live session cookie (401), path (404).
  - Next.js gets a dummy `httpServer` so its auto-hook never sees real upgrades. Our handler
    forwards only `/_next/` (dev HMR) to Next's router-server `upgradeHandler`, after the Host
    and Origin checks. Production forwards nothing.
  - Logout (or a new login) closes that session's sockets (code 4401); every incoming message
    re-checks the session.
  - Agent sessions keep a numbered backlog; `subscribe` with `since` replays only what a
    reconnecting tab missed. A tab that falls 4 MiB behind is closed and reconnects.
- **Consequences:** the Workshop screen needs no server code, only the contract. The Next.js
  hook relies on a non-public getter (`upgradeHandler`), checked at startup with a clear
  error; re-check it when upgrading Next. HMR doesn't need a session, so the dev login page
  still reloads.
