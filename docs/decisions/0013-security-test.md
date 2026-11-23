# 0013 — Security test: planner, workers, proof, retest, all on localhost

- **Status:** accepted · 2026-11-23
- **Context:** ADR 0012 left the optional security step of the release gate open. The owner
  wants a security gate that makes the apps built in Daedalus secure, structured like the
  multi-agent pentest frameworks published in 2026 (a planner, specialist workers, findings
  bound to proof, a retest agent). Those frameworks are being used in real intrusions, and some
  published container images were backdoored. Daedalus uses none of their code, images or
  tooling; only the structure.
- **Decision:**
  - **Scope lock first.** The only target is a throwaway instance of the project that Daedalus
    starts on 127.0.0.1 with a copy of its data. Every request goes through a Daedalus proxy that
    refuses any other host. Agents have no other network access, no free shell, and only
    Daedalus's fixed, non-destructive tools. Per-run time and request budgets.
  - **Planner and workers.** Claude plans from the spec, routes, WebSocket contract and release
    diff. One worker per area (auth and sessions; CSRF, Origin, WebSocket; injection and path
    traversal; secrets and data exposure; dependencies; profile-rule bypass). Profile rules pick
    the providers; Work uses Claude only.
  - **Proof or nothing.** A finding needs a reproducing request/response or test. The other
    provider replays it; unconfirmed findings are "plausible".
  - **Findings become tests.** A fixed finding's proof is saved in the project and runs on
    every release with no model, as a required gate.
  - **Owner in charge.** The owner starts each run, sees usage first, and the findings are
    advice: the gate opens only on the owner's acceptance.
- **Consequences:** security testing costs usage only when the owner runs it, and gets cheaper
  as saved tests accumulate. The proxy, tool set and throwaway instance are new server code,
  security-sensitive, so `[claude]`. Daedalus refuses to point the security test at anything
  outside its own throwaway instance; that refusal is tested.
