# FinalWhistle Match Analyser

A Chrome/Chromium and Firefox extension that scrapes match reports from [FinalWhistle](https://www.finalwhistle.org)
(a browser-based football management game) and turns them into an interactive,
readable breakdown of what actually happened in a match.

FinalWhistle reports each match two ways — a plain-English narrative and a
separate telemetry stream of quality scores — and neither is easy to read on
its own. This extension merges both into a single per-opportunity model (pass
→ duel → shot, with counter-attacks, set pieces, and repeated live-ball shots after
GK rebounds handled explicitly) and renders it as a pitch diagram, a clickable
timeline, and a few statistics views. Each rebound attempt remains a distinct shot,
so its shooter, goalkeeper response, outcome, recovery, and telemetry values stay
aligned instead of overwriting the preceding attempt.

## Features

- **Opportunities** — every attacking sequence as a clickable list, with a pitch
  diagram tracing the actual pass/duel/shot chain (click a row to pin it). Recovered
  counter-attacks keep an earlier blocked pass as subdued context while emphasizing the
  route that continued, and the selected opportunity's complete narrative scrolls beside
  the pitch.
- **Match timeline** — a 0–90′ strip above the list with one marker per
  opportunity; goals are unmistakable, clicking a marker jumps to it wherever
  you are in the app.
- **Statistics** — separate home/away player tables for minutes, saves,
  interceptions, blocks, tackles, attempted/completed passes, assists, shots, goals, and the first
  tired/very-tired report, followed by shot/pass type breakdowns, long-ball summary,
  delivery to forwards, and an offense-vs-defense scatter. Player totals include only
  named actions observed in the report; anonymous blocks are not guessed.
- **Tactics** — the five main team tactics scraped at kickoff and shown for each dynamic
  tactical phase, plus tiredness, substitutions, position changes, and observed tactic
  orders. A new phase begins only on a material tactical-state change, not on a fixed
  clock. This replaced the earlier fixed-window Phases tab, which could not faithfully
  represent extra time.
- **Analysis** — opportunity funnel (where attacks actually stall: midfield, the box,
  the shot itself), a tactical-phase comparison table, and a defensive breakdown of
  conceded shots with the earliest duel the attacker won outright.
- **Narrative / Telemetry** — the raw scraped text, color-coded by quality
  tier and team, with the same timeline linking into it.
- **Issue-ready diagnostics** — parser warnings include a one-click **Copy diagnostics**
  action containing the match URL, extension version, validation details, exact unknown
  lines, a small surrounding narrative window, and compact narrative/telemetry phase
  summaries for alignment mismatches. Reports omit the complete match streams and
  unrelated opportunities.
- **JPG export** — save the current pitch view, a single pinned possession, or a
  whole-match overview as a local JPG. Built as a self-contained SVG from
  already-parsed match data (no page screenshot, no external image/font
  references) and rasterized entirely in-browser via `<canvas>` — nothing is
  uploaded anywhere.

## Security

This extension only ever reads a FinalWhistle match report page and writes to its own
the browser's `storage.local` — there is no network request, no external upload path, and no
data leaves the browser. That claim isn't just asserted:

- `static-audit.test.js` mechanically scans the whole runtime bundle for forbidden
  sinks (`fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `document.cookie`,
  `chrome.cookies`, `chrome.downloads`, ...) and fails CI if any ever appears, and
  separately scans every repo file for secret-shaped strings (private keys, bearer
  tokens, GitHub tokens) before they'd ever reach `origin`.
- `background.js` validates the *sender* of every `SCRAPE_PAGE` message (must be this
  extension's own packaged `viewer.html`, not just "any extension context") and
  sanitizes the shape of whatever `scraper.js` hands back before trusting or storing
  it — `scraper.js` runs injected into FinalWhistle's own page, sharing that page's JS
  realm, so a compromised or just buggy page could otherwise tamper with what comes
  back before it's stored.
- `scraper.js`'s `canonicalMatchUrl()` strictly validates the page URL (protocol,
  hostname, no embedded credentials/port) before scraping anything at all.

Two permission/storage choices worth noting explicitly, since a narrower-looking
alternative exists for each and isn't used:
- **`storage.local`, not `.session`** — `.session` is cleared on browser
  restart; this extension's **Load** button reopens the last scrape from storage
  specifically so it survives that, so `.local`'s persistence is required, not just
  convenient.
- **`tabs` permission, not `activeTab`-only** — `background.js` queries other
  FinalWhistle tabs by URL (`tabs.query`, "prefer an actual `/match/` tab") and
  **New Tab** opens/focuses tabs the user isn't currently on. `activeTab` alone only
  grants access to whichever tab is focused when the toolbar icon is clicked — it can't
  see or target any other tab, which both of those features need.

## Evidence model

Everything this extension shows falls into one of four categories, and the distinction
is treated as load-bearing, not decorative:

| Category | Meaning | Example |
|---|---|---|
| **Observed** | Directly present in the narrative or telemetry | "Player scored in the 62nd minute" |
| **Derived** | A deterministic calculation over observed data | "PB-entry rate rose from 33% to 78%" |
| **Manual-supported interpretation** | Grounded in an explicitly documented FinalWhistle mechanic, clearly labeled as interpretation | "This pattern is consistent with the Manual's documented Constitution/tiredness effect" |
| **Inferred** | A plausible reading the data does not itself prove | never presented as fact — kept in a separate `note`/label field where offered at all |

Concretely, this means the analyser deliberately does **not**:
- reverse-engineer a hidden tactical setting (Style of Play, Preferred Side, Marking,
  Attitude, arrows, ...) from the *shape* of observed play — an observed long-ball
  sequence is not treated as proof of a "Long Balls" Style of Play order, a dominant
  lane is not treated as proof of a Preferred Side order, and an observed shot type is
  not treated as proof a specific Player Order was configured;
- treat telemetry quality values as xG, expected assists, or any other probability —
  they are the engine's own reported quality scores, not converted into anything they
  weren't already;
- present a before/after tactical-phase comparison as a proven causal effect — every
  such comparison is labeled an *association*;
- compute a composite "match rating" or single player score — performance is shown
  role-specific (a CB's defensive duels, a FW's shooting), never collapsed into one
  number without a documented formula behind it.

See `parser.js`'s tactical-construct audit comment (above `parseNarrative`) for exactly
which FinalWhistle mechanics have real narrative evidence behind them versus which are
manual-defined but not currently observable in a report, and `analytics.js`'s file
header for the same distinction applied to the analysis layer.

<img width="623" height="959" alt="image" src="https://github.com/user-attachments/assets/ab3e6928-83d1-46c9-8617-27439b92fab0" />


## Installing

### Chrome / Chromium

This isn't on the Chrome Web Store — load it as an unpacked extension:

1. Clone or download this repo.
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a match report on finalwhistle.org, then click the extension icon.

### Firefox (temporary development installation)

Firefox 140 or newer is required. Temporary installations are intended for development
and disappear when Firefox restarts:

1. Clone or download this repo.
2. In Firefox, open `about:debugging` and choose **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Select this folder's `manifest.json`.
5. Open a FinalWhistle match report, then click the extension icon.

The codebase is prepared for Mozilla Add-ons signing, but v0.5.0 is not automatically
published to AMO. Normal end-user Firefox installation requires a Mozilla-signed `.xpi`;
the stable Gecko ID is already declared in `manifest.json`, but its availability is only
confirmed when the first AMO submission is made.

## Usage

Click **Scrape** while a match report is open to pull in that match. **Load**
reopens the last scrape from storage; **Clear** wipes it. Hover an opportunity
row to preview it on the pitch, click to pin that view, click a timeline
marker to jump straight to any moment in the match. Pick a scope from the
export dropdown (**Full view** / **Pinned possession** / **Overview**) and
click **Save JPG** to download a local snapshot — the pinned-possession scope
needs a possession clicked first. If a warning appears, **Copy diagnostics** produces
an issue-ready report without copying the complete match narrative.

## Architecture

```
FinalWhistle match page
        │  DOM read (injected on demand)
        ▼
   scraper.js  ──────────────  raw scrape payload
        │                      {narrative, telemetry, statistics, initialTactics,
        │                       homeTeam, awayTeam, errors, warnings}
        ▼
   parser.js   ──────────────  trusted match model
        │                      {meta, opportunities[], steps[], tacticalEvents[],
        │                       tacticalPhases, validation, warnings}
        ▼
  analytics.js ──────────────  derived tactical analysis
        │                      {opportunityFunnel, phasePerformance,
        │                       defensiveFailureChains, counterAttackAnalysis, ...}
        ▼
   viewer.js   ──────────────  DOM/SVG rendering + interaction
```

Each layer only depends on the one before it, never the other way around, and
`analytics.js` in particular has zero DOM/WebExtension/global-viewer-state dependency —
it takes a parsed match object and returns plain data, so it's directly unit-testable
and reusable outside the viewer. `parser.js`'s own tactical-construct audit comment and
`analytics.js`'s file header explain what each layer does and does not claim — see
[Evidence model](#evidence-model) above.

Because `viewer.html` loads `parser.js`, `analytics.js`, and `viewer.js` as classic
`<script>` tags (not ES modules) they all share one global lexical scope — a duplicate
top-level `const`/`let` name across two of those files is a real `SyntaxError` at load
time that `node --check` (which only ever sees one file at a time) cannot catch. This
happened once already; `smoke.test.js` now loads every script `viewer.html` references,
in that exact order, into one shared context specifically to catch it again if it ever
recurs.

`scraper.js` is also a classic script, but it is injected into the same match tab again
on every **Scrape** click. Its only top-level data bindings are intentionally
redeclared safely, and `scraper.test.js` evaluates the whole file twice in one shared
tab-like context to prevent repeat-scrape declaration failures.

## Development

No build step — the extension runs directly from source, with no bundler, framework, or
TypeScript. Tests use Node's built-in test runner; Mozilla's `web-ext` is a development-
only dependency used to lint the Firefox add-on manifest and package contents:

```bash
npm ci                # install the pinned Firefox validation tool
npm test              # all regression/integration/smoke tests
npm run check         # node --check on every extension JS file
npm run lint:firefox  # Mozilla web-ext lint
npm run verify        # all of the above checks — run before opening a PR
```

### Project structure

| File | Role |
|---|---|
| `parser.js` | Raw narrative + telemetry → trusted match model. Merges the narrative and telemetry stream into a flat, per-opportunity `steps[]` model, reconstructs tactical state/phases. See the file header and the tactical-construct audit comment above `parseNarrative`. |
| `analytics.js` | Match model → derived tactical analysis (opportunity funnel, turnovers, defensive failure chains, tactical-phase performance, player/GK/set-piece/shot/pass profiles). Pure — no DOM or WebExtension APIs. See the file header for the evidence-category convention every function follows. |
| `viewer.js` | Renders the whole UI from a parsed match + its analysis — pitch, timeline, list, and tabs. See the file header for a section map. |
| `viewer.html` | Markup + styling for the viewer page; also the canonical script-load order (`utils.js`, `parser.js`, `analytics.js`, `viewer.js`) that `smoke.test.js` derives its check from. |
| `scraper.js` | FinalWhistle DOM → raw scrape payload, including the five kickoff tactics. Injected into the page tab on demand and safe to inject repeatedly. |
| `background.js` | Cross-browser extension lifecycle — toolbar click handling, tab selection, script injection, and `storage.local` persistence. |
| `utils.js` | Tiny `browser`/`chrome` API boundary plus genuinely shared tab-selection logic used by both background and viewer contexts. |
| `fixtures/` | Sanitized narrative/telemetry/expected-invariant fixtures used by `integration.test.js`; see `fixtures/README.md` for scenario coverage and provenance. |
| `*.test.js` | `parser.test.js`, `viewer.test.js`, `scraper.test.js`, `analytics.test.js`, `background.test.js` — one per layer above. `integration.test.js` — parser→analytics contract tests. `smoke.test.js` — the script-load-order check described above. `static-audit.test.js` — the forbidden-sinks/secret-scan checks described in [Security](#security). |

### Contributing

- Parser changes should be backed by a test in `parser.test.js`. Where
  possible, base new cases on wording/structure you've actually seen in a real
  match rather than guessed narrative text — FinalWhistle's exact phrasing is
  what the regexes match against, so invented wording can pass a test while
  silently not matching the real site. The same applies to `fixtures/` and
  `analytics.test.js` — see `fixtures/README.md`'s provenance note.
- A parser or analytics change that alters what `integration.test.js` computes from a
  fixture should be treated as a potential regression until proven otherwise, even if
  every unit test in the changed file still passes on its own.
- Keep comments to the *why*, not the *what* — the code should read clearly on
  its own for anything that isn't a non-obvious constraint or tradeoff.
- Do not present an inferred/interpreted conclusion as an observed fact — see
  [Evidence model](#evidence-model).
- Run `npm run verify` on anything you touch before opening a PR. CI
  (`.github/workflows/test.yml`) runs the same thing on every push/PR to `main`.
- See [CHANGELOG.md](CHANGELOG.md) for the release checklist and version convention
  before cutting a release.
- See [FIREFOX_COMPATIBILITY.md](FIREFOX_COMPATIBILITY.md) for the audited API matrix,
  background strategy, and manual browser smoke-test checklist.

## License

MIT — see [LICENSE](LICENSE).
