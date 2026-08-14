# FinalWhistle Match Analyser

A Chrome extension that scrapes match reports from [FinalWhistle](https://www.finalwhistle.org)
(a browser-based football management game) and turns them into an interactive,
readable breakdown of what actually happened in a match.

FinalWhistle reports each match two ways — a plain-English narrative and a
separate telemetry stream of quality scores — and neither is easy to read on
its own. This extension merges both into a single per-opportunity model (pass
→ duel → shot, with counter-attacks, set pieces, and GK saves/rebounds handled
explicitly) and renders it as a pitch diagram, a clickable timeline, and a few
statistics views.

## Features

- **Opportunities** — every attacking sequence as a clickable list, with a pitch
  diagram tracing the actual pass/duel/shot chain (click a row to pin it).
- **Match timeline** — a 0–90′ strip above the list with one marker per
  opportunity; goals are unmistakable, clicking a marker jumps to it wherever
  you are in the app.
- **Statistics** — shot/pass type breakdowns, long-ball summary, delivery to
  forwards, and an offense-vs-defense scatter.
- **Phases** — opportunities/shots/goals/possession share across four fixed match
  windows (0–30′, 30–45′, 45–70′, 70–90′).
- **Squad** — tiredness reports, substitutions, position changes, mentality/style
  orders, and a per-team **Tactical Phases** timeline (dynamic phases that begin only
  on a material tactical-state change, not on a fixed clock).
- **Analysis** — opportunity funnel (where attacks actually stall: midfield, the box,
  the shot itself), a tactical-phase comparison table, and a defensive breakdown of
  conceded shots with the earliest duel the attacker won outright.
- **Narrative / Telemetry** — the raw scraped text, color-coded by quality
  tier and team, with the same timeline linking into it.
- **JPG export** — save the current pitch view, a single pinned possession, or a
  whole-match overview as a local JPG. Built as a self-contained SVG from
  already-parsed match data (no page screenshot, no external image/font
  references) and rasterized entirely in-browser via `<canvas>` — nothing is
  uploaded anywhere.

## Security

This extension only ever reads a FinalWhistle match report page and writes to its own
`chrome.storage.local` — there is no network request, no external upload path, and no
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

This isn't on the Chrome Web Store — load it as an unpacked extension:

1. Clone or download this repo.
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a match report on finalwhistle.org, then click the extension icon.

## Usage

Click **Scrape** while a match report is open to pull in that match. **Load**
reopens the last scrape from storage; **Clear** wipes it. Hover an opportunity
row to preview it on the pitch, click to pin that view, click a timeline
marker to jump straight to any moment in the match. Pick a scope from the
export dropdown (**Full view** / **Pinned possession** / **Overview**) and
click **Save JPG** to download a local snapshot — the pinned-possession scope
needs a possession clicked first.

## Architecture

```
FinalWhistle match page
        │  DOM read (injected on demand)
        ▼
   scraper.js  ──────────────  raw scrape payload
        │                      {narrative, telemetry, statistics,
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
`analytics.js` in particular has zero DOM/`chrome.*`/global-viewer-state dependency —
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

## Development

No build step — the extension runs directly from source, no bundler, framework, or
TypeScript. Tests use Node's built-in test runner, no external framework:

```bash
npm test      # all regression/integration/smoke tests
npm run check # node --check on every extension JS file
npm run verify # both of the above — run this before opening a PR
```

### Project structure

| File | Role |
|---|---|
| `parser.js` | Raw narrative + telemetry → trusted match model. Merges the narrative and telemetry stream into a flat, per-opportunity `steps[]` model, reconstructs tactical state/phases. See the file header and the tactical-construct audit comment above `parseNarrative`. |
| `analytics.js` | Match model → derived tactical analysis (opportunity funnel, turnovers, defensive failure chains, tactical-phase performance, player/GK/set-piece/shot/pass profiles). Pure — no DOM, no `chrome.*`. See the file header for the evidence-category convention every function follows. |
| `viewer.js` | Renders the whole UI from a parsed match + its analysis — pitch, timeline, list, and tabs. See the file header for a section map. |
| `viewer.html` | Markup + styling for the viewer page; also the canonical script-load order (`utils.js`, `parser.js`, `analytics.js`, `viewer.js`) that `smoke.test.js` derives its check from. |
| `scraper.js` | FinalWhistle DOM → raw scrape payload. Injected into the page tab on demand. |
| `background.js` | Extension lifecycle — toolbar click handling, tab selection, script injection, `chrome.storage.local` persistence. |
| `utils.js` | Genuinely shared small utilities only (used by both `background.js` and `viewer.js`) — not a general dumping ground. |
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

## License

MIT — see [LICENSE](LICENSE).
