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
  const analyticsSrc = fs.readFileSync(path.join(__dirname, 'analytics.js'), 'utf8');
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
  // parser.js's functions (qualityLabel, qv, tierColor-adjacent) and analytics.js's
  // Phase C functions (phasePerformance, opportunityFunnel, ...) are referenced by
  // viewer.js, so load both into the same context first, mirroring viewer.html's own
  // script order: utils.js, parser.js, analytics.js, viewer.js.
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(analyticsSrc, context, { filename: 'analytics.js' });
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

test('counter-attacking pass type is credited to the countering team in buildTypeCounts', () => {
  const ctx = loadViewerContext();
  const match = ctx.parseMatch(CA_TELEMETRY, CA_NARRATIVE);
  const counts = ctx.buildTypeCounts(match.opportunities,
    ['START_PASS', 'PB_PASS', 'SP_PASS', 'FK_PASS'], ctx.classifyPassType);
  // The pre-CA START_PASS belongs to home; the post-CA START_PASS + PB_PASS belong to away.
  assert.equal(counts.home.normal, 1, 'only the pre-CA start pass is home\'s');
  assert.equal(counts.away.normal, 2, 'the post-CA start pass and box pass both belong to away');
});

test('goal scorer teamSide differs from opp.teamSide via buildScorers', () => {
  const ctx = loadViewerContext();
  const match = ctx.parseMatch(CA_TELEMETRY, CA_NARRATIVE);
  const scorers = ctx.buildScorers(match);
  assert.equal(scorers.length, 1);
  assert.equal(scorers[0].teamSide, 'away', 'the scorer belongs to the team that countered');
  assert.equal(match.opportunities[0].teamSide, 'home', 'not the opportunity\'s nominal owner');
});

test('phase boundary minutes land in the correct window', () => {
  const ctx = loadViewerContext();
  // "Next phase starts AT the boundary minute" — 30/45/70 belong to the window that
  // starts there, not the one that ends there; 90 belongs to the last window since
  // there's no window starting at 90.
  assert.equal(ctx.phaseIndexOf(0), 0);
  assert.equal(ctx.phaseIndexOf(29), 0);
  assert.equal(ctx.phaseIndexOf(30), 1, 'minute 30 starts the 30–45 window, not the 0–30 one');
  assert.equal(ctx.phaseIndexOf(44), 1);
  assert.equal(ctx.phaseIndexOf(45), 2, 'minute 45 starts the 45–70 window');
  assert.equal(ctx.phaseIndexOf(69), 2);
  assert.equal(ctx.phaseIndexOf(70), 3, 'minute 70 starts the 70–90 window');
  assert.equal(ctx.phaseIndexOf(90), 3, 'minute 90 has no window of its own — falls into the last one');
});

