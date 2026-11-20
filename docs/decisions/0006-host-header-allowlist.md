# 0006 — Host header allowlist on the local server

- **Status:** accepted · 2026-11-20
- **Context:** Binding to `127.0.0.1` stops other devices, but not DNS rebinding: a web page
  on another site can resolve its own hostname to `127.0.0.1` and then call Daedalus from the
  owner's browser. The browser still sends the attacker's hostname in the `Host` header.
  Daedalus can start agents and run check commands, so a rebinding hit would be serious.
- **Decision:** `apps/web/server.ts` accepts a request only when `Host` is exactly
  `127.0.0.1:<port>` or `localhost:<port>` (`apps/web/src/host-check.ts`). Everything else gets
  `421 Misdirected Request` before Next.js sees it. The bind address is a constant, not an
  option; only the port is configurable (`DAE_PORT`, default 4317). IPv6 `[::1]` is not
  accepted because the server does not listen on IPv6.
- **Consequences:** Daedalus can't be reached through a custom hostname, a reverse proxy or
  port forwarding without changing this code, which is the point. The WebSocket (M3) must run
  the same check on `upgrade`, plus the Origin check from SPEC#Security. Login (T1.3) and CSRF
  are still needed: this guard only stops cross-site rebinding, not other local processes.
