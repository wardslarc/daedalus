# Daedalus 1.0 Layout — design spec

Exported from the owner's "Daedalus 1.0 Layout" design canvas (boards: Projects hub, Project chat,
Pipeline board, Workshop, Review center, Providers & usage, Sidebar). This file is the source of
truth for T1.4; values are copied exactly from the design.

## Screens and routes

Every screen is the shared **Sidebar** (232px) on the left plus a main area. Design frame: 1440×960.

| Sidebar item | Route | Board | Sidebar badge in design |
| --- | --- | --- | --- |
| Projects | `/projects` | Projects hub | count of projects |
| Project chat | `/chat` | Project chat | `start` |
| Pipeline | `/pipeline` | Pipeline board | — |
| Workshop | `/workshop` | Workshop (agent consoles) | `2 live` |
| Review | `/review` | Review center | count waiting |
| Release gate | `/release` | Release gate (Verify stage) | — |
| Providers & usage | `/providers` | Providers & usage | — |

In M1 there is no data yet: badges are hidden when there is nothing to count, and every main area
shows an empty state (see below). Sample data in the design (Bilyo, Relato, RMK…) is NOT built.

## Tokens

Colors
| Token | Value | Used for |
| --- | --- | --- |
| `bg` | `#0F1115` | page background |
| `sidebar-bg` | `#0B0D11` | sidebar background |
| `surface` | `#151820` | cards, inputs, secondary buttons |
| `surface-2` | `#1A1E27` | inbox items |
| `surface-3` | `#12151B` | usage panel in sidebar |
| `nav-active-bg` | `#1C212B` | active nav item, version chip |
| `border` | `#232833` | card borders, sidebar right border, dividers |
| `border-2` | `#2E3441` | buttons, inputs, active nav inset ring |
| `track` | `#262B36` | meter tracks, inactive badges |
| `ink` | `#E6E8EC` | primary text |
| `ink-strong` | `#FFFFFF` | active nav text |
| `ink-2` | `#B4BBC8` | nav text, secondary text |
| `muted` | `#9AA3B2` | captions, labels |
| `accent` | `#D9A441` | primary button, logo stroke, active badge, active pill border |
| `accent-ink` | `#17130A` | text on accent |
| `accent-soft-bg` | `#2A2312` | selected pill background |
| `accent-soft-ink` | `#F2D38A` | selected pill text |
| `link` / hover | `#E6C47A` / `#F5DCA0` | links |
| `ok` | `#5DD39E` | "local only" status dot |
| `claude` / `claude-bar` | `#F2A77E` / `#E0895A` | Claude label / meter fill |
| `gemini` / `gemini-bar` | `#8DB8FF` / `#6AA6F8` | Antigravity label / meter fill |
| `danger` | `#FF8A8A` | failed check label |
| profile Work | `#C9B6FF` on `#241E36` | |
| profile Client | `#7FD8C4` on `#15302B` | |
| profile Personal | `#F2C66D` on `#2E2614` | |

Type (Google Fonts): **Space Grotesk** 500/600/700 for the wordmark and headings, **Inter**
400/500/600 for UI text, **JetBrains Mono** 400/500 for the version chip and the local-only line.
- Page title (h1): Space Grotesk 600, 30px, letter-spacing -0.01em
- Card / panel title (h2): Space Grotesk 600, 17–18px
- Body/UI: Inter 14px; captions 12–13px; labels 11px 600 uppercase, letter-spacing 0.08em, `muted`

Radii: buttons/inputs 10px, cards 14px, nav items 10px, pills 999px, meters 3px.
Controls: primary/secondary buttons min-height 44px, padding 0 18px.

## Sidebar (232px wide, full height)

`nav[aria-label="Main"]`, background `sidebar-bg`, right border 1px `border`, padding 24px 16px,
column with 24px gap, top to bottom:

1. **Wordmark** (links to `/projects`): 28×28 SVG logo — a squared labyrinth spiral, stroke
   `accent`, width 2, round caps:
   `<path d="M3 3h22v22H3V9"/><path d="M8 8h12v12H8v-6"/><path d="M13 13h2v2"/>` —
   then "Daedalus" (Space Grotesk 700, 20px, -0.01em), then a `1.0` chip (JetBrains Mono 500 11px,
   `ink-2` on `nav-active-bg`, radius 6px, padding 2px 7px). Gap 10px, padding 0 8px.
2. **Profile switcher**: label "Profile" (11px label style), then a 2×2 grid (gap 6px) of buttons
   All / Work / Client / Personal, min-height 34px, radius 8px, Inter 500 12px. Selected: border
   `accent`, bg `accent-soft-bg`, text `accent-soft-ink`, `aria-pressed="true"`. Others: border
   `border-2`, transparent, text = that profile's color (All uses `accent-soft-ink`). In M1 the
   choice is client-side only and remembered in localStorage; filtering comes in M2.
