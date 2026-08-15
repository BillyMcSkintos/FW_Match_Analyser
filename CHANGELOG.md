# Changelog

Versions follow `MAJOR.MINOR.PATCH`:

- **PATCH** — bugfix / FinalWhistle-compatibility fix, no meaningful feature change.
- **MINOR** — new analysis/view/parser capability.
- **MAJOR** — incompatible stored-data or major UI/model break.

The project is pre-1.0; MAJOR is not bumped merely for internal refactors.
`manifest.json`'s `version` field is canonical — `package.json` is kept in sync with it.

## [Unreleased]

### Added
- A **Playback** tab with match/selected-opportunity scope, play/pause, step, seek,
  restart, and speed controls.
- A pure playback cue adapter that preserves parser order, counter-attack ownership,
  tactical events, recoveries, and arbitrarily repeated shots after goalkeeper rebounds.
- Progressive schematic pitch highlighting, significant-moment vignettes, timeline
  seeking, and reduced-motion support without external assets or network requests.
- Readable normal-speed timing and a dedicated directional arrow for each parsed action
  before playback advances to the next step.

## [0.5.0] — Firefox compatibility

### Added
- One source tree for Chrome/Chromium and Firefox, backed by namespace, background-
  environment, sender-validation, Promise storage, and fallback tab-selection tests.
- A stable Gecko ID and explicit no-data-collection declaration for future AMO signing.
- Mozilla `web-ext lint` as part of the local and CI release gate.
- Kickoff scraping and tactical-phase display for all five main team tactics: Mentality,
  Style of Play, Marking, Defence Focus, and Preferred Side.
- Extra-time break, preferred-side order, and successful/failed offside-trap parsing,
  backed by a new integration fixture.
- One-click issue-ready diagnostic copying from warning banners, including exact unknown
  lines and nearby narrative context.

### Changed
- Runtime extension APIs now pass through a minimal `browser`/`chrome` boundary and use
  Promise-based MV3 calls in both browsers.
- The shared MV3 manifest declares both Chrome's service worker and Firefox's background
  scripts; `utils.js` is loaded exactly once in either environment.
- Sender validation now compares against `runtime.getURL('viewer.html')`, retaining the
  extension-ID/tab/path checks while securely supporting `moz-extension:` URLs.
- JPG decode failures use browser-neutral wording.
- Renamed the Squad tab to **Tactics** and removed the redundant fixed-window Phases tab.
- Recovered counter-attacks now emphasize the route that continued while keeping an
  earlier blocked pass as subdued pitch context; Chain Detail uses the actual attacking
  team and includes recovery passes.
- Selected-opportunity narrative is viewport-bounded and vertically scrollable.

### Fixed
- Style-change wording is labeled and modeled as **Style of Play**, never “Middle Order.”
- Recognized observed unfavored-pass requests and shots rebounding from the crossbar.
- Repeated Scrape clicks no longer redeclare top-level scraper bindings in the same tab.

## [0.4.0] — Fork-review adoptions: hardening + JPG export

Six items cherry-picked from an independent hardening/feature pass on a fork of this
project (`TheCrowsFW/FW_Match_Analyser`, `hardened-0.6.0` branch), adapted to this
project's own architecture rather than merged wholesale. Not adopted from that same
review: `chrome.storage.session` instead of `.local`, and dropping `tabs`/
`host_permissions` for `activeTab`-only — both are genuine trade-offs left for a
separate decision, not oversights.

