'use strict';
// Regression tests for analytics.js. No test framework dependency — Node's
// built-in test runner, matching parser.test.js/viewer.test.js/scraper.test.js.
// Fixtures reuse proven real FinalWhistle narrative wording from parser.test.js's own
// fixtures wherever a matching scenario already exists there, rather than inventing new
// engine phrases just to manufacture coverage.
//
// Run with:  node --test analytics.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch } = require('./parser.js');
const A = require('./analytics.js');

const HA = { homeTeam: 'Home Team', awayTeam: 'Away Team' };

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

// ─────────────────────────────────────────────────────────────────────────────
// opportunityFunnel
// ─────────────────────────────────────────────────────────────────────────────

test('opportunity stopping in midfield reports terminalStage MIDFIELD, not PB/SHOT', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  const funnel = A.opportunityFunnel(match);
  const e = funnel.entries[0];
  assert.equal(e.reachedMidfieldDuel, true);
  assert.equal(e.wonMidfieldDuel, false);
  assert.equal(e.reachedPenaltyBox, false);
  assert.equal(e.shotCount, 0);
  assert.equal(e.terminalStage, 'MIDFIELD');
  assert.equal(e.progressionType, 'OPEN_PLAY');
});

test('opportunity reaching PB but no shot reports terminalStage PENALTY_BOX', () => {
  const narrative = [
    'Minute 20',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made weak reception, Player E [CB] made superb tackle.',
    'Player E [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "20' - H - O_MID_START", "20' - H - V_PASS - (55)", "20' - A - V_ASSISTANCE - (35)",
    "20' - H - V_RECEPTION - (65)",
    "20' - H - V_PASS - (45)", "20' - A - V_ASSISTANCE - (55)",
    "20' - H - V_RECEPTION - (30)", "20' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.reachedPenaltyBox, true);
  assert.equal(e.completedPenaltyBoxReception, false);
  assert.equal(e.shotCount, 0);
  assert.equal(e.terminalStage, 'PENALTY_BOX');
});

test('a direct long shot from midfield is classified OPEN_PLAY, terminal SHOT/GOAL', () => {
  const narrative = [
    'Minute 33',
    'Opportunity for Home Team.',
    'Midfield',
    'Player A [CM] attempted low excellent pass to Player B [CM]',
    'Player C [CM] got decent assistance, and was close.',
    'Player B [CM] made superb reception and took control of the ball.',
    'Long Shot Goal Attempt',
    'Player B [CM] made superb shot.',
    'Player G [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "33' - H - O_MID_START", "33' - H - V_PASS - (65)", "33' - A - V_ASSISTANCE - (40)",
    "33' - H - V_RECEPTION - (70)", "33' - H - V_SHOT - (75)", "33' - A - V_REFLEX - (20)",
    "33' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.progressionType, 'OPEN_PLAY');
  assert.equal(e.shotCount, 1);
  assert.equal(e.goalCount, 1);
  assert.equal(e.terminalStage, 'GOAL');
  assert.equal(e.reachedPenaltyBox, false, 'a long shot from midfield never entered the PB');
});

test('a direct free-kick shot is classified DIRECT_FREE_KICK', () => {
  const narrative = [
    'Minute 40',
    'Opportunity for Home Team.',
    'Free Kick',
    'Player A [CM] has decided to restart the attack',
    'Player A [CM] made superb shot.',
    'Player G [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "40' - H - O_FK_START", "40' - H - V_SHOT - (80)", "40' - A - V_REFLEX - (15)", "40' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.progressionType, 'DIRECT_FREE_KICK');
  assert.deepEqual(A.opportunityFunnel(match).entries[0].terminalStage, 'GOAL');
});

test('a corner sequence is classified SET_PIECE and does not count as reaching the PB', () => {
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
    "50' - H - O_SP_START", "50' - H - V_PASS - (60)", "50' - A - V_ASSISTANCE - (40)",
    "50' - H - V_RECEPTION - (55)", "50' - A - V_TACKLING - (35)",
    "50' - H - V_SHOT - (45)", "50' - A - V_REFLEX - (30)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.progressionType, 'SET_PIECE');
  assert.equal(e.reachedPenaltyBox, false, 'SP entries are tracked separately from open-play PB entries');
  assert.equal(e.shotCount, 1);
  assert.equal(e.terminalStage, 'SHOT');
});

test('multiple shots/rebound in one opportunity are all counted', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.',
    'Player G [GK] was ready, and made excellent effort to prevent goal.',
    'Player G [GK] bounced the ball back.',
    'The ball is now free!',
    'Player D [FW] was close and took control.',
    'Penalty Box',
    'Player D [FW] attempted low good pass to Player H [FW]',
    'Player I [CB] got decent assistance, and was in decent position.',
    'Player H [FW] made good reception, Player I [CB] made weak tackle.',
    'Player H [FW] took control of the ball.',
    'Goal Attempt', 'Player H [FW] made superb shot.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "40' - H - O_PB_START", "40' - H - V_PASS - (55)", "40' - A - V_ASSISTANCE - (35)",
    "40' - H - V_RECEPTION - (60)", "40' - A - V_TACKLING - (30)",
    "40' - H - V_SHOT - (65)", "40' - A - V_REFLEX - (70)", "40' - A - E_FUMBLE",
    "40' - H - V_PASS - (50)", "40' - A - V_ASSISTANCE - (40)",
    "40' - H - V_RECEPTION - (55)", "40' - A - V_TACKLING - (35)",
    "40' - H - V_SHOT - (70)", "40' - A - V_REFLEX - (20)", "40' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  assert.equal(match.warnings.length, 0, match.warnings.join('; '));
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.shotCount, 2);
  assert.equal(e.goalCount, 1);
  assert.equal(e.terminalStage, 'GOAL');
});

// ─────────────────────────────────────────────────────────────────────────────
// turnoverAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('a lost midfield tackle duel is classified TACKLE_LOSS with correct losing/winning sides', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  const turnovers = A.turnoverAnalysis(match);
  assert.equal(turnovers.length, 1);
  assert.equal(turnovers[0].cause, 'TACKLE_LOSS');
  assert.equal(turnovers[0].losingSide, 'home');
  assert.equal(turnovers[0].winningSide, 'away');
  assert.equal(turnovers[0].playerLosing.name, 'Player B');
  assert.equal(turnovers[0].playerWinning.name, 'Player C');
});

test('a GK interception is classified GK_INTERCEPTION', () => {
  const narrative = [
    'Minute 12', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted high weak pass to Player D [FW]',
    'Player G [GK] intercepted the ball.',
  ].join('\n');
  const telemetry = ["12' - H - O_PB_START", "12' - H - V_PASS - (25)"].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const turnovers = A.turnoverAnalysis(match);
  assert.equal(turnovers.length, 1);
  assert.equal(turnovers[0].cause, 'GK_INTERCEPTION');
  assert.equal(turnovers[0].playerWinning.name, 'Player G');
});

test('an attack ended by an offside flag is classified as a turnover, not silently dropped', () => {
  const narrative = [
    'Minute 25', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RM] attempted high brilliant pass to Player D [FW]',
    'Offside trap was attempted by the defense team.',
    'Player E [CB] got weak assistance, and was ready.',
    'Assistant referee signaled the offside flag.',
  ].join('\n');
  const telemetry = ["25' - H - O_PB_START", "25' - H - V_PASS - (85)"].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const turnovers = A.turnoverAnalysis(match);
  assert.equal(turnovers.length, 1);
  assert.equal(turnovers[0].cause, 'OFFSIDE');
  assert.equal(turnovers[0].losingSide, 'home');
  assert.equal(turnovers[0].winningSide, 'away');
});

