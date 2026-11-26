# 0025 — Visual diff against the approved mock

- **Status:** accepted · 2026-11-26 (owner chose screens marked in the mock, with an owner-typed list as fallback)
- **Context:** T6.6 ([[SPEC#Release gate]], [[SPEC#Gate findings]]): each screen is compared with the approved
  mock's screenshots; the owner accepts (reference updated) or rejects (fix task) every difference. The mock is
  one agent-written, clickable `docs/mock.html` with no list of screens, and mock approval (T4.3) stores only the
  artifact link: nothing records which bytes were approved, and the repo copy is agent-writable during Build.
  T6.4/T6.5 (ADR 0021, 0024) give a UAT session with the app running from the owner's start command, Daedalus's
  own Playwright, and a replay step before manual UAT.
- **Decision:**
  - **The approved mock is frozen in SQLite.** Approve mock also stores the sha256 of `docs/mock.html`
    (`shaping_state.mock_approved_sha256`). Start milestone copies `docs/mock.html` into `approved_mocks`
    (project, release, html, sha256) in its transaction, only if the file's hash equals the approved hash
    (otherwise Start milestone is refused: "mock.html changed since you approved it"), like PLAN.md in ADR 0018.
    The visual diff reads only that copy. A milestone started before this change has no copy: the Release page
    then shows the release head's `docs/mock.html` and the owner confirms it as the approved mock (who, when,
    sha256 recorded) before the first visual run. Re-approval after Build stays a change request (T6.7).
  - **Screens are marked in the mock (owner's choice).** The Mock prompt asks for every view to be an element
    with `data-screen="<name>"` (lowercase `a-z0-9-`, 1–60 chars, unique) and `data-app-path="<path>"` (starts
    with a single `/`, no scheme, no `//`, no `\`, ≤ 300 chars, query allowed). Screens are read from the frozen
    copy by Daedalus (in the offline browser below, not by regex), max 50. Invalid or duplicate markers are a
    visual-run error naming the marker. **Fallback** for a mock with no markers: the owner types a list on the
    Release page (name, app path, mock anchor `#id` or empty for the whole page; same rules), stored in SQLite
    per project and release. Markers win when both exist (the list is then shown read-only). No screens at all
    is a non-blocking finding the owner accepts or defers with a reason.
  - **Mock screenshots are taken offline.** The frozen HTML is loaded with `page.setContent` in headless
    Chromium, in a fresh context with `offline: true`, a route that aborts every request, no downloads, no
    permissions, viewport 1280×800, device scale 1, reduced motion, `animations: "disabled"`, caret hidden. For a
    marked screen, Daedalus hides every other `[data-screen]` element and forces this one visible, then takes an
    element screenshot; for a list screen, it goes to the anchor and takes a full-page screenshot. Height is
    clipped at 8,000 px. The mock's own scripts may run, but they can't reach the network or the file system.
  - **App screenshots run inside the UAT session, after replay.** When a session's replay has finished, the server
    takes one headless screenshot per screen: app origin + app path, same viewport and settings, waits for
    `load` then network idle (max 15 s), full page clipped at 8,000 px. The resolved URL and every redirect must
    stay on the app's origin (otherwise that screen is an error). Fresh context, no owner cookies; scrubbed env
    (ADR 0010); killed on Stop/shutdown. The owner can re-run it from the session. No model is used (ADR 0012).
  - **Reference and comparison.** Each screen has a reference image (`visual_references`: project, screen name,
    png sha256, path, source `mock` | `accepted`, release, mock sha256 it was derived from, decided by/at). The
    first reference is the mock screenshot. Comparison uses `pixelmatch` (threshold 0.1, anti-aliasing ignored)
    after padding both images to the larger size (a size change counts as changed pixels). Changed pixels
    > 0.5 % of the padded area = **different**; ≤ 0.5 % = **same**. If the frozen mock's sha256 changes (an
    accepted CR), references derived from the old mock go back to the new mock's screenshots.
  - **Results are bound to the head.** `visual_runs` (session, release, head SHA, status running | done | error)
    and `visual_results` (run, screen, status same | different | error, diff ratio, paths of reference, current
    and diff PNG). Images live under `<dataDir>/visual/<project>/<run>/`, PNG only, ≤ 20 MiB each, served through
    an authenticated route that checks the path stays inside that folder (as ADR 0021). A run that can't produce
    a readable result for a screen is **error** for that screen, never same.
  - **Every difference is decided by the owner.** Per different screen: **Accept** → the current screenshot
    becomes that screen's reference (`source = accepted`), with an optional note; **Reject** → a blocking gate
    finding (`check = "visual"`, title naming the screen) resolved only by a `fix-task` (owner enters its check
    command, ADR 0018/0020). An error screen is a blocking finding resolved by a fix task or by a later run where
    that screen is not an error. Decisions are bound to the run; accepting a difference on an old head doesn't
    carry over to a new head's run.
  - **Ship** additionally needs a finished visual run on the current release head with no undecided difference
    and no error screen (or a decided "no screens" finding), with the gate rules of ADR 0020/0021/0024.
- **Consequences:** the visual diff never trusts the repo copy of the mock and runs no model. The first release
  of a project will show almost every screen as different (a mock is rougher than the app); the owner accepts
  those once and later releases compare against what was accepted. Pixel comparison flags dynamic content
  (dates, counters): the owner accepts or rejects it; masking is left for later. Needs `pixelmatch` and `pngjs`
  as runtime dependencies of `packages/projects`. Mocks made before this change have no markers, so they use the
  typed list until a change request re-shapes the mock.
