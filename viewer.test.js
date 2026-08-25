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
const { makeStubElement } = require('./test-helpers.js');

function loadViewerContext({ namespace = 'chrome' } = {}) {
  const src = fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8');
  const utilsSrc = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
  const analyticsSrc = fs.readFileSync(path.join(__dirname, 'analytics.js'), 'utf8');
  const api = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { getURL: p => `${namespace === 'browser' ? 'moz-extension' : 'chrome-extension'}://test/${p}`, getManifest: () => ({ version: '0.5.0-test' }), sendMessage: async () => ({}) },
    tabs: { query: async () => [], update: async () => {}, create: async () => {} },
    windows: { update: async () => {} },
  };
  const sandbox = {
    console,
    document: {
      getElementById() { return makeStubElement(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeStubElement(); },
    },
    location: { search: '' },
    URLSearchParams,
  };
  sandbox[namespace] = api;
  const context = vm.createContext(sandbox);
  // parser.js's functions (qualityLabel, qv, tierColor-adjacent) and analytics.js's
  // functions (phasePerformance, opportunityFunnel, ...) are referenced by viewer.js, so
  // load both into the same context first, mirroring viewer.html's own script order:
  // utils.js, parser.js, analytics.js, viewer.js.
  vm.runInContext(utilsSrc, context, { filename: 'utils.js' });
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(analyticsSrc, context, { filename: 'analytics.js' });
  vm.runInContext(src, context, { filename: 'viewer.js' });
  return context;
}

test('viewer initializes with either WebExtension API namespace', () => {
  const chromium = loadViewerContext({ namespace: 'chrome' });
  assert.equal(chromium.ext, chromium.chrome);
  const firefox = loadViewerContext({ namespace: 'browser' });
  assert.equal(firefox.ext, firefox.browser);
});

test('diagnostic report includes the match URL and exact unknown lines with nearby context', () => {
  const ctx = loadViewerContext();
  const scrape = {
    url: 'https://example.finalwhistle.org/match/123',
    scrapedAt: Date.UTC(2026, 7, 14, 12, 30),
    narrative: ['Minute 9', 'Opportunity for Home.', 'Midfield', 'Known action', 'New FinalWhistle wording', 'Goal Attempt'].join('\n'),
    errors: [],
    warnings: ['Scrape warning'],
  };
  const match = {
    meta: { homeTeam: 'Home', awayTeam: 'Away', finalScore: { home: 2, away: 1 } },
    warnings: ["1 unrecognized narrative line(s) within an opportunity — FinalWhistle's wording may have changed."],
    validation: {
      confidence: 'exact', narrativeOpportunityCount: 1, telemetryOpportunityCount: 1, matchedBlocks: [{}],
      unknownNarrativeLines: [{ minute: 9, line: 'New FinalWhistle wording' }],
      unknownTelemetryLines: [], unmatchedNarrativeBlocks: [], unusedTelemetryBlocks: [],
      phaseMismatches: [], unresolvedTacticalEvents: [],
    },
  };
  const report = ctx.buildDiagnosticReport(scrape, match);
  assert.match(report, /https:\/\/example\.finalwhistle\.org\/match\/123/);
  assert.match(report, /0\.5\.0-test/);
  assert.match(report, /New FinalWhistle wording/);
  assert.match(report, /Known action/);
  assert.match(report, /"unrecognized": true/);
});

test('diagnostic report includes telemetry and matching diagnostics', () => {
  const ctx = loadViewerContext();
  const report = ctx.buildDiagnosticReport(
    { url: 'https://example.finalwhistle.org/match/456', scrapedAt: 1 },
    { meta: {}, warnings: [], validation: {
      unknownTelemetryLines: ["15' - H - NEW_TOKEN - (42)"],
      unmatchedNarrativeBlocks: [{ minute: 15, side: 'H' }],
      unusedTelemetryBlocks: [{ minute: 16, side: 'A' }],
      phaseMismatches: [{ minute: 15, narrativePhaseCount: 2, streamPhaseCount: 3 }],
      unresolvedTacticalEvents: [{ minute: 70, type: 'STYLE_CHANGE' }],
    } },
  );
  assert.match(report, /NEW_TOKEN/);
  assert.match(report, /unmatchedNarrativeBlocks/);
  assert.match(report, /unusedTelemetryBlocks/);
  assert.match(report, /phaseMismatches/);
  assert.match(report, /unresolvedTacticalEvents/);
});