test('a blocked pass recovered by the attacking team is NOT a turnover', () => {
  const narrative = [
    'Minute 60', 'Opportunity for Home Team.', 'Midfield',
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
    "60' - H - O_MID_START", "60' - H - V_PASS - (25)", "60' - H - V_PASS - (55)",
    "60' - A - V_ASSISTANCE - (35)", "60' - H - V_RECEPTION - (60)", "60' - A - V_TACKLING - (40)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  assert.equal(A.turnoverAnalysis(match).length, 0, 'the same side recovered — no possession change');
});

test('a blocked pass with no recovery (opportunity ends) IS a turnover', () => {
  const narrative = [
    'Minute 61', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low weak pass to Player B [CM]',
    'The pass was blocked by the opponent player.',
    'The ball is now free!',
    'Player C [DM] was close and took control.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = ["61' - H - O_MID_START", "61' - H - V_PASS - (25)"].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const turnovers = A.turnoverAnalysis(match);
  assert.equal(turnovers.length, 1);
  assert.equal(turnovers[0].cause, 'BLOCKED_PASS');
  assert.equal(turnovers[0].losingSide, 'home');
});

test('a failed dribble is classified FAILED_DRIBBLE, not TACKLE_LOSS', () => {
  const narrative = [
    'Minute 22', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got decent assistance, and was in decent position.',
    'Player B [CM] made good reception, Player C [DM] made weak tackle.',
    'Player B [CM] considered his options.',
    'Player B [CM] made weak dribble attempt, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "22' - H - O_MID_START", "22' - H - V_PASS - (55)", "22' - A - V_ASSISTANCE - (40)",
    "22' - H - V_RECEPTION - (60)", "22' - A - V_TACKLING - (30)",
    "22' - H - V_ASSISTANCE - (35)", "22' - H - V_RECEPTION - (25)", "22' - A - V_TACKLING - (75)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const turnovers = A.turnoverAnalysis(match).filter(t => t.cause === 'FAILED_DRIBBLE');
  assert.equal(turnovers.length, 1);
});

test('a missed shot, a goal, and a corner are never classified as turnovers', () => {
  const narrative = [
    'Minute 50', 'Opportunity for Home Team.', 'Corner',
    'Player A [RW] has decided to restart the attack',
    'Player A [RW] made high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.', 'Missed the goal wide.',
  ].join('\n');
  const telemetry = [
    "50' - H - O_SP_START", "50' - H - V_PASS - (60)", "50' - A - V_ASSISTANCE - (40)",
    "50' - H - V_RECEPTION - (55)", "50' - A - V_TACKLING - (35)",
    "50' - H - V_SHOT - (45)", "50' - A - V_REFLEX - (30)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  assert.equal(A.turnoverAnalysis(match).length, 0, 'a missed shot ends the opportunity but is not a turnover');
});

// ─────────────────────────────────────────────────────────────────────────────
// defensiveFailureChains
// ─────────────────────────────────────────────────────────────────────────────

test('firstFailedDefensiveStage is null for a direct free kick (no preceding duel to blame)', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Free Kick',
    'Player A [CM] has decided to restart the attack',
    'Player A [CM] made superb shot.', 'Player G [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = ["40' - H - O_FK_START", "40' - H - V_SHOT - (80)", "40' - A - V_REFLEX - (15)", "40' - H - E_GOAL"].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const chains = A.defensiveFailureChains(match);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].firstFailedDefensiveStage, null);
  assert.equal(chains[0].stages.length, 1, 'a direct FK_SHOT chain has just the shot itself');
});

test('firstFailedDefensiveStage identifies the duel the attacker actually won, conservatively', () => {
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
  const match = parseMatch(telemetry, narrative, HA);
  const chain = A.defensiveFailureChains(match)[0];
  assert.equal(chain.firstFailedDefensiveStage.stepType, 'PB_DUEL');
  assert.equal(chain.firstFailedDefensiveStage.defender.name, 'Player E');
  assert.equal(chain.finalDefender.name, 'Player E');
});

test('firstFailedDefensiveStage picks the EARLIEST duel the attacker won when there are two — a later PB failure never overrides an earlier midfield failure', () => {
  const narrative = [
    'Minute 30', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.', 'Player F [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "30' - H - O_MID_START", "30' - H - V_PASS - (55)", "30' - A - V_ASSISTANCE - (30)", "30' - H - V_RECEPTION - (65)",
    "30' - H - V_PASS - (55)", "30' - A - V_ASSISTANCE - (40)", "30' - H - V_RECEPTION - (65)", "30' - A - V_TACKLING - (35)",
    "30' - H - V_SHOT - (70)", "30' - A - V_REFLEX - (20)", "30' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const chain = A.defensiveFailureChains(match)[0];
  // Player C (MID_DUEL, "was close" — no tackle, attacker won on positioning) is the
  // EARLIER duel the attacker won; Player E (PB_DUEL, contested and lost) is later in
  // the same chain. The earliest one must win, not whichever the loop happens to visit
  // last.
  assert.equal(chain.firstFailedDefensiveStage.stepType, 'MID_DUEL');
  assert.equal(chain.firstFailedDefensiveStage.defender.name, 'Player C');
  assert.notEqual(chain.firstFailedDefensiveStage.defender.name, 'Player E',
    'the later PB duel loss must not override the earlier midfield one as "earliest failed"');
  // finalDefender is a different, deliberately later-scoped field — the LAST duel
  // defender before the shot — so the two fields diverging here is itself correct, not
  // a contradiction (this is exactly the distinction the exposure-role split preserves).
  assert.equal(chain.finalDefender.name, 'Player E');
});

// ─────────────────────────────────────────────────────────────────────────────
// phasePerformance / tactical-phase attribution
// ─────────────────────────────────────────────────────────────────────────────

test('phasePerformance attributes opportunities to the correct phase and reports small-sample confidenceHint', () => {
  const narrative = [
    'Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 62', 'Home Team - Issued order- Change mentality to ATTACKING',
    'Minute 70', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
  ].join('\n');
  const telemetry = [...midTelemetryLines(10, 'H'), ...midTelemetryLines(70, 'H')].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const perf = A.phasePerformance(match, 'home');
  assert.equal(perf.length, 2);
  assert.equal(perf[0].ownOpportunities, 1);
  assert.equal(perf[0].startMinute, 0);
  assert.equal(perf[1].ownOpportunities, 1);
  assert.equal(perf[1].startMinute, 62);
  assert.equal(perf[0].confidenceHint, 'very small sample');
});

test('a counter-attack goal scored during the opponent\'s own opportunity is attributed to the correct side in phasePerformance', () => {
  const narrative = [
    'Minute 70', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RWB] attempted low good pass to Player B [RW]',
    'Player C [LB] got poor assistance, and was close.',
    'Player B [RW] made excellent reception and took control of the ball.',
    'Counter attack', 'Midfield',
    'Player X [FW] attempted low good pass to Player Y [LW]',
    'Player D [CM] got weak assistance, and was close.',
    'Player Y [LW] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player Y [LW] attempted low decent pass to Player X [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player X [FW] made good reception, Player E [CB] made weak tackle.',
    'Player X [FW] took control of the ball.',
    'Goal Attempt', 'Player X [FW] made superb shot.', 'Player Z [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "70' - H - O_MID_START", "70' - H - V_PASS - (60)", "70' - A - V_ASSISTANCE - (30)",
    "70' - H - V_RECEPTION - (70)", "70' - A - E_COUNTER_ATTACK",
    "70' - A - V_PASS - (55)", "70' - H - V_ASSISTANCE - (35)", "70' - A - V_RECEPTION - (65)",
    "70' - A - V_PASS - (50)", "70' - H - V_ASSISTANCE - (40)", "70' - A - V_RECEPTION - (60)",
    "70' - H - V_TACKLING - (35)", "70' - A - V_SHOT - (75)", "70' - H - V_REFLEX - (25)", "70' - A - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const homePerf = A.phasePerformance(match, 'home')[0];
  const awayPerf = A.phasePerformance(match, 'away')[0];
  // The opportunity was HOME's own, but AWAY actually scored via the counter-attack —
  // the goal must show up as HOME's opponentGoals, not vanish or double-count.
  assert.equal(homePerf.ownOpportunities, 1);
  assert.equal(homePerf.opponentGoals, 1);
  assert.equal(homePerf.ownGoals, 0);
  assert.equal(awayPerf.opponentOpportunities, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// before/after tactical comparison
// ─────────────────────────────────────────────────────────────────────────────

test('compareAroundEvent reports a labeled association, not a causal claim', () => {
  const narrative = [
    'Minute 50', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 62', 'Home Team - Issued order- Change mentality to ATTACKING',
    'Minute 70', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RB] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made superb shot.', 'Player F [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    ...midTelemetryLines(50, 'H'),
    "70' - H - O_PB_START", "70' - H - V_PASS - (55)", "70' - A - V_ASSISTANCE - (30)",
    "70' - H - V_RECEPTION - (65)", "70' - A - V_TACKLING - (35)",
    "70' - H - V_SHOT - (70)", "70' - A - V_REFLEX - (20)", "70' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const event = match.tacticalEvents.find(e => e.type === 'MENTALITY_CHANGE');
  const cmp = A.compareAroundEvent(match, event.id, { beforeMinutes: 15, afterMinutes: 15 });
  assert.ok(cmp);
  assert.equal(cmp.label, 'before/after association — not a measured causal effect');
  assert.equal(cmp.before.opportunities, 1);
  assert.equal(cmp.after.opportunities, 1);
  assert.equal(cmp.delta.shots, 1 - 0);
  assert.equal(cmp.after.sampleSizeHint, 'very small sample');
});

test('compareAroundEvent returns null for an event that never resolved a teamSide', () => {
  const match = parseMatch('', 'Minute 5\nOpportunity for Home Team.\nMidfield\n', HA);
  assert.equal(A.compareAroundEvent(match, 'nonexistent-id'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// playerDuelAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('playerDuelAnalysis aggregates attacker and defender duels separately per player', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  const byPlayer = A.playerDuelAnalysis(match);
  assert.equal(byPlayer['Player B'].attackerDuels.attempts, 1);
  assert.equal(byPlayer['Player B'].attackerDuels.losses, 1);
  assert.equal(byPlayer['Player C'].defenderDuels.attempts, 1);
  assert.equal(byPlayer['Player C'].defenderDuels.wins, 1);
  assert.equal(byPlayer['Player C'].tackles.count, 1);
  // Role-specific: a CB never gets a "shooting" or composite rating field merged in.
  assert.equal(byPlayer['Player C'].shooting.attempts, 0);
});

test('playerStatistics aggregates named actions, substitution minutes, assists, and fatigue', () => {
  const match = {
    playerRegistry: {
      'Home Passer': { team: 'Home Team', side: 'home', positions: ['CM'] },
      'Home Scorer': { team: 'Home Team', side: 'home', positions: ['FW'] },
      'Away Defender': { team: 'Away Team', side: 'away', positions: ['CB'] },
      'Away Keeper': { team: 'Away Team', side: 'away', positions: ['GK'] },
      'Home Sub': { team: 'Home Team', side: 'home', positions: ['FW'] },
      'Home Controller': { team: 'Home Team', side: 'home', positions: ['CM'] },
    },
    opportunities: [{ minute: 20, steps: [
      { stepType: 'PB_PASS', from: { name: 'Home Passer', position: 'CM' },
        to: { name: 'Home Scorer', position: 'FW' }, attackingTeam: 'Home Team', attackingSide: 'home' },
      { stepType: 'PB_DUEL', defender: { name: 'Away Defender', position: 'CB' },
        attacker: { name: 'Home Scorer', position: 'FW' },
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'WON',
        values: { tackle: { value: 55 } } },
      { stepType: 'SHOT', shooter: { name: 'Home Scorer', position: 'FW' },
        gk: { name: 'Away Keeper', position: 'GK' }, attackingTeam: 'Home Team', attackingSide: 'home',
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'GOAL' },
    ] }, { minute: 25, steps: [
      { stepType: 'START_PASS', from: { name: 'Other Home', position: 'RB' },
        to: { name: 'Blocked Target', position: 'RW' }, attackingTeam: 'Home Team', attackingSide: 'home' },
      { stepType: 'MID_DUEL', attacker: { name: 'Blocked Target', position: 'RW' },
        defender: { name: 'Away Defender', position: 'CB' }, defendingTeam: 'Away Team',
        defendingSide: 'away', outcome: 'BLOCKED', values: {} },
    ] }, { minute: 30, steps: [
      { stepType: 'SHOT', shooter: { name: 'Home Scorer', position: 'FW' },
        gk: { name: 'Away Keeper', position: 'GK' }, attackingTeam: 'Home Team', attackingSide: 'home',
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'SAVED' },
      { stepType: 'MID_DUEL', defender: { name: 'Away Keeper', position: 'GK' },
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'GK_INTERCEPT', values: {} },
    ] }, { minute: 35, steps: [
      { stepType: 'START_PASS', from: { name: 'Home Passer', position: 'CM' },
        to: { name: 'Home Controller', position: 'CM' }, attackingTeam: 'Home Team', attackingSide: 'home' },
      { stepType: 'MID_DUEL', attacker: { name: 'Home Controller', position: 'CM' },
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'POSSESSION', values: {} },
    ] }, { minute: 50, steps: [
      { stepType: 'MID_DUEL', attacker: { name: 'Home Controller', position: 'CM' },
        defender: { name: 'Away Defender', position: 'CB' },
        fouler: { name: 'Away Defender', position: 'CB' },
        yellowCard: { name: 'Away Defender', position: 'CB' },
        defendingTeam: 'Away Team', defendingSide: 'away', outcome: 'FOUL', values: {} },
    ] }],
    tacticalEvents: [
      { type: 'TIREDNESS', minute: 38, sequence: 38, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Passer', position: 'CM' }, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 40, sequence: 40, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Scorer', position: 'FW' }, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 44, sequence: 44, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Passer', position: 'CM' }, level: 'VERY_TIRED' },
      { type: 'HALF_TIME', minute: 45, sequence: 45 },
      { type: 'INJURY', minute: 50, sequence: 50, team: 'Away Team', teamSide: 'away',
        player: { name: 'Away Defender', position: 'CB' }, severity: 'LIGHT' },
      { type: 'SUBSTITUTION', minute: 60, sequence: 60, team: 'Home Team', teamSide: 'home',
        playerOut: { name: 'Home Scorer', position: 'FW' }, playerIn: { name: 'Home Sub', position: 'FW' } },
      { type: 'TIREDNESS', minute: 68, sequence: 68, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Passer', position: 'CM' }, level: 'TIRED' },
      { type: 'TIREDNESS', minute: 75, sequence: 75, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Sub', position: 'FW' }, level: 'VERY_TIRED' },
      { type: 'TIREDNESS', minute: 82, sequence: 82, team: 'Home Team', teamSide: 'home',
        player: { name: 'Home Passer', position: 'CM' }, level: 'VERY_TIRED' },
    ],
  };
  const stats = A.playerStatistics(match);
  const passer = stats.home.find(p => p.name === 'Home Passer');
  const scorer = stats.home.find(p => p.name === 'Home Scorer');
  const sub = stats.home.find(p => p.name === 'Home Sub');
  const defender = stats.away.find(p => p.name === 'Away Defender');
  const keeper = stats.away.find(p => p.name === 'Away Keeper');

  assert.equal(passer.passes, 2);
  assert.equal(passer.completedPasses, 2, 'a pass completed by a shot and one completed by possession both count');
  assert.equal(passer.passCompletionPct, 100);
  assert.deepEqual(passer.tiredMinutes, [38, 68]);
  assert.deepEqual(passer.veryTiredMinutes, [44, 82]);
  assert.equal(passer.assists, 1);
  assert.equal(scorer.shots, 2);
  assert.equal(scorer.shotsOnTarget, 2);
  assert.equal(scorer.goals, 1);
  assert.equal(scorer.minutesPlayed, 60);
  assert.deepEqual(scorer.tiredMinutes, [40]);
  assert.equal(sub.minutesPlayed, 30);
  assert.deepEqual(sub.veryTiredMinutes, [75]);
  assert.equal(defender.tackles, 1);
  assert.equal(defender.blocks, 1);
  assert.equal(defender.fouls, 1);
  assert.deepEqual(defender.yellowCards, [50]);
  assert.deepEqual(defender.injuries, [{ minute: 50, severity: 'LIGHT' }]);
  assert.equal(keeper.saves, 1);
  assert.equal(keeper.shotsFaced, 2);
  assert.equal(keeper.interceptions, 1);
  assert.equal(stats.home.find(p => p.name === 'Other Home').completedPasses, 0,
    'a blocked pass is not completed even if play continues afterward');
  const scorerIndex = stats.home.findIndex(p => p.name === 'Home Scorer');
  assert.equal(stats.home[scorerIndex + 1].name, 'Home Sub', 'the replacement is grouped after the outgoing player');
  assert.equal(sub.replacedPlayer, 'Home Scorer');
  assert.equal(sub.substitutedInMinute, 60);
});

test('playerStatistics breaks duel wins into Position/Control/Tackle, combining attacking and defending duels into one per-player count', () => {
  const match = {
    playerRegistry: {},
    opportunities: [{ minute: 1, steps: [
      // No tackle attempted (positioning alone decided it) — a Position win for the attacker.
      { stepType: 'MID_DUEL', attacker: { name: 'Attacker A', position: 'FW' },
        defender: { name: 'Defender X', position: 'CB' },
        attackingTeam: 'Home Team', attackingSide: 'home',
        defendingTeam: 'Away Team', defendingSide: 'away',
        outcome: 'POSSESSION', values: {} },
    ] }, { minute: 2, steps: [
      // Tackle contested, attacker keeps the ball — a Control win for the attacker.
      { stepType: 'PB_DUEL', attacker: { name: 'Attacker A', position: 'FW' },
        defender: { name: 'Defender X', position: 'CB' },
        attackingTeam: 'Home Team', attackingSide: 'home',
        defendingTeam: 'Away Team', defendingSide: 'away',
        outcome: 'WON', values: { tackle: { value: 40 } } },
    ] }, { minute: 3, steps: [
      // Tackle contested, defender wins it — a Tackle win for the defender, not a win for the attacker.
      { stepType: 'MID_DUEL', attacker: { name: 'Attacker A', position: 'FW' },
        defender: { name: 'Defender X', position: 'CB' },
        attackingTeam: 'Home Team', attackingSide: 'home',
        defendingTeam: 'Away Team', defendingSide: 'away',
        outcome: 'CLEARED', values: { tackle: { value: 70 } } },
    ] }, { minute: 4, steps: [
      // A dribble is mechanically the same 1v1 contest — must count toward Defender X's own
      // duel record as the attacker this time, combined with their earlier defensive duels.
      { stepType: 'DRIB', dribbler: { name: 'Defender X', position: 'CB' },
        defender: { name: 'Attacker A', position: 'FW' },
        attackingTeam: 'Away Team', attackingSide: 'away',
        defendingTeam: 'Home Team', defendingSide: 'home',
        outcome: 'POSSESSION', values: {} },
    ] }],
    tacticalEvents: [],
  };
  const stats = A.playerStatistics(match);
  const attackerA = stats.home.find(p => p.name === 'Attacker A');
  const defenderX = stats.away.find(p => p.name === 'Defender X');

  // Attacker A: attacked in all 4 duels (won 2, lost 1) and defended in 1 (the dribble) = 4 played.
  assert.equal(attackerA.duelsPlayed, 4);
  assert.equal(attackerA.duelsWonPosition, 1);
  assert.equal(attackerA.duelsWonControl, 1);
  assert.equal(attackerA.duelsWonTackle, 0, 'Attacker A never defended a contested tackle successfully');

  // Defender X: defended in 3 duels (won 1 via tackle) and attacked in 1 (the dribble, won) = 4 played.
  assert.equal(defenderX.duelsPlayed, 4);
  assert.equal(defenderX.duelsWonPosition, 1, 'the won dribble counts as a Position win — no tackle was contested');
  assert.equal(defenderX.duelsWonControl, 0);
  assert.equal(defenderX.duelsWonTackle, 1);
});

test('playerStatistics uses a 120-minute duration when extra time is observed', () => {
  const stats = A.playerStatistics({
    playerRegistry: { Veteran: { team: 'Home', side: 'home', positions: ['CM'] } },
    opportunities: [],
    tacticalEvents: [{ type: 'EXTRA_TIME_BREAK', minute: 90, sequence: 1 }],
  });
  assert.equal(stats.matchMinutes, 120);
  assert.equal(stats.home[0].minutesPlayed, 120);
});

test('playerStatistics assigns each player to one canonical side despite conflicting action stamps', () => {
  const stats = A.playerStatistics({
    meta: { homeTeam: 'Home Team', awayTeam: 'Away Team' },
    playerRegistry: {
      Tsur: { team: 'Away Team', side: 'away', positions: ['FW'] },
      Ryszawa: { team: 'Home Team', side: 'home', positions: ['LW'] },
    },
    opportunities: [{ minute: 10, steps: [
      { stepType: 'SHOT', shooter: { name: 'Tsur', position: 'FW', team: 'Home Team', side: 'home' },
        attackingTeam: 'Home Team', attackingSide: 'home', outcome: 'MISSED' },
      { stepType: 'SHOT', shooter: { name: 'Ryszawa', position: 'LW', team: 'Home Team', side: 'home' },
        attackingTeam: 'Home Team', attackingSide: 'home', outcome: 'MISSED' },
    ] }],
    tacticalEvents: [{ type: 'TIREDNESS', minute: 70, sequence: 70,
      team: 'Away Team', teamSide: 'away', player: { name: 'Ryszawa', position: 'LW' }, level: 'TIRED' }],
  });
  assert.deepEqual(stats.home.map(p => p.name), []);
  assert.deepEqual(stats.away.map(p => p.name).sort(), ['Ryszawa', 'Tsur']);
  assert.equal(stats.away.find(p => p.name === 'Tsur').shots, 1,
    'registry ownership must override a conflicting action stamp');
  assert.equal(stats.away.find(p => p.name === 'Ryszawa').shots, 1,
    'an explicit team-attributed event must override weaker registry/action evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// assistanceAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('assistanceAnalysis reports observed values without inferring Teamwork', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  const result = A.assistanceAnalysis(match);
  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].player.name, 'Player C');
  assert.ok(result.note.toLowerCase().includes('teamwork'));
  assert.ok(!('teamwork' in result), 'must not expose a synthesized personality field');
});

// ─────────────────────────────────────────────────────────────────────────────
// fatigueImpact
// ─────────────────────────────────────────────────────────────────────────────

test('fatigueImpact is observational — it does not itself claim a decline', () => {
  const narrative = [
    'Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]'),
    'Minute 40', 'Home Team - Player B [CM] looks tired.',
  ].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  const result = A.fatigueImpact(match).find(r => r.player.name === 'Player B');
  assert.ok(result);
  assert.equal(result.before.attackingDuels, 1);
  assert.equal(result.after.attackingDuels, 0);
  // The function must never itself assert causation — only a Manual-linked note, kept
  // in a clearly separate string field.
  assert.ok(result.note.includes('not a causal claim'));
  assert.ok(!('decline' in result) && !('caused' in result));
});

// ─────────────────────────────────────────────────────────────────────────────
// laneAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('laneAnalysis buckets by actual reported position, not preferred foot, and does not assert Preferred Side', () => {
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Player A [LB] attempted low good pass to Player B [LM]',
    'Player C [RB] got decent assistance, and was in decent position.',
    'Player B [LM] made weak reception, Player C [RB] made superb tackle.',
    'Player C [RB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_MID_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const lanes = A.laneAnalysis(match);
  assert.equal(lanes.home.left.opportunityStarts, 1, 'LB starts on the left lane');
  assert.equal(lanes.home.left.passes, 1);
  assert.ok(lanes.note.toLowerCase().includes('preferred side'));
});

test('laneAnalysis keeps attack origin and turnover location as separate lanes — a wide start does not mask a central PB turnover', () => {
  const narrative = [
    'Minute 15', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [RM]',
    'Player C [LB] got weak assistance, and was close.',
    'Player B [RM] made superb reception and took control of the ball.',
    'Penalty Box',
    'Player B [RM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made weak reception, Player E [CB] made superb tackle.',
    'Player E [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "15' - H - O_MID_START", "15' - H - V_PASS - (55)", "15' - A - V_ASSISTANCE - (35)", "15' - H - V_RECEPTION - (65)",
    "15' - H - V_PASS - (45)", "15' - A - V_ASSISTANCE - (55)", "15' - H - V_RECEPTION - (30)", "15' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const lanes = A.laneAnalysis(match);
  // The attack STARTED on the right (RB), but the turnover happened via the central FW
  // losing the PB duel — these must land in different lane buckets, not collapse into
  // one number that would misreport where the attack actually originated.
  assert.equal(lanes.home.right.opportunityStarts, 1, 'the attack started from the right-back');
  assert.equal(lanes.home.center.opportunityStarts ?? 0, 0);
  assert.equal(lanes.home.center.turnovers, 1, 'the turnover itself happened via the central forward');
  assert.equal(lanes.home.right.turnovers ?? 0, 0, 'the turnover must not be misattributed back to the origin lane');
});

// ─────────────────────────────────────────────────────────────────────────────
// counterAttackAnalysis (regression: existing CA step ownership)
// ─────────────────────────────────────────────────────────────────────────────

test('counter-attack step ownership remains correct: created/conceded/shots/goals attributed to the actual attacking side', () => {
  const narrative = [
    'Minute 70', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RWB] attempted low good pass to Player B [RW]',
    'Player C [LB] got poor assistance, and was close.',
    'Player B [RW] made excellent reception and took control of the ball.',
    'Counter attack', 'Midfield',
    'Player X [FW] attempted low good pass to Player Y [LW]',
    'Player D [CM] got weak assistance, and was close.',
    'Player Y [LW] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player Y [LW] attempted low decent pass to Player X [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player X [FW] made good reception, Player E [CB] made weak tackle.',
    'Player X [FW] took control of the ball.',
    'Goal Attempt', 'Player X [FW] made superb shot.', 'Player Z [GK] was fooled.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "70' - H - O_MID_START", "70' - H - V_PASS - (60)", "70' - A - V_ASSISTANCE - (30)",
    "70' - H - V_RECEPTION - (70)", "70' - A - E_COUNTER_ATTACK",
    "70' - A - V_PASS - (55)", "70' - H - V_ASSISTANCE - (35)", "70' - A - V_RECEPTION - (65)",
    "70' - A - V_PASS - (50)", "70' - H - V_ASSISTANCE - (40)", "70' - A - V_RECEPTION - (60)",
    "70' - H - V_TACKLING - (35)", "70' - A - V_SHOT - (75)", "70' - H - V_REFLEX - (25)", "70' - A - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const ca = A.counterAttackAnalysis(match);
  assert.equal(ca.away.created, 1);
  assert.equal(ca.away.goals, 1);
  assert.equal(ca.home.conceded, 1);
  assert.equal(ca.home.goalsConceded, 1);
  assert.equal(ca.home.created, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// setPieceAnalysis / goalkeeperAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('goalkeeper fumble and rebound are both captured with correct outcomes', () => {
  const narrative = [
    'Minute 7', 'Opportunity for Home Team.', 'Midfield',
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
    "7' - H - O_DEF_START", "7' - H - V_PASS - (65)", "7' - A - V_ASSISTANCE - (30)",
    "7' - H - V_RECEPTION - (55)", "7' - H - V_PASS - (75)", "7' - A - V_ASSISTANCE - (65)",
    "7' - H - V_RECEPTION - (85)", "7' - A - V_TACKLING - (40)",
    "7' - H - V_SHOT - (55)", "7' - A - V_REFLEX - (75)", "7' - A - E_FUMBLE",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Player G'];
  assert.equal(gk.shotsFaced, 1);
  assert.equal(gk.fumbles, 1);
  assert.equal(gk.saves, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// shot/pass profile: no player-order inference
// ─────────────────────────────────────────────────────────────────────────────

test('an observed shot type is reported without implying the corresponding player order was active', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt', 'Player D [FW] made excellent quick shot.',
    'Player G [GK] was hesitant, and made superb effort to prevent goal.',
    'Player G [GK] could not handle the ball.', 'GOAL!',
  ].join('\n');
  const telemetry = [
    "40' - H - O_PB_START", "40' - H - V_PASS - (55)", "40' - A - V_ASSISTANCE - (30)",
    "40' - H - V_RECEPTION - (65)", "40' - A - V_TACKLING - (35)",
    "40' - H - V_SHOT - (70)", "40' - A - V_REFLEX - (20)", "40' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const profile = A.shotProfileAnalysis(match);
  assert.equal(profile.home.quick.attempts, 1);
  assert.ok(profile.note.includes('does not by itself prove'));
});

test('a direct free kick narrated as a Long Shot Goal Attempt keeps both dimensions instead of collapsing into just one', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Free Kick',
    'Player A [CM] has decided to restart the attack',
    'Long Shot Goal Attempt',
    'Player A [CM] made superb shot.',
    'Player G [GK] was fooled.',
    'GOAL!',
  ].join('\n');
  const telemetry = [
    "40' - H - O_FK_START", "40' - H - V_SHOT - (80)", "40' - A - V_REFLEX - (15)", "40' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const shots = A.collectShotEvents(match);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].isDirectFreeKick, true);
  assert.equal(shots[0].technique, 'long shot', 'technique and set-piece context are separate dimensions on the same event');
  const profile = A.shotProfileAnalysis(match);
  assert.equal(profile.home['long shot (direct free kick)'].attempts, 1,
    'the combined bucket must preserve both facts instead of only "long shot" or only "direct free kick"');
});

test('a penalty is classified by technique regardless of the isDirectFreeKick/isLongShot flags', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
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
    "40' - H - O_PB_START", "40' - H - V_PASS - (55)", "40' - A - V_ASSISTANCE - (40)",
    "40' - H - V_RECEPTION - (60)", "40' - A - V_TACKLING - (30)",
    "40' - A - E_PENALTY_KICK",
    "40' - H - V_SHOT - (75)", "40' - A - V_REFLEX - (20)", "40' - H - E_GOAL",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const profile = A.shotProfileAnalysis(match);
  assert.ok(profile.home.penalty, 'a penalty must classify as penalty, not get folded into a direct-free-kick/long-shot bucket');
});

test('an off-target shot is counted in shots faced but not in on-target, and a GK interception is not a shot at all', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made poor shot.',
    'Player G [GK] was on the right spot, and made good effort to prevent goal.',
    'Missed the goal wide!',
  ].join('\n');
  const telemetry = [
    "40' - H - O_PB_START", "40' - H - V_PASS - (55)", "40' - A - V_ASSISTANCE - (30)",
    "40' - H - V_RECEPTION - (65)", "40' - A - V_TACKLING - (35)",
    "40' - H - V_SHOT - (25)", "40' - A - V_REFLEX - (60)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Player G'];
  assert.equal(gk.shotsFaced, 1, 'the narrative still named a keeper for this attempt, so it counts as faced');
  assert.equal(gk.onTarget, 0, 'a missed (off-target) shot must not count as on target');
  assert.equal(gk.offTargetOrBlocked, 1);
  assert.equal(gk.saves, 0);
  assert.equal(gk.interceptions, 0);
});

test('a GK interception does not increment shotsFaced or onTarget — it is not a shot event at all', () => {
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player G [GK] intercepted the ball.',
  ].join('\n');
  const telemetry = ["40' - H - O_PB_START", "40' - H - V_PASS - (55)"].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Player G'];
  assert.equal(gk.interceptions, 1);
  assert.equal(gk.shotsFaced, 0, 'an interception is not a shot faced');
  assert.equal(gk.onTarget, 0);
});

test('a shot whose resolution line was never captured (a scrape cut off mid-attempt) is counted as shotsFaced but unresolved, not silently folded into on-target or off-target', () => {
  // The GK is named ("was ready, and made X effort") but the narrative stops there —
  // no GOAL!/save/miss resolution line follows, exactly like a report scraped while the
  // match was still in progress.
  const narrative = [
    'Minute 40', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [LM] attempted low good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made good reception, Player E [CB] made weak tackle.',
    'Player D [FW] took control of the ball.',
    'Goal Attempt',
    'Player D [FW] made decent shot.',
    'Player G [GK] was ready, and made good effort to prevent goal.',
  ].join('\n');
  const telemetry = [
    "40' - H - O_PB_START", "40' - H - V_PASS - (55)", "40' - A - V_ASSISTANCE - (30)",
    "40' - H - V_RECEPTION - (65)", "40' - A - V_TACKLING - (35)",
    "40' - H - V_SHOT - (60)", "40' - A - V_REFLEX - (40)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const shots = A.collectShotEvents(match);
  assert.equal(shots.length, 1);
  // Not null: parser.js's phase.outcome is a single shared field across the whole PB
  // progression, and "took control of the ball" already stamped it POSSESSION as a
  // work-in-progress marker before the shot — with no later resolution line to
  // overwrite it, that stale mid-progression value is what the SHOT step inherits. The
  // point of this test is that goalkeeperAnalysis must not mistake THIS for any of
  // GOAL/SAVED/FUMBLED/MISSED/POST/SHOT_BLOCKED — its catch-all handles any non-terminal
  // value, not just a literal null.
  assert.equal(shots[0].result, 'POSSESSION');
  assert.equal(shots[0].isGoal, false);
  assert.equal(shots[0].isSaved, false);
  assert.equal(shots[0].isFumbled, false);
  assert.equal(shots[0].isMissed, false);
  assert.equal(shots[0].isBlocked, false);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Player G'];
  assert.equal(gk.shotsFaced, 1);
  assert.equal(gk.onTarget, 0, 'must not guess this was on target');
  assert.equal(gk.offTargetOrBlocked, 0, 'must not guess this was off target either');
  assert.equal(gk.unresolved, 1);
  assert.equal(gk.shotsFaced, gk.onTarget + gk.offTargetOrBlocked + gk.unresolved,
    'shotsFaced must always equal the sum of its three sub-categories');
  const reconciliation = A.reconcileScoutingReport(match);
  assert.equal(reconciliation.valid, true, JSON.stringify(reconciliation.mismatches));
});

test('an observed high pass is counted without implying a High Ball order', () => {
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made weak reception, Player E [CB] made superb tackle.',
    'Player E [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = midTelemetryLines(10, 'H').join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const profile = A.passProfileAnalysis(match);
  assert.equal(profile.byHeight.home.high, 1);
  assert.ok(profile.note.includes('not a declared'));
});

test('a long-ball sequence is reported as an observed route, not a Long Balls tactical style claim', () => {
  const narrative = [
    'Minute 10', 'Opportunity for Home Team.', 'Penalty Box',
    'Player A [RB] attempted high good pass to Player D [FW]',
    'Player E [CB] got decent assistance, and was in decent position.',
    'Player D [FW] made weak reception, Player E [CB] made superb tackle.',
    'Player E [CB] cleared the ball to safety.',
  ].join('\n');
  const telemetry = [
    "10' - H - O_PB_START", "10' - H - V_PASS - (30)", "10' - A - V_ASSISTANCE - (40)",
    "10' - H - V_RECEPTION - (25)", "10' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, HA);
  const e = A.opportunityFunnel(match).entries[0];
  assert.equal(e.progressionType, 'LONG_BALL');
  // No field anywhere on the funnel entry asserts a "Long Balls" team-order setting.
  assert.ok(!('style' in e) && !('tacticalStyle' in e));
});

// ─────────────────────────────────────────────────────────────────────────────
// small-sample discipline
// ─────────────────────────────────────────────────────────────────────────────

test('sampleSizeHint follows the documented display thresholds', () => {
  assert.equal(A.sampleSizeHint(0), 'very small sample');
  assert.equal(A.sampleSizeHint(2), 'very small sample');
  assert.equal(A.sampleSizeHint(3), 'small sample');
  assert.equal(A.sampleSizeHint(5), 'small sample');
  assert.equal(A.sampleSizeHint(6), 'moderate sample');
  assert.equal(A.sampleSizeHint(10), 'moderate sample');
  assert.equal(A.sampleSizeHint(11), 'larger sample');
});

// ─────────────────────────────────────────────────────────────────────────────
// degraded parser validation propagates analytical confidence
// ─────────────────────────────────────────────────────────────────────────────

test('degraded parser validation propagates into analytics confidence fields', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  // No telemetry at all for this minute — parseMatch marks this opportunity's stream
  // match as 'none', which degrades match.validation.confidence.
  const match = parseMatch('', narrative, HA);
  assert.equal(match.validation.confidence, 'degraded');
  assert.equal(A.parserConfidence(match), 'degraded');
  assert.equal(A.opportunityFunnel(match).confidence, 'degraded');
  assert.equal(A.assistanceAnalysis(match).confidence, 'degraded');
});

test('exact parser validation keeps analytics confidence exact', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  assert.equal(match.validation.confidence, 'exact');
  assert.equal(A.opportunityFunnel(match).confidence, 'exact');
});

// ─────────────────────────────────────────────────────────────────────────────
// duelMatchups
// ─────────────────────────────────────────────────────────────────────────────

function pbDuelStep({ attacker, defender, outcome, tackle, side = 'home', isCA = false }) {
  return {
    stepType: 'PB_DUEL', attacker, defender, outcome, isCA,
    attackingTeam: side === 'home' ? 'Home Team' : 'Away Team', attackingSide: side,
    defendingTeam: side === 'home' ? 'Away Team' : 'Home Team', defendingSide: side === 'home' ? 'away' : 'home',
    values: { reception: { value: 60 }, assistance: { value: 40 }, tackle: tackle != null ? { value: tackle } : null },
  };
}
function shotStep({ shooter, outcome, side = 'home', isCA = false }) {
  return {
    stepType: 'SHOT', shooter, outcome, isCA,
    attackingSide: side, defendingSide: side === 'home' ? 'away' : 'home',
    values: { shot: { value: 70 }, gkSave: { value: 50 } },
  };
}
const P = (name, position) => ({ name, position });

test('duelMatchups: repeated attacker-v-defender PB matchup accumulates one entry with contests=2', () => {
  const A1 = P('Tsur', 'FW'), D1 = P('Golan', 'CB');
  const match = { opportunities: [
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D1, outcome: 'WON', tackle: 40 })] },
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D1, outcome: 'CLEARED', tackle: 60 })] },
  ] };
  const matchups = A.duelMatchups(match);
  assert.equal(matchups.length, 1);
  assert.equal(matchups[0].contests, 2);
  assert.equal(matchups[0].attackerWins, 1);
  assert.equal(matchups[0].defenderWins, 1);
  assert.equal(matchups[0].attackerWinRate, 0.5);
  assert.equal(matchups[0].zone, 'PENALTY_BOX');
});

test('duelMatchups: same attacker facing two different defenders produces two distinct entries', () => {
  const A1 = P('Tsur', 'FW');
  const match = { opportunities: [
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: P('Golan', 'CB'), outcome: 'WON', tackle: 40 })] },
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: P('Silva', 'CB'), outcome: 'WON', tackle: 40 })] },
  ] };
  const matchups = A.duelMatchups(match);
  assert.equal(matchups.length, 2);
  assert.deepEqual(matchups.map(m => m.defender).sort(), ['Golan', 'Silva']);
});

