'use strict';
// Regression tests for parser.js's narrative+telemetry merge logic. No test framework
// dependency — Node's built-in test runner covers this project's needs without adding
// a devDependency to a zero-build-step browser extension.
//
// Run with:  node --test parser.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch, tacticalStateAt, buildTacticalPhases, phaseIdAt, deriveFormation } = require('./parser.js');

function stepTypes(opp) { return opp.steps.map(s => s.stepType); }
function outcomeOf(opp, stepType) { return opp.steps.find(s => s.stepType === stepType)?.outcome; }

test('basic chain: MID win -> PB win -> shot -> goal', () => {
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [CM] got weak assistance, and was close.',
    'Player B [CM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player F [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START",
    "10' - H - V_PASS - (65)",
    "10' - A - V_ASSISTANCE - (30)",
    "10' - H - V_RECEPTION - (75)",
    "10' - H - V_PASS - (55)",
    "10' - A - V_ASSISTANCE - (60)",
    "10' - H - V_RECEPTION - (65)",
    "10' - A - V_TACKLING - (35)",
    "10' - H - V_SHOT - (80)",
    "10' - A - V_REFLEX - (20)",
    "10' - H - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  assert.equal(match.opportunities.length, 1);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['START_PASS', 'MID_DUEL', 'PB_PASS', 'PB_DUEL', 'SHOT']);
  assert.equal(opp.hasGoal, true);
  assert.equal(outcomeOf(opp, 'SHOT'), 'GOAL');
});

