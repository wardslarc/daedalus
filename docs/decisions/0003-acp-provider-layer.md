# 0003 — ACP as the provider layer

- **Status:** accepted · 2026-11-20
- **Context:** New AI providers must be addable without code changes. Claude (`@agentclientprotocol/claude-agent-acp`) and Antigravity both have ACP agents.
- **Decision:** Daedalus is an ACP client (`@agentclientprotocol/sdk`, ACP v1 stable entrypoint). Each provider is a `providers.json` entry. Agents without ACP run through a CLI fallback inside node-pty. The pipeline asks for roles (lead, coder, reviewer, reader), not provider names.
- **Consequences:** Provider quirks stay inside `packages/providers`. Versions are pinned so updates never change behavior silently.