test('phase-mismatch diagnostics include compact structural summaries without the full narrative', () => {
  const ctx = loadViewerContext();
  const unrelated = 'PRIVATE UNRELATED NARRATIVE THAT MUST NOT BE COPIED';
  const report = ctx.buildDiagnosticReport(
    {
      url: 'https://example.finalwhistle.org/match/phase-mismatch', scrapedAt: 1,
      narrative: ['Minute 1', unrelated, 'Minute 77', 'Opportunity for Home.'].join('\n'),
      telemetry: "1' - H - PRIVATE_COMPLETE_STREAM_TOKEN",
    },
    { meta: {}, warnings: [], validation: {
      unknownNarrativeLines: [], unknownTelemetryLines: [], unmatchedNarrativeBlocks: [],
      unusedTelemetryBlocks: [], unresolvedTacticalEvents: [],
      phaseMismatches: [{
        minute: 77, team: 'Home', narrativePhaseCount: 1, streamPhaseCount: 2,
        narrativePhases: [{ index: 0, phaseType: 'PB', shotTaker: 'Player B', outcome: 'FUMBLED' }],
        streamPhases: [
          { index: 0, valueKeys: ['pass', 'shot'], events: ['E_FUMBLE'] },
          { index: 1, valueKeys: ['shot'], events: [] },
        ],
      }],
    } },
  );
  assert.match(report, /"phaseType": "PB"/);
  assert.match(report, /"shotTaker": "Player B"/);
  assert.match(report, /"valueKeys": \[/);
  assert.doesNotMatch(report, new RegExp(unrelated));
  assert.doesNotMatch(report, /PRIVATE_COMPLETE_STREAM_TOKEN/);
  assert.ok(report.length < 6000, `diagnostic should remain bounded, got ${report.length} characters`);
});

test('buildScoutingReport returns a placeholder when no match is loaded', () => {
  const ctx = loadViewerContext();
  assert.match(ctx.buildScoutingReport(null, null), /No match loaded/);
});

test('buildScoutingReport covers both teams with a curated summary followed by the full raw narrative and telemetry', () => {
  const ctx = loadViewerContext();
  // Every duel role uses a distinct player so each side's totals are unambiguous to
  // hand-verify: Bost wins on positioning, Tsur wins via a contested tackle (Control,
  // and scores), Kova defends and wins via tackle (Tackle) — all three Home. Golan and
  // Silva (Away) each lose the duel they defended; Reyes (Away) loses the one they
  // attacked. So Home should show 3 duels played, 3 won, split 1/1/1, and Away should
  // show 3 duels played, 0 won.
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Doe [RB] attempted low decent pass to Bost [CM]',
    'Golan [CB] got weak assistance, and was close.',
    'Bost [CM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Bost [CM] attempted high excellent pass to Tsur [FW]',
    'Silva [CB] got weak assistance, and was in decent position.',
    'Tsur [FW] made excellent reception, Silva [CB] made weak tackle.',
    'Tsur [FW] took control of the ball.',
    'Goal Attempt',
    'Tsur [FW] made excellent shot.',
    'Ferro [GK] was ready, and made excellent effort to prevent goal.',
    'GOAL!',
    '[1-0]',
    'Minute 20', 'Opportunity for Away Team.', 'Midfield',
    'Haas [GK] attempted low decent pass to Reyes [CM]',
    'Kova [CM] got good assistance, and was in decent position.',
    'Reyes [CM] made weak reception, Kova [CM] made superb tackle.',
    'Kova [CM] cleared the ball to safety.',
    '[1-0]',
    'Minute 30',
    'Home Team - Issued order- Change mentality to ATTACKING',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (65)", "10' - A - V_ASSISTANCE - (30)", "10' - H - V_RECEPTION - (75)",
    "10' - H - V_PASS - (85)", "10' - A - V_ASSISTANCE - (40)", "10' - H - V_RECEPTION - (85)", "10' - A - V_TACKLING - (35)",
    "10' - H - V_SHOT - (80)", "10' - A - V_REFLEX - (60)", "10' - H - E_GOAL",
    "20' - A - O_MID_START", "20' - A - V_PASS - (55)", "20' - H - V_ASSISTANCE - (60)", "20' - A - V_RECEPTION - (30)", "20' - H - V_TACKLING - (75)",
  ].join('\n');
  const initialTactics = {
    home: { mentality: 'BALANCED', style: 'SHORT_PASSES', marking: 'ZONAL', defenceFocus: 'CENTER', preferredSide: 'NONE' },
    away: {},
  };
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team', initialTactics });
  const scrape = { homeTeam: 'Home Team', awayTeam: 'Away Team', scrapedAt: Date.UTC(2026, 7, 19), narrative, telemetry };

  const report = ctx.buildScoutingReport(match, scrape);

  assert.match(report, /## Home Team \(home\)/);
  assert.match(report, /## Away Team \(away\)/);
  assert.match(report, /final score 1-0/);
  assert.match(report, /Scorers: Tsur \(10'\)/, 'the actual scorer must be named');
  assert.match(report, /Final pass before goal \(DERIVED, not an FW-sourced "assist"\): Bost \(10'\)/, 'the actual final-pass player must be named, labeled DERIVED rather than "assist"');
  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));
  const awaySection = report.slice(report.indexOf('## Away Team'), report.indexOf('## Raw narrative'));
  assert.match(homeSection, /Duels competed in: 3, won: 3 \(100%\)/, 'Bost + Tsur + Kova each won their one duel');
  assert.match(homeSection, /Won breakdown — Position: 1, Control: 1, Tackle: 1/);
  assert.match(awaySection, /Duels competed in: 3, won: 0 \(0%\)/, 'Golan, Silva, and Reyes each lost their one duel');
  assert.match(awaySection, /Won breakdown — Position: 0, Control: 0, Tackle: 0/);
  // Initial tactics: present and populated for Home, present but explicitly "not
  // available" for Away — never silently absent either way.
  assert.match(homeSection, /### Initial tactics\nMentality: BALANCED\nStyle of Play: SHORT_PASSES\nMarking: ZONAL\nDefence Focus: CENTER\nPreferred Side: NONE/);
  assert.match(awaySection, /### Initial tactics\nNot available in this scrape\./);
  assert.match(homeSection, /### Tactical changes\n30' — Mentality changed to ATTACKING/);
  assert.match(awaySection, /### Tactical changes\nNo in-match tactical changes observed\./);
  assert.match(report, /## Raw narrative/);
  assert.match(report, /## Raw telemetry/);
  assert.match(report, /Bost \[CM\] attempted high excellent pass to Tsur \[FW\]/, 'the exact raw narrative text must be included verbatim');
  assert.match(report, /O_MID_START/, 'the exact raw telemetry text must be included verbatim');
});

test('buildScoutingReport: the global Key Matchups table shows both teams once; PB attacking/defending subsections are correctly one-sided by role', () => {
  const ctx = loadViewerContext();
  const pbDuel = (attacker, defender, outcome, side) => ({
    stepType: 'PB_DUEL', attacker, defender, outcome,
    attackingSide: side, defendingSide: side === 'home' ? 'away' : 'home',
    values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: { value: 50 } },
  });
  // Home attacks (Tsur vs Golan, Golan defending for Away) and Away attacks (Reyes vs
  // Kova, Kova defending for Home) — a matchup is always bilateral, so BOTH pairs must
  // appear in the single global table, but each must land in only ONE of the four
  // role-scoped PB subsections (Home-attacking / Home-defending / Away-attacking /
  // Away-defending), never more than one.
  const homeA = { name: 'Tsur', position: 'FW' }, awayD = { name: 'Golan', position: 'CB' };
  const awayA = { name: 'Reyes', position: 'FW' }, homeD = { name: 'Kova', position: 'CB' };
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } },
    tacticalEvents: [],
    opportunities: [
      { teamSide: 'home', steps: [pbDuel(homeA, awayD, 'WON', 'home')] },
      { teamSide: 'home', steps: [pbDuel(homeA, awayD, 'WON', 'home')] },
      { teamSide: 'away', steps: [pbDuel(awayA, homeD, 'CLEARED', 'away')] },
      { teamSide: 'away', steps: [pbDuel(awayA, homeD, 'CLEARED', 'away')] },
    ],
  };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const globalMatchups = report.slice(report.indexOf('## Key Matchups'), report.indexOf('## Scouting Signals'));
  assert.match(globalMatchups, /Tsur \| Golan/, 'the global table must include both recurring matchups');
  assert.match(globalMatchups, /Reyes \| Kova/);

  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));
  const awaySection = report.slice(report.indexOf('## Away Team'), report.indexOf('## Key Matchups'));
  const homeAttackingBlock = homeSection.slice(homeSection.indexOf('#### PB matchups — Home Team attacking'), homeSection.indexOf('#### PB matchups — Home Team defending'));
  const homeDefendingBlock = homeSection.slice(homeSection.indexOf('#### PB matchups — Home Team defending'), homeSection.indexOf('#### Defensive-chain exposure'));
  assert.match(homeAttackingBlock, /Tsur \| Golan/, "Home's own attacking matchup belongs under Home attacking");
  assert.doesNotMatch(homeAttackingBlock, /Reyes \| Kova/, 'Away attacking a Home defender must not appear under Home attacking');
  assert.match(homeDefendingBlock, /Reyes \| Kova/, "Home's own defender's matchup belongs under Home defending");
  assert.doesNotMatch(homeDefendingBlock, /Tsur \| Golan/);

  const awayAttackingBlock = awaySection.slice(awaySection.indexOf('#### PB matchups — Away Team attacking'), awaySection.indexOf('#### PB matchups — Away Team defending'));
  assert.match(awayAttackingBlock, /Reyes \| Kova/);
  assert.doesNotMatch(awayAttackingBlock, /Tsur \| Golan/);
});

test('buildScoutingReport: attacking routes, attack termination, and fatigue timeline surface real recurring data', () => {
  const ctx = loadViewerContext();
  const rb = { name: 'Bilardo', position: 'RB' }, rm = { name: 'Bakkely', position: 'RM' }, fw = { name: 'Tsur', position: 'FW' };
  const passStep = (from, to) => ({ stepType: 'START_PASS', from, to, attackingSide: 'home', defendingSide: 'away', values: { pass: { value: 60 } } });
  const shot = (outcome) => ({ stepType: 'SHOT', shooter: fw, outcome, attackingSide: 'home', defendingSide: 'away', values: { shot: { value: 70 }, gkSave: { value: 40 } } });
  const oneOpp = (outcome) => ({ teamSide: 'home', finalOutcome: outcome, steps: [passStep(rb, rm), passStep(rm, fw), shot(outcome)] });
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 1, away: 0 } },
    tacticalEvents: [
      { type: 'TIREDNESS', minute: 55, sequence: 55, team: 'Home Team', teamSide: 'home', player: rm, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 75, sequence: 75, team: 'Home Team', teamSide: 'home', player: rm, level: 'VERY_TIRED' },
      { type: 'SUBSTITUTION', minute: 80, sequence: 80, team: 'Home Team', teamSide: 'home', playerOut: rm, playerIn: { name: 'Sub', position: 'RM' } },
    ],
    opportunities: [oneOpp('GOAL'), oneOpp('GOAL'), oneOpp('MISSED')],
  };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));
  assert.match(homeSection, /Bilardo RB → Bakkely RM → Tsur FW — 3 times/, 'the repeated three-player route must be reported with its real occurrence count');
  assert.match(homeSection, /Goal: 2/);
  assert.match(homeSection, /Shot missed: 1/);
  assert.match(homeSection, /Bakkely: tired 55', very tired 75', substituted 80'/, 'the fatigue timeline must show the real tired/very-tired/substitution minutes for this player');
  assert.match(homeSection, /Manual mechanic: TIRED applies a skill penalty/, 'the tiredness skill-penalty mechanic must be cited as a labeled Manual mechanic');
});

test('buildScoutingReport: Scouting Signals stay observed/derived language, never a tactical recommendation or setting inference', () => {
  const ctx = loadViewerContext();
  const pbDuel = (attacker, defender, outcome) => ({
    stepType: 'PB_DUEL', attacker, defender, outcome, attackingSide: 'home', defendingSide: 'away',
    values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: { value: 70 } },
  });
  const attacker = { name: 'Tsur', position: 'FW' }, defender = { name: 'Golan', position: 'CB' };
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } },
    tacticalEvents: [],
    // Golan loses 3 of 4 PB contests, each followed by a shot — crosses the
    // buildScoutingSignals defender-exposure threshold (contests>=3, lost/contests>=0.5).
    opportunities: [
      { teamSide: 'home', steps: [pbDuel(attacker, defender, 'WON'), { stepType: 'SHOT', shooter: attacker, outcome: 'SAVED', attackingSide: 'home', defendingSide: 'away', values: {} }] },
      { teamSide: 'home', steps: [pbDuel(attacker, defender, 'WON'), { stepType: 'SHOT', shooter: attacker, outcome: 'MISSED', attackingSide: 'home', defendingSide: 'away', values: {} }] },
      { teamSide: 'home', steps: [pbDuel(attacker, defender, 'WON'), { stepType: 'SHOT', shooter: attacker, outcome: 'GOAL', attackingSide: 'home', defendingSide: 'away', values: {} }] },
      { teamSide: 'home', steps: [pbDuel(attacker, defender, 'CLEARED')] },
    ],
  };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const signals = report.slice(report.indexOf('## Scouting Signals'), report.indexOf('## Raw narrative'));
  assert.match(signals, /Golan/, 'the repeated PB defender loss must actually surface as a signal on this fixture');
  const forbidden = /\b(should|recommend|attack (their|his|her)|use man-to-man|press |prefer(?:s|red)?|instructed|weak defender|bad player|responsible for)\b/i;
  assert.doesNotMatch(signals, forbidden, 'Scouting Signals must state observed counts/ratios only, never a recommendation or a tactical-setting inference');
  // This same fixture also has Tsur beating Golan 3/4 in their direct matchup — a
  // priority-4 signal that describes the exact same underlying vulnerability as the
  // priority-3 "Golan lost 3/4 PB contests" signal above. Only the higher-priority one
  // should survive; the matchup line must not restate it.
  assert.match(signals, /lost 3\/4 PB contests/, 'the PB-defender-exposure signal (priority 3) must be kept');
  assert.doesNotMatch(signals, /Tsur vs Golan/, 'the redundant dominant-matchup signal (priority 4, same player) must be suppressed');
  // Tsur's own PB attacking success is a DIFFERENT fact (his conversion record as an
  // attacker, not a restatement of Golan's exposure) and must still come through.
  assert.match(signals, /Tsur \(Home Team\): won 3\/4 PB contests as the attacker/);
});

