# 0008 — Profile rules in one pure module, enforced by the server

- **Status:** accepted · 2026-11-20
- **Context:** Work projects must never go to Gemini (company policy); Client projects use it
  only when the client allows; Personal projects use everything. If those rules lived in the UI,
  a direct API call or a hand-edited database row could get around them.
- **Decision:** `packages/core/src/profiles.ts` holds the whole rules table and the guards
  (`assertProviderAllowed`, `assertSkipPermissionsAllowed`, `validateProjectSettings`). The
  server calls them before starting any agent and before saving settings, and maps
  `ProfileRuleError` to 403. The stored `gemini_allowed` flag only counts for Client: Work is
  always refused and Personal always allowed, whatever the row says. Unknown profiles and
  unknown providers fail closed. Asking for a forbidden setting is an error, never silently
  changed. The same rules render into each project's AGENTS.md through the kit.
- **Consequences:** Changing company policy means editing one table and its tests. A wrong
  git host is a warning, not an error, since a work repo can live on GitHub. The UI may hide
  options, but never as the only check.
