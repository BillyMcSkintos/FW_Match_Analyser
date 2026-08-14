'use strict';
// Regression tests for the DOM-reading logic in scraper.js. Like viewer.test.js,
// scraper.js is a plain browser script (not a CommonJS module) that expects
// `document`/`window`/`location`/`Node` as globals, so it's loaded via node:vm into a
// minimal DOM stub rather than duplicated here. Only fwScrape() (the synchronous part)
// is exercised — fwScrapeWithTelemetry()'s click/wait steps need a live page and aren't
// meaningfully testable against a stub.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function makeNarrativeEl(text) {
  return {
    nodeType: ELEMENT_NODE,
    tagName: 'DIV',
    childNodes: [{ nodeType: TEXT_NODE, nodeValue: text }],
    cloneNode() {
      // findNarrativeElement's caller only ever reads innerText/textContent and calls
      // querySelectorAll to strip nested telemetry markup — a flat stand-in is enough.
      return { innerText: text, textContent: text, querySelectorAll: () => [] };
    },
  };
}

function makeTelemetryLine(minute, side, kind, val) {
  return {
    textContent: `${minute}' - ${side} - ${kind}` + (val !== null ? ` - (${val})` : ''),
    querySelector(sel) {
      if (sel === 'span.home, span.away') {
        const cls = side === 'H' ? 'home' : 'away';
        return { classList: { contains: c => c === cls } };
      }
      if (sel === '[class^="tele-"]') return { textContent: kind };
      if (sel === '[class^="denom"]') return val !== null ? { textContent: String(val) } : null;
      return null;
    },
  };
}

function makeStatsTable(rows) {
  // rows: [[home, label, away], ...] mirroring extractStatsTable's expected 3-cell shape.
  return {
    querySelectorAll(sel) {
      if (sel !== 'tr') return [];
      return rows.map(cells => ({
        querySelectorAll(s) { return s === 'td, th' ? cells.map(c => ({ textContent: c })) : []; },
      }));
    },
  };
}

function loadScraperContext({ narrativeText, telemetryLines, teams, hasStats, statsRows }) {
  const src = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
  // narrativeText: null means no matching element anywhere on the page at all — the
  // real NARRATIVE_NOT_FOUND scenario (the fast-forward button was never clicked).
  const bodyChildren = narrativeText != null ? [makeNarrativeEl(narrativeText)] : [];
  const telemetryContainer = {
    querySelectorAll(sel) { return sel === '.telemetry-line' ? telemetryLines : []; },
  };
  const statsTable = statsRows ? makeStatsTable(statsRows) : { querySelectorAll: () => [] };

  const sandbox = {
    console,
    Node: { ELEMENT_NODE, TEXT_NODE },
    URL, // vm contexts don't inherit Node's own globals automatically — canonicalMatchUrl needs this
    location: { href: 'https://www.finalwhistle.org/match/123' },
    window: {},
    document: {
      body: { nodeType: ELEMENT_NODE, childNodes: bodyChildren },
      querySelectorAll(sel) {
        if (sel === 'h5 a.text-decoration-none') return teams.map(t => ({ textContent: t }));
        return [];
      },
      querySelector(sel) {
        if (sel === '.telemetry-body') return telemetryLines ? telemetryContainer : null;
        if (hasStats && sel === 'table.match-stats-table') return statsTable;
        return null;
      },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'scraper.js' });
  return context;
}

test('a missing statistics table produces a warning, not a fatal error, and the scrape is still ok', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\n',
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: ['Home Team', 'Away Team'],
    hasStats: false,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some(w => w.startsWith('STATS_NOT_FOUND')), 'expected a STATS_NOT_FOUND warning');
});

test('a genuinely missing core input (no team names) still leaves the scrape not ok', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\n',
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: [],
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(w => w.startsWith('TEAMS_NOT_FOUND')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Remaining scraper.js coverage
// ─────────────────────────────────────────────────────────────────────────────

test('team-name extraction: first h5 link is home, second is away', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\n',
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: ['  Home Team  ', 'Away Team'], // extra whitespace, confirms .trim()
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.homeTeam, 'Home Team');
  assert.equal(result.awayTeam, 'Away Team');
});