test('a long-ball sequence that becomes a conceded counter-attack goal is not counted as the long-ball team\'s goal', () => {
  const ctx = loadViewerContext();
  // Home plays a long ball into the box, loses the PB duel, Away counters and scores —
  // structurally identical to the existing "counter-attack originating from a penalty-box
  // duel loss" parser test, just starting with a long ball (PB_PASS from a back position,
  // no Midfield phase) instead of a normal midfield-won sequence.
  const narrative = [
    'Minute 55',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [LB] attempted high risky pass to Player B [FW]',
    'Player C [CB] got decent assistance, and was in decent position.',
    'Player B [FW] made weak reception, Player C [CB] made superb tackle.',
    'Player C [CB] cleared the ball to safety.',
    'Counter attack',
    'Midfield',
    'Player C [CB] attempted low good pass to Player D [FW]',
    'Player E [CM] got decent assistance, and was close.',
    'Player D [FW] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player D [FW] attempted low decent pass to Player F [LW]',
    'Player G [CB] got good assistance, and was in decent position.',
    'Player F [LW] made good reception, Player G [CB] made weak tackle.',
    'Player F [LW] took control of the ball.',
    'Goal Attempt',
    'Player F [LW] made superb shot.',
    'Player Z [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "55' - H - O_DEF_START",
    "55' - H - V_PASS - (60)",
    "55' - A - V_ASSISTANCE - (40)",
    "55' - H - V_RECEPTION - (35)",
    "55' - A - V_TACKLING - (75)",
    "55' - A - E_COUNTER_ATTACK",
    "55' - A - V_PASS - (55)",
    "55' - H - V_ASSISTANCE - (35)",
    "55' - A - V_RECEPTION - (65)",
    "55' - A - V_PASS - (50)",
    "55' - H - V_ASSISTANCE - (40)",
    "55' - A - V_RECEPTION - (60)",
    "55' - H - V_TACKLING - (30)",
    "55' - A - V_SHOT - (75)",
    "55' - H - V_REFLEX - (20)",
    "55' - A - E_GOAL",
  ].join('\n');

  const match = ctx.parseMatch(telemetry, narrative);
  const opp = match.opportunities[0];
  assert.equal(opp.isLongBallSequence, true);
  assert.equal(opp.teamSide, 'home');
  assert.equal(opp.hasGoal, true, 'the opportunity did contain a goal');

  const stats = ctx.computeLongBallStats(match.opportunities);
  assert.equal(stats.home.attempted, 1, 'home is still credited with attempting the long ball');
  assert.equal(stats.home.goals, 0, 'but not with a goal it didn\'t score — away countered and scored instead');
  assert.equal(stats.away.attempted, 0, 'away never attempted a long ball here');
});

test('stats functions handle empty and null-heavy input without throwing', () => {
  const ctx = loadViewerContext();
  assert.doesNotThrow(() => ctx.buildTypeCounts([], ['SHOT'], ctx.classifyShotType));
  assert.doesNotThrow(() => ctx.buildFWDelivery([]));
  assert.doesNotThrow(() => ctx.computeLongBallStats([]));
  assert.doesNotThrow(() => ctx.computePhaseStats({ opportunities: [] }));
  assert.doesNotThrow(() => ctx.computePhaseStats(null));
  assert.doesNotThrow(() => ctx.buildScorers({ opportunities: [] }));
  assert.doesNotThrow(() => ctx.buildScorers(null));

  // A step whose players/values never resolved (e.g. a phase the narrative described but
  // the parser couldn't fully populate) shouldn't crash aggregation just because a field
  // that's normally present is missing.
  const bareOpp = {
    minute: 10, teamSide: 'home', hasGoal: false, hasShot: false, isLongBallSequence: false,
    steps: [{ stepType: 'SHOT', outcome: null, values: {}, shooter: null, attackingSide: null }],
  };
  assert.doesNotThrow(() => ctx.buildTypeCounts([bareOpp], ['SHOT'], ctx.classifyShotType));
  assert.doesNotThrow(() => ctx.computePhaseStats({ opportunities: [bareOpp] }));
});

test('malicious player/team names are escaped, not injected as HTML', () => {
  const ctx = loadViewerContext();
  const payload = '<script>alert(1)</script>';
  const html = ctx.escapeHtml(payload);
  assert.ok(!html.includes('<script>'), 'the raw tag must not survive escaping');
  assert.ok(html.includes('&lt;script&gt;'), 'it should be escaped instead');

  // nm() is what most player-name rendering in the app goes through — but it only ever
  // renders the LAST word of a name (name.split(' ').pop(), matching how the whole app
  // shows last-name-only), so a payload with spaces in it gets truncated away before
  // reaching escapeHtml at all and this test would prove nothing. Keep the malicious part
  // in a single space-free "word" so it actually exercises the escaping path.
  const attackName = 'Bob "><img/src=x/onerror=alert(1)>';
  const out = ctx.nm({ name: attackName, position: 'FW' }, null);
  assert.ok(!out.includes('<img'), 'an unescaped tag must not reach the output');
  assert.ok(out.includes('&lt;img'), 'it should appear escaped instead');
});

// ─────────────────────────────────────────────────────────────────────────────
// Tactical Phases (Phase B) — Squad tab rendering
// ─────────────────────────────────────────────────────────────────────────────