test('duelMatchups: same defender facing two different attackers produces two distinct entries', () => {
  const D1 = P('Golan', 'CB');
  const match = { opportunities: [
    { teamSide: 'home', steps: [pbDuelStep({ attacker: P('Tsur', 'FW'), defender: D1, outcome: 'CLEARED', tackle: 60 })] },
    { teamSide: 'home', steps: [pbDuelStep({ attacker: P('Ryszawa', 'FW'), defender: D1, outcome: 'CLEARED', tackle: 60 })] },
  ] };
  const matchups = A.duelMatchups(match);
  assert.equal(matchups.length, 2);
  assert.deepEqual(matchups.map(m => m.attacker).sort(), ['Ryszawa', 'Tsur']);
});

test('duelMatchups: an attacker win followed by a shot is credited to that matchup, a win followed by a goal increments both counters', () => {
  const A1 = P('Tsur', 'FW'), D1 = P('Golan', 'CB');
  const duel1 = pbDuelStep({ attacker: A1, defender: D1, outcome: 'WON', tackle: 40 });
  const match = { opportunities: [
    { teamSide: 'home', steps: [duel1, shotStep({ shooter: A1, outcome: 'SAVED' })] },
  ] };
  let matchups = A.duelMatchups(match);
  assert.equal(matchups[0].shotsAfterAttackerWin, 1);
  assert.equal(matchups[0].goalsAfterAttackerWin, 0);

  const duel2 = pbDuelStep({ attacker: A1, defender: D1, outcome: 'WON', tackle: 40 });
  const matchGoal = { opportunities: [
    { teamSide: 'home', steps: [duel2, shotStep({ shooter: A1, outcome: 'GOAL' })] },
  ] };
  matchups = A.duelMatchups(matchGoal);
  assert.equal(matchups[0].shotsAfterAttackerWin, 1);
  assert.equal(matchups[0].goalsAfterAttackerWin, 1);
});

