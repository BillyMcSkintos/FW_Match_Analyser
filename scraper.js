'use strict';

/**
 * FinalWhistle page scraper
 *
 * Confirmed selectors:
 *   Team names      : h5 a.text-decoration-none (first=home, second=away)
 *   Telemetry btn   : button[title="Toggle Telemetry"]
 *   Telemetry body  : .telemetry-body  /  .telemetry-line
 *   Stats table     : table.match-stats-table
 *   Fast-forward    : button with bi-skip-end-fill icon (jumps to end of match)
 *   Narrative       : any element containing "Opportunity for" text (scan all)
 */

// Flip to true when debugging scraper selector matches — console.debug only shows up
// with devtools' verbose log level on, so it stays out of the way normally. This used
// to be pushed into result.warnings, which put a "matched tag=DIV len=22927" line in
// the viewer's warning banner on every single successful scrape — confusing for anyone
// reading it as an actual problem when it's just a diagnostic confirmation.
// `var`, intentionally: background.js injects this whole file again on every Scrape
// click. Top-level `const` bindings persist in Chrome's isolated tab world and throw an
// "already been declared" SyntaxError on the second injection; `var` is safely
// redeclarable while remaining private to the extension's isolated world.
var DEBUG = false;
function debug(...args) { if (DEBUG) console.debug('[FW Analyser]', ...args); }

// Validates the scraped page's own URL before trusting anything scraped from it. Only
// asserts what host_permissions (`https://*.finalwhistle.org/*`) already restricts
// network access to — protocol, hostname (including subdomains, matching that same
// wildcard pattern), and no embedded port/credentials. Deliberately does NOT assert an
// exact match-report path shape (e.g. a fixed /en/match/<uuid> pattern) — this project
// has no confirmed evidence FinalWhistle's path is always that shape, and guessing one
// here would risk rejecting a legitimate scrape on an unverified assumption, the same
// "don't fabricate structure that isn't actually confirmed" discipline the parser
// applies to narrative wording.
function canonicalMatchUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'finalwhistle.org' && !url.hostname.endsWith('.finalwhistle.org')) return null;
  if (url.port || url.username || url.password) return null;
  return url.href;
}

