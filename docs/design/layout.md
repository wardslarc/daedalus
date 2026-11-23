# Daedalus 1.0 Layout — design spec (Direction C)

Exported from the owner's "Daedalus 1.0 Layout" design canvas after the 2026-11-23 UI/UX review.
The canvas is the picture; this file is the source of truth for building. Values are copied from
the boards. Direction C ("Midnight": navy, lime accent, icon rail) replaced the earlier gold theme.

Per-screen specs live beside this file: [workshop.md](workshop.md). Screens built in later
milestones (Project chat M4, Pipeline M5, Review and Release gate M6, Providers M8) get their own
file when their milestone starts, exported from their board at that time.

## Navigation and routes

Two levels:
1. **Rail** (left, 96px): only the app-wide screens.
2. **Project tabs** (top of every project screen): the screens that belong to one project.

| Where | Item | Route | Board |
| --- | --- | --- | --- |
| Rail | Projects | `/projects` | Projects hub |
| Rail | Workshop | `/workshop` | Workshop (agent consoles) |
| Rail | Usage | `/providers` | Providers & usage |
| Project tab | Chat | `/projects/[id]/chat` | Project chat |
| Project tab | Pipeline | `/projects/[id]/pipeline` | Pipeline board |
| Project tab | Review | `/projects/[id]/review` | Review center |
| Project tab | Release gate | `/projects/[id]/release` | Release gate |
| Project tab | Change requests | `/projects/[id]/changes` | Change request |

The old top-level routes `/chat`, `/pipeline`, `/review` and `/release` are removed. A project
screen highlights **Projects** in the rail. There is no global profile switch any more; the only
profile filter is the chips on the Projects hub.

Until a milestone builds a screen, it shows the empty state listed at the end of this file.
Sample data in the boards (Bilyo, Relato, RMK…) is NOT built.

## Tokens

The app uses CSS custom properties (`apps/web/app/globals.css`); the names stay, the values change.

| Token | Value | Used for |
| --- | --- | --- |
| `bg` | `#0A0F1C` | page background |
| `sidebar-bg` | `#0E1424` | rail background |
| `surface` | `#121A2E` | cards, inputs, secondary buttons |
| `surface-2` | `#141D33` | inbox items, raised rows |
| `surface-3` | `#0E1424` | panels, project tabs bar |
| `nav-active-bg` | `#18213A` | active rail item, active tab |
| `border` | `#1F2944` | card borders, rail border, dividers |
| `border-2` | `#2A365A` | buttons, inputs, active tab inset ring |
| `track` | `#212B47` | meter tracks, inactive stage segments, inactive badges |
| `ink` | `#E8EDF7` | primary text |
| `ink-strong` | `#FFFFFF` | active tab text |
| `ink-2` | `#B3BDD1` | secondary text, inactive tabs |
| `muted` | `#97A3BC` | captions, labels, inactive rail items |
| `accent` | `#C8F25A` | primary buttons, logo, current stage, active badge |
| `accent-ink` | `#0A0F1C` | text on accent |
| `accent-soft-bg` | `#1B2410` | selected pill background |
| `accent-soft-ink` | `#DDF79A` | selected pill text, current-stage label |
| `accent-done` | `#7FA33A` | finished stage segments (new) |
| `link` / hover | `#C8F25A` / `#E2FA9E` | links |
| `ok` | `#5DD39E` on `#102019`, border `#1F4434` | passed, shipped, local-only dot |
| `warn` (new) | `#F2C66D` / `#F2E3BF` on `#1D1810`, border `#6B5320` | waiting on you, frozen scope, permission requests |
| `danger` | `#FF8A8A` on `#1D1414`, border `#5A2A2A` | failed checks, blocking items |
| `claude` / `claude-bar` | `#F2A77E` / `#E0895A`, chip bg `#2A1D16` | Claude |
| `gemini` / `gemini-bar` | `#8DB8FF` / `#6AA6F8`, chip bg `#16213A` | Antigravity |
| profile Work | `#FBBF24` on `#2A2311` | |
| profile Client | `#67E8F9` on `#0E2A33` | |
| profile Personal | `#F0ABFC` on `#2A1633` | |

Status colours (ok, warn, danger) and the agent colours (claude, gemini) mean the same on every
screen and are never used for decoration. All text/background pairs above pass 4.5:1.

Type (Google Fonts, through `next/font`): **Space Grotesk** 600/700 for headings and card titles,
**Plus Jakarta Sans** 400/500/600/700 for UI text (replaces Inter), **JetBrains Mono** 400/500 for
ids, branches, versions and the local-only line.
- Page title (h1): Space Grotesk 700, 30px, letter-spacing -0.02em
- Card / panel title: Space Grotesk 600, 14–18px
- Body/UI: Plus Jakarta Sans 14px; captions 12–13px; rail labels 11px 600

Radii: buttons/inputs 10px, cards 14px, phase columns 16px, rail items 12px, tabs 9px, pills 999px,
stage segments 3px. Controls: primary/secondary buttons min-height 40–44px; nothing under 36px.

## Rail (96px wide, full height)

`nav[aria-label="Main"]`, bg `sidebar-bg`, right border 1px `border`, padding 20px 8px, a centred
column with 8px gap, top to bottom:
1. **Logo** (links to `/projects`, `aria-label="Daedalus home"`): the 28×28 labyrinth SVG, stroke
   `accent`, width 2.4, round caps:
   `<path d="M3 3h22v22H3V9"/><path d="M8 8h12v12H8v-6"/><path d="M13 13h2v2"/>`; 16px below it.