test('cleared at midfield: no PB phase, no shot', () => {
  const narrative = [
    'Minute 5',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [LB] attempted low weak pass to Player B [LM]',
    'Player C [RM] got decent assistance, and was in decent position.',
    'Player B [LM] made weak reception, Player C [RM] made superb tackle.',
    'Player C [RM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "5' - H - O_DEF_START",
    "5' - H - V_PASS - (30)",
    "5' - A - V_ASSISTANCE - (45)",
    "5' - H - V_RECEPTION - (25)",
    "5' - A - V_TACKLING - (75)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['START_PASS', 'MID_DUEL']);
  assert.equal(outcomeOf(opp, 'MID_DUEL'), 'CLEARED');
  assert.equal(opp.hasShot, false);
  assert.equal(opp.hasGoal, false);
});

test('counter-attack: scoring side flips from the opportunity\'s starting side', () => {
  const narrative = [
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
  const telemetry = [
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

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.equal(opp.teamSide, 'home');
  assert.equal(opp.isCounterAttack, true);
  const goalStep = opp.steps.find(s => s.outcome === 'GOAL');
  assert.equal(goalStep.isCA, true);
  // The scorer belongs to the team that countered, not the team the opportunity
  // is nominally "for" — this is the exact bug fixed for the scorers header.
  assert.equal(goalStep.shooter.side, 'away');
  // Every step carries its own attackingSide/defendingSide (set by assignSides,
  // read by phaseToSteps's mk()) so viewer code never has to fall back to
  // opp.teamSide — which would be wrong for every step after the CA boundary.
  // The pre-CA duel still belongs to home; the post-CA goal step flips to away.
  const preCADuel = opp.steps.find(s => s.stepType === 'MID_DUEL' && !s.isCA);
  assert.equal(preCADuel.attackingSide, 'home');
  assert.equal(preCADuel.defendingSide, 'away');
  assert.equal(goalStep.attackingSide, 'away');
  assert.equal(goalStep.defendingSide, 'home');
});

test('long ball: PB_PASS with no preceding midfield phase, from a back position', () => {
  const narrative = [
    'Minute 20',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [LB] attempted high risky pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player G [GK] managed to get hold of the ball.',
  ].join('\n');
  const telemetry = [
    "20' - H - O_DEF_START",
    "20' - H - V_PASS - (65)",
    "20' - A - V_ASSISTANCE - (45)",
    "20' - H - V_RECEPTION - (55)",
    "20' - A - V_TACKLING - (30)",
    "20' - H - V_SHOT - (70)",
    "20' - A - V_REFLEX - (80)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['PB_PASS', 'PB_DUEL', 'SHOT']);
  assert.equal(opp.isLongBallSequence, true);
});

test('direct free-kick shot: no pass line, FK_SHOT only', () => {
  const narrative = [
    'Minute 30',
    'Opportunity for Home Team.',
    'Free Kick',
    'Player A [CM] has decided to restart the attack',
    'Player A [CM] made superb shot.',
    'Player G [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "30' - H - O_FK_START",
    "30' - H - V_SHOT - (70)",
    "30' - A - V_REFLEX - (15)",
    "30' - H - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['FK_SHOT']);
  assert.equal(outcomeOf(opp, 'FK_SHOT'), 'GOAL');
});

test('free-kick delivery: pass + duel + shot, mirroring PB shape', () => {
  const narrative = [
    'Minute 40',
    'Opportunity for Home Team.',
    'Free Kick',
    'Player A [CM] has decided to restart the attack',
    'Player A [CM] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player G [GK] managed to get hold of the ball.',
  ].join('\n');
  const telemetry = [
    "40' - H - O_FK_START",
    "40' - H - V_PASS - (60)",
    "40' - A - V_ASSISTANCE - (40)",
    "40' - H - V_RECEPTION - (55)",
    "40' - A - V_TACKLING - (35)",
    "40' - H - V_SHOT - (65)",
    "40' - A - V_REFLEX - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['FK_PASS', 'FK_DUEL', 'SHOT']);
  assert.equal(outcomeOf(opp, 'SHOT'), 'SAVED');
  assert.equal(outcomeOf(opp, 'FK_DUEL'), 'WON'); // normalized from the shot-terminal outcome
});

test('corner: pass + duel + shot, missed wide', () => {
  const narrative = [
    'Minute 50',
    'Opportunity for Home Team.',
    'Corner',
    'Player A [RW] has decided to restart the attack',
    'Player A [RW] made high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Missed the goal wide.',
  ].join('\n');
  const telemetry = [
    "50' - H - O_SP_START",
    "50' - H - V_PASS - (60)",
    "50' - A - V_ASSISTANCE - (40)",
    "50' - H - V_RECEPTION - (55)",
    "50' - A - V_TACKLING - (35)",
    "50' - H - V_SHOT - (45)",
    "50' - A - V_REFLEX - (30)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['SP_PASS', 'SP_DUEL', 'SHOT']);
  assert.equal(outcomeOf(opp, 'SHOT'), 'MISSED');
});

test('blocked pass then recovery: flush-and-restart produces two clean phases, no phantom', () => {
  const narrative = [
    'Minute 60',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'The pass was blocked by the opponent player.',
    'The ball is now free!',
    'Player C [DM] was close and took control.',
    'Player C [DM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "60' - H - O_MID_START",
    "60' - H - V_PASS - (25)",
    "60' - H - V_PASS - (55)",
    "60' - A - V_ASSISTANCE - (35)",
    "60' - H - V_RECEPTION - (60)",
    "60' - A - V_TACKLING - (40)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['START_PASS', 'MID_DUEL', 'START_PASS', 'MID_DUEL']);
  assert.equal(opp.steps[1].outcome, 'BLOCKED');
  assert.equal(opp.steps[3].outcome, 'CLEARED');
});

test('penalty: E_PENALTY_KICK tags the shot step, not the whole phase type', () => {
  const narrative = [
    'Minute 70',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [CM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player E [CB] committed a foul.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player G [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "70' - H - O_PB_START",
    "70' - H - V_PASS - (55)",
    "70' - A - V_ASSISTANCE - (40)",
    "70' - H - V_RECEPTION - (60)",
    "70' - A - V_TACKLING - (30)",
    "70' - A - E_PENALTY_KICK",
    "70' - H - V_SHOT - (75)",
    "70' - A - V_REFLEX - (20)",
    "70' - H - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0);
  const opp = match.opportunities[0];
  const shot = opp.steps.find(s => s.stepType === 'SHOT');
  assert.equal(shot.isPenalty, true);
  assert.equal(shot.outcome, 'GOAL');
});

test('phase-count mismatch between narrative and stream is surfaced as a warning', () => {
  const narrative = [
    'Minute 80',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  // Deliberately carries a second stream phase's worth of tokens with no matching
  // narrative phase, to trigger the mismatch this warning exists to catch.
  const telemetry = [
    "80' - H - O_MID_START",
    "80' - H - V_PASS - (30)",
    "80' - A - V_ASSISTANCE - (40)",
    "80' - H - V_RECEPTION - (25)",
    "80' - A - V_TACKLING - (70)",
    "80' - H - V_PASS - (50)",
    "80' - A - V_ASSISTANCE - (20)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.ok(match.warnings.some(w => w.includes('PHASE_COUNT_MISMATCH')), match.warnings.join('; '));
  // The warning is now derived from validation.phaseMismatches, not a separately-computed
  // string — check the structured diagnostic actually holds the same information.
  assert.equal(match.validation.phaseMismatches.length, 1);
  assert.equal(match.validation.phaseMismatches[0].narrativePhaseCount, 1);
  assert.equal(match.validation.phaseMismatches[0].streamPhaseCount, 2);
  assert.equal(match.validation.confidence, 'degraded');
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-match validation diagnostics
// ─────────────────────────────────────────────────────────────────────────────

test('validation reports exact confidence when narrative and telemetry counts agree', () => {
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [CM] got weak assistance, and was close.',
    'Player B [CM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player F [GK] managed to get hold of the ball.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START",
    "10' - H - V_PASS - (65)",
    "10' - A - V_ASSISTANCE - (30)",
    "10' - H - V_RECEPTION - (75)",
    "10' - H - V_PASS - (55)",
    "10' - A - V_ASSISTANCE - (60)",
    "10' - H - V_RECEPTION - (65)",
    "10' - A - V_TACKLING - (35)",
    "10' - H - V_SHOT - (70)",
    "10' - A - V_REFLEX - (80)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.validation.narrativeOpportunityCount, 1);
  assert.equal(match.validation.telemetryOpportunityCount, 1);
  assert.equal(match.validation.matchedBlocks.length, 1);
  assert.equal(match.validation.unmatchedNarrativeBlocks.length, 0);
  assert.equal(match.validation.unusedTelemetryBlocks.length, 0);
  assert.equal(match.validation.phaseMismatches.length, 0);
  assert.equal(match.validation.confidence, 'exact');
});

test('validation reports a missing telemetry block as an unmatched narrative opportunity', () => {
  const narrative = [
    'Minute 40',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const match = parseMatch('', narrative); // no telemetry at all
  assert.equal(match.validation.narrativeOpportunityCount, 1);
  assert.equal(match.validation.telemetryOpportunityCount, 0);
  assert.equal(match.validation.matchedBlocks.length, 0);
  assert.equal(match.validation.unmatchedNarrativeBlocks.length, 1);
  assert.equal(match.validation.unmatchedNarrativeBlocks[0].minute, 40);
  assert.equal(match.validation.confidence, 'degraded');
  assert.ok(match.warnings.some(w => w.includes('no matching telemetry')), match.warnings.join('; '));
});

test('validation reports an extra telemetry block that no narrative opportunity claimed', () => {
  const narrative = [
    'Minute 15',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  // A second, complete stream block at a minute the narrative never mentions at all —
  // nothing to pair it with, so it should show up as unused rather than silently vanish.
  const telemetry = [
    "15' - H - O_MID_START",
    "15' - H - V_PASS - (30)",
    "15' - A - V_ASSISTANCE - (40)",
    "15' - H - V_RECEPTION - (25)",
    "15' - A - V_TACKLING - (70)",

    "50' - A - O_MID_START",
    "50' - A - V_PASS - (40)",
    "50' - H - V_ASSISTANCE - (30)",
    "50' - A - V_RECEPTION - (35)",
    "50' - H - V_TACKLING - (60)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.validation.narrativeOpportunityCount, 1);
  assert.equal(match.validation.telemetryOpportunityCount, 2);
  assert.equal(match.validation.unusedTelemetryBlocks.length, 1);
  assert.equal(match.validation.unusedTelemetryBlocks[0].minute, 50);
  assert.equal(match.validation.confidence, 'degraded');
  assert.ok(match.warnings.some(w => w.includes('never matched a narrative opportunity')), match.warnings.join('; '));
});

test('validation captures an unrecognized telemetry line without dropping it silently', () => {
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  // A malformed/future-format line mixed in with otherwise-valid tokens — simulates
  // FinalWhistle changing or adding to its telemetry format without notice.
  const telemetry = [
    "10' - H - O_MID_START",
    "10' - H - V_PASS - (30)",
    "10' - X - V_NEW_METRIC_TYPE - (99)",
    "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)",
    "10' - A - V_TACKLING - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.validation.unknownTelemetryLines.length, 1);
  assert.ok(match.validation.unknownTelemetryLines[0].includes('V_NEW_METRIC_TYPE'));
  assert.ok(match.warnings.some(w => w.includes('unrecognized telemetry line')), match.warnings.join('; '));
});

test('validation captures an unrecognized narrative line within a phase without dropping it silently', () => {
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player B [CM] performed an unheard-of maneuver.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START",
    "10' - H - V_PASS - (30)",
    "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)",
    "10' - A - V_TACKLING - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.validation.unknownNarrativeLines.length, 1);
  assert.equal(match.validation.unknownNarrativeLines[0].line, 'Player B [CM] performed an unheard-of maneuver.');
  assert.ok(match.warnings.some(w => w.includes('unrecognized narrative line')), match.warnings.join('; '));
});

// ─────────────────────────────────────────────────────────────────────────────
// GK save/rebound handling
//
// These cases exercise the exact phrase parser.js's own regexes key off of for a
// fumble/parry vs. a controlled save. One gap: a rebound recovered by the SAME
// attacking team producing a literal second recorded shot isn't covered here —
// that continuation hasn't been confirmed against the game's actual output, so
// there's nothing solid to assert against; see the summary notes.
// ─────────────────────────────────────────────────────────────────────────────

test('GK fumble (not held) reports FUMBLED on the shot, not the recovery aftermath', () => {
  const narrative = [
    'Minute 7',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low excellent pass to Player B [LM]',
    'Player C [CM] got decent assistance, and was close.',
    'Player B [LM] made decent reception and took control of the ball.',
    'Penalty Box',
    'Player B [LM] attempted low awesome pass to Player D [FW]',
    'Player E [CB] got excellent assistance, and was in decent position.',
    'Player D [FW] made awesome reception, Player E [CB] made decent tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] has a weak angle.',
    'Player D [FW] made good shot.',
    'Player G [GK] was fooled, and made superb effort to prevent goal.',
    'Player G [GK] bounced the ball back.',
    'The ball is now free!',
    'Player F [RB] was close and took control of the ball.',
    'Player F [RB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "7' - H - O_DEF_START",
    "7' - H - V_PASS - (65)",
    "7' - A - V_ASSISTANCE - (30)",
    "7' - H - V_RECEPTION - (55)",
    "7' - H - V_PASS - (75)",
    "7' - A - V_ASSISTANCE - (65)",
    "7' - H - V_RECEPTION - (85)",
    "7' - A - V_TACKLING - (40)",
    "7' - H - V_SHOT - (55)",
    "7' - A - V_REFLEX - (75)",
    "7' - A - E_FUMBLE",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.equal(outcomeOf(opp, 'SHOT'), 'FUMBLED');
  assert.equal(outcomeOf(opp, 'PB_DUEL'), 'WON'); // the attacker still won the duel and got a shot away
  assert.equal(opp.hasShot, true);
  assert.equal(opp.finalOutcome, 'FUMBLED');
  // The recovering defender must not be lost even though the shot's own outcome takes
  // priority over the "cleared" aftermath text.
  const pbDuel = opp.steps.find(s => s.stepType === 'PB_DUEL');
  assert.equal(pbDuel.blockRecovery?.name, 'Player F');
});

test('GK fumble immediately resulting in a goal is still reported as GOAL', () => {
  const narrative = [
    'Minute 31',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [CM] attempted low brilliant pass to Player B [CM]',
    'Player C [CM] got poor assistance, and was in decent position.',
    'Player B [CM] made superb reception, Player C [CM] made decent tackle.',
    'Player B [CM] took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low excellent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made brilliant reception, Player E [CB] made good tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made excellent quick shot.',
    'Player G [GK] was hesitant, and made superb effort to prevent goal.',
    'Player G [GK] could not handle the ball.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "31' - H - O_MID_START",
    "31' - H - V_PASS - (70)",
    "31' - A - V_ASSISTANCE - (30)",
    "31' - H - V_RECEPTION - (75)",
    "31' - H - V_PASS - (65)",
    "31' - A - V_ASSISTANCE - (55)",
    "31' - H - V_RECEPTION - (85)",
    "31' - A - V_TACKLING - (55)",
    "31' - H - V_SHOT - (65)",
    "31' - A - V_REFLEX - (75)",
    "31' - A - E_GOAL",
    "31' - A - E_FUMBLE",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.equal(outcomeOf(opp, 'SHOT'), 'GOAL');
  assert.equal(opp.hasGoal, true);
});

test('GK fumble recovered and cleared behind for a corner keeps the corner', () => {
  const narrative = [
    'Minute 15',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player G [GK] was ready, and made excellent effort to prevent goal.',
    'Player G [GK] bounced the ball back.',
    'The ball is now free!',
    'Player E [CB] directed ball to corner.',
    'Corner',
    'Player H [RW] has decided to restart the attack',
    'Player H [RW] made high good pass to Player D [FW]',
    'Player I [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player I [CB] made weak tackle.',
    'Player I [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "15' - H - O_DEF_START",
    "15' - H - V_PASS - (60)",
    "15' - A - V_ASSISTANCE - (40)",
    "15' - H - V_RECEPTION - (55)",
    "15' - A - V_TACKLING - (35)",
    "15' - H - V_SHOT - (55)",
    "15' - A - V_REFLEX - (65)",
    "15' - A - E_FUMBLE",
    "15' - A - E_CORNER",
    "15' - H - V_PASS - (50)",
    "15' - A - V_ASSISTANCE - (35)",
    "15' - H - V_RECEPTION - (45)",
    "15' - A - V_TACKLING - (60)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  // The fumbled shot and the corner it produced are both preserved as distinct steps —
  // the corner is a new SP phase within the same opportunity, not a discarded event.
  // CORNER unconditionally overrides the shot outcome (same override pattern as GOAL),
  // so the final SHOT outcome is CORNER, not FUMBLED — the fumble itself is still what
  // produced the corner, it's just not the terminal outcome recorded on the step.
  assert.deepEqual(stepTypes(opp), ['PB_PASS', 'PB_DUEL', 'SHOT', 'SP_PASS', 'SP_DUEL']);
  assert.equal(outcomeOf(opp, 'SHOT'), 'CORNER');
});

test('GK gains control and the save itself launches a counter-attack', () => {
  // The GK becomes the passer of the new (isCA) phase.
  const narrative = [
    'Minute 26',
    'Opportunity for Away Team.',
    'Midfield',
    'Player A [RM] attempted low excellent pass to Player B [LM]',
    'Player C [RM] got good assistance, and was in decent position.',
    'Player B [LM] made decent reception, Player C [RM] made poor tackle.',
    'Player B [LM] took control of the ball.',
    'Penalty Box',
    'Player B [LM] attempted low awesome accurate pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made excellent reception, Player E [CB] made excellent tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] has a good angle.',
    'Player D [FW] made good shot.',
    'Player G [GK] was in perfect spot, and made excellent effort to prevent goal.',
    'Player G [GK] managed to get hold of the ball.',
    'Counter attack',
    'Midfield',
    'Player G [GK] attempted low weak pass to Player H [LM]',
    'Player I [RM] got good assistance, and was in decent position.',
    'Player H [LM] made decent reception, Player I [RM] made poor tackle.',
    'Player H [LM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "26' - A - O_MID_START",
    "26' - A - V_PASS - (65)",
    "26' - H - V_ASSISTANCE - (50)",
    "26' - A - V_RECEPTION - (45)",
    "26' - H - V_TACKLING - (28)",
    "26' - A - V_PASS - (95)",
    "26' - H - V_ASSISTANCE - (45)",
    "26' - A - V_RECEPTION - (65)",
    "26' - H - V_TACKLING - (65)",
    "26' - A - V_SHOT - (55)",
    "26' - H - V_REFLEX - (65)",
    "26' - H - E_COUNTER_ATTACK",
    "26' - H - V_PASS - (35)",
    "26' - A - V_ASSISTANCE - (55)",
    "26' - H - V_RECEPTION - (55)",
    "26' - A - V_TACKLING - (65)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.equal(opp.teamSide, 'away');
  assert.equal(opp.isCounterAttack, true);
  // Possession correctly flips to the GK's own team for the counter phase.
  const caStep = opp.steps.find(s => s.isCA && s.stepType === 'START_PASS');
  assert.equal(caStep.from.name, 'Player G');
  assert.equal(caStep.from.side, 'home');
});

// ─────────────────────────────────────────────────────────────────────────────
// Counter-attack origins
// ─────────────────────────────────────────────────────────────────────────────

test('counter-attack originating from a midfield duel loss', () => {
  const narrative = [
    'Minute 12',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Counter attack',
    'Midfield',
    'Player C [DM] attempted low good pass to Player X [FW]',
    'Player D [CM] got decent assistance, and was close.',
    'Player X [FW] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "12' - H - O_MID_START",
    "12' - H - V_PASS - (55)",
    "12' - A - V_ASSISTANCE - (40)",
    "12' - H - V_RECEPTION - (25)",
    "12' - A - V_TACKLING - (85)",
    "12' - A - E_COUNTER_ATTACK",
    "12' - A - V_PASS - (55)",
    "12' - H - V_ASSISTANCE - (30)",
    "12' - A - V_RECEPTION - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.equal(opp.isCounterAttack, true);
  const caStep = opp.steps.find(s => s.isCA && s.stepType === 'START_PASS');
  assert.equal(caStep.from.side, 'away'); // the team that won the midfield duel
});

test('counter-attack originating from a penalty-box duel loss', () => {
  const narrative = [
    'Minute 55',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got excellent assistance, and was ready.',
    'Player D [FW] made weak reception, Player E [CB] made awesome tackle.',
    'Player E [CB] cleared the ball to safety.',
    'Counter attack',
    'Midfield',
    'Player E [CB] attempted low good pass to Player Y [FW]',
    'Player F [CM] got decent assistance, and was close.',
    'Player Y [FW] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "55' - H - O_MID_START",
    "55' - H - V_PASS - (55)",
    "55' - A - V_ASSISTANCE - (20)",
    "55' - H - V_RECEPTION - (65)",
    "55' - H - V_PASS - (45)",
    "55' - A - V_ASSISTANCE - (85)",
    "55' - H - V_RECEPTION - (25)",
    "55' - A - V_TACKLING - (90)",
    "55' - A - E_COUNTER_ATTACK",
    "55' - A - V_PASS - (55)",
    "55' - H - V_ASSISTANCE - (30)",
    "55' - A - V_RECEPTION - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.equal(opp.isCounterAttack, true);
  assert.deepEqual(stepTypes(opp).slice(0, 4), ['START_PASS', 'MID_DUEL', 'PB_PASS', 'PB_DUEL']);
  const caStep = opp.steps.find(s => s.isCA && s.stepType === 'START_PASS');
  assert.equal(caStep.from.side, 'away'); // the defender who won the box duel
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked passes — free ball either team can recover
// ─────────────────────────────────────────────────────────────────────────────

test('blocked pass recovered by the attacking team: same attack continues', () => {
  const narrative = [
    'Minute 60',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'The pass was blocked by the opponent player.',
    'The ball is now free!',
    'Player C [DM] was close and took control.',
    'Player C [DM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
  ].join('\n');
  const telemetry = [
    "60' - H - O_MID_START",
    "60' - H - V_PASS - (25)",
    "60' - H - V_PASS - (55)",
    "60' - A - V_ASSISTANCE - (35)",
    "60' - H - V_RECEPTION - (60)",
    "60' - A - V_TACKLING - (40)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['START_PASS', 'MID_DUEL', 'START_PASS', 'MID_DUEL']);
  assert.equal(opp.steps[1].outcome, 'BLOCKED');
  // The recovering player continues the SAME attack as its new passer.
  assert.equal(opp.steps[2].from.name, 'Player C');
  assert.equal(opp.steps[2].from.side, 'home');
  assert.equal(opp.hasShot, false); // attack is still live, no shot yet — opportunity not over
});

test('blocked pass recovered by the defending team: possession changes, opportunity ends', () => {
  const narrative = [
    'Minute 61',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'The pass was blocked by the opponent player.',
    'The ball is now free!',
    'Player C [DM] was close and took control.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "61' - H - O_MID_START",
    "61' - H - V_PASS - (25)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  // No further pass attempt after the recovery — the restarted phase never got a real
  // action, so it correctly doesn't appear as a phantom continuation of Home's attack.
  assert.deepEqual(stepTypes(opp), ['START_PASS', 'MID_DUEL']);
  assert.equal(opp.steps[1].outcome, 'BLOCKED');
  assert.equal(opp.finalOutcome, 'BLOCKED');
});

// ─────────────────────────────────────────────────────────────────────────────
// Penalties — fouler vs. taker distinction
// ─────────────────────────────────────────────────────────────────────────────

test('penalty scored: PB foul -> penalty -> goal (fouled player takes it)', () => {
  const narrative = [
    'Minute 61',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [LB] attempted high superb pass to Player B [LM]',
    'Player C [RM] got awful assistance, and was in decent position.',
    'Player B [LM] made decent reception, Player C [RM] made poor tackle.',
    'Player B [LM] took control of the ball.',
    'Penalty Box',
    'Player B [LM] attempted low awesome accurate pass to Player D [FW]',
    'Player E [CB] got poor assistance, and was ready.',
    'Player D [FW] made brilliant reception, Player E [CB] made good tackle.',
    'Player E [CB] committed a foul.',
    'Penalty',
    'Goal Attempt',
    'Player D [FW] made brilliant shot.',
    'Player G [GK] was totally in the wrong position, and made superb effort to prevent goal.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "61' - H - O_MID_START",
    "61' - H - V_PASS - (75)",
    "61' - A - V_ASSISTANCE - (10)",
    "61' - H - V_RECEPTION - (45)",
    "61' - H - V_PASS - (95)",
    "61' - A - V_ASSISTANCE - (20)",
    "61' - H - V_RECEPTION - (85)",
    "61' - A - V_TACKLING - (55)",
    "61' - A - E_PENALTY_KICK",
    "61' - H - V_SHOT - (85)",
    "61' - A - V_REFLEX - (75)",
    "61' - H - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  const duel = opp.steps.find(s => s.stepType === 'PB_DUEL');
  const shot = opp.steps.find(s => s.stepType === 'SHOT');
  assert.equal(duel.fouler.name, 'Player E');   // who committed the foul
  assert.equal(shot.shooter.name, 'Player D');  // who took the resulting penalty
  assert.equal(shot.isPenalty, true);
  assert.equal(shot.outcome, 'GOAL');
});

test('penalty missed: PB foul -> penalty -> saved', () => {
  const narrative = [
    'Minute 70',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [CM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player E [CB] committed a foul.',
    'Penalty',
    'Goal Attempt',
    'Player D [FW] made decent shot.',
    'Player G [GK] was ready, and made brilliant effort to prevent goal.',
    'Player G [GK] managed to get hold of the ball.',
  ].join('\n');
  const telemetry = [
    "70' - H - O_DEF_START",
    "70' - H - V_PASS - (55)",
    "70' - A - V_ASSISTANCE - (40)",
    "70' - H - V_RECEPTION - (60)",
    "70' - A - V_TACKLING - (30)",
    "70' - A - E_PENALTY_KICK",
    "70' - H - V_SHOT - (45)",
    "70' - A - V_REFLEX - (75)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  const shot = opp.steps.find(s => s.stepType === 'SHOT');
  assert.equal(shot.isPenalty, true);
  assert.equal(shot.outcome, 'SAVED');
  assert.equal(opp.hasGoal, false);
});

test('penalty taker distinct from the player who was fouled is preserved, not lost', () => {
  // A designated taker differing from the fouled player hasn't been directly observed,
  // but FinalWhistle's own penalty-taker priority settings mean it's a real mechanic —
  // this locks in that the code path (shot line names the actual taker) keeps that
  // identity rather than silently defaulting to whoever won the box duel.
  const narrative = [
    'Minute 70',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [CM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player E [CB] committed a foul.',
    'Penalty',
    'Goal Attempt',
    'Player Z [CM] made decent shot.',
    'Player G [GK] was ready, and made brilliant effort to prevent goal.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "70' - H - O_DEF_START",
    "70' - H - V_PASS - (55)",
    "70' - A - V_ASSISTANCE - (40)",
    "70' - H - V_RECEPTION - (60)",
    "70' - A - V_TACKLING - (30)",
    "70' - A - E_PENALTY_KICK",
    "70' - H - V_SHOT - (45)",
    "70' - A - V_REFLEX - (75)",
    "70' - H - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  const duel = opp.steps.find(s => s.stepType === 'PB_DUEL');
  const shot = opp.steps.find(s => s.stepType === 'SHOT');
  assert.equal(duel.attacker.name, 'Player D');  // won the box duel, was fouled
  assert.equal(shot.shooter.name, 'Player Z');   // designated taker actually named in the shot line
  assert.equal(shot.shooter.side, 'home');       // still correctly attributed to the attacking side
});

// ─────────────────────────────────────────────────────────────────────────────
// Substitutions and tactical events
// ─────────────────────────────────────────────────────────────────────────────

test('substitution: outgoing and incoming player identities are captured distinctly', () => {
  const narrative = [
    'Minute 60',
    "Home Team - Player A [FW] looks very tired.",
    'Minute 61',
    'Home Team - Issued order- Player A [FW] was substituted with Player Z [FW]',
    'Minute 65',
    'Opportunity for Home Team.',
    'Midfield',
    'Player B [RB] attempted low good pass to Player Z [FW]',
    'Player C [CB] got decent assistance, and was in decent position.',
    'Player Z [FW] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "65' - H - O_DEF_START",
    "65' - H - V_PASS - (55)",
    "65' - A - V_ASSISTANCE - (30)",
    "65' - H - V_RECEPTION - (65)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  const sub = match.tacticalEvents.find(e => e.type === 'SUBSTITUTION');
  assert.ok(sub, 'expected a SUBSTITUTION tactical event');
  assert.equal(sub.playerOut.name, 'Player A');
  assert.equal(sub.playerIn.name, 'Player Z');
  // The replacement shows up correctly in the following opportunity, as their own player.
  const opp = match.opportunities[0];
  const midDuel = opp.steps.find(s => s.stepType === 'MID_DUEL');
  assert.equal(midDuel.attacker.name, 'Player Z');
});

test('position change tactical event is captured', () => {
  const narrative = [
    'Minute 40',
    'Home Team - Issued order- Player A [CM] was moved to RM',
    'Minute 41',
    'Opportunity for Home Team.',
    'Midfield',
    'Player B [RB] attempted low good pass to Player A [RM]',
    'Player C [CB] got decent assistance, and was in decent position.',
    'Player A [RM] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "41' - H - O_DEF_START",
    "41' - H - V_PASS - (55)",
    "41' - A - V_ASSISTANCE - (30)",
    "41' - H - V_RECEPTION - (65)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  const posChange = match.tacticalEvents.find(e => e.type === 'POSITION_CHANGE');
  assert.ok(posChange);
  assert.equal(posChange.player.name, 'Player A');
  assert.equal(posChange.player.position, 'CM');
  assert.equal(posChange.toPosition, 'RM');
});

// ─────────────────────────────────────────────────────────────────────────────
// Secondary regression cases
// ─────────────────────────────────────────────────────────────────────────────

test('long ball intercepted by the goalkeeper', () => {
  const narrative = [
    'Minute 20',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [LB] attempted high risky pass to Player D [FW]',
    'Player G [GK] intercepted the ball.',
  ].join('\n');
  const telemetry = [
    "20' - H - O_DEF_START",
    "20' - H - V_PASS - (65)",
    "20' - A - V_ASSISTANCE - (45)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  // A long ball is a PB_PASS with no preceding midfield phase — absence of a midfield
  // duel here is valid, not malformed.
  assert.equal(opp.isLongBallSequence, true);
  assert.deepEqual(stepTypes(opp), ['PB_PASS', 'PB_DUEL']);
  assert.equal(outcomeOf(opp, 'PB_DUEL'), 'GK_INTERCEPT');
});

test('corner generated from an open-play defensive clearance', () => {
  const narrative = [
    'Minute 18',
    'Opportunity for Home Team.',
    'Penalty Box',
    'Player A [LM] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made superb tackle.',
    'Player E [CB] sent ball to corner.',
    'Corner',
    'Player F [RW] has decided to restart the attack',
    'Player F [RW] made high good pass to Player D [FW]',
    'Player I [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player I [CB] made weak tackle.',
    'Player I [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "18' - H - O_DEF_START",
    "18' - H - V_PASS - (60)",
    "18' - A - V_ASSISTANCE - (40)",
    "18' - H - V_RECEPTION - (55)",
    "18' - A - V_TACKLING - (70)",
    "18' - A - E_CORNER",
    "18' - H - V_PASS - (50)",
    "18' - A - V_ASSISTANCE - (35)",
    "18' - H - V_RECEPTION - (45)",
    "18' - A - V_TACKLING - (60)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const opp = match.opportunities[0];
  assert.deepEqual(stepTypes(opp), ['PB_PASS', 'PB_DUEL', 'SP_PASS', 'SP_DUEL']);
  assert.equal(outcomeOf(opp, 'PB_DUEL'), 'CORNER');
});

test('multiple opportunities in the same minute stay separate and correctly ordered', () => {
  const narrative = [
    'Minute 5',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Opportunity for Away Team.',
    'Midfield',
    'Player X [LB] attempted low good pass to Player Y [CM]',
    'Player Z [DM] got poor assistance, and was close.',
    'Player Y [CM] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "5' - H - O_MID_START",
    "5' - H - V_PASS - (30)",
    "5' - A - V_ASSISTANCE - (40)",
    "5' - H - V_RECEPTION - (25)",
    "5' - A - V_TACKLING - (70)",
    "5' - A - O_MID_START",
    "5' - A - V_PASS - (55)",
    "5' - H - V_ASSISTANCE - (20)",
    "5' - A - V_RECEPTION - (65)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  assert.equal(match.opportunities.length, 2);
  assert.equal(match.opportunities[0].team, 'Home Team');
  assert.equal(match.opportunities[0].minute, 5);
  assert.equal(match.opportunities[1].team, 'Away Team');
  assert.equal(match.opportunities[1].minute, 5);
  // Home's and Away's opportunities here are different (minute, side) keys — each side
  // only ever had one possible stream block to pair with, so there was no cursor-order
  // ambiguity to report; both should read 'exact', not 'uncertain'.
  assert.equal(match.opportunities[0].streamMatchConfidence, 'exact');
  assert.equal(match.opportunities[1].streamMatchConfidence, 'exact');
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-minute score tracking
// ─────────────────────────────────────────────────────────────────────────────

test('two goals in the same minute each get the score that actually applied to them', () => {
  // Home scores (1-0), Away is cleared (no change), Away scores (1-1) — all in the same
  // minute. Under the old minute-keyed lookup, scoreByMinute[33] could only ever hold the
  // LAST bracket seen for that minute (1-1), so the Home goal's own opportunity would have
  // resolved to the wrong scoreAfter (1-1 instead of 1-0) despite the score genuinely
  // having been 1-0 at the moment it happened.
  const narrative = [
    'Minute 33',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [CM] got weak assistance, and was close.',
    'Player B [CM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made superb shot.',
    'Player F [GK] was fooled.',
    'GOAL!',
    '[1-0]',
    'Opportunity for Away Team.',
    'Midfield',
    'Player X [LB] attempted low weak pass to Player Y [CM]',
    'Player Z [DM] got decent assistance, and was in decent position.',
    'Player Y [CM] made weak reception, Player Z [DM] made superb tackle.',
    'Player Z [DM] cleared the ball to safety.',
    'Opportunity for Away Team.',
    'Midfield',
    'Player X [LB] attempted low good pass to Player W [FW]',
    'Player V [CB] got weak assistance, and was close.',
    'Player W [FW] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player W [FW] attempted low decent pass to Player U [FW]',
    'Player T [CB] got good assistance, and was in decent position.',
    'Player U [FW] made good reception, Player T [CB] made weak tackle.',
    'Player U [FW] took control of the ball.',
    'Goal Attempt',
    'Player U [FW] made superb shot.',
    'Player F [GK] was fooled.',
    'GOAL!',
    '[1-1]',
  ].join('\n');
  const telemetry = [
    "33' - H - O_MID_START",
    "33' - H - V_PASS - (65)",
    "33' - A - V_ASSISTANCE - (30)",
    "33' - H - V_RECEPTION - (75)",
    "33' - H - V_PASS - (55)",
    "33' - A - V_ASSISTANCE - (60)",
    "33' - H - V_RECEPTION - (65)",
    "33' - A - V_TACKLING - (35)",
    "33' - H - V_SHOT - (70)",
    "33' - A - V_REFLEX - (80)",
    "33' - H - E_GOAL",

    "33' - A - O_MID_START",
    "33' - A - V_PASS - (30)",
    "33' - H - V_ASSISTANCE - (40)",
    "33' - A - V_RECEPTION - (25)",
    "33' - H - V_TACKLING - (70)",

    "33' - A - O_MID_START",
    "33' - A - V_PASS - (65)",
    "33' - H - V_ASSISTANCE - (30)",
    "33' - A - V_RECEPTION - (75)",
    "33' - A - V_PASS - (55)",
    "33' - H - V_ASSISTANCE - (60)",
    "33' - A - V_RECEPTION - (65)",
    "33' - H - V_TACKLING - (35)",
    "33' - A - V_SHOT - (70)",
    "33' - H - V_REFLEX - (80)",
    "33' - A - E_GOAL",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.opportunities.length, 3);

  const [homeGoal, awayCleared, awayGoal] = match.opportunities;
  assert.deepEqual(homeGoal.scoreBefore, { home: 0, away: 0 });
  assert.deepEqual(homeGoal.scoreAfter,  { home: 1, away: 0 }, 'the Home goal must not inherit the LATER Away goal\'s score');
  assert.deepEqual(awayCleared.scoreBefore, { home: 1, away: 0 }, 'reflects the goal that just happened before it');
  assert.deepEqual(awayCleared.scoreAfter,  { home: 1, away: 0 }, 'unchanged — this opportunity had no goal of its own');
  assert.deepEqual(awayGoal.scoreBefore, { home: 1, away: 0 });
  assert.deepEqual(awayGoal.scoreAfter,  { home: 1, away: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit home/away identity (item 3)
// ─────────────────────────────────────────────────────────────────────────────

test('a team with zero opportunities still resolves correctly when trusted metadata is provided', () => {
  // Away Team never appears in an "Opportunity for" line, only in a tactical event —
  // parseMatch's own narrative/stream-based inference has nothing to pair Away against
  // (no opportunity, no attacking-side stream block), so without explicit meta it could
  // never resolve awayTeam at all. Trusted scrape metadata sidesteps that entirely.
  const narrative = [
    'Minute 10',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Minute 15',
    'Away Team - Player Z [CM] looks tired.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START",
    "10' - H - V_PASS - (30)",
    "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)",
    "10' - A - V_TACKLING - (70)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative, { homeTeam: 'Home Team', awayTeam: 'Away Team' });
  assert.equal(match.meta.homeTeam, 'Home Team');
  assert.equal(match.meta.awayTeam, 'Away Team');
  assert.equal(match.opportunities.length, 1);
  assert.equal(match.opportunities[0].teamSide, 'home');

  const cornerEvent = match.tacticalEvents.find(e => e.team === 'Away Team');
  assert.ok(cornerEvent, 'expected a tactical event attributed to Away Team');
  assert.equal(cornerEvent.teamSide, 'away');
});

test('two same-team same-minute opportunities report uncertain stream-match confidence', () => {
  // Same (minute, side) key twice — pairing the second one to the second stream block is
  // only correct because both blocks happen to parse cleanly in order; if an earlier block
  // had gone missing or malformed, this opportunity would silently pair with the wrong
  // one. streamMatchConfidence exists specifically to flag that this pairing was picked
  // by cursor order among multiple candidates, not because it was the only possible match.
  const narrative = [
    'Minute 12',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Opportunity for Home Team.',
    'Midfield',
    'Player D [RB] attempted low good pass to Player E [CM]',
    'Player F [DM] got poor assistance, and was close.',
    'Player E [CM] made excellent reception and took control of the ball.',
  ].join('\n');
  const telemetry = [
    "12' - H - O_MID_START",
    "12' - H - V_PASS - (30)",
    "12' - A - V_ASSISTANCE - (40)",
    "12' - H - V_RECEPTION - (25)",
    "12' - A - V_TACKLING - (70)",
    "12' - H - O_MID_START",
    "12' - H - V_PASS - (55)",
    "12' - A - V_ASSISTANCE - (20)",
    "12' - H - V_RECEPTION - (65)",
  ].join('\n');

  const match = parseMatch(telemetry, narrative);
  assert.equal(match.opportunities.length, 2);
  assert.equal(match.opportunities[0].streamMatchConfidence, 'uncertain');
  assert.equal(match.opportunities[1].streamMatchConfidence, 'uncertain');
  // The ambiguity is surfaced through the same warnings the UI already shows, one
  // aggregate line rather than one per opportunity.
  assert.equal(match.warnings.length, 1);
  assert.match(match.warnings[0], /2 opportunities shared a minute\+side/);
});

test('an opportunity with no matching stream block reports none confidence', () => {
  const narrative = [
    'Minute 40',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const match = parseMatch('', narrative); // no telemetry at all for this minute
  assert.equal(match.opportunities[0].streamMatchConfidence, 'none');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — Tactical Truth: tacticalStateAt, buildTacticalPhases, opportunity association
// ─────────────────────────────────────────────────────────────────────────────

function midOppLines(team, passer, target, defender) {
  return [
    `Opportunity for ${team}.`,
    'Midfield',
    `${passer} attempted low good pass to ${target}`,
    `${defender} got decent assistance, and was in decent position.`,
    `${target} made weak reception, ${defender} made superb tackle.`,
    `${defender} cleared the ball to safety.`,
  ];
}
function midTelemetryLines(minute, side) {
  const opp = side === 'H' ? 'A' : 'H';
  return [
    `${minute}' - ${side} - O_MID_START`,
    `${minute}' - ${side} - V_PASS - (30)`,
    `${minute}' - ${opp} - V_ASSISTANCE - (40)`,
    `${minute}' - ${side} - V_RECEPTION - (25)`,
    `${minute}' - ${opp} - V_TACKLING - (70)`,
  ];
}
const HA = { homeTeam: 'Home Team', awayTeam: 'Away Team' };

test('tacticalStateAt at kickoff returns fully unknown team state and no players', () => {
  const narrative = ['Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  const state = tacticalStateAt(match, 'home', 0, -1);
  assert.deepEqual(state.teamState, {
    mentality: null, style: null, middleOrder: null, marking: null, defenceFocus: null,
    preferredSide: null, offside: null, playerOrders: null, aggression: null, arrows: null,
    specialOrders: { isolate: [] },
  });
  assert.deepEqual(state.players, {});
  assert.equal(state.uncertain, false);
});

test('a tactical setting the narrative never exposes stays null even after other changes happen', () => {
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 10',
    'Home Team - Issued order- Change mentality to ATTACKING',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999999);
  assert.equal(state.teamState.mentality, 'ATTACKING', 'the one setting that WAS observed should still be reflected');
  assert.equal(state.teamState.marking, null);
  assert.equal(state.teamState.defenceFocus, null);
  assert.equal(state.teamState.preferredSide, null);
  assert.equal(state.teamState.offside, null);
  assert.equal(state.teamState.arrows, null);
  assert.equal(state.teamState.aggression, null);
  assert.equal(state.teamState.playerOrders, null);
});

test('a mentality change updates teamState.mentality from the point it occurs', () => {
  const narrative = ['Minute 10', 'Home Team - Issued order- Change mentality to DEFENSIVE'].join('\n');
  const match = parseMatch('', narrative, HA);
  assert.equal(tacticalStateAt(match, 'home', 5, 0).teamState.mentality, null, 'before the change');
  assert.equal(tacticalStateAt(match, 'home', 90, 999).teamState.mentality, 'DEFENSIVE', 'after the change');
});

test('a "Change order to X" line updates teamState.middleOrder, never teamState.style', () => {
  // The source line is ambiguous between the manual's team-wide Style of Play and a
  // per-zone Player Order (see parser.js's B1 audit comment) — nothing may write to the
  // field literally named `style` until that ambiguity is resolved against real evidence.
  const narrative = ['Minute 10', 'Home Team - Issued order- Change order to SHORT_PASSES'].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.equal(state.teamState.middleOrder, 'SHORT_PASSES');
  assert.equal(state.teamState.style, null, 'must stay unpopulated — the mechanic identity is unresolved');

  const ev = match.tacticalEvents.find(e => e.type === 'STYLE_CHANGE');
  assert.equal(ev.semanticType, 'MIDDLE_ORDER_CHANGE');
  assert.equal(ev.interpretation, 'ambiguous');
});

test('isolating a player records who and stays zone-null (the narrative names no zone)', () => {
  // teamNames (used to recognize the "Home Team" context-marker line before "Isolate
  // Player -") is only populated from an "Opportunity for X." line elsewhere in the
  // report — include one so issuingTeam/teamSide resolve, same as a real report would.
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 20',
    'Home Team',
    'Isolate Player - Player X [FW]',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.deepEqual(state.teamState.specialOrders.isolate, [{ player: { name: 'Player X', position: 'FW' }, zone: null }]);
});

test('a second isolate order replaces the first rather than accumulating', () => {
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 20', 'Home Team', 'Isolate Player - Player X [FW]',
    'Minute 40', 'Home Team', 'Isolate Player - Player Y [FW]',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.equal(state.teamState.specialOrders.isolate.length, 1);
  assert.equal(state.teamState.specialOrders.isolate[0].player.name, 'Player Y');
});

test('a substitution takes the outgoing player off pitch and puts the incoming player on', () => {
  const narrative = [
    'Minute 60',
    'Home Team - Issued order- Player Y [FW] was substituted with Player Z [CM]',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.equal(state.players['Player Y'].onPitch, false);
  assert.equal(state.players['Player Z'].onPitch, true);
  // The incoming player must only carry what FinalWhistle actually stated about them
  // (identity + position) — nothing is ever copied from the outgoing player's record.
  assert.equal(state.players['Player Z'].position, 'CM', 'replacement appears at the position the source line establishes');
  assert.equal(state.players['Player Z'].order, null);
  assert.equal(state.players['Player Z'].aggression, null);
  assert.equal(state.players['Player Z'].arrow, null);
});

test('a position change updates the moved player without touching anyone else', () => {
  const narrative = [
    'Minute 30',
    'Home Team - Issued order- Player A [FW] was moved to LM',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.equal(state.players['Player A'].position, 'LM');
  assert.equal(state.players['Player A'].onPitch, true);
});

test('two consecutive substitutions both apply correctly and independently', () => {
  const narrative = [
    'Minute 55',
    'Home Team - Issued order- Player A [FW] was substituted with Player B [FW]',
    'Minute 70',
    'Home Team - Issued order- Player C [CM] was substituted with Player D [CM]',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999);
  assert.equal(state.players['Player A'].onPitch, false);
  assert.equal(state.players['Player B'].onPitch, true);
  assert.equal(state.players['Player C'].onPitch, false);
  assert.equal(state.players['Player D'].onPitch, true);
});

test('multiple tactical changes in the same minute preserve narrative sequence order', () => {
  // Mirrors the worked example in the Phase B spec: a position move, a substitution and a
  // mentality change all issued at 62', immediately followed by an opportunity. The state
  // seen by that opportunity must reflect all three changes, in the order they actually
  // appeared — not an ambiguous "some subset of same-minute events" guess.
  const narrative = [
    'Minute 62',
    'Home Team - Issued order- Player X [FW] was moved to LM',
    'Home Team - Issued order- Player Y [FW] was substituted with Player Z [CM]',
    'Home Team - Issued order- Change mentality to ATTACKING',
    ...midOppLines('Home Team', 'Player Z [CM]', 'Player X [LM]', 'Player D [RB]'),
  ].join('\n');
  const match = parseMatch(midTelemetryLines(62, 'H').join('\n'), narrative, HA);
  assert.equal(match.opportunities.length, 1);

  const ctx = match.opportunities[0].tacticalContext;
  const homePhase = match.tacticalPhases.home.find(p => p.id === ctx.homePhaseId);
  assert.ok(homePhase, 'opportunity must resolve to a real phase');
  assert.equal(homePhase.state.teamState.mentality, 'ATTACKING');
  assert.equal(homePhase.state.players['Player X'].position, 'LM');
  assert.equal(homePhase.state.players['Player Y'].onPitch, false);
  assert.equal(homePhase.state.players['Player Z'].onPitch, true);
  assert.equal(homePhase.triggeredBy.length, 3, 'all three same-minute changes grouped into one phase transition');
});

test('tactical state before vs after a same-minute change differs when sequence disambiguates', () => {
  const narrative = ['Minute 40', 'Home Team - Issued order- Change mentality to VERY_ATTACKING'].join('\n');
  const match = parseMatch('', narrative, HA);
  const changeEvent = match.tacticalEvents[0];
  const before = tacticalStateAt(match, 'home', 40, changeEvent.sequence);
  const after  = tacticalStateAt(match, 'home', 40, changeEvent.sequence + 1);
  assert.equal(before.teamState.mentality, null);
  assert.equal(after.teamState.mentality, 'VERY_ATTACKING');
});

test('without a sequence, a same-minute boundary is marked uncertain rather than guessed', () => {
  const narrative = ['Minute 40', 'Home Team - Issued order- Change mentality to VERY_ATTACKING'].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 40); // no sequence passed
  assert.equal(state.uncertain, true);
  assert.equal(state.teamState.mentality, null, 'excluded rather than silently included');
});

test('tiredness updates player context but does not create a new tactical phase', () => {
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 40',
    'Home Team - Player B [CM] looks tired.',
    'Minute 70', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
  ].join('\n');
  const telemetry = [...midTelemetryLines(5, 'H'), ...midTelemetryLines(70, 'H')].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  assert.equal(match.tacticalPhases.home.length, 1, 'tiredness alone must not split a phase');
  const state = tacticalStateAt(match, 'home', 90, 999999);
  assert.equal(state.players['Player B'].tiredness, 'TIRED');
});

test('an opportunity, a shot/goal, or a score change alone does not split a tactical phase', () => {
  const narrative = [
    'Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 50', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 80', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
  ].join('\n');
  const telemetry = [...midTelemetryLines(10, 'H'), ...midTelemetryLines(50, 'H'), ...midTelemetryLines(80, 'H')].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  assert.equal(match.opportunities.length, 3);
  assert.equal(match.tacticalPhases.home.length, 1, 'no tactical order ever changed, so there is exactly one phase');
});

test('a phase begins only on a material change (mentality/style/sub/position/isolate)', () => {
  const narrative = [
    'Minute 10',
    'Home Team - Issued order- Change mentality to ATTACKING',
    'Minute 50',
    'Home Team - Issued order- Player A [FW] was moved to LM',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const phases = match.tacticalPhases.home;
  assert.equal(phases.length, 3, 'kickoff phase + one phase per material change');
  assert.equal(phases[0].triggeredBy.length, 0);
  assert.equal(phases[1].triggeredBy[0].type, 'MENTALITY_CHANGE');
  assert.equal(phases[2].triggeredBy[0].type, 'POSITION_CHANGE');
});

test('an observed long-ball pattern does not infer Style of Play — the setting stays null', () => {
  // Three long-ball-shaped opportunities in a row (back-position player passing straight
  // into the box) must never cause teamState.style to be anything but null: no
  // STYLE_CHANGE event ever fired, so nothing may be inferred from the shape of play.
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RB] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.',
    'Player F [GK] was fooled.', 'GOAL!', '[1-0]',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const state = tacticalStateAt(match, 'home', 90, 999999);
  assert.equal(state.teamState.style, null);
  assert.equal(match.opportunities[0].isLongBallSequence, true, 'sanity check: this really is the long-ball shape');
});

test('injury ownership resolves teamSide from the player\'s own identity even though the line has no team prefix', () => {
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 20',
    'Player B [CM] has suffered a light injury.',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  const injuryEvent = match.tacticalEvents.find(ev => ev.type === 'INJURY');
  assert.ok(injuryEvent);
  assert.equal(injuryEvent.teamSide, 'home', 'resolved via Player B already being seen on the home side in the opportunity');
  assert.equal(injuryEvent.team, 'Home Team');
  const state = tacticalStateAt(match, 'home', 90, 999999);
  assert.equal(state.players['Player B'].injury, 'LIGHT');
});

test('a team with zero opportunities still gets its own tactical phases and events', () => {
  const narrative = [
    'Minute 5', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 60',
    'Away Team - Issued order- Change mentality to DEFENSIVE',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(5, 'H').join('\n'), narrative, HA);
  assert.equal(match.opportunities.filter(o => o.teamSide === 'away').length, 0, 'sanity check: away really has zero opportunities');
  assert.equal(match.tacticalPhases.away.length, 2, 'kickoff phase + the mentality change, despite zero opportunities');
  assert.equal(match.tacticalPhases.away[1].state.teamState.mentality, 'DEFENSIVE');
});

test('deriveFormation reports partial reconstruction honestly instead of guessing a label', () => {
  const players = {
    'Player A': { name: 'Player A', position: 'CB', onPitch: true },
    'Player B': { name: 'Player B', position: 'CM', onPitch: true },
    'Player C': { name: 'Player C', position: 'FW', onPitch: false }, // subbed off — must not count
  };
  const formation = deriveFormation(players);
  assert.equal(formation.playerCount, 2);
  assert.equal(formation.complete, false);
  assert.equal(formation.counts.DEF, 1);
  assert.equal(formation.counts.MID, 1);
  assert.equal(formation.counts.FW, 0);
});

test('an injury for a player never observed elsewhere is flagged as an unresolved tactical event, not silently dropped or guessed', () => {
  const narrative = [
    'Minute 20',
    'Player Never Seen Elsewhere [CB] has suffered a severe injury.',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const injuryEvent = match.tacticalEvents.find(ev => ev.type === 'INJURY');
  assert.equal(injuryEvent.teamSide, undefined);
  assert.equal(match.validation.unresolvedTacticalEvents.length, 1);
  assert.equal(match.validation.unresolvedTacticalEvents[0].type, 'INJURY');
  assert.ok(match.warnings.some(w => w.includes('could not be attributed to a side')));
});

test('phaseIdAt resolves an opportunity to the correct phase on both sides of a boundary', () => {
  const phases = [
    { id: 'p0', startSequence: -1, endSequence: 5 },
    { id: 'p1', startSequence: 5, endSequence: null },
  ];
  assert.equal(phaseIdAt(phases, 3), 'p0');
  assert.equal(phaseIdAt(phases, 6), 'p1');
});
