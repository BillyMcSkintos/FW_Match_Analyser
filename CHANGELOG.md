# Changelog

Versions follow `MAJOR.MINOR.PATCH`:

- **PATCH** — bugfix / FinalWhistle-compatibility fix, no meaningful feature change.
- **MINOR** — new analysis/view/parser capability.
- **MAJOR** — incompatible stored-data or major UI/model break.

The project is pre-1.0; MAJOR is not bumped merely for internal refactors.
`manifest.json`'s `version` field is canonical — `package.json` is kept in sync with it.

## [0.6.3] — Scouting Assessment: minimal reintroduction with 5 targeted fixes

Re-adds a small "### Scouting Assessment" section per team (Strengths/Weaknesses/Key
matchup findings/Potential vulnerabilities/Threats/Tactical implications), deliberately
scoped down to just the deterministic synthesis logic plus five concrete bugs found by
reviewing real generated reports — not the larger refinement (lane synthesis, outstanding-
defender detection, effect-size confidence, fatigue-timing overhaul) that was judged too
much engineering for what it added and was dropped.

### Fixed
- **Key matchup findings duplicated across both teams.** Was scoped to
  `attackerSide === side || defenderSide === side`, so the exact same finding (one
  team's attacker beating the other's defender) appeared verbatim under BOTH teams'
  assessments. Now scoped to `attackerSide === side` only — a finding appears once,
  under the attacking team; the defending team's own view of the same pair already
  surfaces separately via `assessVulnerabilities`.
- **"Dominant PB target" mislabeling.** A high-usage target with a poor win rate (e.g.
  1/6, with a single goal) was labeled "Dominant" purely because `goals > 0`. Now
  requires real usage AND performance (win rate ≥60% or ≥2 goals).
- **Backwards threat/vulnerability wording for efficient shooting.** "Highly efficient
  shooting… may be exploitable via limiting shot volume rather than assuming poor
  finishing" read as if a team's own clinical finishing were a weakness. Reworded to
  "Clinical finishing in this match — G/A shots were goals. Limiting shot volume may
  therefore be important."
- **Fatigue-vulnerability label mismatch.** "N starter(s) reached TIRED/VERY_TIRED
  before full time" only ever counted players who reached the more severe VERY_TIRED
  tier, not anyone who got just TIRED — the label overclaimed what was counted. Now
  reads "reached VERY_TIRED before full time."