function fwScrape() {
  const result = {
    ok: false,
    errors: [],
    warnings: [],
    narrative: null,
    telemetry: null,
    statistics: null,
    homeTeam: null,
    awayTeam: null,
    initialTactics: null,
    url: location.href,
    scrapedAt: Date.now(),
  };

  // Fatal, checked first: everything else this function does only makes sense against a
  // genuine FinalWhistle page. scraper.js should only ever run injected into one (gated
  // by host_permissions), so this should never actually fire in practice — it exists as
  // an explicit, visible guard rather than silently trusting location.href, in case a
  // future change ever injects this script somewhere unexpected.
  const canonicalUrl = canonicalMatchUrl(result.url);
  if (!canonicalUrl) {
    result.errors.push('WRONG_PAGE: this does not look like a finalwhistle.org page URL.');
    return result;
  }
  result.url = canonicalUrl;

  // Report FF button miss from async step
  if (window._fwFfMissed !== undefined) {
    result.warnings.push('FF_BTN_NOT_FOUND — button icons on page: ' + (window._fwFfMissed || 'none'));
    delete window._fwFfMissed;
  }

  // ── 1. TEAM NAMES ─────────────────────────────────────────────────────────
  const teamLinks = [...document.querySelectorAll('h5 a.text-decoration-none')];
  if (teamLinks.length >= 2) {
    result.homeTeam = teamLinks[0].textContent.trim();
    result.awayTeam = teamLinks[1].textContent.trim();
  } else {
    result.errors.push('TEAMS_NOT_FOUND: expected two h5 a.text-decoration-none elements.');
  }

  // ── 1b. INITIAL TACTICS ───────────────────────────────────────────────────
  // Pre-match mentality/style/marking/defence-focus/preferred-side summary, shown in its
  // own card near the top of the match page (present on load, no fast-forward/telemetry
  // toggle needed — unlike narrative/telemetry below). This is the ONLY source for what a
  // team's settings actually were at kickoff: parser.js's narrative/telemetry streams
  // only ever report CHANGES, never a starting value.
  result.initialTactics = extractInitialTactics();
  if (!result.initialTactics) {
    result.warnings.push('INITIAL_TACTICS_NOT_FOUND: pre-match tactics summary not found on page.');
  }

  // ── 2. NARRATIVE ─────────────────────────────────────────────────────────
  // Strategy: scan every element in the page for one containing
  // "Opportunity for" — prefer the most specific (deepest) match.
  const narEl = findNarrativeElement();
  if (narEl) {
    const clone = narEl.cloneNode(true);
    // Strip telemetry panel if nested inside the same container
    clone.querySelectorAll('.telemetry-body, .telemetry-line, fw-match-telemetry').forEach(e => e.remove());
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    let raw = (clone.innerText || clone.textContent).trim();

    // Normalise whitespace artifacts from Angular DOM rendering
    raw = raw.split('\n').map(l => {
      l = l.trimStart();
      l = l.replace(/[ \t]{2,}/g, ' ');
      l = l.trimEnd();
      return l;
    }).join('\n');

    // Fix: score token directly followed by "Minute" — insert newline
    raw = raw.replace(/(\[\d+-\d+\])(Minute)/g, '$1\n$2');
    // Fix: sentence end directly followed by "Minute" — insert newline
    raw = raw.replace(/(\.)( *Minute \d)/g, '$1\n$2');
    // Remove blank lines (multiple consecutive newlines → single)
    raw = raw.replace(/\n{3,}/g, '\n\n');

    result.narrative = raw;
    debug('Narrative match', { tag: narEl.tagName, length: raw.length });
  } else {
    result.errors.push('NARRATIVE_NOT_FOUND: no element containing "Opportunity for" found. ' +
      'The fast-forward button must be clicked first to render the full match report.');
  }

  // ── 3. TELEMETRY ─────────────────────────────────────────────────────────
  result.telemetry = extractTelemetryFromDOM();
  if (!result.telemetry) {
    result.errors.push('TELEMETRY_NOT_FOUND: .telemetry-body missing — toggle button may not have been clicked.');
  }

  // ── 4. STATS TABLE ────────────────────────────────────────────────────────
  const STATS_CANDS = [
    'table.match-stats-table', 'fw-hide-spoils table',
    '.match-stats-table', 'fw-match-stats table', '[class*="stats-table"]',
  ];
  let statsEl = null;
  for (const sel of STATS_CANDS) {
    statsEl = document.querySelector(sel);
    if (statsEl) break;
  }
  if (statsEl) {
    result.statistics = extractStatsTable(statsEl);
  } else {
    // Narrative and telemetry are the core data a scrape needs to be useful at
    // all; statistics are supplementary. A missing stats table shouldn't sink
    // an otherwise-usable scrape into ok:false alongside a genuinely missing
    // narrative or telemetry — it belongs in warnings, not errors.
    result.warnings.push('STATS_NOT_FOUND: activate Statistics tab first.');
  }

  // ── 5. SANITY CHECK ──────────────────────────────────────────────────────
  // A FinalWhistle DOM/selector change could make findNarrativeElement() grab an
  // element that's missing opportunities (or telemetry that's out of sync with
  // it), and parser.js's narrative↔stream pairing has no way to detect that on
  // its own — it would just silently pair opportunities with the wrong stream
  // data instead of visibly failing. Catch the coarse case here, right after
  // scraping, rather than letting corrupted input propagate into analysis as
  // confidently-wrong numbers. This can't see a CA sub-block miscount (parser.js
  // splits those out of a normal opportunity's own token stream, not a separate
  // O_*_START token), so a match is still exactly one real O_ token — this is a
  // real 1:1 count, not an approximation.
  if (result.narrative) {
    const narrativeOppCount = (result.narrative.match(/^Opportunity for /gm) || []).length;
    if (narrativeOppCount === 0) {
      result.errors.push('NARRATIVE_NO_OPPORTUNITIES: narrative element was found but contains no "Opportunity for" lines.');
    } else if (result.telemetry) {
      const telemetryOppCount = (result.telemetry.match(/- O_\w+/g) || []).length;
      if (telemetryOppCount !== narrativeOppCount) {
        result.warnings.push(
          `OPPORTUNITY_COUNT_MISMATCH: narrative has ${narrativeOppCount} opportunit${narrativeOppCount === 1 ? 'y' : 'ies'}, ` +
          `telemetry has ${telemetryOppCount} opportunity start${telemetryOppCount === 1 ? '' : 's'} — some opportunities may end up paired with the wrong stream data.`
        );
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * Find the element whose text contains "Opportunity for".
 * Among elements whose subtree contains both the marker and a score like
 * [0-0], pick the deepest (most specific container).
 *
 * A single bottom-up pass instead of `querySelectorAll('*')` + `.textContent`
 * per element: reading .textContent on an ancestor re-concatenates every
 * descendant's text, so on a deep Angular tree the same characters get
 * revisited once per ancestor level — O(nodes × depth). This walks each
 * text node once and ORs "has marker" / "has score" up through direct
 * parents, so each node is visited exactly once — O(nodes).
 *
 * Note: this preserves the original "deepest qualifying element" rule
 * rather than stopping at the nearest ancestor of the first match — real
 * narratives repeat "Opportunity for" and "[H-A]" once per opportunity, so
 * if individual opportunity rows are themselves separate DOM nodes, a
 * nearest-ancestor walk from the *first* occurrence would stop there and
 * only capture that one opportunity instead of the whole match report.
 */
function findNarrativeElement() {
  const MARKER = 'Opportunity for';
  const SCORE  = /\[\d+-\d+\]/;

  let best = null;
  let bestDepth = -1;

  function visit(el, depth) {
    let hasMarker = false, hasScore = false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.nodeValue;
        if (!hasMarker && t.includes(MARKER)) hasMarker = true;
        if (!hasScore && SCORE.test(t)) hasScore = true;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const [childHasMarker, childHasScore] = visit(child, depth + 1);
        hasMarker = hasMarker || childHasMarker;
        hasScore  = hasScore  || childHasScore;
      }
    }
    if (hasMarker && hasScore && depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
    return [hasMarker, hasScore];
  }

  visit(document.body, 0);
  return best;
}

/**
 * Parse telemetry from Angular-rendered .telemetry-body DOM.
 */
function extractTelemetryFromDOM() {
  const container = document.querySelector('.telemetry-body');
  if (!container) return null;
  const lines = [...container.querySelectorAll('.telemetry-line')];
  if (!lines.length) return null;

  const tokens = [];
  for (const line of lines) {
    const raw = line.textContent;
    const mM = raw.match(/(\d+)'/);
    if (!mM) continue;
    const minute = mM[1];
    const sideEl = line.querySelector('span.home, span.away');
    if (!sideEl) continue;
    const side = sideEl.classList.contains('home') ? 'H' : 'A';
    const kindEl = line.querySelector('[class^="tele-"]');
    if (!kindEl) continue;
    const kind = kindEl.textContent.trim();
    const valEl = line.querySelector('[class^="denom"]');
    const val = valEl ? valEl.textContent.trim() : null;
    tokens.push(val !== null
      ? `${minute}' - ${side} - ${kind} - (${val})`
      : `${minute}' - ${side} - ${kind}`);
  }
  return tokens.length ? tokens.join('\n') : null;
}

// Row labels this page actually uses, mapped to the field names parser.js's
// initialTeamState() already carries (all five were placeholder null-only fields with no
// scrape source until now — see that function's own comment for how each behaves once
// seeded). `.tactics-label` identifies the row; the live page stores home's value in
// `.text-end.fw-semibold` (left/first column) and away's in `.text-start.fw-semibold`
// (right/second). `.tactic-side` remains only as a compatibility fallback for older or
// simplified markup — matching the page's own left-team/right-team layout, not an
// assumed ordering.
// See DEBUG above: this file is deliberately safe to evaluate repeatedly in one tab.
var INITIAL_TACTIC_FIELDS = {
  'Team Mentality': 'mentality', 'Style of Play': 'style',
  'Marking': 'marking', 'Defence Focus': 'defenceFocus', 'Preferred Side': 'preferredSide',
};
// "Through balls" → "THROUGH_BALLS", matching the enum-like convention every other
// tactical value in this codebase already uses (MENTALITY_CHANGE/STYLE_CHANGE's captured
// values come from all-caps "Issued order-" text, not prose like this page uses) — kept
// as a display-agnostic token rather than the page's own casing/wording, which reads
// naturally in isolation but wouldn't match anything else in the app if left as prose.
function enumify(text) {
  if (typeof text !== 'string') return null;
  const token = text.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return token || null;
}
function extractInitialTactics() {
  const tactics = { home: {}, away: {} };
  let found = false;
  for (const label of document.querySelectorAll('.tactics-label')) {
    const field = INITIAL_TACTIC_FIELDS[label.textContent.trim()];
    if (!field) continue;
    const row = label.parentElement;
    // The live match page uses `.text-end.fw-semibold` / `.text-start.fw-semibold`.
    // Keep `.tactic-side` as a compatibility fallback for older/simplified markup.
    tactics.home[field] = enumify(row?.querySelector('.text-end.fw-semibold, .text-end.tactic-side')?.textContent);
    tactics.away[field] = enumify(row?.querySelector('.text-start.fw-semibold, .text-start.tactic-side')?.textContent);
    found = true;
  }
  return found ? tactics : null;
}

function extractStatsTable(tableEl) {
  const stats = {};
  for (const row of tableEl.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td, th')].map(c => c.textContent.trim());
    if (cells.length === 3 && cells[1]) {
      stats[cells[1]] = { home: cells[0], away: cells[2] };
    }
  }
  return Object.keys(stats).length ? stats : null;
}

/**
 * Resolve as soon as `selector` matches something in the document, instead of
 * re-querying on a fixed interval. querySelector itself is cheap (unlike the
 * textContent scan below), so this only needs to react to DOM changes, not
 * re-read anything large or repeated on every tick.
 */
function waitForElement(selector, timeout = 7500) {
  return new Promise(resolve => {
    const existing = document.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

/**
 * Resolve once `marker` appears anywhere in the page text. Unlike polling
 * `document.body.textContent.includes(marker)` on an interval — which
 * re-serializes the entire accumulated page on every tick, up to 50 times
 * while the report streams in — this only inspects what a mutation actually
 * added, so each check is bounded by the size of the new content, not the
 * whole page so far. There's no single selector for "the narrative started"
 * (that's what findNarrativeElement figures out afterward), so text is the
 * only signal available here; the point is to stop re-scanning everything
 * that hasn't changed.
 */
function waitForText(marker, timeout = 7500) {
  return new Promise(resolve => {
    if (document.body.textContent.includes(marker)) { resolve(true); return; }

    const seen = (mutations) => mutations.some(m => {
      if (m.type === 'characterData') return m.target.textContent?.includes(marker);
      return [...m.addedNodes].some(n =>
        (n.nodeType === Node.TEXT_NODE ? n.nodeValue : n.textContent)?.includes(marker));
    });

    const observer = new MutationObserver(mutations => {
      if (seen(mutations)) { observer.disconnect(); clearTimeout(timer); resolve(true); }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
  });
}

/**
 * Resolve once `measure()` stops changing for `stableMs`. A MutationObserver
 * alone only reports THAT the DOM changed, not when it's done changing — the
 * match report streams in over many small mutations, so reacting to the first
 * one (as this used to, via waitForText/waitForElement resolving on first
 * appearance) can catch a render mid-stream instead of complete. Re-arming a
 * short "quiet timer" on every real mutation — rather than polling on a fixed
 * interval or sleeping a fixed duration — means the wait ends as soon as
 * things actually settle, and at most a handful of measurements happen (only
 * right after a mutation), not dozens against an unchanged DOM.
 *
 * Resolves { value, stable } — `stable: false` means the hard timeout was hit
 * while the measurement was still changing (or never got a chance to settle),
 * so the caller can warn rather than silently trusting a possibly-incomplete
 * render.
 */
function waitForStable(measure, { timeout = 7500, stableMs = 400 } = {}) {
  return new Promise(resolve => {
    let lastValue = measure();
    let settleTimer = null;

    const finish = (stable) => {
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      observer.disconnect();
      resolve({ value: measure(), stable });
    };

    const armSettleTimer = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(true), stableMs);
    };

    const observer = new MutationObserver(() => {
      const value = measure();
      if (value !== lastValue) {
        lastValue = value;
        armSettleTimer();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const hardTimer = setTimeout(() => finish(false), timeout);
    armSettleTimer();
  });
}

/**
 * Async entry point:
 * 1. Click fast-forward button → wait for the report to finish rendering
 * 2. Click telemetry toggle → wait for telemetry lines to finish rendering
 * 3. Run fwScrape()
 */
async function fwScrapeWithTelemetry() {
  const TIMEOUT_MS = 7500;
  const STABLE_MS = 400;
  const stabilityWarnings = [];

  // ── Step 1: Fast-forward to end of match ─────────────────────────────────
  // The match viewer has playback buttons. The fast-forward (skip-to-end)
  // button renders the full narrative. Try several selector candidates.
  const FF_SELS = [
    'button[title="Fast Forward"]',
    'button[title="Skip to end"]',
    'button[title="Go to end"]',
    'button .bi-skip-end-fill',          // Bootstrap icon — select parent
    'button .bi-fast-forward-fill',
    'button .bi-skip-end',
    'button .bi-fast-forward',
    '.btn .bi-skip-end-fill',
    '.bi-skip-end-fill',
    '.bi-fast-forward-fill',
  ];

  if (!document.body.textContent.includes('Opportunity for')) {
    let ffBtn = null;
    for (const sel of FF_SELS) {
      const el = document.querySelector(sel);
      if (el) {
        // If we matched the icon span, click its parent button
        ffBtn = el.closest('button') || el;
        break;
      }
    }

    if (ffBtn) {
      ffBtn.click();
      // Prefer the report's own completion signal — the same "final whistle"
      // line parser.js already recognizes and discards — over guessing when
      // rendering is done. It's the fastest and most direct confirmation when
      // FinalWhistle's DOM provides it.
      const gotFinalWhistle = await waitForText('referee blew the final whistle', TIMEOUT_MS);
      if (!gotFinalWhistle) {
        // No end-of-report marker seen within budget — fall back to DOM
        // stability: keep watching until the opportunity count stops
        // changing for a short window, rather than trusting the first
        // "Opportunity for" occurrence (which may be minute 1 of a 90-minute
        // report still streaming in).
        const { stable } = await waitForStable(
          () => (document.body.textContent.match(/Opportunity for /g) || []).length,
          { timeout: TIMEOUT_MS, stableMs: STABLE_MS }
        );
        if (!stable) {
          stabilityWarnings.push('NARRATIVE_STABILITY_TIMEOUT: could not confirm the match report finished rendering before scraping — some opportunities may be missing.');
        }
      }
    } else {
      // Record button icons for debugging; stored so fwScrape can emit a warning
      window._fwFfMissed = [...document.querySelectorAll('button i[class*="bi-"]')]
        .map(i => i.className).join(' | ');
    }
  }

  // ── Step 2: Telemetry toggle ──────────────────────────────────────────────
  if (!document.querySelector('.telemetry-body .telemetry-line')) {
    const btn = document.querySelector('button[title="Toggle Telemetry"]');
    if (btn) {
      btn.click();
      const gotFirstLine = await waitForElement('.telemetry-body .telemetry-line', TIMEOUT_MS);
      if (gotFirstLine) {
        // Telemetry has no end-of-report text marker to watch for, so line-count
        // stability is the only signal available — wait for it to stop growing
        // rather than scraping right after the first line appears.
        const { stable } = await waitForStable(
          () => document.querySelectorAll('.telemetry-body .telemetry-line').length,
          { timeout: TIMEOUT_MS, stableMs: STABLE_MS }
        );
        if (!stable) {
          stabilityWarnings.push('TELEMETRY_STABILITY_TIMEOUT: could not confirm telemetry finished rendering before scraping — some values may be missing.');
        }
      } else {
        stabilityWarnings.push('TELEMETRY_STABILITY_TIMEOUT: no telemetry lines appeared before timing out.');
      }
    }
  }

  const result = fwScrape();
  result.warnings.push(...stabilityWarnings);
  return result;
}
