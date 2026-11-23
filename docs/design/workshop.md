# Workshop — design spec (`/workshop`)

Exported from the "Workshop (agent consoles)" board of the Daedalus 1.0 Layout canvas, 2026-11-23.
Tokens, rail and type are in [layout.md](layout.md). Data and actions come only from the channel
contract `apps/web/src/ws/protocol.ts` (REST: list/start/stop sessions; `/ws`: events, prompts,
cancel, permission answers). [[SPEC#Workshop]]

## What it is
App-wide (rail item **Workshop**, badge "N live"): every live agent session from every project, one
console each, side by side. At most **2** sessions run at once (the server answers 409 for a third).

## Header
- h1 "Workshop"; summary "Live agent sessions across projects".
- Right: "Sessions N / 2" readout, and **New session** (primary).
- **New session** opens a picker panel under the header (bg `surface`, border, radius 14px, padding
  16px): **Project** select (each option "Name · Profile"), **Provider** choice (Claude /
  Antigravity, as two pills), a note "Work projects: Claude only (Gemini off by policy)", **Open
  terminal** (T3.7), and **Start**. The provider choice only offers what the project's profile allows:
  for a Work project Antigravity is not shown at all, and the server refuses it anyway (403).
  At 2/2, Start is disabled with "2 of 2 sessions running · stop one first".
- Server refusals (403 profile rule, 404, 409 full, 502 failed to start) show their message inline
  in the picker, in the `danger` style.

## Console (one per session)
Layout: consoles in a wrapping row (`flex: 1 1 460px`, gap 16px); each is a column with a header,
the output, and the input. Border radius 14px; Claude consoles border `#3A2A20`, Antigravity `#22314D`.

**Header** (wraps): provider chip ("Claude", `claude` on `#2A1D16`; "Antigravity", `gemini` on
`#16213A`), the project name with its profile chip, a session chip (`Task T5 · worktree wt-T5` or
`Free session · project folder`), "context N%" (from `usage` events: `used / size`), then **Run log**
(link, T3.6), **Cancel turn**, **Stop** (danger outline). Stop asks no confirm but cancels any open
permission request.

**Output** (`pre`-like, xterm.js, JetBrains Mono 13px/1.7, bg `#070B16`, min-height 520px, scrolls):
renders events in order:
- `prompt` → the owner's text, in the provider colour, prefixed `>`
- `message` chunks → plain text, appended
- `thought` → muted
- `tool_call` / `tool_call_update` → "● Title" lines, `✓` / `✗` when completed / failed
- `plan` → "[plan] status: entry" lines
- `turn_end` → a muted "— turn ended (reason)" line
- `error` → danger line; `exit` → "Agent exited (code)" and the console shows **Session ended**
  with a **Close** button; the input is removed.

**Input** ("Steer this session", label above): text input + **Send**. While a turn runs
(`busy`): input and Send are disabled, placeholder "Claude is working · you can type after this
turn", **Cancel turn** sits beside them. Send is a `prompt` message; its `ack` clears the box, an
`error` shows under it.

**Reconnect**: when the socket drops, a thin banner at the top of every console: "Reconnecting…".
On reconnect the page re-subscribes with `since` = the last seq it rendered and shows "Reconnected ·
caught up from event N" (ok style) for a few seconds. A 4401 close ("signed out") sends the page to
`/login`.

## Permission requests (T3.5)
A `permission` event renders an amber panel under the output (bg `#1D1810`, border `#6B5320`):
title "Antigravity asks to …" (from the event's `title`), the time left before auto-cancel (10 min,
counting down), "Nothing runs until you choose. Stopping the session cancels this request.", and one
button per offered option: **Allow once** (primary) and **Deny** (danger outline); other option kinds
use their `name`. The whole console gets the amber border and a "Waiting for you" pill in its header;
the rail's Workshop item shows the badge in amber. Choosing sends a `permission` message; the
`permission_resolved` event removes the panel. Nothing is ever auto-approved by the page.

## Free terminal (T3.7)
A third console type, opened from the picker: header "Terminal · Project · you type, no agent", a
shell in the project folder, prompt line `~/projects/<name> $`, **Close**. No agent, no provider chip.

## Empty state
No sessions: one dashed panel "No live sessions. Start one from a project's Pipeline, or open a free
session." with **New session**.

## Accessibility
Each console is a `section` with `aria-label="<Provider> session, <task or free> on <project>"`; the
output is a live region (`aria-live="polite"`) that announces turn ends and permission requests, not
every chunk. Buttons have visible labels; the permission panel is a `role="group"` with a label.