- Goalkeeper shot-total reconciliation (already fixed in 0.6.1/0.6.2, unaffected by this
  round — noted here since it was reported as still visibly broken in a live-generated
  report; the fix just hadn't been reloaded into the running extension build yet).

## [0.6.2] — Duel-detail split view and narrative positioning capture

### Added
- The narrative's own positioning call — "close", "in decent position", "in perfect
  position", "out of position" for outfield defenders; "in decent spot", "on the right
  spot", "hesitant", "totally in the wrong position", "ready" for a goalkeeper — is now
  captured (`positioning`/`gkPositioning` on duel/shot steps) instead of discarded. Per
  the Manual, "close"/"out of position" mean no tackle attempt follows; the other
  outfield calls proceed to a control phase, so this also distinguishes a duel won on
  positioning alone from one won via a contested tackle.
- Duel/shot detail rendering now splits attacker (Rec) from defender (Ast/Pos/Tack) and
  shooter (Sh) from goalkeeper (Sa/Pos) into two side-by-side columns instead of one
  flat stat list, with a "Won on positioning" vs "Won on tackle" tooltip and a
  Pos/Ctrl/Tack breakdown in the player statistics table's duel-win column.
- "Copy Scouting Report" button — copies the curated summary plus full raw
  narrative/telemetry (both teams) to the clipboard as paste-ready text.

## [0.6.1] — Scouting report correctness & reconciliation pass

Fixes a real counter-attack misattribution bug found via validation against a real
match: the opportunity funnel and attack-termination breakdown attributed every
counter-attack shot/goal/termination to the ORIGINAL opportunity's owner instead of the
side that actually took the action, silently omitting counter-attack shots from the
counter-attacking team's headline stats. `shotProfileAnalysis` was already correct
(step-level attribution), which is exactly why its totals disagreed with the funnel's.

### Fixed
- The opportunity funnel now operates per ATTACKING SEQUENCE (an opportunity's pre- and
  post-counter-attack portions are two separate sequences, each correctly owned by
  whichever side actually attacked) instead of blending both sides' actions under one
  opportunity-wide entry. `attackTermination` files each opportunity's outcome under the
  side that actually ended it, not the side that opened it.
- Introduced one canonical shot-event list that the funnel, shot profile, and goalkeeper
  stats all now read from, so their totals can no longer independently drift out of
  agreement with each other.
- Shot technique (normal/long shot/penalty) and set-piece origin (direct free kick) are
  now two separate dimensions instead of one collapsing into the other — a direct free
  kick narrated as a long shot no longer loses one label to keep the other.
- Goalkeeper stats now separate on-target from off-target/blocked shots faced, and state
  explicitly that "shots faced" includes off-target attempts whenever the narrative still
  named a keeper for them. A GK interception was already excluded from shot counts; this
  is now stated explicitly rather than left implicit.
- "Assists" in the Scouting Report is relabeled "Final pass before goal" and marked
  DERIVED — FinalWhistle's own report does not use real-football assist conventions, and
  the extension was never sourcing this from anywhere but its own last-pass heuristic.
- "First failed defensive contest" is relabeled "earliest failed defensive contest",
  with an explanatory note that later defensive losses in the same sequence are not
  counted — and "most exposed defender" is now two separate, separately-computed roles
  (most involved in opponent shot chains vs. most frequent earliest-failed defender),
  since a player can lead one without leading the other.
- Scouting Signals are now generated in an explicit priority order and capped at 6 per
  side, with lower-priority signals suppressed when a higher-priority one already named
  the same player for what is effectively the same underlying pattern.
- Tied statistical leaders (top scorer, most PB deliveries, main shot taker, main
  opportunity starter/progression player/PB supplier, etc.) are now reported as
  "Joint ... : A, B, C (N each)" instead of `sort()[0]` silently crowning an arbitrary
  one of several tied players.
- Goalkeeper shot totals now always reconcile: a shot event whose resolution was never
  captured (e.g. narrative cut off mid-attempt) is counted in `shotsFaced` but tracked
  in a new `unresolved` field rather than being silently folded into on-target or
  off-target; the dead `CORNER`-outcome branch now also folds into `offTargetOrBlocked`
  instead of neither bucket. `shotsFaced === onTarget + offTargetOrBlocked + unresolved`
  always holds, and `reconcileScoutingReport()` now checks it per goalkeeper.

### Added
- A development/test-only `reconcileScoutingReport()` invariant checker verifying that
  headline shot counts, shot-profile totals, GK shot-faced totals, and PB target/defender
  totals all agree with the canonical shot-event list and with each other.

## [0.6.0] — Scouting report gap fill

### Added
- The Scouting Report now covers what previously required rereading the raw narrative:
  player-vs-player duel matchups (attacker/defender/zone, win rate, shots and goals
  following each attacker win), penalty-box target and defender breakdowns (who received
  the ball in the box, who defended it, and what each contest led to), recurring
  attacking routes built from actual player-progression chains, an attack-termination
  breakdown ("where attacks ended" — PB loss, midfield loss, blocked delivery,
  interception, goal, etc. — one count per opportunity, never double-counted through a
  corner/rebound continuation), a defensive-chain exposure view (which defenders were
  repeatedly involved in or first-failed a shot-conceding chain), a fatigue timeline
  (first tired/very-tired minute, substitution timing relative to each) with the
  Manual's documented tiredness skill-penalty cited as a labeled mechanic, key player
  involvement roles (main opportunity starter, progression player, PB supplier/target,
  shot taker), and a Scouting Signals section — deterministic, threshold-based
  observations phrased as counts/ratios only, never a tactical recommendation or a
  claim about a hidden opponent setting.
- The report distinguishes shot-producing opportunities from total shot attempts (a
  rebound or fumble recovery can put more than one shot into a single opportunity), and
  separates attack-origin lane, PB-delivery lane, shot lane, and turnover lane instead of
  one generic "lane distribution" that could make a wide-origin, central-turnover
  sequence read as if the attack itself was central.
- Initial tactics is now its own guaranteed report section, separate from in-match
  tactical changes, and states plainly when the scrape carries no tactics data instead
  of silently omitting the section.

## [0.5.1] — Rebound attribution and chain-display fixes

### Added
- Home and away player-statistics tables with derived minutes played, saves,
  interceptions, blocks, tackles, attempted/completed passes, pass percentage, assists,
  shots, goalkeeper shots faced, shots on target, goals, fouls, cards, injuries, and every tired/very-tired report
  minute. Totals remain limited to named actions observed in
  the match report, so anonymous defensive actions are never assigned speculatively.
  Positions, yellow cards, and injuries appear beside player names rather than consuming
  separate table columns; completed passes appear in parentheses after pass attempts;
  substitutes are grouped directly beneath the player they replaced.

### Fixed
- Split consecutive telemetry shots into distinct live-ball rebound phases even when
  woodwork produces no intervening terminal event, preventing phase-count degradation
  and shot-value overwrites.
- Recognized FinalWhistle's pressured/rushed-play wording, preserving it as passer
  context and labeling the corresponding opportunity step as rushed.
- Recognized and preserved FinalWhistle's weak, poor, and good shot-angle wording;
  opportunity details now show the actual angle instead of labeling every angle as weak.
- Player statistics resolve one canonical home/away side per player, preferring explicit
  team-attributed match events over weaker action-level stamps, so one player cannot be
  duplicated under both teams.
- A recovered shot rebound (post or blocked, not just a fumble) is now attributed to the
  attacking side instead of being left unassigned.
- Attacks ended by an offside flag are now counted in turnover analytics instead of being
  silently dropped, and the opportunity list gives offside its own marker color instead of
  falling back to the generic gray.
- The penalty-box chain and pitch highlight now show the pass/duel pair that actually
  advanced play, not always the first attempt — a blocked-then-recovered pass or an
  initial shot that rebounds into a decisive second shot no longer displays the discarded
  first attempt in its place.
- Clicking the toolbar icon while multiple viewer tabs are open with no unique
  most-recently-used one now focuses an existing tab instead of opening a duplicate and
  clearing the other tabs' shared scrape data.

### Changed
- Improved the selected-opportunity narrative with separated phase and transition
  headings, bold white step labels, and a bold yellow goal marker.
- Replaced the very-tired emoji with 💤 and now displays the manual-defined tiredness
  penalty increasing from 5% by one percentage point per minute to the 20% cap.

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