test('duelMatchups: a defender win (PB loss for the attacker) correctly terminates the attack with no shot credited', () => {
  const A1 = P('Tsur', 'FW'), D1 = P('Golan', 'CB');
  const match = { opportunities: [
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D1, outcome: 'CLEARED', tackle: 70 })] },
  ] };
  const matchups = A.duelMatchups(match);
  assert.equal(matchups[0].defenderWins, 1);
  assert.equal(matchups[0].attackerWins, 0);
  assert.equal(matchups[0].shotsAfterAttackerWin, 0);
});

test('duelMatchups: CA action ownership stays step-side correct — a pre-CA duel is not credited with a post-CA shot', () => {
  const A1 = P('Wu', 'LW'), D1 = P('Marks', 'RB');
  const preCA = pbDuelStep({ attacker: A1, defender: D1, outcome: 'WON', tackle: 30, side: 'home', isCA: false });
  const postCAShot = shotStep({ shooter: P('Dia', 'FW'), outcome: 'GOAL', side: 'away', isCA: true });
  const match = { opportunities: [{ teamSide: 'home', isCounterAttack: true, steps: [preCA, postCAShot] }] };
  const matchups = A.duelMatchups(match);
  assert.equal(matchups[0].attacker, 'Wu');
  assert.equal(matchups[0].shotsAfterAttackerWin, 0, 'the post-CA shot belongs to a different attacking side, not this pre-CA duel');
});

