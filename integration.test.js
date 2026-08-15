'use strict';
// End-to-end parser → analytics integration tests.
//
// parser.test.js and analytics.test.js each test ONE layer in isolation with
// hand-built fixtures. That leaves a real gap: a parser change can keep every
// parser.test.js assertion green while silently reinterpreting a field analytics.js
// depends on (e.g. renaming an outcome string, or changing what `attackingSide` means
// after a CA boundary) — analytics.js would then compute something subtly wrong while
// its OWN unit tests (built on the same, now-stale assumptions) keep passing too.
//
// These tests read fixtures/ (see fixtures/README.md for scenario/provenance details),
// run the full fixture → parseMatch() → analytics.js path, and check two kinds of
// things:
//   1. the small invariant facts recorded in each fixture's expected.json, computed
//      here independently of analytics.js (directly off match.opportunities/steps) —
//      so a bug in analytics.js's OWN counting logic doesn't cancel out against an
//      equally-wrong expectation baked into the same code path;
//   2. targeted CONTRACTS between the layers (tactical phase IDs vs. opportunity
//      context, counter-attack step ownership, validation-confidence propagation) rather
//      than re-testing every unit already covered in parser.test.js/analytics.test.js.
//
// Run with:  node --test integration.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMatch } = require('./parser.js');
const A = require('./analytics.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SHOT_TYPES = ['SHOT', 'FK_SHOT'];

function loadFixture(name) {
  const dir = path.join(FIXTURES_DIR, name);
  const narrative = fs.readFileSync(path.join(dir, 'narrative.txt'), 'utf8');
  const telemetry = fs.readFileSync(path.join(dir, 'telemetry.txt'), 'utf8');
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  return { narrative, telemetry, expected };
}

function fixtureNames() {
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => fs.statSync(path.join(FIXTURES_DIR, f)).isDirectory());
}

function parseFixture(name) {
  const fixture = loadFixture(name);
  const { narrative, telemetry, expected } = fixture;
  return {
    ...fixture,
    match: parseMatch(telemetry, narrative, {
      homeTeam: expected.homeTeam || 'Home Team',
      awayTeam: expected.awayTeam || 'Away Team',
    }),
  };
}