test('telemetry-line extraction builds "min\' - side - kind - (val)" tokens from the DOM', () => {
  const ctx = loadScraperContext({
    narrativeText: null, telemetryLines: null, teams: [], hasStats: false,
  });
  const container = {
    querySelectorAll(sel) {
      return sel === '.telemetry-line'
        ? [makeTelemetryLine(12, 'H', 'V_PASS', 65), makeTelemetryLine(12, 'A', 'V_ASSISTANCE', null)]
        : [];
    },
  };
  ctx.document.querySelector = (sel) => sel === '.telemetry-body' ? container : null;
  const telemetry = ctx.extractTelemetryFromDOM();
  assert.equal(telemetry, "12' - H - V_PASS - (65)\n12' - A - V_ASSISTANCE");
});

test('telemetry-line extraction returns null when the telemetry body is present but empty', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: [], teams: [], hasStats: false });
  ctx.document.querySelector = (sel) => sel === '.telemetry-body' ? { querySelectorAll: () => [] } : null;
  assert.equal(ctx.extractTelemetryFromDOM(), null);
});

test('statistics-table extraction reads 3-cell rows as {home, away} keyed by the middle label', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  const table = makeStatsTable([['58%', 'Ball Possession', '42%'], ['5', 'Corners', '3']]);
  const stats = ctx.extractStatsTable(table);
  // stats is an object from the vm context's own realm — assert.deepEqual (strict mode)
  // treats a cross-realm object as never reference-equal even with identical enumerable
  // properties, so compare via JSON instead of asserting object identity/prototype.
  assert.equal(JSON.stringify(stats), JSON.stringify({
    'Ball Possession': { home: '58%', away: '42%' },
    'Corners': { home: '5', away: '3' },
  }));
});

test('statistics-table extraction returns null for a table with no usable 3-cell rows', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  assert.equal(ctx.extractStatsTable(makeStatsTable([])), null);
});

test('narrative-container selection prefers the deepest element containing both the marker and a score', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  // Build a small tree by hand: an outer div (has marker+score via descendants) wrapping
  // an inner div that itself directly contains both — findNarrativeElement must pick the
  // INNER one (deepest), not the outer wrapper.
  const inner = {
    nodeType: ELEMENT_NODE, tagName: 'SPAN',
    childNodes: [{ nodeType: TEXT_NODE, nodeValue: 'Opportunity for Home Team. [1-0]' }],
  };
  const outer = { nodeType: ELEMENT_NODE, tagName: 'DIV', childNodes: [inner] };
  ctx.document.body = { nodeType: ELEMENT_NODE, childNodes: [outer] };
  const found = ctx.findNarrativeElement();
  assert.equal(found, inner);
});

test('narrative-container selection returns null when nothing on the page matches', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  assert.equal(ctx.findNarrativeElement(), null);
});

test('fatal: missing narrative container leaves the scrape not ok even with teams/telemetry present', () => {
  const ctx = loadScraperContext({
    narrativeText: null,
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: ['Home Team', 'Away Team'],
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(w => w.startsWith('NARRATIVE_NOT_FOUND')));
});

test('fatal: missing telemetry body leaves the scrape not ok even with teams/narrative present', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\n',
    telemetryLines: null,
    teams: ['Home Team', 'Away Team'],
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(w => w.startsWith('TELEMETRY_NOT_FOUND')));
});

test('opportunity-count sanity check: matching narrative/telemetry counts produce no warning', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\nOpportunity for Away Team.\n[0-0]\nMinute 10\nMidfield\n',
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null), makeTelemetryLine(10, 'A', 'O_MID_START', null)],
    teams: ['Home Team', 'Away Team'],
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some(w => w.startsWith('OPPORTUNITY_COUNT_MISMATCH')));
});

test('opportunity-count / telemetry start-count sanity check: a mismatch produces a warning, not a fatal error', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\nOpportunity for Away Team.\n[0-0]\nMinute 10\nMidfield\n',
    // Only one O_ token for two narrative opportunities.
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: ['Home Team', 'Away Team'],
    hasStats: true,
  });
  const result = ctx.fwScrape();
  assert.equal(result.ok, true, 'a count mismatch is a warning, not a fatal error');
  assert.ok(result.warnings.some(w => w.startsWith('OPPORTUNITY_COUNT_MISMATCH: narrative has 2 opportunities, telemetry has 1 opportunity start')));
});