// ─────────────────────────────────────────────────────────────────────────────
// pbTargetAnalysis / pbDefenderAnalysis
// ─────────────────────────────────────────────────────────────────────────────

test('pbTargetAnalysis and pbDefenderAnalysis report matching won/lost counts and the main opponent faced', () => {
  const A1 = P('Tsur', 'FW'), D1 = P('Golan', 'CB'), D2 = P('Silva', 'CB');
  const match = { opportunities: [
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D1, outcome: 'WON', tackle: 40 }), shotStep({ shooter: A1, outcome: 'GOAL' })] },
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D1, outcome: 'CLEARED', tackle: 70 })] },
    { teamSide: 'home', steps: [pbDuelStep({ attacker: A1, defender: D2, outcome: 'CLEARED', tackle: 70 })] },
  ] };
  const targets = A.pbTargetAnalysis(match);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].pbContests, 3);
  assert.equal(targets[0].won, 1);
  assert.equal(targets[0].lost, 2);
  assert.equal(targets[0].goals, 1);
  assert.equal(targets[0].mainDefender.name, 'Golan');
  assert.equal(targets[0].mainDefender.contests, 2);

  const defenders = A.pbDefenderAnalysis(match);
  const golan = defenders.find(d => d.player === 'Golan');
  assert.equal(golan.contests, 2);
  assert.equal(golan.won, 1);
  assert.equal(golan.lost, 1);
  assert.equal(golan.goalsAllowedAfterLoss, 1);
  assert.equal(golan.mainOpponent.name, 'Tsur');
});

