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
- **Phases** — opportunities/shots/goals/possession share across four match
  windows (0–30′, 30–45′, 45–70′, 70–90′).
- **Squad** — tiredness reports, substitutions, position changes, and
  mentality/style orders, split by team.
- **Narrative / Telemetry** — the raw scraped text, color-coded by quality
  tier and team, with the same timeline linking into it.

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
marker to jump straight to any moment in the match.

## Development

No build step — the extension runs directly from source. Tests use Node's
built-in test runner, no external framework:

```bash
npm test
```

### Project structure

| File | Role |
|---|---|
| `parser.js` | Merges the narrative + telemetry stream into a flat, per-opportunity `steps[]` model. This is the core logic — see the file header for the step-type reference. |
| `viewer.js` | Renders the whole UI from a parsed match — pitch, timeline, list, and tabs. See the file header for a section map. |
| `viewer.html` | Markup + styling for the viewer page. |
| `scraper.js` | Reads narrative/telemetry/stats off the live FinalWhistle DOM. Injected into the page tab on demand. |
| `background.js` | Service worker — toolbar click handling and relaying scrape requests. |
| `utils.js` | Small helpers shared between `background.js` and `viewer.js`. |
| `parser.test.js`, `viewer.test.js` | Regression tests. |

### Contributing

- Parser changes should be backed by a test in `parser.test.js`. Where
  possible, base new cases on wording/structure you've actually seen in a real
  match rather than guessed narrative text — FinalWhistle's exact phrasing is
  what the regexes match against, so invented wording can pass a test while
  silently not matching the real site.
- Keep comments to the *why*, not the *what* — the code should read clearly on
  its own for anything that isn't a non-obvious constraint or tradeoff.
- Run `npm test` and `node --check <file>` on anything you touch before
  opening a PR.

## License

MIT — see [LICENSE](LICENSE).
