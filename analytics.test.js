'use strict';
// Regression tests for analytics.js (Phase C). No test framework dependency — Node's
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
// C2 — opportunityFunnel
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
// C5 — turnoverAnalysis
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
// C6 — defensiveFailureChains
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

// ─────────────────────────────────────────────────────────────────────────────
// C3 — phasePerformance / tactical-phase attribution
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
// C4 — before/after tactical comparison
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
// C7 — playerDuelAnalysis
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

// ─────────────────────────────────────────────────────────────────────────────
// C8 — assistanceAnalysis
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
// C9 — fatigueImpact
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
// C10 — laneAnalysis
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

// ─────────────────────────────────────────────────────────────────────────────
// C11 — counterAttackAnalysis (regression: existing CA step ownership)
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
// C12/C13 — setPieceAnalysis / goalkeeperAnalysis
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
// C14/C15 — shot/pass profile: no player-order inference
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
// C20 — small-sample discipline
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
// C24 — degraded Phase A alignment propagates analytical confidence
// ─────────────────────────────────────────────────────────────────────────────

test('degraded Phase A validation propagates into analytics confidence fields', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  // No telemetry at all for this minute — Phase A marks this opportunity's stream match
  // as 'none', which degrades match.validation.confidence.
  const match = parseMatch('', narrative, HA);
  assert.equal(match.validation.confidence, 'degraded');
  assert.equal(A.phaseAConfidence(match), 'degraded');
  assert.equal(A.opportunityFunnel(match).confidence, 'degraded');
  assert.equal(A.assistanceAnalysis(match).confidence, 'degraded');
});

test('exact Phase A validation keeps analytics confidence exact', () => {
  const narrative = ['Minute 10', ...midOppLines('Home Team', 'Player A [RB]', 'Player B [CM]', 'Player C [DM]')].join('\n');
  const match = parseMatch(midTelemetryLines(10, 'H').join('\n'), narrative, HA);
  assert.equal(match.validation.confidence, 'exact');
  assert.equal(A.opportunityFunnel(match).confidence, 'exact');
});