// ─────────────────────────────────────────────────────────────────────────────
// attackingRoutes
// ─────────────────────────────────────────────────────────────────────────────

function passStep(stepType, from, to, side = 'home') {
  return { stepType, from, to, attackingSide: side, defendingSide: side === 'home' ? 'away' : 'home', values: { pass: { value: 60 } } };
}

test('attackingRoutes: a repeated three-player chain (RB -> RM -> FW) is aggregated as one route with occurrences=3', () => {
  const rb = P('Bilardo', 'RB'), rm = P('Bakkely', 'RM'), fw = P('Tsur', 'FW');
  const oneOpp = () => ({ teamSide: 'home', steps: [
    passStep('START_PASS', rb, rm),
    passStep('PB_PASS', rm, fw),
    shotStep({ shooter: fw, outcome: 'SAVED' }),
  ] });
  const match = { opportunities: [oneOpp(), oneOpp(), oneOpp()] };
  const routes = A.attackingRoutes(match);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].occurrences, 3);
  assert.deepEqual(routes[0].chain.map(n => n.name), ['Bilardo', 'Bakkely', 'Tsur']);
  assert.equal(routes[0].pbEntries, 3);
  assert.equal(routes[0].shots, 3);
});

test('attackingRoutes: a direct defender-to-forward route (no midfield relay) is captured as its own two-node chain', () => {
  const cb = P('Harrell', 'CB'), fw = P('Tsur', 'FW');
  const match = { opportunities: [{ teamSide: 'home', steps: [
    passStep('START_PASS', cb, fw),
    shotStep({ shooter: fw, outcome: 'MISSED' }),
  ] }] };
  const routes = A.attackingRoutes(match);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].chain.map(n => n.name), ['Harrell', 'Tsur']);
});

test('attackingRoutes: a chain occurrence with no PB entry is still counted, just with pbEntries=0', () => {
  const rb = P('Bilardo', 'RB'), cm = P('Styrczula', 'CM');
  const match = { opportunities: [{ teamSide: 'home', steps: [
    passStep('START_PASS', rb, cm),
  ] }] };
  const routes = A.attackingRoutes(match);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pbEntries, 0);
  assert.equal(routes[0].shots, 0);
});

test('attackingRoutes: a broken chain (recovery by an unrelated player) is not joined into one route', () => {
  const rb = P('Bilardo', 'RB'), cm = P('Styrczula', 'CM'), other = P('Recovered', 'LM'), fw = P('Tsur', 'FW');
  // Styrczula receives the start pass, but the PB pass is sent by an unrelated player
  // (e.g. after a recovered loose ball) — the chain must stop at Styrczula, not silently
  // extend to Tsur as if Styrczula had carried it forward themselves.
  const match = { opportunities: [{ teamSide: 'home', steps: [
    passStep('START_PASS', rb, cm),
    passStep('PB_PASS', other, fw),
  ] }] };
  const routes = A.attackingRoutes(match);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].chain.map(n => n.name), ['Bilardo', 'Styrczula'], 'the chain must stop where continuity broke, not jump to the unrelated PB pass');
});

// ─────────────────────────────────────────────────────────────────────────────
// attackTermination
// ─────────────────────────────────────────────────────────────────────────────

