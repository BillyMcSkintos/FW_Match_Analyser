'use strict';
// Regression tests for pure logic inside viewer.js (player status resolution). viewer.js
// isn't a CommonJS module — it's a plain browser <script> that expects `document`,
// `chrome`, and `location` as globals — so it's loaded here with node:vm into a minimal
// stub context rather than duplicating its logic in the test (a copy could silently
// drift from the real implementation and stop being a regression test at all).
//
// Run with:  node --test viewer.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeStubElement() {
  const el = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    children: [], textContent: '', innerHTML: '',
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return el;
}

function loadViewerContext() {
  const src = fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8');
  const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
  const sandbox = {
    console,
    document: {
      getElementById() { return makeStubElement(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeStubElement(); },
    },
    chrome: {
      storage: { local: { get(_k, cb) { if (cb) cb({}); }, set() {}, remove() {} } },
      runtime: { getURL: p => 'chrome-extension://test/' + p, sendMessage: async () => ({}) },
      tabs: { query: async () => [] },
    },
    location: { search: '' },
    URLSearchParams,
  };
  const context = vm.createContext(sandbox);
  // parser.js's functions (qualityLabel, qv, tierColor-adjacent) are referenced by
  // viewer.js at file scope in a couple of spots, so load it into the same context
  // first, mirroring how viewer.html loads parser.js before viewer.js.
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(src, context, { filename: 'viewer.js' });
  return context;
}

test('half time clears reported tiredness but preserves injury', () => {
  const ctx = loadViewerContext();
  const events = [
    { minute: 20, type: 'INJURY', player: { name: 'Player A' }, severity: 'LIGHT' },
    { minute: 30, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'TIRED' },
    { minute: 45, type: 'HALF_TIME' },
  ];
  const before = ctx.playerStatusAt(events, 'Player A', 44);
  assert.equal(before.injury, 'LIGHT');
  assert.equal(before.tiredness, 'TIRED');

  const after = ctx.playerStatusAt(events, 'Player A', 46);
  assert.equal(after.injury, 'LIGHT', 'injury must persist across half time');
  assert.equal(after.tiredness, null, 'first-half tiredness report must not carry into the second half');
});

test('tiredness reported again in the second half is tracked normally', () => {
  const ctx = loadViewerContext();
  const events = [
    { minute: 30, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'TIRED' },
    { minute: 45, type: 'HALF_TIME' },
    { minute: 70, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'VERY_TIRED' },
  ];
  const late = ctx.playerStatusAt(events, 'Player A', 80);
  assert.equal(late.tiredness, 'VERY_TIRED');
});

test('an uninjured, untired player reports both as null', () => {
  const ctx = loadViewerContext();
  const result = ctx.playerStatusAt([], 'Nobody', 10);
  assert.equal(result.injury, null);
  assert.equal(result.tiredness, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Counter-attack statistical attribution — a home-owned opportunity where Away
// counters and scores. opp.teamSide stays 'home' for the whole opportunity (that's
// correct — it's still "the opportunity Home started"), but every viewer stat that
// counts actions within it must attribute the post-CA pass/shot to Away, not Home.
// Same fixture shape as parser.test.js's "counter-attack: scoring side flips" test.
// ─────────────────────────────────────────────────────────────────────────────
const CA_NARRATIVE = [
  'Minute 70',
  'Opportunity for Home Team.',
  'Midfield',
  'Player A [RWB] attempted low good pass to Player B [RW]',
  'Player C [LB] got poor assistance, and was close.',
  'Player B [RW] made excellent reception and took control of the ball.',
  'Counter attack',
  'Midfield',
  'Player X [FW] attempted low good pass to Player Y [LW]',
  'Player D [CM] got weak assistance, and was close.',
  'Player Y [LW] made excellent reception and took control of the ball.',
  'Penalty Box',
  'Player Y [LW] attempted low decent pass to Player X [FW]',
  'Player E [CB] got good assistance, and was in decent position.',
  'Player X [FW] made good reception, Player E [CB] made weak tackle.',
  'Player X [FW] took control of the ball.',
  'Goal Attempt',
  'Player X [FW] made superb shot.',
  'Player Z [GK] was fooled.',
  'GOAL!',
].join('\n');
const CA_TELEMETRY = [
  "70' - H - O_MID_START",
  "70' - H - V_PASS - (60)",
  "70' - A - V_ASSISTANCE - (30)",
  "70' - H - V_RECEPTION - (70)",
  "70' - A - E_COUNTER_ATTACK",
  "70' - A - V_PASS - (55)",
  "70' - H - V_ASSISTANCE - (35)",
  "70' - A - V_RECEPTION - (65)",
  "70' - A - V_PASS - (50)",
  "70' - H - V_ASSISTANCE - (40)",
  "70' - A - V_RECEPTION - (60)",
  "70' - H - V_TACKLING - (35)",
  "70' - A - V_SHOT - (75)",
  "70' - H - V_REFLEX - (25)",
  "70' - A - E_GOAL",
].join('\n');

test('counter-attacking shot is credited to the countering team in buildTypeCounts', () => {
  const ctx = loadViewerContext();
  const match = ctx.parseMatch(CA_TELEMETRY, CA_NARRATIVE);
  assert.equal(match.opportunities[0].teamSide, 'home');
  const counts = ctx.buildTypeCounts(match.opportunities, ['SHOT', 'FK_SHOT'], ctx.classifyShotType);
  assert.equal(counts.away.normal, 1, 'the shot belongs to away, which countered and scored');
  assert.equal(counts.home.normal ?? 0, 0, 'home never took a shot in this opportunity');
});

test('counter-attacking pass into the box is credited to the countering team in buildFWDelivery', () => {
  const ctx = loadViewerContext();
  const match = ctx.parseMatch(CA_TELEMETRY, CA_NARRATIVE);
  const { laneCounts } = ctx.buildFWDelivery(match.opportunities);
  const awayTotal = Object.values(laneCounts.away).reduce((a, b) => a + b, 0);
  const homeTotal = Object.values(laneCounts.home).reduce((a, b) => a + b, 0);
  assert.equal(awayTotal, 1, 'the PB pass to the FW belongs to away, not the opportunity\'s nominal home owner');
  assert.equal(homeTotal, 0);
});

test('counter-attacking goal is credited to the countering team in computePhaseStats', () => {
  const ctx = loadViewerContext();
  const match = ctx.parseMatch(CA_TELEMETRY, CA_NARRATIVE);
  const stats = ctx.computePhaseStats(match);
  const window7090 = stats.find(s => s.label === "70–90'");
  assert.equal(window7090.home.opps, 1, 'the opportunity itself is still home\'s — it started the sequence');
  assert.equal(window7090.away.goals, 1, 'the goal belongs to away, who actually scored it');
  assert.equal(window7090.home.goals, 0, 'home must not be credited with a goal it didn\'t score');
});