// ── waitForStable: minimal fake MutationObserver, no jsdom dependency ───────────────
// A hand-rolled DOM stub is "enough" here — the only real DOM surface waitForStable
// touches is document.body (passed straight to MutationObserver.observe, never read) and
// MutationObserver itself, both trivially fakeable without a full DOM library. Real
// setTimeout/clearTimeout are used with intentionally small timeout/stableMs values so
// this stays fast.
function makeFakeMutationObserver() {
  const instances = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; instances.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  FakeMutationObserver.trigger = () => instances.forEach(o => !o.disconnected && o.cb([]));
  return FakeMutationObserver;
}

test('waitForStable resolves stable:true once measure() stops changing for stableMs', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
  const FakeMutationObserver = makeFakeMutationObserver();
  const sandbox = { console, document: { body: {} }, MutationObserver: FakeMutationObserver, setTimeout, clearTimeout };
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'scraper.js' });

  let count = 1;
  const resultPromise = context.waitForStable(() => count, { timeout: 500, stableMs: 30 });
  // Simulate one real mutation shortly after start, then let it go quiet.
  await new Promise(r => setTimeout(r, 10));
  count = 2;
  FakeMutationObserver.trigger();

  const result = await resultPromise;
  assert.equal(result.stable, true);
  assert.equal(result.value, 2);
});

test('waitForStable resolves stable:false if measure() keeps changing past the hard timeout', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
  const FakeMutationObserver = makeFakeMutationObserver();
  const sandbox = { console, document: { body: {} }, MutationObserver: FakeMutationObserver, setTimeout, clearTimeout };
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'scraper.js' });

  let count = 1;
  const resultPromise = context.waitForStable(() => count, { timeout: 60, stableMs: 1000 });
  // Keep mutating faster than stableMs can ever elapse, so only the hard timeout can end this.
  const iv = setInterval(() => { count++; FakeMutationObserver.trigger(); }, 10);
  const result = await resultPromise;
  clearInterval(iv);
  assert.equal(result.stable, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// canonicalMatchUrl
// ─────────────────────────────────────────────────────────────────────────────

test('canonicalMatchUrl accepts finalwhistle.org and its subdomains over https', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  assert.equal(ctx.canonicalMatchUrl('https://www.finalwhistle.org/en/match/abc'), 'https://www.finalwhistle.org/en/match/abc');
  assert.equal(ctx.canonicalMatchUrl('https://finalwhistle.org/match/1'), 'https://finalwhistle.org/match/1');
});

test('canonicalMatchUrl rejects the wrong protocol, wrong host, embedded credentials, and a non-default port', () => {
  const ctx = loadScraperContext({ narrativeText: null, telemetryLines: null, teams: [], hasStats: false });
  assert.equal(ctx.canonicalMatchUrl('http://www.finalwhistle.org/match/1'), null, 'must be https');
  assert.equal(ctx.canonicalMatchUrl('https://evil.com/finalwhistle.org/match/1'), null, 'host must actually be finalwhistle.org');
  assert.equal(ctx.canonicalMatchUrl('https://finalwhistle.org.evil.com/match/1'), null, 'suffix spoofing must not pass');
  assert.equal(ctx.canonicalMatchUrl('https://user:pass@www.finalwhistle.org/match/1'), null, 'no embedded credentials');
  assert.equal(ctx.canonicalMatchUrl('https://www.finalwhistle.org:8443/match/1'), null, 'no non-default port');
  assert.equal(ctx.canonicalMatchUrl(null), null);
  assert.equal(ctx.canonicalMatchUrl(42), null);
  assert.equal(ctx.canonicalMatchUrl('not a url at all'), null);
});

test('fwScrape() fails fast with WRONG_PAGE when the page URL is not finalwhistle.org', () => {
  const ctx = loadScraperContext({
    narrativeText: 'Opportunity for Home Team.\n[0-0]\nMinute 5\nMidfield\n',
    telemetryLines: [makeTelemetryLine(5, 'H', 'O_MID_START', null)],
    teams: ['Home Team', 'Away Team'],
    hasStats: true,
  });
  ctx.location.href = 'https://not-finalwhistle.example.com/match/1';
  const result = ctx.fwScrape();
  assert.equal(result.ok, false);
  // result.errors is a cross-realm array (from the vm context) — compare via JSON, not
  // assert.deepEqual's strict mode, which treats cross-realm objects/arrays as never
  // reference-equal even with identical contents (same gotcha as the stats-table test).
  assert.equal(JSON.stringify(result.errors), JSON.stringify(['WRONG_PAGE: this does not look like a finalwhistle.org page URL.']));
});