test('attackTermination categorizes each opportunity exactly once, using finalOutcome so a corner continuation is not double-counted', () => {
  const narrative = [
    'Minute 5', 'Opportunity for Home Team.', 'Midfield',
    'Player A [RB] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Player B [CM] attempted low decent pass to Player D [FW]',
    'Player E [CB] got good assistance, and was in decent position.',
    'Player D [FW] made weak reception, Player E [CB] made superb tackle.',
    'Player E [CB] sent ball to corner.',
    'Corner',
    'Player B [CM] made high decent pass to Player F [CB]',
    'Player E [CB] got weak assistance, and was close.',
    'Player F [CB] made superb reception and took control of the ball.',
    'Goal Attempt',
    'Player F [CB] made excellent shot.',
    'Player G [GK] was ready, and made excellent effort to prevent goal.',
    'GOAL!',
  ].join('\n');
  const match = parseMatch('', narrative, HA);
  const counts = A.attackTermination(match);
  const total = Object.values(counts.home).reduce((a, b) => a + b, 0);
  assert.equal(total, 1, 'one opportunity, however many phases it passed through via the corner, must count as exactly one termination');
  assert.equal(counts.home.GOAL, 1);
});

test('attackTermination reports OTHER_UNKNOWN rather than forcing an unresolved outcome into a category', () => {
  const opp = { teamSide: 'home', finalOutcome: null, steps: [{ stepType: 'START_PASS', from: P('A', 'RB'), to: P('B', 'CM') }] };
  assert.equal(A.classifyAttackTermination(opp), 'OTHER_UNKNOWN');
});

// ─────────────────────────────────────────────────────────────────────────────
// fatigueImpact — tired/very-tired/substitution timeline
// ─────────────────────────────────────────────────────────────────────────────

function tirednessEvent(minute, level, player, sequence) {
  return { type: 'TIREDNESS', minute, sequence, team: 'Home Team', teamSide: 'home', player, level };
}
function subEvent(minute, playerOut, sequence) {
  return { type: 'SUBSTITUTION', minute, sequence, team: 'Home Team', teamSide: 'home', playerOut, playerIn: P('Sub', 'CM') };
}

test('fatigueImpact: tired -> very tired -> substituted computes both minute-deltas correctly', () => {
  const player = P('Mustafa', 'CM');
  const match = { tacticalEvents: [
    tirednessEvent(42, 'TIRED', player, 42),
    tirednessEvent(77, 'VERY_TIRED', player, 77),
    subEvent(80, player, 80),
  ], opportunities: [] };
  const [result] = A.fatigueImpact(match);
  assert.equal(result.firstTiredMinute, 42);
  assert.equal(result.firstVeryTiredMinute, 77);
  assert.equal(result.substitutedAtMinute, 80);
  assert.equal(result.minutesFromFirstTiredToSub, 38);
  assert.equal(result.minutesFromFirstVeryTiredToSub, 3);
  assert.equal(result.remainedOnPitch, false);
});

test('fatigueImpact: a player reported tired but never substituted has remainedOnPitch true and null sub fields', () => {
  const player = P('Ryszawa', 'FW');
  const match = { tacticalEvents: [tirednessEvent(60, 'TIRED', player, 60)], opportunities: [] };
  const [result] = A.fatigueImpact(match);
  assert.equal(result.substitutedAtMinute, null);
  assert.equal(result.remainedOnPitch, true);
  assert.equal(result.minutesFromFirstTiredToSub, null);
});

test('fatigueImpact: a substitution before the player was ever reported very tired leaves minutesFromFirstVeryTiredToSub null', () => {
  const player = P('Golan', 'CB');
  const match = { tacticalEvents: [
    tirednessEvent(50, 'TIRED', player, 50),
    subEvent(65, player, 65),
  ], opportunities: [] };
  const [result] = A.fatigueImpact(match);
  assert.equal(result.firstVeryTiredMinute, null);
  assert.equal(result.minutesFromFirstVeryTiredToSub, null);
  assert.equal(result.minutesFromFirstTiredToSub, 15);
});

// ─────────────────────────────────────────────────────────────────────────────
// shot-producing opportunities vs total shot attempts
// ─────────────────────────────────────────────────────────────────────────────

test('opportunityFunnel: a rebound producing two shot attempts in one opportunity counts as one shot-producing opportunity but two shot attempts', () => {
  const fw = P('Tsur', 'FW');
  const match = { opportunities: [{ teamSide: 'home', steps: [
    shotStep({ shooter: fw, outcome: 'POST' }),
    shotStep({ shooter: fw, outcome: 'GOAL' }),
  ] }] };
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.home.shots, 1, 'one opportunity produced a shot, regardless of how many shot events it contains');
  assert.equal(funnel.home.shotAttempts, 2, 'both the post and the rebound goal are separate shot attempts');
});

// ─────────────────────────────────────────────────────────────────────────────
// defensiveExposure
// ─────────────────────────────────────────────────────────────────────────────

test('defensiveExposure counts outcome-based involvement, not a raw telemetry-value comparison', () => {
  const attacker = P('Tsur', 'FW'), defender = P('Golan', 'CB');
  // The defender "wins" this contest per the parsed outcome (CLEARED) even though the
  // raw tackle number (30) is lower than the attacker's reception number (60) would
  // suggest — defensiveExposure must follow the outcome, never re-judge from the values.
  const duel = pbDuelStep({ attacker, defender, outcome: 'CLEARED', tackle: 30 });
  duel.values.reception.value = 60;
  const shot = shotStep({ shooter: attacker, outcome: 'GOAL' });
  // A separate opportunity where the SAME defender instead loses (attacker wins outright)
  // is what actually creates a shot chain for defensiveExposure to attribute.
  const lostDuel = pbDuelStep({ attacker, defender, outcome: 'WON', tackle: 20 });
  const match = { opportunities: [
    { teamSide: 'home', steps: [duel] },
    { teamSide: 'home', steps: [lostDuel, shot] },
  ] };
  const exposure = A.defensiveExposure(match);
  const golan = exposure.find(e => e.player === 'Golan');
  assert.equal(golan.shotChainsInvolvedIn, 1, 'only the chain that actually reached a shot counts as a shot chain');
  assert.equal(golan.firstFailedDefensiveStageCount, 1);
  assert.equal(golan.goalsFollowingLoss, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Counter-attack ownership correctness pass — regression coverage per the Medak III
// validation (minute-36: Ravnogorac opens, loses the midfield duel, Medak counters
// through Gešević -> Kopranović -> Løfsgaard and shoots). Every metric below must
// attribute post-CA actions to the actual counter-attacking side (step.attackingSide),
// never to the parent opportunity's nominal owner.
// ─────────────────────────────────────────────────────────────────────────────

function caFixture({ outcome = 'SAVED' } = {}) {
  const tail = outcome === 'GOAL'
    ? ['Kari [GK] was ready, and made excellent effort to prevent goal.', 'GOAL!', '[0-1]']
    : ['Kari [GK] was ready, and made excellent effort to prevent goal.', 'Kari [GK] managed to get hold of the ball.', '[0-0]'];
  return [
    'Minute 36', 'Opportunity for Ravnogorac.', 'Midfield',
    'Player A [CM] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Counter attack', 'Midfield',
    'Gešević [DM] attempted low good pass to Kopranović [RM]',
    'Player X [CB] got weak assistance, and was close.',
    'Kopranović [RM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Kopranović [RM] attempted low decent pass to Løfsgaard [FW]',
    'Player Y [CB] got good assistance, and was in decent position.',
    'Løfsgaard [FW] made weak reception, Player Y [CB] made superb tackle.',
    'Løfsgaard [FW] took control of the ball.',
    'Goal Attempt',
    'Løfsgaard [FW] made decent shot.',
    ...tail,
  ].join('\n');
}
function caTelemetry(shotOutcomeTag = "36' - A - V_REFLEX - (70)") {
  return [
    "36' - A - O_MID_START", "36' - A - V_PASS - (55)", "36' - H - V_ASSISTANCE - (40)", "36' - A - V_RECEPTION - (30)", "36' - H - V_TACKLING - (75)",
    "36' - H - E_COUNTER_ATTACK",
    "36' - H - V_PASS - (60)", "36' - A - V_ASSISTANCE - (35)", "36' - H - V_RECEPTION - (70)",
    "36' - H - V_PASS - (50)", "36' - A - V_ASSISTANCE - (55)", "36' - H - V_RECEPTION - (35)", "36' - A - V_TACKLING - (65)",
    "36' - H - V_SHOT - (55)", shotOutcomeTag,
  ].join('\n');
}
const CA_TEAMS = { homeTeam: 'Medak III', awayTeam: 'Ravnogorac' };

test('CA scenario A: a counter-attack shot belongs to the counter-attacking team everywhere — funnel, shot profile, GK, PB target, PB defender', () => {
  const match = parseMatch(caTelemetry(), caFixture(), CA_TEAMS);
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.home.shotAttempts, 1, 'Medak (home) took the shot');
  assert.equal(funnel.away.shotAttempts, 0, 'Ravnogorac (away) never got a shot away');
  assert.equal(funnel.home.total, 1, 'Medak gets its own attacking-sequence entry');
  assert.equal(funnel.home.fwOpportunities, 0, 'Medak never opened a narrative Opportunity-for-X container');
  assert.equal(funnel.away.fwOpportunities, 1, 'Ravnogorac opened the one FW opportunity');

  const profile = A.shotProfileAnalysis(match);
  assert.equal(profile.home.normal.attempts, 1);
  assert.deepEqual(profile.away, {});

  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Kari'];
  assert.equal(gk.side, 'away', "Kari plays for Ravnogorac even though he faced Medak's shot");
  assert.equal(gk.shotsFaced, 1);
  assert.equal(gk.saves, 1);

  const target = A.pbTargetAnalysis(match).find(t => t.player === 'Løfsgaard');
  assert.equal(target.side, 'home');
  assert.equal(target.pbContests, 1);
  assert.equal(target.won, 1);

  const defender = A.pbDefenderAnalysis(match).find(d => d.player === 'Player Y');
  assert.equal(defender.side, 'away');
  assert.equal(defender.lost, 1);

  const reconciliation = A.reconcileScoutingReport(match);
  assert.equal(reconciliation.valid, true, `expected all invariants to hold: ${JSON.stringify(reconciliation.mismatches)}`);
});

test('CA scenario B: a counter-attack that ends before any shot records zero shots for both sides, not a phantom attribution', () => {
  const narrative = [
    'Minute 36', 'Opportunity for Ravnogorac.', 'Midfield',
    'Player A [CM] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Counter attack', 'Midfield',
    'Gešević [DM] attempted low good pass to Kopranović [RM]',
    'Player X [CB] got good assistance, and was in decent position.',
    'Kopranović [RM] made weak reception, Player X [CB] made superb tackle.',
    'Player X [CB] cleared the ball to safety.',
    '[0-0]',
  ].join('\n');
  const telemetry = [
    "36' - A - O_MID_START", "36' - A - V_PASS - (55)", "36' - H - V_ASSISTANCE - (40)", "36' - A - V_RECEPTION - (30)", "36' - H - V_TACKLING - (75)",
    "36' - H - E_COUNTER_ATTACK",
    "36' - H - V_PASS - (50)", "36' - A - V_ASSISTANCE - (60)", "36' - H - V_RECEPTION - (25)", "36' - A - V_TACKLING - (70)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, CA_TEAMS);
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.home.shotAttempts, 0);
  assert.equal(funnel.away.shotAttempts, 0);
  assert.equal(funnel.home.total, 1, "Medak's own (shotless) counter-attack sequence still gets counted");
  assert.equal(funnel.home.reachedMidfield, 1);
  const reconciliation = A.reconcileScoutingReport(match);
  assert.equal(reconciliation.valid, true, JSON.stringify(reconciliation.mismatches));
});

test('CA scenario C: a counter-attack goal is attributed to the counter-attacking team, not the parent opportunity owner', () => {
  const match = parseMatch(caTelemetry("36' - H - E_GOAL"), caFixture({ outcome: 'GOAL' }), CA_TEAMS);
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.home.goals, 1, "Medak's counter-attack sequence scored");
  assert.equal(funnel.away.goals, 0);
  const shots = A.collectShotEvents(match);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].attackingSide, 'home');
  assert.equal(shots[0].isGoal, true);
  const gk = A.goalkeeperAnalysis(match).byGoalkeeper['Kari'];
  assert.equal(gk.goalsConceded, 1);
  const reconciliation = A.reconcileScoutingReport(match);
  assert.equal(reconciliation.valid, true, JSON.stringify(reconciliation.mismatches));
});