test('buildScoutingReport: Scouting Signals are capped at 6 per side even with many qualifying candidates', () => {
  const ctx = loadViewerContext();
  const pbDuel = (attacker, defender, outcome) => ({
    stepType: 'PB_DUEL', attacker, defender, outcome, attackingSide: 'away', defendingSide: 'home',
    values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: { value: 70 } },
  });
  const shot = (shooter, outcome) => ({ stepType: 'SHOT', shooter, outcome, attackingSide: 'away', defendingSide: 'home', values: {} });
  // Seven DIFFERENT home defenders, each losing 3/3 PB contests to a shared away
  // attacker — seven genuinely distinct priority-3 signals (different players, so
  // dedup must not suppress any of them), enough to prove the cap itself is doing the
  // limiting, not the dedup logic.
  const attacker = { name: 'Striker', position: 'FW' };
  const opportunities = [];
  const defenderNames = ['DefA', 'DefB', 'DefC', 'DefD', 'DefE', 'DefF', 'DefG'];
  for (const name of defenderNames) {
    const defender = { name, position: 'CB' };
    for (let i = 0; i < 3; i++) {
      opportunities.push({ teamSide: 'away', steps: [pbDuel(attacker, defender, 'WON'), shot(attacker, 'SAVED')] });
    }
  }
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } },
    tacticalEvents: [],
    opportunities,
  };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const signals = report.slice(report.indexOf('## Scouting Signals'), report.indexOf('## Raw narrative'));
  const homeSignalLines = signals.split('\n').filter(l => defenderNames.some(name => l.includes(name)));
  assert.ok(homeSignalLines.length <= 6, `expected at most 6 Home-side signals, got ${homeSignalLines.length}: ${JSON.stringify(homeSignalLines)}`);
  assert.ok(homeSignalLines.length >= 1, 'the cap must not suppress everything either');
});

test('buildScoutingReport: defensive-chain exposure keeps "most involved" and "most frequent earliest failed" as two separate roles, using the relabeled terminology', () => {
  const ctx = loadViewerContext();
  const attacker = { name: 'Attacker', position: 'FW' };
  const stoilkovic = { name: 'Stoilkovic', position: 'CB' };
  const midDuel = (defender, outcome) => ({
    stepType: 'MID_DUEL', attacker, defender, outcome, attackingSide: 'away', defendingSide: 'home',
    values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: outcome === 'CLEARED' ? { value: 70 } : null },
  });
  const pbDuel = (defender) => ({
    stepType: 'PB_DUEL', attacker, defender, outcome: 'WON', attackingSide: 'away', defendingSide: 'home',
    values: { reception: { value: 70 }, assistance: { value: 30 }, tackle: { value: 40 } },
  });
  const shot = { stepType: 'SHOT', shooter: attacker, outcome: 'SAVED', attackingSide: 'away', defendingSide: 'home', values: {} };
  const opportunities = [];
  // Stoilkovic defends the PB stage in all 5 chains (involved in 5), but the midfield
  // stage is lost first each time — 3 of those 5 to Gesevic specifically, 2 to a
  // throwaway defender — so Stoilkovic is NEVER the earliest failed duel, while Gesevic
  // is, 3 times, despite being involved in fewer chains overall.
  for (let i = 0; i < 3; i++) {
    opportunities.push({ teamSide: 'away', steps: [
      midDuel({ name: 'Gesevic', position: 'DM' }, 'POSSESSION'), pbDuel(stoilkovic), shot,
    ] });
  }
  for (let i = 0; i < 2; i++) {
    opportunities.push({ teamSide: 'away', steps: [
      midDuel({ name: 'OtherDef', position: 'DM' }, 'POSSESSION'), pbDuel(stoilkovic), shot,
    ] });
  }
  const match = { meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } }, tacticalEvents: [], opportunities };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));

  assert.match(homeSection, /Most involved in opponent shot chains: Stoilkovic \(5\)/);
  assert.match(homeSection, /Most frequent earliest failed defender: Gesevic \(3\)/);
  // The relabeled per-row terminology — "earliest failed defensive contest", not the
  // old "first failed defensive contest" wording that read as sole responsibility.
  assert.match(homeSection, /earliest failed defensive contest in/);
  assert.doesNotMatch(homeSection, /first failed defensive contest/);
  assert.match(homeSection, /Note: "earliest failed defensive contest"/);
});

test('buildScoutingReport: tied leaders are reported jointly instead of an arbitrary single winner', () => {
  const ctx = loadViewerContext();
  const shot = (shooter, outcome) => ({ stepType: 'SHOT', shooter, outcome, attackingSide: 'home', defendingSide: 'away', values: {} });
  const pass = (from, to) => ({ stepType: 'START_PASS', from, to, attackingSide: 'home', defendingSide: 'away', values: { pass: { value: 60 } } });
  // Three different players each take exactly one shot — a genuine three-way tie for
  // "main shot taker", not a case where sort()[0] should get to arbitrarily pick one.
  const players = ['Zubac', 'Karolyi', 'Saarela'].map(name => ({ name, position: 'FW' }));
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } },
    tacticalEvents: [],
    opportunities: players.map(p => ({ teamSide: 'home', steps: [pass({ name: 'Passer', position: 'CM' }, p), shot(p, 'SAVED')] })),
  };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));
  assert.match(homeSection, /Joint main shot takers: Zubac, Karolyi, Saarela \(1 each\)/);
  assert.doesNotMatch(homeSection, /Main shot taker: Zubac \(1\)/, 'must not silently crown one of the tied players as THE leader');
});

test('Scouting Assessment: Key matchup findings only appear under the ATTACKING team, never copy-pasted into the defending team\'s own section too', () => {
  const ctx = loadViewerContext();
  const attacker = { name: 'Dragic', position: 'FW' }, defender = { name: 'Gesevic', position: 'CB' };
  const pbDuel = (outcome) => ({ stepType: 'PB_DUEL', attacker, defender, outcome, attackingSide: 'home', defendingSide: 'away', values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: { value: 50 } } });
  const opportunities = [
    ...Array(4).fill(0).map(() => ({ teamSide: 'home', steps: [pbDuel('WON')] })),
    { teamSide: 'home', steps: [pbDuel('CLEARED')] },
  ];
  const match = { meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } }, tacticalEvents: [], opportunities };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const homeSection = report.slice(report.indexOf('## Home Team'), report.indexOf('## Away Team'));
  const awaySection = report.slice(report.indexOf('## Away Team'), report.indexOf('## Key Matchups'));
  assert.match(homeSection, /Dragic repeatedly beat Gesevic/, "the attacking team's own section must show this finding");
  const awayKeyMatchups = awaySection.slice(awaySection.indexOf('#### Key matchup findings'), awaySection.indexOf('#### Potential vulnerabilities'));
  assert.doesNotMatch(awayKeyMatchups, /Dragic repeatedly beat Gesevic/, "the defending team's Key matchup findings must NOT duplicate the attacking team's own finding");
});

test('Scouting Assessment: a high-usage but low-win-rate PB target is never mislabeled "Dominant" just because it produced a goal', () => {
  const ctx = loadViewerContext();
  const attacker = { name: 'Lofsgaard', position: 'FW' }, defender = { name: 'Kova', position: 'CB' };
  const pbDuel = (outcome) => ({ stepType: 'PB_DUEL', attacker, defender, outcome, attackingSide: 'home', defendingSide: 'away', values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: { value: 50 } } });
  const shot = (outcome) => ({ stepType: 'SHOT', shooter: attacker, outcome, attackingSide: 'home', defendingSide: 'away', values: {} });
  // 1/6 PB contests won, with a single goal scored off that one win — the exact
  // Løfsgaard-shaped case that previously got mislabeled "Dominant PB target".
  const opportunities = [
    ...Array(5).fill(0).map(() => ({ teamSide: 'home', steps: [pbDuel('CLEARED')] })),
    { teamSide: 'home', steps: [pbDuel('WON'), shot('GOAL')] },
  ];
  const match = { meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 1, away: 0 } }, tacticalEvents: [], opportunities };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.doesNotMatch(report, /Dominant PB target: Lofsgaard/, 'a 1/6 win rate must never be called "Dominant" purely because it produced one goal');
});

