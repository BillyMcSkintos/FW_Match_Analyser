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

function loadScraperContext({ narrativeText, telemetryLines, teams, hasStats }) {
  const src = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
  const narEl = makeNarrativeEl(narrativeText);
  const telemetryContainer = {
    querySelectorAll(sel) { return sel === '.telemetry-line' ? telemetryLines : []; },
  };

  const sandbox = {
    console,
    Node: { ELEMENT_NODE, TEXT_NODE },
    location: { href: 'https://www.finalwhistle.org/match/123' },
    window: {},
    document: {
      body: { nodeType: ELEMENT_NODE, childNodes: [narEl] },
      querySelectorAll(sel) {
        if (sel === 'h5 a.text-decoration-none') return teams.map(t => ({ textContent: t }));
        return [];
      },
      querySelector(sel) {
        if (sel === '.telemetry-body') return telemetryLines ? telemetryContainer : null;
        if (hasStats && sel === 'table.match-stats-table') return { querySelectorAll: () => [] };
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