3. **Nav** (gap 4px): the six items in the table above. Item: min-height 42px, padding 0 12px,
   radius 10px, Inter 500 14px, label left, optional badge right. Active: bg `nav-active-bg`,
   inset 0 0 0 1px `border-2`, text `ink-strong`, `aria-current="page"`, badge bg `accent` /
   text `accent-ink`. Inactive: text `ink-2`, badge bg `track` / text `ink`. Badge: padding
   1px 8px, radius 999px, 11px 600.
4. Spacer (flex-grow).
5. **Usage panel**: padding 14px, radius 12px, bg `surface-3`, border `border`. Two meters
   (gap 14px): "Claude · this week" (`claude`) and "Antigravity · weekly" (`gemini`), percentage
   right in `ink-2` 12px, 6px track `track`, fill `claude-bar` / `gemini-bar`, and under
   Antigravity a caption "Resets Mon 08:00" (11px `muted`). In M1 there is no usage data: show
   "—" instead of a percentage and an empty track (usage is M8).
6. **Status line**: 8px `ok` dot + "127.0.0.1:4317 · local only" (JetBrains Mono 11px `muted`).
   Show the real host:port the server is on.
7. Add for M1: a **Sign out** control under the status line (secondary text style), using the
   existing `LogoutButton` / CSRF helper from T1.3.

## Main area

`main`: padding 32px 40px, column gap 24px, takes the remaining width.

Header row (wraps, space-between, align end): h1 + one-line summary under it (14px `muted`),
and the screen's actions on the right.

### Projects (`/projects`)
- h1 "Projects"; summary "No projects yet".
- Actions: "Import project" (secondary: bg `surface`, border `border-2`, text `ink`) and
  "New project" (primary: bg `accent`, text `accent-ink`, 600). Both disabled in M1 with a
  tooltip "Comes in M2".
- Filter row: profile pills "All · 0", "Work · 0", "Client · 0", "Personal · 0" (min-height 36px,
  padding 0 14px, radius 999px, 13px; selected uses the accent-soft style) and a "Search"
  labelled input (min-height 38px, width 220px, bg `surface`, border `border-2`, radius 10px).
- Body: left, the project grid area (cards `surface`, border `border`, radius 14px, padding
  18px; grid auto-fill minmax(280px,1fr), gap 16px) showing one dashed empty card
  (bg `#121419`, 1px dashed `#3A4150`) with "No projects yet" and "Import a folder or a Git URL,
  or start a new project." Right, the **"Waiting on you"** panel (`aside#inbox`, flex 1 1 300px,
  `surface`, border, radius 14px, padding 18px): h2 + count badge, empty text "Nothing is
  waiting on you."

### Other screens (`/chat`, `/pipeline`, `/workshop`, `/review`, `/release`, `/providers`)
Same header pattern with the board's title as h1 ("Project chat", "Pipeline", "Workshop",
"Review", "Release gate", "Providers & usage"), a one-line summary, and one empty-state panel (`surface`,
border, radius 14px, padding 24px) saying what will appear there and which milestone builds it:
- Project chat — "Start a project by talking it through: intake, mock, spec and plan." (M4)
- Pipeline — "Tasks from the project's PLAN.md, by stage." (M5)
- Workshop — "Live agent sessions, one console per running agent." (M3)
- Review — "Changes waiting for review, with findings and your decision." (M6)
- Release gate — "UAT, security checks and your acceptance before a release ships." (M6)
- Providers & usage — "Claude and Antigravity: status, roles and weekly usage." (M8)

## Design changes, 2026-11-23 (canvas updated)
- Pipeline stage bar has 8 stages: Intake, Spec, Mock approved, Plan, Build, Review, **Verify**, Ship
  (Ship shown as locked until Verify passes). [[SPEC#Pipeline]]
- New board **Release gate** (`ReleaseGate.dc.html`, sidebar item "Release gate"): UAT checklist
  from the spec's `## Verify` items with Pass / Fail-with-note and an "Open app in recorded
  Chromium" button; visual diff against the approved mock with Accept / Reject per screen;
  always-on checks (saved UAT scripts, saved security tests, secret scan, dependency audit,
  profile ship checklist); the optional security test (scope chips: throwaway 127.0.0.1 target,
  proxy, budget; worker areas; findings with severity, Confirmed / Plausible, proof, "Save proof
  as security test"). "Accept release and ship" stays disabled until every gate passes.
  [[SPEC#Release gate]] [[SPEC#Security test]]
- Workshop consoles: header buttons are **Cancel turn** and **Stop** (no Pause). A permission
  request shows inline under the console output (amber panel: what the agent wants to do, time
  left before auto-cancel, **Allow once** / **Deny**). [[SPEC#Workshop]]

## Responsive
Sidebar and main sit in a wrapping flex row (sidebar `flex: 1 1 232px`, main `flex: 999 1 560px`),
so under ~800px the sidebar stacks above the main area. Nothing may scroll sideways at 400px.