// Independent of analytics.js on purpose (see file header) — computed directly off the
// parser's own step model, the same way expected.json's values were originally derived.
function countShots(match, side) {
  return match.opportunities.reduce((n, o) =>
    n + o.steps.filter(s => SHOT_TYPES.includes(s.stepType) && (s.attackingSide || o.teamSide) === side).length, 0);
}
function countGoals(match, side) {
  return match.opportunities.reduce((n, o) =>
    n + o.steps.filter(s => SHOT_TYPES.includes(s.stepType) && s.outcome === 'GOAL' && (s.attackingSide || o.teamSide) === side).length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: every fixture's expected.json invariants, independently recomputed
// ─────────────────────────────────────────────────────────────────────────────

for (const name of fixtureNames()) {
  test(`fixture "${name}": expected.json invariants hold end-to-end`, () => {
    const { expected, match } = parseFixture(name);
    const ca = A.counterAttackAnalysis(match);

    assert.equal(match.opportunities.length, expected.opportunities, 'opportunities');
    assert.equal(match.opportunities.filter(o => o.teamSide === 'home').length, expected.homeOpportunities, 'homeOpportunities');
    assert.equal(match.opportunities.filter(o => o.teamSide === 'away').length, expected.awayOpportunities, 'awayOpportunities');
    assert.equal(countShots(match, 'home'), expected.homeShots, 'homeShots');
    assert.equal(countShots(match, 'away'), expected.awayShots, 'awayShots');
    assert.equal(countGoals(match, 'home'), expected.homeGoals, 'homeGoals');
    assert.equal(countGoals(match, 'away'), expected.awayGoals, 'awayGoals');
    assert.equal(ca.home.created, expected.counterAttacksCreatedHome, 'counterAttacksCreatedHome');
    assert.equal(ca.away.created, expected.counterAttacksCreatedAway, 'counterAttacksCreatedAway');
    assert.equal(match.tacticalEvents.length, expected.tacticalEventCount, 'tacticalEventCount');
    assert.equal(match.tacticalPhases.home.length, expected.homeTacticalPhases, 'homeTacticalPhases');
    assert.equal(match.tacticalPhases.away.length, expected.awayTacticalPhases, 'awayTacticalPhases');
    assert.equal(match.validation.confidence, expected.validationConfidence, 'validationConfidence');
    assert.equal(match.warnings.length, expected.warnings, 'warnings');

    // shotProfileAnalysis sums shots per TYPE, not per opportunity — reconciling its
    // total against the same independently-counted figure is itself a parser↔analytics
    // contract check: if analytics.js's own shot-counting ever silently diverges from
    // the raw step model (e.g. double-counting a rebound, or missing a CA-flipped shot),
    // this catches it even though both this test and analytics.test.js could otherwise
    // each look internally consistent on their own.
    const shotProfile = A.shotProfileAnalysis(match);
    const sumAttempts = side => Object.values(shotProfile[side]).reduce((n, t) => n + (t.attempts || 0), 0);
    assert.equal(sumAttempts('home'), expected.homeShots, 'shotProfileAnalysis home total must reconcile with the raw step count');
    assert.equal(sumAttempts('away'), expected.awayShots, 'shotProfileAnalysis away total must reconcile with the raw step count');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Targeted layer contracts (not duplicating per-fixture unit coverage)
// ─────────────────────────────────────────────────────────────────────────────

test('contract: every opportunity\'s tacticalContext phase id exists in match.tacticalPhases for that side', () => {
  // Catches tactical phase IDs silently drifting out of sync with opportunity context
  // (e.g. buildTacticalPhases and phaseIdAt disagreeing after an independent change to
  // either one).
  for (const name of fixtureNames()) {
    const { match } = parseFixture(name);
    const homeIds = new Set(match.tacticalPhases.home.map(p => p.id));
    const awayIds = new Set(match.tacticalPhases.away.map(p => p.id));
    for (const opp of match.opportunities) {
      assert.ok(homeIds.has(opp.tacticalContext.homePhaseId), `${name}: opportunity at ${opp.minute}' has an unknown homePhaseId`);
      assert.ok(awayIds.has(opp.tacticalContext.awayPhaseId), `${name}: opportunity at ${opp.minute}' has an unknown awayPhaseId`);
    }
  }
});

test('contract: tactical-phase-transition opportunities land in the correct phase before/after the mentality change', () => {
  const { narrative, telemetry } = loadFixture('tactical-phase-transition');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.equal(match.opportunities.length, 2);
  const [before, after] = match.opportunities;
  assert.equal(before.tacticalContext.homePhaseId, match.tacticalPhases.home[0].id);
  assert.equal(after.tacticalContext.homePhaseId, match.tacticalPhases.home[1].id);
  assert.notEqual(before.tacticalContext.homePhaseId, after.tacticalContext.homePhaseId);

  const perf = A.phasePerformance(match, 'home');
  assert.equal(perf[0].ownOpportunities, 1);
  assert.equal(perf[1].ownOpportunities, 1);

  // Before-after contract: comparing around the mentality-change event must not
  // throw and must report the same 1-vs-1 split, labeled as an association.
  const event = match.tacticalEvents.find(e => e.type === 'MENTALITY_CHANGE');
  const cmp = A.compareAroundEvent(match, event.id, { beforeMinutes: 90, afterMinutes: 90 });
  assert.equal(cmp.before.opportunities, 1);
  assert.equal(cmp.after.opportunities, 1);
  assert.match(cmp.label, /association/);
});

test('contract: counter-attack step ownership survives the full parser→analytics path', () => {
  const { narrative, telemetry } = loadFixture('counter-attack');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const opp = match.opportunities[0];
  // Parser-level fact: the opportunity is nominally Home's, but the actual scoring step
  // belongs to Away (the counter-attacking side) — this must not get collapsed anywhere
  // downstream into "it's Home's opportunity, so it's Home's goal".
  assert.equal(opp.teamSide, 'home');
  const goalStep = opp.steps.find(s => s.outcome === 'GOAL');
  assert.equal(goalStep.attackingSide, 'away');

  // Analytics-level facts must agree with that, not with opp.teamSide.
  assert.equal(A.counterAttackAnalysis(match).away.goals, 1);
  assert.equal(A.counterAttackAnalysis(match).home.goalsConceded, 1);
  const chain = A.defensiveFailureChains(match)[0];
  assert.equal(chain.attackingSide, 'away');
  assert.equal(chain.defendingSide, 'home');
});

test('contract: degraded parser validation propagates through every analytics confidence field exercised here', () => {
  const { narrative, telemetry } = loadFixture('degraded-alignment');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.equal(match.validation.confidence, 'degraded');
  assert.equal(A.parserConfidence(match), 'degraded');
  assert.equal(A.opportunityFunnel(match).confidence, 'degraded');
  assert.equal(A.assistanceAnalysis(match).confidence, 'degraded');
  assert.equal(A.phasePerformance(match, 'home')[0].confidence, 'degraded');
});

test('contract: a team with zero opportunities still gets consistent tactical phases and PB-entry counting', () => {
  const { narrative, telemetry } = loadFixture('zero-opportunities-team');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.equal(match.opportunities.filter(o => o.teamSide === 'away').length, 0);
  assert.equal(match.tacticalPhases.away.length, 2, 'kickoff phase + the mentality change');
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.away.total, 0);
  assert.equal(funnel.away.reachedPenaltyBox, 0);
});

test('contract: set-piece step types map to the correct analytics category', () => {
  for (const [fixture, category] of [
    ['corner', 'corner'],
    ['delivered-free-kick', 'deliveredFreeKick'],
    ['direct-free-kick', 'directFreeKick'],
  ]) {
    const { narrative, telemetry } = loadFixture(fixture);
    const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
    const sp = A.setPieceAnalysis(match);
    assert.equal(sp[category].home.attempts, 1, `${fixture} should register one attempt under ${category}`);
  }
});

test('contract: a fumble recorded by the parser is visible in goalkeeper analytics', () => {
  const { narrative, telemetry } = loadFixture('save-fumble-rebound');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Player G'];
  assert.ok(gk, 'expected Player G to appear in goalkeeper analytics');
  assert.equal(gk.fumbles, 1);
  assert.equal(gk.shotsFaced, 1, 'only the fumbled shot named a GK — the rebound goal had none');
});

test('contract: same-minute tactical changes are all reflected in the following opportunity\'s tactical state', () => {
  const { narrative, telemetry } = loadFixture('same-minute-tactical-events');
  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  const opp = match.opportunities[0];
  const phase = match.tacticalPhases.home.find(p => p.id === opp.tacticalContext.homePhaseId);
  assert.equal(phase.state.teamState.mentality, 'ATTACKING');
  assert.equal(phase.state.players['Player X'].position, 'LM');
  assert.equal(phase.state.players['Player Y'].onPitch, false);
  assert.equal(phase.state.players['Player Z'].onPitch, true);
});

test('observed rebound: counter-attack fumble then saved lob stays two aligned away shots', () => {
  const { match } = parseFixture('rebound-second-shot-save');
  const opp = match.opportunities[0];
  const shots = opp.steps.filter(s => s.stepType === 'SHOT');
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map(s => [s.shooter.name, s.gk.name, s.outcome, s.values.shot.value, s.values.gkSave.value]), [
    ['Marin Burgă', 'Vlastimil Šindelář', 'FUMBLED', 85, 85],
    ['Ceferino Hinojosa', 'Vlastimil Šindelář', 'SAVED', 75, 65],
  ]);
  assert.equal(shots[0].looseBallRecovery.name, 'Ceferino Hinojosa');
  assert.equal(shots[0].looseBallRecovery.side, 'away');
  assert.equal(shots[1].shotType, 'lob');
  assert.deepEqual(shots.map(s => s.attackingSide), ['away', 'away']);
  assert.equal(A.opportunityFunnel(match).entries[0].shotCount, 2);
  assert.equal(A.counterAttackAnalysis(match).away.shots, 2);
  assert.equal(A.counterAttackAnalysis(match).home.shotsConceded, 2);
  assert.equal(A.phasePerformance(match, 'home')[0].opponentShots, 2);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Vlastimil Šindelář'];
  assert.equal(gk.shotsFaced, 2);
  assert.equal(gk.fumbles, 1);
  assert.equal(gk.saves, 1);
  assert.equal(A.playerInvolvementChains(match).terminators['Ceferino Hinojosa'].side, 'away');
  assert.equal(match.validation.confidence, 'exact');
  assert.equal(match.warnings.length, 0);
});

test('observed rebound: fumble then post preserves both home shooters and telemetry values', () => {
  const { match, narrative, telemetry, expected } = parseFixture('rebound-second-shot-post');
  const opp = match.opportunities[0];
  const shots = opp.steps.filter(s => s.stepType === 'SHOT');
  assert.deepEqual(shots.map(s => [s.shooter.name, s.outcome, s.values.shot.value, s.values.gkSave.value]), [
    ['Colby Carson', 'FUMBLED', 30, 65],
    ['Manuel Antonio Saslavsky', 'POST', 20, 55],
  ]);
  assert.equal(shots[0].looseBallRecovery.name, 'Manuel Antonio Saslavsky');
  assert.match(opp.rawLines.join('\n'), /Colby Carson \[FW\] has a good angle\./,
    'the existing positive-angle semantics preserve the source line without inventing a numeric angle');
  assert.deepEqual(shots.map(s => s.attackingSide), ['home', 'home']);
  assert.equal(A.opportunityFunnel(match).entries[0].shotCount, 2);
  assert.equal(A.goalkeeperAnalysis(match).byGoalkeeper['Dan Kubelka'].shotsFaced, 2);
  assert.equal(match.validation.phaseMismatches.length, 0);

  const augmented = parseMatch(telemetry, [
    'Minute 90', 'FC Lions Pouchov - Colby Carson [FW] looks tired.',
    narrative, 'Minute 90', 'The referee blew the final whistle.',
  ].join('\n'), { homeTeam: expected.homeTeam, awayTeam: expected.awayTeam });
  assert.equal(augmented.tacticalEvents.filter(e => e.type === 'TIREDNESS').length, 1);
  assert.equal(augmented.tacticalEvents.find(e => e.type === 'TIREDNESS').level, 'TIRED');
  assert.equal(augmented.validation.unknownNarrativeLines.length, 0,
    'the adjacent tiredness and final-whistle lines remain recognized admin text');
});

test('observed rebound: second fumble recovery and clearance remain aftermath, not a third shot', () => {
  const { match } = parseFixture('rebound-second-shot-clearance');
  const opp = match.opportunities[0];
  const shots = opp.steps.filter(s => s.stepType === 'SHOT');
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map(s => [s.shooter.name, s.outcome, s.looseBallRecovery.name]), [
    ['Petrică Certejan', 'FUMBLED', 'Richárd Rejtő'],
    ['Richárd Rejtő', 'FUMBLED', 'Eusebio Caruso'],
  ]);
  assert.equal(shots[1].looseBallRecovery.side, 'away');
  assert.equal(shots[1].looseBallResolution, 'CLEARED');
  assert.match(opp.rawLines.join('\n'), /Eusebio Caruso \[LB\] cleared the ball to safety\./);
  assert.equal(A.opportunityFunnel(match).entries[0].shotCount, 2);
  assert.equal(A.goalkeeperAnalysis(match).byGoalkeeper['Julio César Sáenz Peña'].fumbles, 2);
  assert.equal(match.validation.confidence, 'exact');
});
