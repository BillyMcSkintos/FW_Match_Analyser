# Changelog

Versions follow `MAJOR.MINOR.PATCH`:

- **PATCH** — bugfix / FinalWhistle-compatibility fix, no meaningful feature change.
- **MINOR** — new analysis/view/parser capability.
- **MAJOR** — incompatible stored-data or major UI/model break.

The project is pre-1.0; MAJOR is not bumped merely for internal refactors.
`manifest.json`'s `version` field is canonical — `package.json` is kept in sync with it.

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

1. `npm run verify`
2. Load the unpacked extension in Chrome (`chrome://extensions` → Developer mode →
   Load unpacked)
3. Scrape a current FinalWhistle match
4. Verify Phase A alignment/diagnostics (warnings banner, `validation.confidence`)
5. Inspect Pitch
6. Inspect Opportunities
7. Inspect Statistics
8. Inspect fixed-window Phases
9. Inspect Squad / Tactical Phases
10. Inspect Analysis
11. Test hover/click/pinning on an opportunity
12. Test a match with missing Statistics (still `ok: true`)
13. Clear and rescrape
14. Bump `manifest.json`'s `version` (keep `package.json` in sync)
15. Update this file
16. Commit/tag
