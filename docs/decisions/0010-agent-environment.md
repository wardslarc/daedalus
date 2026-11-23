# 0010 — Agents get our environment minus a secrets blocklist

- **Status:** accepted · 2026-11-23
- **Context:** The session manager (T3.2) starts agent CLIs (`claude-agent-acp` through npx,
  `agy`) as child processes. They inherit the server's environment unless told otherwise.
  AGENTS.md says providers use their own CLI logins and Daedalus never hands them keys, but
  the owner's shell may hold unrelated secrets (API keys, tokens, database URLs). An automated
  security review suggested an allowlist (PATH, HOME, LANG, TERM, TMPDIR, USER, SHELL).
- **Decision:**
  - A **blocklist**, not an allowlist. Dropped: every `DAE_*` variable; names containing
    TOKEN, SECRET, PASSW, CREDENTIAL, AUTH, COOKIE, PRIVATE, APIKEY, or a `KEY` / `API_KEY` /
    `PAT` word; and any value that is a URL with credentials in it (`scheme://user:pass@…`).
  - `AUTH` also drops `SSH_AUTH_SOCK`: agents don't push or fetch over SSH. Git that needs
    credentials is run by Daedalus itself.
  - The logic is `scrubEnv` in `packages/providers/src/session.ts`, unit-tested with planted
    secrets.
- **Why not an allowlist:** agents need variables we can't list in advance: nvm's PATH and
  `NVM_*`, `XDG_*`, WSL interop (`WSL_*`, `WSLENV`), npm cache settings, locale. An allowlist
  would break agents quietly, in ways that look like provider bugs, and every new provider
  would need entries.
- **Consequences:** a secret under an unusual name (e.g. `MY_SERVICE_PW`) still reaches the
  agent. Run logs (T3.6) redact secret-looking strings as a second line of defence. If a
  provider ever needs a specific variable, providers.json gets an explicit per-provider
  `env` list rather than loosening this filter.