test('CA scenario D: a counter-attack that wins a corner and then shoots keeps the shot on the counter-attacking side', () => {
  const narrative = [
    'Minute 36', 'Opportunity for Ravnogorac.', 'Midfield',
    'Player A [CM] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Counter attack', 'Midfield',
    'Gešević [DM] attempted low good pass to Kopranović [RM]',
    'Player X [CB] got weak assistance, and was close.',
    'Kopranović [RM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Kopranović [RM] attempted low decent pass to Løfsgaard [FW]',
    'Player Y [CB] got good assistance, and was in decent position.',
    'Løfsgaard [FW] made weak reception, Player Y [CB] made superb tackle.',
    'Player Y [CB] sent ball to corner.',
    'Corner',
    'Kopranović [RM] made high decent pass to Løfsgaard [FW]',
    'Player Y [CB] got weak assistance, and was close.',
    'Løfsgaard [FW] made superb reception and took control of the ball.',
    'Goal Attempt',
    'Løfsgaard [FW] made excellent shot.',
    'Kari [GK] was ready, and made excellent effort to prevent goal.',
    'Kari [GK] managed to get hold of the ball.',
    '[0-0]',
  ].join('\n');
  const telemetry = [
    "36' - A - O_MID_START", "36' - A - V_PASS - (55)", "36' - H - V_ASSISTANCE - (40)", "36' - A - V_RECEPTION - (30)", "36' - H - V_TACKLING - (75)",
    "36' - H - E_COUNTER_ATTACK",
    "36' - H - V_PASS - (60)", "36' - A - V_ASSISTANCE - (35)", "36' - H - V_RECEPTION - (70)",
    "36' - H - V_PASS - (50)", "36' - A - V_ASSISTANCE - (55)", "36' - H - V_RECEPTION - (35)", "36' - A - V_TACKLING - (65)",
    "36' - H - V_PASS - (65)", "36' - A - V_ASSISTANCE - (40)", "36' - H - V_RECEPTION - (80)",
    "36' - H - V_SHOT - (85)", "36' - A - V_REFLEX - (60)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, CA_TEAMS);
  const funnel = A.opportunityFunnel(match);
  assert.equal(funnel.home.shotAttempts, 1, "Medak's shot after winning their own corner is still Medak's");
  assert.equal(funnel.away.shotAttempts, 0);
  const termination = A.attackTermination(match);
  assert.equal((termination.home.SHOT_SAVED || 0) + (termination.away.SHOT_SAVED || 0), 1);
  assert.equal(termination.away.SHOT_SAVED || 0, 0, 'the save must not be filed under Ravnogorac');
});

test('CA scenario E: a counter-attack rebound produces two shot events, both correctly on the counter-attacking side', () => {
  const narrative = [
    'Minute 36', 'Opportunity for Ravnogorac.', 'Midfield',
    'Player A [CM] attempted low good pass to Player B [CM]',
    'Player C [DM] got weak assistance, and was close.',
    'Player B [CM] made weak reception, Player C [DM] made superb tackle.',
    'Player C [DM] cleared the ball to safety.',
    'Counter attack', 'Midfield',
    'Gešević [DM] attempted low good pass to Kopranović [RM]',
    'Player X [CB] got weak assistance, and was close.',
    'Kopranović [RM] made excellent reception and took control of the ball.',
    'Penalty Box',
    'Kopranović [RM] attempted low decent pass to Løfsgaard [FW]',
    'Player Y [CB] got good assistance, and was in decent position.',
    'Løfsgaard [FW] made weak reception, Player Y [CB] made superb tackle.',
    'Løfsgaard [FW] took control of the ball.',
    'Goal Attempt',
    'Løfsgaard [FW] made decent shot.',
    'Kari [GK] was hesitant, and made weak effort to prevent goal.',
    'Kari [GK] failed to get a hold of the ball!',
    'Kopranović [RM] was close and took control of the ball.',
    'Goal Attempt',
    'Kopranović [RM] made superb shot.',
    'Kari [GK] was ready, and made excellent effort to prevent goal.',
    'Kari [GK] managed to get hold of the ball.',
    '[0-0]',
  ].join('\n');
  const telemetry = [
    "36' - A - O_MID_START", "36' - A - V_PASS - (55)", "36' - H - V_ASSISTANCE - (40)", "36' - A - V_RECEPTION - (30)", "36' - H - V_TACKLING - (75)",
    "36' - H - E_COUNTER_ATTACK",
    "36' - H - V_PASS - (60)", "36' - A - V_ASSISTANCE - (35)", "36' - H - V_RECEPTION - (70)",
    "36' - H - V_PASS - (50)", "36' - A - V_ASSISTANCE - (55)", "36' - H - V_RECEPTION - (35)", "36' - A - V_TACKLING - (65)",
    "36' - H - V_SHOT - (55)", "36' - A - V_REFLEX - (30)",
    "36' - H - V_SHOT - (90)", "36' - A - V_REFLEX - (75)",
  ].join('\n');
  const match = parseMatch(telemetry, narrative, CA_TEAMS);
  const shots = A.collectShotEvents(match);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map(s => s.attackingSide), ['home', 'home']);
  assert.equal(A.opportunityFunnel(match).home.shotAttempts, 2);
  assert.equal(A.opportunityFunnel(match).home.shots, 1, 'both shots came from the same attacking sequence');
  const reconciliation = A.reconcileScoutingReport(match);
  assert.equal(reconciliation.valid, true, JSON.stringify(reconciliation.mismatches));
});

test('CA scenario F: attackingSequencesFor never invents a switch back to the original side — a counter-attacked opportunity yields at most one pre-CA and one post-CA sequence', () => {
  const match = parseMatch(caTelemetry(), caFixture(), CA_TEAMS);
  const opp = match.opportunities[0];
  const sequences = A.attackingSequencesFor(opp);
  assert.equal(sequences.length, 2, 'exactly one pre-CA and one post-CA sequence, never a third "switch back"');
  assert.equal(sequences[0].attackingSide, 'away');
  assert.equal(sequences[0].isCounterAttack, false);
  assert.equal(sequences[1].attackingSide, 'home');
  assert.equal(sequences[1].isCounterAttack, true);
  assert.ok(sequences[1].steps.every(s => s.isCA === true));
  assert.ok(sequences[0].steps.every(s => s.isCA === false || s.isCA == null));
});