2. **Three items**: Projects, Workshop, Usage. Each is an 80px-wide link, padding 10px 4px, radius
   12px, a 22px stroke icon (1.8 stroke, round) above an 11px 600 label, and an optional 10px badge
   under it ("4 waiting", "2 live"). Active: bg `nav-active-bg`, text `ink`, icon and badge
   `accent`, `aria-current="page"`. Inactive: text and icon `muted`. Icons (24×24 viewBox):
   - Projects: four rounded squares `rect x=3 y=3 / 14 3 / 3 14 / 14 14, 7×7, rx 1.5`
   - Workshop: `rect x=3 y=4 w=18 h=16 rx=2` + `path d="M7 9l3 3-3 3"` + `path d="M12 15h5"`
   - Usage: `path d="M4 20V10"`, `M10 20V4`, `M16 20v-7`, `M22 20H2`
3. Spacer.
4. **Usage bars**: two 8×48px vertical tracks (`track`, radius 4px) filled from the bottom with
   `claude-bar` and `gemini-bar` to the week's percentage, labelled "C" and "A" (10px, agent
   colours), with `role="img"` and an `aria-label` giving both percentages. With no usage data:
   empty tracks and the label "—".
5. **Status**: "local / only" (JetBrains Mono 10px `muted`, two lines). The full host:port goes in
   its `title`.
6. **Sign out** stays reachable: an icon button under the status (`aria-label="Sign out"`), using the
   existing `LogoutButton`.

## Project tabs

On every project screen, under the page header: `nav[aria-label="Project sections"]`, bg
`surface-3`, border `border`, radius 12px, padding 4px, wrapping row with 4px gap. Tabs: Chat,
Pipeline, Review, Release gate, Change requests. Each tab: min-height 40px, padding 0 14px, radius
9px, 14px. Active: bg `nav-active-bg`, inset 1px `border-2`, text `ink-strong` 600,
`aria-current="page"`, badge bg `accent` / text `accent-ink`. Inactive: text `ink-2` 500, badge bg
`track` / text `ink`. Badges are hidden when there is nothing to count.

## Main area

`main`: padding 28px 32px, column gap 20px, takes the remaining width; the page is a non-wrapping
flex row (rail, main). Header row (wraps, space-between): h1 + one-line summary (14px `muted`), the
screen's actions on the right.

### Projects hub (`/projects`)
- h1 "Projects"; summary "N projects by phase · N tasks running · Claude N% · Antigravity N% this week".
- Actions, right: profile chips **All / Work / Client / Personal** (min-height 36px, radius 8px;
  selected: border and text `accent`, bg `accent-soft-bg`), **Import** (secondary), **New project**
  (primary).
- Body: a **phase board** of four columns (grid `repeat(4, minmax(230px, 1fr))`, gap 14px, scrolls
  sideways inside its own box below ~1000px): **Shaping** (Intake → Plan), **Building** (Build ·
  Review), **Verify** (Release gate), **Setup** (kit to merge). Column: bg `sidebar-bg`, border
  `border`, radius 16px, padding 12px; title "Shaping · 2" (Space Grotesk 600 14px) with a 11px
  subtitle right.
- Project card (bg `surface`, border `border`, radius 14px, padding 16px, gap 12px): name (links to
  the project's Pipeline) + profile chip; an **8-segment stage bar** (Intake, Spec, Mock, Plan, Build,
  Review, Verify, Ship; 5px high, 3px gap; done `accent-done`, current `accent`, todo `track`;
  `role="img"` with "Stage N of 8: name"); the status line ("Building v1.1 · M2 Quotes · 5 of 9 tasks
  merged"); agent chips if any are running; footer with "GitHub · last shipped v1.0" (11px `muted`)
  and **one next-action button** (primary, small: "Open pipeline", "Test release", "Approve plan",
  "Merge kit", "Continue interview").
- Right: **Needs you** (`aside`, flex 1 1 260px): items grouped and ordered **Blocking** (danger dot)
  → **Decide** (accent dot) → **Info** (muted dot), each a link to the screen that resolves it.
- Empty states: a column with no projects shows "None"; with no projects at all, one card "No
  projects yet · Import a folder or a Git URL, or start a new project". Inbox empty: "Nothing needs you."

### Empty states for screens not built yet
Same header pattern and one panel (`surface`, border, radius 14px, padding 24px):
- Project chat — "Start a project by talking it through: intake, spec, mock and plan." (M4)
- Pipeline — "This milestone's tasks, by status." (M5)
- Review — "Changes waiting for review, with findings and your decision." (M6)
- Release gate — "UAT, security checks and your acceptance before a release ships." (M6)
- Change requests — "Changes asked for after a milestone started, and what you decided." (M6)
- Providers & usage — "Claude and Antigravity: versions, status and weekly usage." (M8)

## Responsive
The rail stays 96px; main shrinks (`min-width: 0`). Wide content (phase board, consoles side by
side, tables) scrolls inside its own box. Nothing may scroll the whole page sideways at 400px.

## History
- 2026-11-23: Direction C chosen over A (graphite list) and B (light paper); rail cut to three items;
  project tabs added; stage order fixed to Intake, Spec, Mock, Plan; Verify stage, Release gate,
  change requests and findings added. The earlier gold-theme spec is in git history.