test('Scouting Assessment: efficient shooting is worded as a threat/strength, never as something exploitable against the team that did it', () => {
  const ctx = loadViewerContext();
  const fw = { name: 'Sharp', position: 'FW' };
  const shot = (outcome) => ({ stepType: 'SHOT', shooter: fw, outcome, attackingSide: 'home', defendingSide: 'away', values: {} });
  const opportunities = [
    { teamSide: 'home', steps: [shot('GOAL')] }, { teamSide: 'home', steps: [shot('GOAL')] },
    { teamSide: 'home', steps: [shot('SAVED')] }, { teamSide: 'home', steps: [shot('MISSED')] },
  ];
  const match = { meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } }, tacticalEvents: [], opportunities };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.match(report, /Clinical finishing in this match — 2\/4 shots were goals/);
  assert.doesNotMatch(report, /may be exploitable via limiting shot volume/i, 'high conversion must never be worded as if it were a weakness to exploit');
});

test('Scouting Assessment: the physical-vulnerability count is labeled to match what it actually counts (VERY_TIRED only)', () => {
  const ctx = loadViewerContext();
  const players = ['A', 'B', 'C'].map(n => ({ name: n, position: 'CM' }));
  const tacticalEvents = players.map((p, i) => ({ type: 'TIREDNESS', minute: 70 + i, sequence: 70 + i, team: 'Home Team', teamSide: 'home', player: p, level: 'VERY_TIRED' }));
  const match = { meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } }, tacticalEvents, opportunities: [] };
  const report = ctx.buildScoutingReport(match, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.match(report, /3 starter\(s\) reached VERY_TIRED before full time/);
  assert.doesNotMatch(report, /reached TIRED\/VERY_TIRED/, 'the label must not claim to count plain-TIRED players when only VERY_TIRED is actually counted');
});

test('goalkeeper aggregation reconciles even for the currently-unreachable CORNER shot outcome (defensive correctness, not just the reachable paths)', () => {
  const ctx = loadViewerContext();
  const gk = { name: 'Keeper', position: 'GK' };
  const shooter = { name: 'Shooter', position: 'FW' };
  // Bypasses the narrative parser entirely — constructs a match object with a raw SHOT
  // step whose outcome is 'CORNER' directly, since real narrative parsing never produces
  // this today (see SHOT_TERMINALS in parser.js) but the aggregation must not silently
  // break its own invariant if it ever did.
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team', finalScore: { home: 0, away: 0 } },
    opportunities: [{ teamSide: 'away', steps: [
      { stepType: 'SHOT', shooter, gk, outcome: 'CORNER', attackingSide: 'away', defendingSide: 'home', values: {} },
    ] }],
  };
  const gkAnalysis = ctx.goalkeeperAnalysis(match);
  const rec = gkAnalysis.byGoalkeeper['Keeper'];
  assert.equal(rec.shotsFaced, 1);
  assert.equal(rec.cornersConceded, 1);
  assert.equal(rec.offTargetOrBlocked, 1, 'a CORNER outcome must be folded into offTargetOrBlocked, not silently dropped from the onTarget+offTargetOrBlocked+unresolved reconciliation');
  assert.equal(rec.shotsFaced, rec.onTarget + rec.offTargetOrBlocked + rec.unresolved);
});

test('generated viewer wording normalizes the raw narrow miss grammar', () => {
  const ctx = loadViewerContext();
  assert.equal(ctx.outcomeLabel('MISSED', 'narrow'), 'missed narrowly');
  assert.equal(ctx.outcomeLabel('MISSED', 'wide'), 'missed wide');
});

test('selected-opportunity narrative is viewport-bounded and vertically scrollable', () => {
  const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  assert.match(html, /\.right-overlay\{[^}]*top:10px;[^}]*bottom:10px;/);
  assert.match(html, /\.raw-panel\{[^}]*min-height:0;[^}]*flex:1;[^}]*overflow-y:auto;/);
});

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

