# 0005 — Usage: Claude read from ACP, Antigravity entered by hand

- **Status:** accepted · 2026-11-23
- **Context:** SPEC#Usage and quota wants Claude usage against the owner's weekly limit and
  Antigravity's weekly quota, so the queue can pause at the Claude limit and `[gemini]` tasks can
  move to Claude when Antigravity runs out. T0.4: run both ACP spikes and see what `usage_update`
  events carry. Runs: 2026-11-20 (claude-agent-acp 0.109.0, Antigravity ACP server 1.5.13) and
  2026-11-23 in `~/work` (same Claude adapter, Antigravity 1.5.14). Logs in `spikes/out/`.
- **What arrives:**
  - **Claude**: several `usage_update` per turn with `used` / `size` (context tokens, size 1,000,000)
    and `cost` (USD), and in `_meta["_claude/rateLimit"]` the account's real limits:
    `unifiedWindows.five_hour` and `unifiedWindows.seven_day`, each with `utilization` (0–1),
    `resetsAt` (unix seconds) and `status` (`allowed`, `allowed_warning` past `surpassedThreshold`
    0.9, …), plus `overageStatus`. Example from 2026-11-23: five-hour 0.91 (`allowed_warning`),
    seven-day 0.66.
  - **Antigravity**: one or two `usage_update` per turn with `used` / `size` (context tokens, size
    1,048,576) only. No cost, no quota, no reset time. `agy` has no usage or quota command.
- **Decision:**
  - **Claude: read from ACP.** Each `usage_update` that has `_claude/rateLimit` updates a stored
    "latest Claude limits" reading (both windows, reset times, status, and when it was read).
    The weekly meter is the **seven-day utilization**; the five-hour window is shown beside it,
    because it is the one that actually stops work first. The queue pauses when either window's
    status stops being `allowed`/`allowed_warning`, or at the owner's own weekly cap if set lower.
    Readings only arrive while a Claude session runs, so the meter shows "read N min ago".
  - **Antigravity: manual entry.** The owner types the weekly quota percentage (from the Antigravity
    app) and can mark it **used up**, which triggers the `[gemini]` → Claude fallback. Daedalus also
    shows the tokens its own Antigravity sessions used this week, labelled as Daedalus usage, never
    as quota.
  - **No estimates** of quota from tokens for either provider: a wrong number is worse than "unknown".
  - Parse `_meta` defensively: the `_claude/` keys are adapter details, not ACP spec. The pinned
    adapter version (providers.json) keeps them stable; a missing key means "no reading", not an error.
- **Consequences:** M8's usage work is concrete: store and show Claude's two windows, a manual
  Antigravity field with "used up", per-session cost and tokens from the run logs. The Providers &
  usage board's "from agy · updated 1 h ago" becomes "entered by you · updated …". If Antigravity
  later reports quota over ACP, this ADR is revisited.
