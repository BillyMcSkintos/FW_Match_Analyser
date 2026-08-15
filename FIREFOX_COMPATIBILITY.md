# Firefox compatibility

Version 0.5.0 uses one Manifest V3 source tree for Chrome/Chromium and Firefox. Parser,
analytics, tactics, scraper semantics, and rendered UI remain shared.

## Browser API audit

| API | Runtime files | Compatibility classification | v0.5.0 handling |
|---|---|---|---|
| `runtime.getURL`, `runtime.id`, `runtime.getManifest` | background, viewer | namespace difference | shared `ext` alias |
| `runtime.sendMessage`, `runtime.onMessage` | background, viewer | namespace + Promise/callback difference | Promise sender; cross-browser `sendResponse` listener |
| `action.onClicked` | background | namespace difference | shared `ext` alias |
| `tabs.query`, `tabs.update`, `tabs.create` | background, viewer | namespace + Promise/callback difference | Promise-based calls through `ext` |
| `windows.update` | background, viewer | namespace + Promise/callback difference | Promise-based call through `ext` |
| `storage.local.get/set/remove` | background, viewer | namespace + Promise/callback difference | Promise-based calls through `ext`; existing `lastScrape` schema unchanged |
| `scripting.executeScript` | background | namespace + result-detail difference | Promise-based call; Firefox frame `error` is surfaced before sanitization |
| `tabs.Tab.lastAccessed` | background, viewer | supported, optional field | timestamp preferred; sole active/sole match fallback; unordered multi-tab sets are not guessed |

`scraper.js` does not call extension APIs. Its injected result still crosses the same
`sanitizeScrapeResult()` boundary; no shape/prototype validation was weakened.

## Background and manifest strategy

The shared manifest declares both `background.service_worker` and `background.scripts`.
Chrome uses `background.js` as a service worker and imports `utils.js`; Firefox 140+
loads `utils.js` followed by `background.js` as an event page. A guard prevents duplicate
classic-script loading. The existing CSP and permissions are unchanged.

Firefox settings declare:

- Gecko ID `fw-match-analyser@billymcskintos.github.io`;
- minimum Firefox version 140, which supports the built-in data-consent manifest field;
- `data_collection_permissions.required: ["none"]`, accurately describing local-only
  processing and no transmission outside the browser.

The Gecko ID must still be confirmed as available during the first AMO submission.
This repository does not contain AMO credentials and does not publish automatically.
`web-ext build` excludes tests, fixtures, repository documentation, and npm metadata so
the unsigned AMO package contains only runtime files, icons, the manifest, and license.

## Manual smoke matrix

Record browser versions and results before tagging a release.

### Chrome / Chromium

- Load unpacked; click toolbar; verify fresh viewer and viewer-tab reuse.
- With several FinalWhistle tabs open, verify `/match/` and most-recent selection.
- Scrape; inspect Pitch, Opportunities, Statistics, Tactics, and Analysis.
- Pin an opportunity; export full view, overview, and pinned possession as non-empty JPGs.
- Use New Tab; clear; rescrape; reload the viewer and load stored data.

### Firefox

- Load `manifest.json` through `about:debugging` → This Firefox → Load Temporary Add-on.
- Repeat every Chrome item above.
- Reload the temporary add-on and reopen the viewer; verify stored data remains usable.
- Restart Firefox and confirm the temporary extension itself is removed as expected.

Automated tests cover both namespaces, both background environments, Chrome and Firefox
sender URLs, Promise storage/script injection, safe tab fallback, classic-script load
order, XSS/static security, and unchanged parser/analytics fixtures. Canvas/Image/JPG
rasterization remains a real-browser acceptance item.

`web-ext lint` currently reports no errors. Its expected warnings are the ignored Chrome
`service_worker` half of the dual-background manifest, an Android-only minimum-version
notice (v0.5.0 targets Firefox Desktop), and conservative `innerHTML` notices. Every
dynamic renderer is covered by payload-shaped XSS regressions and the static sink audit;
the CSP remains `script-src 'self'; object-src 'self'`.