test('an extra-time break clears reported tiredness the same way half time does', () => {
  const ctx = loadViewerContext();
  const events = [
    { minute: 20, type: 'INJURY', player: { name: 'Player A' }, severity: 'LIGHT' },
    { minute: 85, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'VERY_TIRED' },
    { minute: 90, type: 'EXTRA_TIME_BREAK', period: 'start' },
  ];
  const before = ctx.playerStatusAt(events, 'Player A', 89);
  assert.equal(before.tiredness, 'VERY_TIRED');

  const after = ctx.playerStatusAt(events, 'Player A', 95);
  assert.equal(after.injury, 'LIGHT', 'injury must persist across the break');
  assert.equal(after.tiredness, null, 'a pre-break tiredness report must not carry into extra time');
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

test('renderTacticalRow shows a distinct bar for the start of extra time vs the changeover between its two halves', () => {
  const ctx = loadViewerContext();
  const start = ctx.renderTacticalRow({ type: 'EXTRA_TIME_BREAK', period: 'start', minute: 90 });
  assert.ok(start.includes('EXTRA TIME'));
  const halfway = ctx.renderTacticalRow({ type: 'EXTRA_TIME_BREAK', period: 'halfway', minute: 105 });
  assert.ok(halfway.includes('END OF FIRST EXTRA TIME'));
});

test('renderTacticalRow shows the preferred-side order', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderTacticalRow({ type: 'PREFERRED_SIDE_CHANGE', preferredSide: 'LEFT_RIGHT', teamSide: 'home', minute: 78 });
  assert.ok(html.includes('Preferred side'));
  assert.ok(html.includes('LEFT_RIGHT'));
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

test('a recovered counter-attack highlights the successful route and keeps the blocked pass as context', () => {
  const ctx = loadViewerContext();
  const opp = {
    teamSide: 'away', isCounterAttack: true,
    steps: [
      { stepType: 'START_PASS', isCA: true, attackingSide: 'home', from: { name: 'Martinov', position: 'CB' }, to: { name: 'Sperstad', position: 'RM' }, values: { pass: { value: 1 } } },
      { stepType: 'MID_DUEL', isCA: true, attackingSide: 'home', attacker: { name: 'Sperstad', position: 'RM' }, defender: null, outcome: 'BLOCKED', values: {} },
      { stepType: 'START_PASS', isCA: true, attackingSide: 'home', from: { name: 'Wicinski', position: 'RB' }, to: { name: 'Sato', position: 'LM' }, values: { pass: { value: 75 } } },
      { stepType: 'MID_DUEL', isCA: true, attackingSide: 'home', attacker: { name: 'Sato', position: 'LM' }, defender: { name: 'Gentil', position: 'RW' }, outcome: 'POSSESSION', values: {} },
      { stepType: 'PB_PASS', isCA: true, attackingSide: 'home', from: { name: 'Sato', position: 'LM' }, to: { name: 'Tsur', position: 'FW' }, values: { pass: { value: 95 } } },
      { stepType: 'PB_DUEL', isCA: true, attackingSide: 'home', attacker: { name: 'Tsur', position: 'FW' }, defender: { name: 'Clatesteanu', position: 'CB' }, outcome: 'WON', values: {} },
      { stepType: 'SHOT', isCA: true, attackingSide: 'home', shooter: { name: 'Tsur', position: 'FW' }, gk: { name: 'Barrionuevo', position: 'GK' }, outcome: 'GOAL', values: { shot: { value: 55 }, gkSave: { value: 75 } } },
    ],
  };

  const chain = ctx.stepsToChain(opp);
  assert.equal(chain.sP, 'RB', 'the recovered successful pass must be the main route start');
  assert.equal(chain.mP, 'LM');
  assert.equal(chain.earlierFailedPasses.length, 1);
  assert.equal(chain.earlierFailedPasses[0].from, 'CB');
  assert.match(ctx.renderHighlightChain(opp), /data-chain-context="earlier-failed-pass"/);
});

test('stepsToChain defers building earlierFailedPasses until it is actually read', () => {
  const ctx = loadViewerContext();
  const opp = {
    teamSide: 'home', isCounterAttack: false,
    steps: [
      { stepType: 'START_PASS', from: { name: 'A', position: 'RB' }, to: { name: 'B', position: 'CM' }, values: { pass: { value: 60 } } },
      { stepType: 'MID_DUEL', attacker: { name: 'B', position: 'CM' }, defender: null, outcome: 'POSSESSION', values: {} },
    ],
  };
  const chain = ctx.stepsToChain(opp);
  const descriptor = Object.getOwnPropertyDescriptor(chain, 'earlierFailedPasses');
  assert.equal(typeof descriptor.get, 'function',
    'earlierFailedPasses must be computed lazily via a getter, not built eagerly on every stepsToChain call');
  assert.ok(Array.isArray(chain.earlierFailedPasses), 'reading the getter must still produce the array');
});

test('renderOppList reuses its own stepsToChain result instead of making renderMiniChain recompute it', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  let calls = 0;
  const original = ctx.stepsToChain;
  ctx.stepsToChain = (...args) => { calls++; return original(...args); };
  ctx.renderOppList(match);
  assert.equal(calls, 1, 'stepsToChain must be computed once per opportunity, not once by renderOppList and again by renderMiniChain');
});

test('a blocked penalty-box pass that is recovered and re-attempted shows the recovered route, not the block', () => {
  const ctx = loadViewerContext();
  const opp = {
    teamSide: 'home', isCounterAttack: false,
    steps: [
      { stepType: 'START_PASS', from: { name: 'A', position: 'RB' }, to: { name: 'B', position: 'CM' }, values: { pass: { value: 60 } } },
      { stepType: 'MID_DUEL', attacker: { name: 'B', position: 'CM' }, defender: null, outcome: 'POSSESSION', values: {} },
      // First PB attempt: blocked and lost.
      { stepType: 'PB_PASS', from: { name: 'B', position: 'CM' }, to: { name: 'C', position: 'FW' }, values: { pass: { value: 40 } } },
      { stepType: 'PB_DUEL', attacker: { name: 'C', position: 'FW' }, defender: { name: 'X', position: 'CB' }, outcome: 'BLOCKED', values: {} },
      // Recovered and re-attempted from a different position — this is the pair that
      // actually matters, and used to be discarded in favor of the blocked one above.
      { stepType: 'PB_PASS', from: { name: 'D', position: 'LW' }, to: { name: 'E', position: 'FW' }, values: { pass: { value: 90 } } },
      { stepType: 'PB_DUEL', attacker: { name: 'E', position: 'FW' }, defender: { name: 'X', position: 'CB' }, outcome: 'WON', values: {} },
      { stepType: 'SHOT', shooter: { name: 'E', position: 'FW' }, gk: { name: 'Y', position: 'GK' }, outcome: 'GOAL', values: { shot: { value: 80 }, gkSave: { value: 60 } } },
    ],
  };
  const chain = ctx.stepsToChain(opp);
  assert.equal(chain.pbP, 'LW', 'the recovered pass, not the blocked first attempt, must be the main PB route');
  assert.equal(chain.rP, 'FW');
  assert.equal(chain.pbRes, 'adv');
});

test('a rebound shot chain shows the final decisive shot, not the discarded first attempt', () => {
  const ctx = loadViewerContext();
  const opp = {
    teamSide: 'home', isCounterAttack: false,
    steps: [
      { stepType: 'PB_PASS', from: { name: 'A', position: 'RB' }, to: { name: 'B', position: 'FW' }, values: { pass: { value: 70 } } },
      { stepType: 'PB_DUEL', attacker: { name: 'B', position: 'FW' }, defender: { name: 'X', position: 'CB' }, outcome: 'WON', values: {} },
      // First shot bounces off the post — a live-ball outcome, not the sequence's real result.
      { stepType: 'SHOT', shooter: { name: 'B', position: 'FW' }, gk: { name: 'Y', position: 'GK' }, outcome: 'POST', values: { shot: { value: 50 }, gkSave: { value: 40 } } },
      // The rebound is recovered by a teammate and put away — this is how the sequence
      // actually ended, and used to be discarded in favor of the POST attempt above.
      { stepType: 'SHOT', shooter: { name: 'C', position: 'FW' }, gk: { name: 'Y', position: 'GK' }, outcome: 'GOAL', values: { shot: { value: 85 }, gkSave: { value: 30 } } },
    ],
  };
  const chain = ctx.stepsToChain(opp);
  assert.equal(chain.shName, 'C', 'the final, decisive shot must win, not the first shot in the sequence');
  assert.equal(chain.attOut, 'goal');
  assert.equal(chain.gkRes, 'goal');
});

test('counter-attack chain detail uses the countering team and includes a recovery pass', () => {
  const ctx = loadViewerContext();
  vm.runInContext("_match = { meta: { homeTeam: 'AC Pasofino', awayTeam: 'Parana Clube' } }", ctx);
  const opp = {
    teamSide: 'away', isCounterAttack: true,
    steps: [
      { stepType: 'START_PASS', isCA: true, from: { name: 'Gavril Martinov', position: 'CB' }, to: { name: 'Torgeir Sperstad', position: 'RM' }, values: { pass: { value: 1 } } },
      { stepType: 'MID_DUEL', isCA: true, outcome: 'BLOCKED' },
      { stepType: 'START_PASS', isCA: true, from: { name: 'Jan Wicinski', position: 'RB' }, to: { name: 'Fagner Sato', position: 'LM' }, values: { pass: { value: 75 } } },
      { stepType: 'MID_DUEL', isCA: true, outcome: 'POSSESSION' },
      { stepType: 'PB_PASS', isCA: true, from: { name: 'Fagner Sato', position: 'LM' }, to: { name: 'Naor Tsur', position: 'FW' }, values: { pass: { value: 95 } } },
    ],
  };
  const html = ctx.buildPassSummary(opp);
  assert.match(html, /AC Pasofino/);
  assert.doesNotMatch(html, /Parana Clube/);
  assert.match(html, /Wicinski/);
  assert.match(html, /Recovery/);
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
// Tactical Phases — Tactics tab rendering
// ─────────────────────────────────────────────────────────────────────────────

test('renderTacticalPhasesSection shows all five main tactics on every phase card', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 62',
    'Home Team - Issued order- Change mentality to ATTACKING',
  ].join('\n');
  const initialTactics = {
    home: { mentality: 'NORMAL', style: 'THROUGH_BALLS', marking: 'ZONE', defenceFocus: 'CENTER', preferredSide: 'LEFT' },
    away: { mentality: 'DEFENSIVE', style: 'FLEXIBLE', marking: 'MAN_TO_MAN', defenceFocus: 'NORMAL', preferredSide: 'RIGHT' },
  };
  const match = ctx.parseMatch('', narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team', initialTactics });
  const html = ctx.renderTacticalPhasesSection(match, 'home', '#4da3ff');

  assert.ok(html.includes('Tactical Phases (2)'), 'kickoff phase + the mentality change');
  // escapeHtml renders the apostrophe as &#39; — assert on the digits/dash, not the raw quote.
  assert.ok(html.includes('0–62'), 'first phase period label');
  assert.ok(html.includes('ATTACKING'), 'the changed setting is shown');
  for (const [label, value] of [
    ['Mentality', 'NORMAL'], ['Style of Play', 'THROUGH_BALLS'], ['Marking', 'ZONE'],
    ['Defence Focus', 'CENTER'], ['Preferred Side', 'LEFT'],
  ]) {
    assert.ok(html.includes(`<b>${label}:</b> ${value}`), `${label} should be shown at kickoff`);
  }
  assert.ok(html.includes('<b>Mentality:</b> ATTACKING'), 'the subsequent mentality change is shown in the next phase');
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

test('renderSquadTab still renders supporting event sections alongside Tactical Phases', () => {
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

test('renderTacticalPhasesSection shows a Style of Play change in the next phase', () => {
  const ctx = loadViewerContext();
  const narrative = ['Minute 20', 'Home Team - Issued order- Change order to LONG_BALLS'].join('\n');
  const match = ctx.parseMatch('', narrative, {
    homeTeam: 'Home Team', awayTeam: 'Away Team',
    initialTactics: { home: { style: 'THROUGH_BALLS' }, away: {} },
  });
  const html = ctx.renderTacticalPhasesSection(match, 'home', '#4da3ff');
  assert.ok(html.includes('<b>Style of Play:</b> THROUGH_BALLS'), 'kickoff phase');
  assert.ok(html.includes('<b>Style of Play:</b> LONG_BALLS'), 'changed phase');
  assert.ok(html.includes('Style of Play <span class="p-arr">→</span> LONG_BALLS'));
  assert.equal(html.includes('Middle order'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Analysis tab
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

// ─────────────────────────────────────────────────────────────────────────────
// Cross-file duplication drift check
// ─────────────────────────────────────────────────────────────────────────────
// viewer.js's own pitch-layout lane() and analytics.js's laneOf() are independent
// position→lane implementations (analytics.js must not depend on viewer.js's DOM-mixed
// code — see analytics.js's own module comment) that happen to encode the same
// left/center/right convention. Rather than force a risky shared-require refactor across
// the classic-script boundary that already caused one real collision this phase, this
// test directly enforces the invariant that actually matters: the two must never
// silently diverge. If this ever fails, update whichever of LANE_MAP (viewer.js) /
// POSITION_LANE_MAP (analytics.js) is stale.

test('viewer.js\'s lane() and analytics.js\'s laneOf() agree for every FinalWhistle position', () => {
  const ctx = loadViewerContext();
  const positions = ['GK', 'LB', 'CB', 'RB', 'LWB', 'DM', 'RWB', 'LM', 'CM', 'RM', 'LW', 'OM', 'RW', 'FW'];
  for (const pos of positions) {
    assert.equal(ctx.lane(pos), ctx.laneOf(pos), `lane('${pos}') and laneOf('${pos}') disagree`);
  }
  // Also confirm both fall back to 'center' identically for an unrecognized position.
  assert.equal(ctx.lane('XX'), ctx.laneOf('XX'));
});

// ─────────────────────────────────────────────────────────────────────────────
// innerHTML security audit: payload-shaped strings, end-to-end
// ─────────────────────────────────────────────────────────────────────────────
// These check RENDERED OUTPUT is escaped, not just that escapeHtml() behaves correctly
// in isolation — each payload is pushed through a genuine data path a real scrape could
// carry it through (a player name, a team name, a scraped stat label), into the actual
// render function a real match uses. Not merely "escapeHtml() works in isolation" —
// every actual call site that touches untrusted text is exercised end-to-end.

const XSS_SCRIPT = '<script>alert(1)</script>';
const XSS_IMG = '"><img src=x onerror=alert(1)>';
const XSS_SVG_BREAKOUT = '</span><svg onload=alert(1)>';

test('renderOppList escapes a script-tag payload in a player name reached via the opportunity list', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 10',
    `Opportunity for Home Team.`,
    'Midfield',
    `${XSS_SCRIPT} [RB] attempted low good pass to Player B [CM]`,
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const html = ctx.renderOppList(match);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw <script> must not reach renderOppList output');
});

test('an offside-ended opportunity gets its own marker color, not the generic gray fallback', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 25', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RM] attempted high brilliant pass to Player D [FW]',
    'Offside trap was attempted by the defense team.',
    'Player E [CB] got weak assistance, and was ready.',
    'Assistant referee signaled the offside flag.',
  ].join('\n');
  const telemetry = ["25' - H - O_PB_START", "25' - H - V_PASS - (85)"].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.equal(match.opportunities[0].finalOutcome, 'OFFSIDE');
  const html = ctx.renderOppList(match);
  assert.ok(!html.includes('color:#8a9ab0'), 'an OFFSIDE opportunity must not fall back to the generic gray used for an unmapped outcome');
  assert.ok(html.includes('#c8902a'), 'an OFFSIDE opportunity must use the same amber as FOUL, matching OUT_CSS');
});

test('meta header escapes an "><img onerror=...> payload in a team name', () => {
  const ctx = loadViewerContext();
  const narrative = [
    'Minute 10',
    `Opportunity for ${XSS_IMG}.`,
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = ctx.parseMatch(telemetry, narrative, { homeTeam: XSS_IMG, awayTeam: 'Away Team' });
  const scorersHtml = ctx.renderScorersRow(ctx.buildScorers(match));
  const passSummaryHtml = ctx.buildPassSummary(match.opportunities[0]);
  assert.ok(!scorersHtml.includes('onerror=alert(1)>'), 'scorers row must not carry a live onerror handler');
  assert.ok(!passSummaryHtml.includes('onerror=alert(1)>'), 'pass summary (team name row) must not carry a live onerror handler');
});

test('the stats panel escapes an </span><svg onload=...> breakout payload in a scraped stat label', () => {
  const ctx = loadViewerContext();
  const stats = { [XSS_SVG_BREAKOUT]: { home: '58%', away: '42%' } };
  const html = ctx.renderStats(stats, 'Home Team', 'Away Team', []);
  assert.ok(!html.includes('<svg onload=alert(1)>'), 'raw breakout markup must not reach the stats panel');
});

test('tiredness penalty increases one point per minute from 5% to the 20% cap', () => {
  const ctx = loadViewerContext();
  assert.equal(ctx.tirednessPenalty('TIRED', 30, 30), 5);
  assert.equal(ctx.tirednessPenalty('TIRED', 30, 35), 10);
  assert.equal(ctx.tirednessPenalty('TIRED', 30, 45), 20);
  assert.equal(ctx.tirednessPenalty('TIRED', 30, 80), 20);
  assert.equal(ctx.tirednessPenalty('VERY_TIRED', 45, 45), 20);
  assert.equal(ctx.tirednessPenalty(null, null, 45), null);
  assert.match(ctx.statusDetail(null, 'TIRED', 30, 35), /🫩.*-10%/);
  assert.match(ctx.statusDetail(null, 'VERY_TIRED', 45, 45), /💤.*-20%/);
});

test('a rest break clears the tiredness minute used for the calculated penalty', () => {
  const ctx = loadViewerContext();
  const status = ctx.playerStatusAt([
    { minute: 30, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'TIRED' },
    { minute: 45, type: 'HALF_TIME' },
  ], 'Player A', 46);
  assert.equal(status.tiredness, null);
  assert.equal(status.tirednessMinute, null);
});

test('tiredness event badges use the very-tired sleep symbol and documented thresholds', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderTirednessGroup({
    player: { name: 'Player A', position: 'CM' },
    entries: [
      { minute: 30, level: 'TIRED' },
      { minute: 45, level: 'VERY_TIRED' },
    ],
  }, '#fff');
  assert.match(html, /🫩 30' \(-5%\)/);
  assert.match(html, /💤 45' \(-20%\)/);
  assert.doesNotMatch(html, /😴/);
});

test('selected-opportunity narrative separates and emphasizes phase and goal labels', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderOpportunityNarrative([
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [CM] attempted low good pass to Player B [FW]',
    'Penalty Box',
    'Goal Attempt',
    'Long Shot Goal Attempt',
    'Penalty',
    'Counter attack',
    'GOAL!',
    'Corner',
    'Free Kick',
  ], {});

  for (const label of [
    'Midfield', 'Penalty Box', 'Goal Attempt', 'Long Shot Goal Attempt',
    'Corner', 'Free Kick', 'Penalty', 'Counter attack',
  ]) {
    assert.match(html, new RegExp(`\\n\\n<span class="narrative-step-label">${label}</span>`));
  }
  assert.match(html, /<span class="narrative-goal-label">GOAL!<\/span>/);

  const page = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  assert.match(page, /\.narrative-step-label\{color:#fff;font-weight:700\}/);
  assert.match(page, /\.narrative-goal-label\{color:#e8c468;font-weight:700\}/);
});

test('player statistics render separate home and away tables with requested columns', () => {
  const ctx = loadViewerContext();
  const match = {
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team' },
    playerRegistry: {
      'Home Player': { team: 'Home Team', side: 'home', positions: ['CM'] },
      'Away Keeper': { team: 'Away Team', side: 'away', positions: ['GK'] },
      'Away Defender': { team: 'Away Team', side: 'away', positions: ['CB'] },
    },
    opportunities: [{ minute: 15, steps: [
      { stepType: 'PB_PASS', from: { name: 'Home Passer', position: 'RM' },
        to: { name: 'Home Player', position: 'CM' }, attackingTeam: 'Home Team', attackingSide: 'home' },
      { stepType: 'PB_DUEL', attacker: { name: 'Home Player', position: 'CM' },
        defender: { name: 'Away Defender', position: 'CB' }, fouler: { name: 'Away Defender', position: 'CB' },
        yellowCard: { name: 'Away Defender', position: 'CB' }, defendingTeam: 'Away Team',
        defendingSide: 'away', outcome: 'WON', values: {} },
      { stepType: 'SHOT', shooter: { name: 'Home Player', position: 'CM' },
      gk: { name: 'Away Keeper', position: 'GK' }, attackingTeam: 'Home Team', attackingSide: 'home',
      defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'SAVED',
    }] }],
    tacticalEvents: [
      { type: 'TIREDNESS', minute: 35, sequence: 35, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Player', position: 'CM' }, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 43, sequence: 43, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Player', position: 'CM' }, level: 'VERY_TIRED' },
      { type: 'HALF_TIME', minute: 45, sequence: 45 },
      { type: 'INJURY', minute: 65, sequence: 65, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Player', position: 'CM' }, severity: 'LIGHT' },
      { type: 'TIREDNESS', minute: 70, sequence: 70, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Player', position: 'CM' }, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 82, sequence: 82, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Player', position: 'CM' }, level: 'VERY_TIRED' },
      { type: 'SUBSTITUTION', minute: 85, sequence: 85, team: 'Home Team', teamSide: 'home',
        playerOut: { name: 'Home Player', position: 'CM' }, playerIn: { name: 'Home Sub', position: 'CM' } },
    ],
  };
  const html = ctx.renderStats({}, 'Home Team', 'Away Team', match.opportunities, match);
  assert.match(html, /Player Statistics/);
  assert.match(html, /Home Team/);
  assert.match(html, /Away Team/);
  assert.match(html, /Minutes played/);
  assert.match(html, /Interceptions/);
  assert.match(html, /Shots faced/);
  assert.match(html, /Passes \(completed\)/);
  assert.match(html, /Pass %/);
  assert.match(html, /On target/);
  assert.match(html, /Fouls/);
  assert.match(html, /Very tired \(min\)/);
  assert.match(html, /Away Keeper/);
  assert.match(html, /Home Player <span class="player-position">\[CM\]<\/span>/);
  assert.match(html, /<th[^>]*>Duels<\/th>/);
  assert.match(html, /Won \(Pos\/Ctrl\/Tack\)/);
  assert.match(html, />1\/0\/0</, 'Home Player won the one duel on positioning alone (no tackle value present)');
  assert.doesNotMatch(html, /<th>Pos<\/th>/);
  assert.match(html, /1 \(1\)/);
  assert.match(html, /100%/);
  assert.match(html, /35', 70'/);
  assert.match(html, /43', 82'/);
  assert.match(html, /🟨 15'/);
  assert.match(html, /🩹 Light 65'/);
  assert.match(html, /player-substitute/);
  assert.match(html, /↳<\/span>Home Sub <span class="player-position">\[CM\]<\/span> <span class="sub-minute">85'/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility with old storage.local scrape objects
// ─────────────────────────────────────────────────────────────────────────────
// Fields like validation, sequence, tacticalContext, and tactical phases only ever
// exist on the FRESHLY-COMPUTED match model — none of those were ever part of what gets
// PERSISTED to storage.local (the persisted shape is scraper.js's own
// {narrative, telemetry, homeTeam, awayTeam, statistics, errors, warnings, scrapedAt}
// output; parseMatch() rebuilds the whole match model fresh from stored narrative/
// telemetry text on every load). These tests still exist because that's an invariant
// worth protecting explicitly, not just an accident of the current implementation.

test('render() does not throw on a minimal old-format scrape object with no errors/warnings/statistics/scrapedAt', () => {
  const ctx = loadViewerContext();
  const oldScrape = {
    narrative: [
      'Minute 10', 'Opportunity for Home Team.', 'Midfield',
      'Player A [RB] attempted low good pass to Player B [CM]',
      'Player C [DM] got decent assistance, and was in decent position.',
      'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
      'Player C [DM] cleared the ball to safety.',
    ].join('\n'),
    telemetry: null,
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    // Deliberately no errors/warnings/statistics/ok/scrapedAt/schemaVersion fields.
  };
  assert.doesNotThrow(() => ctx.render(oldScrape));
});

test('render() does not throw on a completely empty stored object', () => {
  const ctx = loadViewerContext();
  assert.doesNotThrow(() => ctx.render({}));
});

test('render() does not throw on malformed narrative text that never resolves an opportunity', () => {
  const ctx = loadViewerContext();
  assert.doesNotThrow(() => ctx.render({ narrative: 'this is not really a FinalWhistle report at all' }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-panel error isolation
// ─────────────────────────────────────────────────────────────────────────────

// loadViewerContext()'s stub document.getElementById returns a fresh throwaway element
// on every call, which is fine for tests that only check a render FUNCTION's return
// value — but this test needs to verify what render() actually WROTE into specific
// panels by id, so it needs the same element object back on every $('panel-x') call.
function loadViewerContextWithStableElements() {
  const src = fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8');
  const utilsSrc = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
  const analyticsSrc = fs.readFileSync(path.join(__dirname, 'analytics.js'), 'utf8');
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubElement());
    return elements.get(id);
  };
  const sandbox = {
    console,
    document: {
      getElementById: getEl,
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeStubElement(); },
    },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { getURL: p => 'chrome-extension://test/' + p, sendMessage: async () => ({}) },
      tabs: { query: async () => [], update: async () => {}, create: async () => {} },
      windows: { update: async () => {} },
    },
    location: { search: '' },
    URLSearchParams,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(utilsSrc, context, { filename: 'utils.js' });
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(analyticsSrc, context, { filename: 'analytics.js' });
  vm.runInContext(src, context, { filename: 'viewer.js' });
  return { context, elements };
}

test('a throwing Analysis panel degrades locally and does not blank out Stats/Squad/Pitch', () => {
  const { context: ctx, elements } = loadViewerContextWithStableElements();
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');

  // Simulate a genuine bug in renderAnalysisTab — any exception, not a data problem.
  ctx.renderAnalysisTab = () => { throw new Error('boom'); };

  assert.doesNotThrow(() => ctx.render({ narrative, telemetry, homeTeam: 'Home Team', awayTeam: 'Away Team' }));

  const analysisHtml = elements.get('panel-analysis').innerHTML;
  assert.ok(analysisHtml.includes('Analysis unavailable'), 'the failing panel should show a local, labeled message');
  assert.ok(analysisHtml.includes('boom'), 'the actual error message should be visible (escaped), not swallowed');

  // Stats/Squad must still have rendered normally — the Analysis failure must not have
  // stopped render() from reaching them.
  const statsHtml = elements.get('panel-stats').innerHTML;
  const squadHtml = elements.get('panel-squad').innerHTML;
  assert.ok(statsHtml && !statsHtml.includes('unavailable'), 'Stats panel must render normally');
  assert.ok(squadHtml && squadHtml.includes('Tactical Phases'), 'Squad panel must render normally');

  // Opportunities list is core, not one of the isolated panels — it must also still work.
  const oppListHtml = elements.get('opp-list').innerHTML;
  assert.ok(oppListHtml.includes('opp-row'), 'the opportunity list must still have rendered');
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — JPG SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

test('escapeXmlText strips XML 1.0-invalid code points and escapes every delimiter', () => {
  const ctx = loadViewerContext();
  assert.equal(ctx.escapeXmlText(`<tag> & "quoted" 'apos'`), '&lt;tag&gt; &amp; &quot;quoted&quot; &apos;apos&apos;');
  // \x00 (a raw control character) is not a valid XML 1.0 character at all — an SVG
  // parser can choke on it even though it'd pass right through escapeHtml() for HTML.
  assert.equal(ctx.escapeXmlText('a\x00b'), 'ab');
  assert.equal(ctx.escapeXmlText(null), '');
  assert.equal(ctx.escapeXmlText(undefined), '');
});

test('truncateDisplay caps at maxChars (ellipsis included) and never exceeds the hard ceiling', () => {
  const ctx = loadViewerContext();
  assert.equal(ctx.truncateDisplay('hello', 10), 'hello');
  assert.equal(ctx.truncateDisplay('hello world', 8), 'hello w…');
  // EXPORT_MAX_DISPLAY_CHARS is a top-level `const` in viewer.js, so (unlike its function
  // declarations) it never attaches to the sandbox object as ctx.EXPORT_MAX_DISPLAY_CHARS
  // — read it via runInContext instead (same gotcha as background.test.js's SCRAPE_LIMITS).
  const maxDisplayChars = vm.runInContext('EXPORT_MAX_DISPLAY_CHARS', ctx);
  assert.equal(ctx.truncateDisplay('x'.repeat(500), 500).length, maxDisplayChars, 'a huge maxChars request is still capped at the hard ceiling');
  assert.equal(ctx.truncateDisplay('hi', -1), '');
});

test('buildExportFilename extracts a match id from a /match/<id> URL and falls back to a timestamp otherwise', () => {
  const ctx = loadViewerContext();
  assert.equal(
    ctx.buildExportFilename('https://www.finalwhistle.org/en/match/abc-123/', 'full-view', 1700000000000),
    'finalwhistle-match-abc-123-full-view.jpg',
  );
  assert.equal(
    ctx.buildExportFilename('https://www.finalwhistle.org/en/match/abc-123', 'overview', 1700000000000),
    'finalwhistle-match-abc-123-overview.jpg',
  );
  assert.equal(
    ctx.buildExportFilename('https://www.finalwhistle.org/en/match/abc-123', 'possession', 1700000000000, 0),
    'finalwhistle-match-abc-123-possession-001.jpg',
  );
  // A URL that doesn't loosely match the /match/ convention (or no URL at all) must
  // still produce a usable filename rather than throwing — graceful degradation, not
  // the fork's INVALID_MATCH_URL rejection.
  assert.equal(
    ctx.buildExportFilename('not a url', 'full-view', 1700000000000),
    'finalwhistle-match-unknown-1700000000000-full-view.jpg',
  );
  assert.equal(
    ctx.buildExportFilename(undefined, 'full-view', undefined).startsWith('finalwhistle-match-unknown-'),
    true,
  );
  // An out-of-range/missing possessionIndex on a 'possession' scope degrades to the
  // full-view filename shape rather than throwing.
  assert.equal(
    ctx.buildExportFilename('https://www.finalwhistle.org/en/match/abc-123', 'possession', 1700000000000, null),
    'finalwhistle-match-abc-123-full-view.jpg',
  );
});

// Same narrative/telemetry as "a throwing Analysis panel..." above — already proven to
// parse into a single clean opportunity and render every panel without error, so export
// tests exercise real _match/_hFlowData/_aFlowData state instead of a one-off fixture.
function renderSampleMatch(ctx, overrides = {}) {
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  ctx.render({
    narrative, telemetry, homeTeam: 'Home Team', awayTeam: 'Away Team',
    url: 'https://www.finalwhistle.org/en/match/sample-uuid/', scrapedAt: 1700000000000,
    ...overrides,
  });
}

function assertWellFormedExportSvg(svg, width, height) {
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes(`width="${width}"`));
  assert.ok(svg.includes(`height="${height}"`));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(/<(?:foreignObject|image)\b/i.test(svg), false, 'export SVG must never embed a raster image or foreignObject');
  assert.equal(/<(?!svg\b)[^>]+\b(?:xlink:)?href\s*=/i.test(svg), false, 'export SVG must never reference an external resource via href');
}

test('buildExportSvg throws NO_EXPORTABLE_MATCH before anything has been scraped', () => {
  const ctx = loadViewerContext();
  assert.throws(() => ctx.buildExportSvg('full-view'), /NO_EXPORTABLE_MATCH/);
});

test('buildExportSvg("possession") throws NO_PINNED_POSSESSION when nothing is pinned', () => {
  const ctx = loadViewerContext();
  renderSampleMatch(ctx);
  ctx.getPinnedIdx = () => null;
  assert.throws(() => ctx.buildExportSvg('possession'), /NO_PINNED_POSSESSION/);
});

test('buildExportSvg builds a well-formed, self-contained SVG for each of the 3 scopes', () => {
  const ctx = loadViewerContext();
  renderSampleMatch(ctx);
  ctx.getPinnedIdx = () => 0; // pin the only opportunity

  const fullView = ctx.buildExportSvg('full-view');
  assertWellFormedExportSvg(fullView, 1920, 1080);
  assert.ok(fullView.includes('Away Team'), 'team names should appear in the full-view export');
  assert.ok(fullView.includes('PINNED POSSESSION 1'), 'the pinned possession should be labeled 1-based');

  const possession = ctx.buildExportSvg('possession');
  assertWellFormedExportSvg(possession, 1600, 1200);
  assert.ok(possession.includes('PINNED POSSESSION'));

  const overview = ctx.buildExportSvg('overview');
  assertWellFormedExportSvg(overview, 1600, 1200);
  assert.ok(overview.includes('MATCH OVERVIEW'));
  assert.ok(overview.includes('Whole-match overview'));
});

test('buildExportSvg escapes a malicious team name instead of injecting it into the SVG', () => {
  const ctx = loadViewerContext();
  renderSampleMatch(ctx);
  ctx.getPinnedIdx = () => null;
  // Mutate the already-parsed match's team name directly, the same way a hostile
  // FinalWhistle page's own team-name element could reach this data — exercises the
  // export SVG's escaping path without relying on the parser's own team-name matching.
  // _match is a top-level `let` in viewer.js, so (like SCRAPE_LIMITS in
  // background.test.js) it never attaches to the sandbox as ctx._match — read the live
  // object reference via runInContext instead, then mutate it in place.
  vm.runInContext('_match', ctx).meta.homeTeam = `Evil"/><script>alert(1)</script>`;
  const svg = ctx.buildExportSvg('overview');
  assert.equal(svg.includes('<script>'), false, 'the raw tag must not survive escaping into the export SVG');
  assert.ok(svg.includes('&lt;script&gt;'), 'it should appear escaped instead');
});

test('createExportJpeg and saveJpg exist as functions — actual canvas/Image rasterization is browser-only and is verified manually, not in Node', () => {
  const ctx = loadViewerContext();
  assert.equal(typeof ctx.createExportJpeg, 'function');
  assert.equal(typeof ctx.saveJpg, 'function');
});

test('duel detail splits attacker (Rec) from defender (Ast/Pos/Tack) and shows dashed Tack plus a positioning-win tooltip when positioning alone decided it', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderStepDetail({
    minute: 1,
    steps: [{
      stepType: 'MID_DUEL',
      attacker: { name: 'Nicolai Bakkely', position: 'RM' },
      defender: { name: 'Julio Manuel Wu', position: 'LW' },
      positioning: 'out of position',
      outcome: 'POSSESSION',
      values: { reception: { value: 60, label: 'good' }, assistance: { value: 85, label: 'superb' }, tackle: null },
    }],
  });
  assert.match(html, /class="split-off"[^]*?Rec:[^]*?60/, 'Rec must be on the offense (left) side');
  assert.match(html, /class="split-def"[^]*?Ast:[^]*?85/, 'Ast must be on the defense (right) side, not with Rec');
  assert.match(html, /Pos:<\/span><span class="val-word">out of position/, 'positioning phrase must render labeled as Pos:');
  assert.match(html, /Tack:<\/span><span class="val-num">—/, 'no tackle occurred, so Tack must show a dash, not vanish');
  assert.match(html, /title="Won on positioning"/);
  assert.doesNotMatch(html, /grp-lbl|>OFF<|>DEF</, 'no separate OFF/DEF text label — left/right position already conveys it');
  assert.match(html, /class="split-off"><span class="p-nm">Bakkely/, 'attacker name must use the same prominent p-nm\\/p-pos styling as every other row');
});

test('duel detail shows a real Tack value and a tackle-win tooltip when a control phase actually occurred', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderStepDetail({
    minute: 10,
    steps: [{
      stepType: 'PB_DUEL',
      attacker: { name: 'Naor Tsur', position: 'FW' },
      defender: { name: 'Arad Golan', position: 'CB' },
      positioning: 'ready',
      outcome: 'WON',
      values: { reception: { value: 70, label: 'good' }, assistance: { value: 50, label: 'decent' }, tackle: { value: 30, label: 'weak' } },
    }],
  });
  assert.match(html, /Pos:<\/span><span class="val-word">ready/);
  assert.match(html, /Tack:<\/span><span class="val-num" style="color:[^"]*">30/, 'a real tackle value must render normally, not dashed');
  assert.doesNotMatch(html, /Tack:<\/span><span class="val-num">—/);
  assert.match(html, /title="Won on tackle"/);
});

test('duel detail omits the outcome tooltip entirely when the defense won the duel', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderStepDetail({
    minute: 20,
    steps: [{
      stepType: 'MID_DUEL',
      attacker: { name: 'Player A', position: 'FW' },
      defender: { name: 'Player B', position: 'CB' },
      positioning: 'in decent position',
      outcome: 'CLEARED',
      values: { reception: { value: 40, label: 'weak' }, assistance: { value: 70, label: 'good' }, tackle: { value: 65, label: 'good' } },
    }],
  });
  assert.doesNotMatch(html, /title="Won on/);
});

test('shot detail splits shooter (Sh) from goalkeeper (Sa/Pos), attributing shot-context flags to the offense block', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderStepDetail({
    minute: 51,
    steps: [{
      stepType: 'SHOT',
      shooter: { name: 'Gniewosz Ryszawa', position: 'FW' },
      gk: { name: 'Vít Šafařík', position: 'GK' },
      gkPositioning: 'totally in the wrong position',
      oneOnOne: true,
      outcome: 'GOAL',
      values: { shot: { value: 85, label: 'excellent' }, gkSave: { value: 20, label: 'awful' } },
    }],
  });
  assert.match(html, /class="split-off"[^]*?1v1[^]*?Sh:[^]*?85/, 'shot flags and Sh must be on the offense (left) side with the shooter');
  assert.match(html, /class="split-def"[^]*?Sa:[^]*?20/, 'Sa must be on the defense (right) side with the goalkeeper');
  assert.match(html, /Pos:<\/span><span class="val-word">totally in the wrong position/);
});

test('shot detail preserves weak, poor, and good angle labels', () => {
  const ctx = loadViewerContext();
  const renderAngle = shotAngle => ctx.renderStepDetail({
    minute: 73,
    steps: [{
      stepType: 'SHOT',
      shooter: { name: 'Player A', position: 'FW' },
      gk: { name: 'Player B', position: 'GK' },
      shotAngle,
      values: {},
    }],
  });

  assert.match(renderAngle('weak'), />weak angle</);
  assert.match(renderAngle('poor'), />poor angle</);
  assert.match(renderAngle('good'), />good angle</);
  assert.doesNotMatch(renderAngle('poor'), />weak angle</);
});

test('a pass made under pressure is labeled rushed in step detail', () => {
  const ctx = loadViewerContext();
  const html = ctx.renderStepDetail({
    minute: 88,
    steps: [{
      stepType: 'PB_PASS',
      from: { name: 'John Lomholt', position: 'LW' },
      to: { name: 'Jakov Ponjarac', position: 'FW' },
      passerUnderPressure: { name: 'John Lomholt', position: 'LW' },
      values: { pass: { value: 65 } },
    }],
  });
  assert.match(html, />rushed</);
});