test('renderTacticalPhasesSection shows one card per material change, with only known fields', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 62',
    'Home Team - Issued order- Change mentality to ATTACKING',
  ].join('\n');
  const match = ctx.parseMatch('', narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderTacticalPhasesSection(match, 'home', '#4da3ff');

  assert.ok(html.includes('Tactical Phases (2)'), 'kickoff phase + the mentality change');
  // escapeHtml renders the apostrophe as &#39; — assert on the digits/dash, not the raw quote.
  assert.ok(html.includes('0–62'), 'first phase period label');
  assert.ok(html.includes('ATTACKING'), 'the changed setting is shown');
  // Middle order was never observed for this team — must render as the unknown marker,
  // never a guessed value. Labeled "Middle order", not "Style" — see parser.js's
  // initialTeamState comment on why teamState.style is never populated.
  assert.ok(html.includes('Middle order: —'));
  assert.ok(html.includes('Initial state'), 'the first (kickoff) phase has no triggering event');

  // Away team never had a single tactical event — section renders nothing for the away
  // side, since there are no phases beyond a trivial single kickoff-only phase... but
  // buildTacticalPhases always returns at least the kickoff phase, so it should still show.
  const awayHtml = ctx.renderTacticalPhasesSection(match, 'away', '#ff6b6b');
  assert.ok(awayHtml.includes('Tactical Phases (1)'), 'away still gets its own kickoff phase even with zero events');
});

test('renderTacticalPhasesSection escapes malicious player/team text from a substitution', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 60',
    'Home Team - Issued order- <script>evil()</script> [FW] was substituted with Player B [CM]',
  ].join('\n');
  const match = ctx.parseMatch('', narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderTacticalPhasesSection(match, 'home', '#4da3ff');
  assert.ok(!html.includes('<script>evil()'), 'the raw tag must not survive into the rendered phase card');
});

test('renderSquadTab still renders the existing sections alongside the new Tactical Phases section', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Minute 60',
    'Home Team - Issued order- Player A [RB] was moved to LB',
  ].join('\n');
  const match = ctx.parseMatch('', narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderSquadTab(match);
  assert.ok(html.includes('Tactical Phases'));
  assert.ok(html.includes('Position Changes'));
  assert.ok(html.includes('Substitutions'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Analysis tab (Phase C)
// ─────────────────────────────────────────────────────────────────────────────

test('renderAnalysisTab renders the funnel, phase comparison and defensive breakdown sections', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 30', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RB] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.', 'Player F [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "30' - H - O_PB_START", "30' - H - V_PASS - (55)", "30' - A - V_ASSISTANCE - (30)",
    "30' - H - V_RECEPTION - (65)", "30' - A - V_TACKLING - (35)",
    "30' - H - V_SHOT - (70)", "30' - A - V_REFLEX - (20)", "30' - H - E_GOAL",
  ].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderAnalysisTab(match);
  assert.ok(html.includes('Opportunity Funnel'));
  assert.ok(html.includes('Tactical Phase Comparison'));
  assert.ok(html.includes('Defensive Breakdown'));
  // Away conceded the goal — its defensive breakdown must show the failed duel and
  // defender (lastName() shows only the final name token, matching the rest of the app).
  assert.ok(html.includes('lost by E'), 'the failed defender should appear in the breakdown text');
});

test('renderAnalysisTab escapes malicious player/team names in the defensive breakdown', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 30', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RB] attempted high good pass to Player D [FW]',
    '<script>evil()</script> [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, <script>evil()</script> [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.', 'Player F [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "30' - H - O_PB_START", "30' - H - V_PASS - (55)", "30' - A - V_ASSISTANCE - (30)",
    "30' - H - V_RECEPTION - (65)", "30' - A - V_TACKLING - (35)",
    "30' - H - V_SHOT - (70)", "30' - A - V_REFLEX - (20)", "30' - H - E_GOAL",
  ].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderAnalysisTab(match);
  assert.ok(!html.includes('<script>evil()'), 'raw tag must not survive into the rendered breakdown');
});