### Added
- `static-audit.test.js` — a CI test that regex-scans the whole runtime bundle for
  forbidden sinks (`fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `document.cookie`,
  `chrome.cookies`, `chrome.downloads`, ...) and separately scans every repo file for
  secret-shaped strings (private keys, bearer tokens, GitHub tokens). Turns the D11
  "no external upload path" audit from a one-time manual check into a permanent,
  automatic one.
- `canonicalMatchUrl()` in `scraper.js` — strict URL validation (protocol, hostname,
  no embedded credentials/port) gating `fwScrape()` on a genuine finalwhistle.org page
  before it does any work.
- Sender validation on `chrome.runtime.onMessage` (`isTrustedViewerSender()` in
  `background.js`) — a `SCRAPE_PAGE` request must come from this extension's own
  packaged `viewer.html`, not just any extension context.
- Scrape-result shape validation (`sanitizeScrapeResult()` in `background.js`) applied
  before a scrape is stored or returned — `scraper.js` runs injected into
  FinalWhistle's own page, sharing that page's JS realm, so a compromised or just buggy
  page could otherwise tamper with what comes back (including prototype pollution)
  before it's trusted. Follows this project's existing graceful-degradation philosophy
  (truncate oversized-but-valid fields with a warning, drop malformed-but-optional
  fields like `statistics`) rather than rejecting the whole scrape on any violation.
- **JPG export** — save the current pitch view, a pinned possession, or a whole-match
  overview as a local JPG. Built as a self-contained SVG from already-parsed match
  data (no page screenshot, no external image/font references) and rasterized
  in-browser via `<canvas>`; reuses this project's own pitch/flow/highlight/timeline
  renderers rather than porting the fork's parallel copies of them.

## [0.3.0] — Phase D: Engineering & Hardening

This is the first release versioned under the convention above. It also covers the
three prior, unversioned phases (Phase A–C), which shipped as commits without a
version bump — see `git log` for that history if needed.

### Added
- `analytics.js` — a pure tactical-analysis layer (opportunity funnel, turnover
  classification, defensive failure chains, tactical-phase performance, before/after
  comparison, player/assistance/fatigue/lane/counter-attack/set-piece/goalkeeper/shot/
  pass analysis, involvement chains) and a new **Analysis** tab in the viewer.
- Whole-match narrative↔telemetry validation diagnostics (`match.validation`), with
  per-metric confidence propagation into `analytics.js`.
- Tactical-state reconstruction: normalized tactical events, `tacticalStateAt()`,
  dynamic tactical phases (`buildTacticalPhases()`), and a **Tactical Phases** section
  in the Squad tab.
- Explicit home/away team identity via trusted scrape metadata.
- `fixtures/` + `integration.test.js` — end-to-end parser→analytics contract tests.
- `smoke.test.js` — loads every script in `viewer.html`'s own order into one shared
  context, guarding against classic-script global-scope collisions (see Fixed, below).
- `scraper.test.js` expanded to cover team/telemetry/stats extraction, narrative
  container selection, opportunity-count sanity checks, and `waitForStable`.
- `.github/workflows/test.yml` — CI on push/PR to `main`.
- `npm run check` / `npm run verify` scripts.
- `CHANGELOG.md` (this file) and a documented release checklist (below).

### Changed
- Scraper waits for report/telemetry render *stability* (or the report's own
  "final whistle" marker) instead of a fixed sleep or first-line-appearance.
- `background.js` prefers an actual `/match/` tab over any FinalWhistle tab.
- Missing statistics is now a warning, not a fatal scrape error.
- Optional secondary UI panels (Statistics, fixed-window Phases, Squad, Analysis) now
  fail in isolation — a bug in one shows a local, escaped error message instead of
  blanking the whole viewer; Opportunities/Pitch remain usable regardless.
- Stored `lastScrape` objects now carry a `schemaVersion` field for future migrations.

### Fixed
- Same-minute score sequencing (two goals in one minute could get the wrong
  `scoreAfter`) — now ordered by true narrative sequence, not minute alone.
- **A real production-breaking bug**: `analytics.js` and `viewer.js` both declared
  top-level `const LANE_MAP` / `const PASS_STEP_TYPES` — harmless individually, but a
  `SyntaxError` the moment both loaded together in `viewer.html`'s shared classic-script
  scope. `node --check` cannot catch this class of bug (it checks one file at a time);
  `smoke.test.js` now does.
- `scraper.js` was missing `'use strict'`.
- A genuine internal duplication in `viewer.js` (`PASS_STEP_TYPES_FOR_STATS` and
  `PASS_STEP_TYPES` were the same array declared twice) consolidated to one.
- SVG position-label interpolations (`playerNode`/`duelNode`/pitch-flow node labels)
  now escape defensively, even though upstream parsing already constrains position
  codes to `[A-Z]+`.

### Security
- Full `innerHTML` audit across `viewer.js`; added payload-shaped regression tests
  (`<script>`, `"><img onerror=...>`, `</span><svg onload=...>`) verifying rendered
  output is escaped end-to-end, not just that `escapeHtml()` behaves correctly in
  isolation.

## Release checklist

1. `npm ci && npm run verify`
2. Load the unpacked extension in Chrome (`chrome://extensions` → Developer mode →
   Load unpacked)
3. Scrape a current FinalWhistle match
4. Verify Phase A alignment/diagnostics (warnings banner, `validation.confidence`)
5. Inspect Pitch
6. Inspect Opportunities
7. Inspect Statistics
8. Inspect Tactics / Tactical Phases, including all five kickoff settings
9. Test an extra-time or offside match when one is available
10. Inspect Analysis
11. Test hover/click/pinning on an opportunity
12. Test a match with missing Statistics (still `ok: true`)
13. Clear and rescrape, then scrape the same tab again
14. Bump `manifest.json`'s `version` (keep `package.json` in sync)
15. Update this file
16. Temporarily install in Firefox (`about:debugging` → This Firefox → Load Temporary Add-on)
17. Repeat the scrape, tabs, storage, pinning, and all three JPG-export scopes in Firefox
18. Record both browser versions and manual smoke results in the release notes
19. Commit/tag
