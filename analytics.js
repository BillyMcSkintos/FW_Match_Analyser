'use strict';

/**
 * FinalWhistle Match Analyser — Tactical Analysis Layer
 *
 * Pure analytics layer. Consumes the parsed match model built by parser.js
 * (opportunities, steps, tacticalEvents, tacticalPhases, validation) and returns plain
 * structured analysis objects. No DOM, no chrome.*, no global viewer state — every
 * function here takes `match` (and sometimes a teamSide/options argument) and returns
 * plain data, so it is directly testable and reusable by any future UI.
 *
 * Evidence categories — every function below is one of:
 *   OBSERVED                      — directly present in steps/tacticalEvents
 *   DERIVED                       — deterministic calculation from OBSERVED data
 *   MANUAL-SUPPORTED INTERPRETATION — grounded in an explicitly documented FW mechanic
 *   INFERRED                      — a plausible reading the data does not itself prove
 * Nothing here computes an INFERRED conclusion and returns it as if it were a fact — an
 * INFERRED reading, on the few functions that offer one at all (assistance, fatigue,
 * lane), is returned as a separate `note` string, never merged into a numeric field.
 * See parser.js's tactical-construct audit comment (above parseNarrative) for which FW
 * mechanics this codebase has narrative evidence for at all; nothing here assumes a
 * tactical setting merely because a pattern in observed play looks a certain way. See
 * also README.md's Evidence model section for the same convention applied project-wide.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const SHOT_STEP_TYPES = ['SHOT', 'FK_SHOT'];
const PASS_STEP_KINDS = ['START_PASS', 'PB_PASS', 'SP_PASS', 'FK_PASS'];
const DUEL_STEP_TYPES = ['MID_DUEL', 'PB_DUEL', 'SP_DUEL', 'FK_DUEL', 'DRIB'];

// Position → lane. Identical to viewer.js's own POSITION_LANE_MAP — kept as a second copy
// (not imported) because analytics.js must not depend on viewer.js, which mixes DOM
// code into the same file. This is a positional convention, not parser logic, so
// duplicating it here does not risk drifting from what the parser itself derives (it
// never re-derives narrative/telemetry parsing semantics).
const POSITION_LANE_MAP = {
  GK: 'center', LB: 'left', CB: 'center', RB: 'right',
  LWB: 'left', DM: 'center', RWB: 'right',
  LM: 'left', CM: 'center', RM: 'right',
  LW: 'left', OM: 'center', RW: 'right', FW: 'center',
};
function laneOf(position) { return POSITION_LANE_MAP[position] || 'center'; }

// Zone (front-to-back line) a position belongs to, for pass-route classification —
// deliberately a different grouping than POSITION_LANE_MAP (left/center/right): this is about
// DEF/MID/FW zone-of-origin, not side.
const ZONE_OF_POSITION = {
  GK: 'DEF', CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  DM: 'MID', CM: 'MID', LM: 'MID', RM: 'MID', OM: 'MID', LW: 'MID', RW: 'MID',
  FW: 'FW',
};

// Zone a STEP TYPE occurred in — distinct from ZONE_OF_POSITION (that's about a
// player's role; this is about which phase of play the step itself belongs to).
const ZONE_OF_STEP_TYPE = {
  START_PASS: 'MIDFIELD', MID_DUEL: 'MIDFIELD', DRIB: 'MIDFIELD',
  PB_PASS: 'PENALTY_BOX', PB_DUEL: 'PENALTY_BOX',
  SP_PASS: 'SET_PIECE', SP_DUEL: 'SET_PIECE',
  FK_PASS: 'SET_PIECE', FK_DUEL: 'SET_PIECE', FK_SHOT: 'SET_PIECE',
};

function otherSide(side) { return side === 'home' ? 'away' : 'home'; }
function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function avg(arr) { return arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }

// Small-sample discipline. A purely descriptive UI heuristic — never a statistical
// significance claim. No p-values or confidence intervals are computed anywhere in this
// file; thresholds are display buckets only, adjustable without changing any underlying
// calculation.
function sampleSizeHint(n) {
  if (n == null) return null;
  if (n <= 2) return 'very small sample';
  if (n <= 5) return 'small sample';
  if (n <= 10) return 'moderate sample';
  return 'larger sample';
}

// Confidence propagation from the parser's own validation. Analytics leaning on
// telemetry VALUES (not just narrative-observed counts/outcomes) should surface
// 'degraded' whenever parseMatch's own validation flagged the underlying
// narrative↔telemetry alignment as uncertain — counts drawn only from reliable narrative
// data (outcomes, player names, minutes) stay exact regardless, so this is attached
// per-function/per-metric, not as a single match-wide kill switch.
function parserConfidence(match) {
  return match?.validation?.confidence === 'degraded' ? 'degraded' : 'exact';
}

function newValueAgg() { return { values: [] }; }
function addValue(agg, qvObj) { if (qvObj?.value != null) agg.values.push(qvObj.value); }
function finalizeValueAgg(agg) {
  const n = agg.values.length;
  return { count: n, avg: n ? avg(agg.values) : null };
}
function newDuelAgg() { return { attempts: 0, wins: 0, losses: 0 }; }

// ─────────────────────────────────────────────────────────────────────────────
// Opportunity funnel
// ─────────────────────────────────────────────────────────────────────────────

// OBSERVED/DERIVED. Classifies HOW an opportunity's attack was routed — deliberately
// separate from `terminalStage` (WHERE it stopped) and from `isCounterAttack` (already
// on the opportunity, carried through unchanged). Set pieces, direct free kicks and long
// balls bypass the normal midfield/PB progression entirely, so lumping them into
// "open play" would misrepresent how they actually started.
function classifyProgressionType(opp) {
  if (opp.isLongBallSequence) return 'LONG_BALL';
  if (opp.startType === 'SP') return 'SET_PIECE';
  if (opp.startType === 'FK') {
    // A direct free-kick shot has no pass line at all (parser.js's phaseToSteps 'FK'
    // case only emits FK_SHOT, never FK_PASS, when phase.target is unset) — a delivered
    // free kick produces FK_PASS/FK_DUEL like a corner does.
    return opp.steps.some(s => s.stepType === 'FK_SHOT') ? 'DIRECT_FREE_KICK' : 'SET_PIECE';
  }
  return 'OPEN_PLAY'; // MID/PB/DEF starts
}

// A duel step counts as "won" by the attacking side only when the step's own OUTCOME
// says so (WON — set whenever a shot followed — or POSSESSION — the attacker took
// control outright with no contested tackle). This is the single authoritative
// definition of "won a duel" used throughout this file — never a raw value comparison,
// matching findFirstFailedDefensiveStage's explicit conservatism requirement below.
function attackerWonDuel(step) { return step.outcome === 'WON' || step.outcome === 'POSSESSION'; }

function buildFunnelEntry(opp) {
  const steps = opp.steps;
  const midDuel = steps.find(s => s.stepType === 'MID_DUEL');
  const pbSteps = steps.filter(s => s.stepType === 'PB_PASS' || s.stepType === 'PB_DUEL');
  const pbDuel  = steps.find(s => s.stepType === 'PB_DUEL');
  const shotSteps = steps.filter(s => SHOT_STEP_TYPES.includes(s.stepType));
  const goalSteps = shotSteps.filter(s => s.outcome === 'GOAL');

  const reachedMidfieldDuel = !!midDuel;
  const wonMidfieldDuel = !!midDuel && attackerWonDuel(midDuel);
  const reachedPenaltyBox = pbSteps.length > 0;
  const completedPenaltyBoxReception = !!pbDuel && attackerWonDuel(pbDuel);
  const shotCount = shotSteps.length;
  const goalCount = goalSteps.length;

  let terminalStage;
  if (goalCount > 0) terminalStage = 'GOAL';
  else if (shotCount > 0) terminalStage = 'SHOT';
  else if (reachedPenaltyBox) terminalStage = 'PENALTY_BOX';
  else if (reachedMidfieldDuel) terminalStage = 'MIDFIELD';
  else terminalStage = 'SET_PIECE'; // e.g. a corner/FK delivery that never resolved into PB_DUEL

  return {
    minute: opp.minute, sequence: opp.sequence, team: opp.team, teamSide: opp.teamSide,
    progressionType: classifyProgressionType(opp),
    isCounterAttack: !!opp.isCounterAttack,
    reachedMidfieldDuel, wonMidfieldDuel,
    reachedPenaltyBox, completedPenaltyBoxReception,
    shotCount, goalCount, terminalStage,
  };
}

// DERIVED. Per-opportunity funnel entries plus a per-side count summary — the summary
// is exact arithmetic over the entries, nothing estimated.
function opportunityFunnel(match) {
  const entries = (match?.opportunities || []).map(buildFunnelEntry);
  const summarize = (side) => {
    const e = entries.filter(x => x.teamSide === side);
    return {
      total: e.length,
      reachedMidfield: e.filter(x => x.reachedMidfieldDuel).length,
      wonMidfield: e.filter(x => x.wonMidfieldDuel).length,
      reachedPenaltyBox: e.filter(x => x.reachedPenaltyBox).length,
      shots: e.filter(x => x.shotCount > 0).length,
      goals: e.filter(x => x.goalCount > 0).length,
    };
  };
  return { entries, home: summarize('home'), away: summarize('away'), confidence: parserConfidence(match) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turnover classification
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED, directly from step outcomes — not every terminated opportunity is a
// turnover. Explicitly excluded: a missed/saved/post shot
// (the culmination of an attack, not a possession failure during buildup), a goal, a
// foul (typically a free kick FOR the attacking side, not a loss of it), and a corner
// (typically won by continued attacking pressure, not a defensive turnover). BLOCKED is
// only a turnover if nothing continues afterward — a same-side recovery is not a change
// of possession (see parser.test.js: "blocked pass recovered by the attacking team").
function classifyTurnoverCause(step) {
  if (step.outcome === 'GK_INTERCEPT') return 'GK_INTERCEPTION';
  if (step.outcome === 'BLOCKED') return 'BLOCKED_PASS';
  if (step.outcome === 'CLEARED') {
    if (step.stepType === 'DRIB') return 'FAILED_DRIBBLE';
    // Whether a tackle value was actually recorded distinguishes "lost a contested
    // tackle" from "reception failed with no tackle described" — both narrative
    // patterns exist and resolve to the same CLEARED outcome string.
    return step.values?.tackle?.value != null ? 'TACKLE_LOSS' : 'FAILED_RECEPTION';
  }
  return null;
}

function turnoverAnalysis(match) {
  const turnovers = [];
  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps;
    steps.forEach((step, idx) => {
      if (!DUEL_STEP_TYPES.includes(step.stepType)) return;
      if (step.outcome === 'BLOCKED' && idx !== steps.length - 1) return;
      const cause = classifyTurnoverCause(step);
      if (!cause) return;
      const next = steps[idx + 1];
      turnovers.push({
        minute: opp.minute, sequence: opp.sequence, stepIndex: idx,
        opportunityTeam: opp.team,
        losingSide: step.attackingSide || opp.teamSide,
        winningSide: step.defendingSide || otherSide(step.attackingSide || opp.teamSide),
        zone: ZONE_OF_STEP_TYPE[step.stepType] || null,
        playerLosing: step.attacker || step.dribbler || null,
        playerWinning: step.defender || null,
        cause,
        causedCounterAttack: !!(next && next.isCA),
      });
    });
  }
  return turnovers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensive failure chain
// ─────────────────────────────────────────────────────────────────────────────

function summarizeChainStage(step) {
  return {
    stepType: step.stepType, outcome: step.outcome, values: step.values || null,
    from: step.from || null, to: step.to || null,
    attacker: step.attacker || step.dribbler || null, defender: step.defender || null,
    shooter: step.shooter || null, gk: step.gk || null,
  };
}

// Conservative by construction: the ONLY signal used is the step's own recorded
// outcome (WON/POSSESSION means the attacker won that duel outright) — never a raw
// value comparison like "reception 82 vs tackle 71". A chain with no duel the attacker
// won outright (a direct free kick, a corner resolved straight into a shot with no
// PB_DUEL) correctly returns null rather than guessing which stage "must have" failed.
function findFirstFailedDefensiveStage(chainSteps) {
  for (const s of chainSteps) {
    if (!DUEL_STEP_TYPES.includes(s.stepType)) continue;
    if (attackerWonDuel(s)) return summarizeChainStage(s);
  }
  return null;
}

// DERIVED. One entry per shot (SHOT/FK_SHOT step) in the match, describing the chain of
// play that led to it — scoped to the CURRENT attacking sequence (from the start of the
// opportunity, or from the counter-attack boundary if this shot came after one), since
// blaming a defense for what happened before a CA flipped who's attacking would
// misattribute the failure to the wrong team entirely (see parser.js's isCA/attackingSide
// stamping, preserved unchanged here).
function defensiveFailureChains(match) {
  const chains = [];
  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps;
    steps.forEach((step, idx) => {
      if (!SHOT_STEP_TYPES.includes(step.stepType)) return;
      const attackingSide = step.attackingSide || opp.teamSide;
      const defendingSide = step.defendingSide || otherSide(attackingSide);

      let startIdx = idx;
      for (let i = idx; i >= 0; i--) {
        if (!!steps[i].isCA !== !!step.isCA) break;
        startIdx = i;
      }
      const chainSteps = steps.slice(startIdx, idx + 1);
      const duelSteps = chainSteps.filter(s => DUEL_STEP_TYPES.includes(s.stepType));
      const finalDefender = duelSteps.length ? duelSteps[duelSteps.length - 1].defender || null : null;

      chains.push({
        minute: opp.minute, sequence: opp.sequence, opportunityTeam: opp.team,
        attackingSide, defendingSide,
        stages: chainSteps.map(summarizeChainStage),
        firstFailedDefensiveStage: findFirstFailedDefensiveStage(chainSteps),
        finalDefender, gk: step.gk || null, gkOutcome: step.outcome,
        tacticalContext: opp.tacticalContext || null,
      });
    });
  }
  return chains;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tactical-phase performance
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED. Per material-change phase (parser.js's buildTacticalPhases), own/opponent
// metrics for `teamSide`. Shots/goals/PB-entries are attributed by each STEP's own
// attackingSide (not by which team's opportunity container it sits in) — otherwise a
// counter-attack goal scored during the OPPONENT's own opportunity would silently
// vanish from both sides' totals (it isn't in "our opportunities", and filtering the
// opponent's opportunities by "shots belonging to the opponent's side" would wrongly
// exclude it too, since the step itself now belongs to us). This is the same
// attackingSide-vs-opp.teamSide fix already applied throughout viewer.js's stats.
function phasePerformance(match, teamSide) {
  const phases = match?.tacticalPhases?.[teamSide] || [];
  const oppSide = otherSide(teamSide);
  const phaseIdKey = `${teamSide}PhaseId`;
  const allOpps = match?.opportunities || [];
  const turnovers = turnoverAnalysis(match);
  const oppBySequence = new Map(allOpps.map(o => [o.sequence, o]));

  return phases.map(phase => {
    const oppsInPhase = allOpps.filter(o => o.tacticalContext?.[phaseIdKey] === phase.id);
    const ownOpps = oppsInPhase.filter(o => o.teamSide === teamSide);
    const opponentOpps = oppsInPhase.filter(o => o.teamSide === oppSide);

    const shotsBy = (side) => oppsInPhase.reduce((n, o) =>
      n + o.steps.filter(s => SHOT_STEP_TYPES.includes(s.stepType) && (s.attackingSide || o.teamSide) === side).length, 0);
    const goalsBy = (side) => oppsInPhase.reduce((n, o) =>
      n + o.steps.filter(s => SHOT_STEP_TYPES.includes(s.stepType) && s.outcome === 'GOAL' && (s.attackingSide || o.teamSide) === side).length, 0);
    const pbBy = (side) => oppsInPhase.filter(o =>
      o.steps.some(s => (s.stepType === 'PB_PASS' || s.stepType === 'PB_DUEL') && (s.attackingSide || o.teamSide) === side)).length;
    const caBy = (side) => oppsInPhase.filter(o => o.isCounterAttack &&
      o.steps.some(s => s.isCA && (s.attackingSide || o.teamSide) === side)).length;

    const turnoversInPhase = (losingSide) => turnovers.filter(t => {
      const opp = oppBySequence.get(t.sequence);
      return opp && opp.tacticalContext?.[phaseIdKey] === phase.id && t.losingSide === losingSide;
    }).length;

    const durationMinutes = phase.endMinute != null ? (phase.endMinute - phase.startMinute) : null;
    const sampleSize = oppsInPhase.length;

    return {
      phaseId: phase.id, teamSide,
      startMinute: phase.startMinute, endMinute: phase.endMinute, durationMinutes,
      ownOpportunities: ownOpps.length, opponentOpportunities: opponentOpps.length,
      ownShots: shotsBy(teamSide), opponentShots: shotsBy(oppSide),
      ownGoals: goalsBy(teamSide), opponentGoals: goalsBy(oppSide),
      ownPBEntries: pbBy(teamSide), opponentPBEntries: pbBy(oppSide),
      ownCounterAttacks: caBy(teamSide), opponentCounterAttacks: caBy(oppSide),
      turnoversWon: turnoversInPhase(oppSide), turnoversLost: turnoversInPhase(teamSide),
      // Avoid overprecision on tiny samples — rates are still computed (they're
      // simple division, not statistics), but always travel with sampleSize/
      // durationMinutes/confidenceHint so a caller can choose not to trust a rate from
      // a 3-minute, 1-opportunity phase.
      rates: durationMinutes && durationMinutes > 0 ? {
        opportunitiesPer10Min: round2(ownOpps.length / durationMinutes * 10),
        shotsPerOpportunity: ownOpps.length ? round2(shotsBy(teamSide) / ownOpps.length) : null,
        pbEntryRate: ownOpps.length ? round2(pbBy(teamSide) / ownOpps.length) : null,
        opponentShotsPer10Min: round2(shotsBy(oppSide) / durationMinutes * 10),
      } : null,
      sampleSize, confidenceHint: sampleSizeHint(sampleSize),
      confidence: parserConfidence(match),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Before/after tactical-change comparison
// ─────────────────────────────────────────────────────────────────────────────

function windowStats(match, side, oppSide, lo, hi, minuteLower, turnovers) {
  const inWindow = (match.opportunities || []).filter(o => o.minute >= lo && o.minute < hi);
  const own = inWindow.filter(o => o.teamSide === side);
  const opp = inWindow.filter(o => o.teamSide === oppSide);
  const shots = own.reduce((n, o) => n + o.steps.filter(s => SHOT_STEP_TYPES.includes(s.stepType) && (s.attackingSide || o.teamSide) === side).length, 0);
  const pbEntries = own.filter(o => o.steps.some(s => (s.stepType === 'PB_PASS' || s.stepType === 'PB_DUEL') && (s.attackingSide || o.teamSide) === side)).length;
  const counterAttacksConceded = opp.filter(o => o.isCounterAttack && o.steps.some(s => s.isCA && (s.attackingSide || o.teamSide) === side)).length;
  const turnoversLost = turnovers.filter(t => t.minute >= lo && t.minute < hi && t.losingSide === side).length;
  return {
    opportunities: own.length, shots, pbEntries, counterAttacksConceded, turnoversLost,
    pbEntryRate: own.length ? round2(pbEntries / own.length) : null,
    shotRate: own.length ? round2(shots / own.length) : null,
    sampleSizeHint: sampleSizeHint(own.length),
  };
}

// DERIVED, explicitly labeled as a before/after ASSOCIATION, never a causal effect —
// this function does not and cannot determine whether a tactical change caused any
// difference it reports (same framing as compareAdjacentPhases below). `windowTooThin`
// flags a comparison spanning under 3 real minutes on either side (too close to
// kickoff/full time or another change to be meaningful even as description).
function compareAroundEvent(match, eventId, { beforeMinutes = 15, afterMinutes = 15 } = {}) {
  const event = (match?.tacticalEvents || []).find(e => e.id === eventId);
  if (!event || event.minute == null || !event.teamSide) return null;
  const side = event.teamSide, oppSide = otherSide(side);
  const lo = Math.max(0, event.minute - beforeMinutes);
  const hi = Math.min(90, event.minute + afterMinutes);
  const actualBefore = event.minute - lo, actualAfter = hi - event.minute;
  const turnovers = turnoverAnalysis(match);

  const before = windowStats(match, side, oppSide, lo, event.minute, lo, turnovers);
  const after  = windowStats(match, side, oppSide, event.minute, hi, event.minute, turnovers);

  const delta = {};
  for (const key of ['opportunities', 'shots', 'pbEntries', 'counterAttacksConceded', 'turnoversLost']) {
    delta[key] = after[key] - before[key];
  }

  return {
    eventId, event: { id: event.id, type: event.type, minute: event.minute, rawText: event.rawText,
      semanticType: event.semanticType || null, interpretation: event.interpretation || null },
    windowMinutes: { before: actualBefore, after: actualAfter },
    windowTooThin: actualBefore < 3 || actualAfter < 3,
    before, after, delta,
    label: 'before/after association — not a measured causal effect',
    confidence: parserConfidence(match),
  };
}

// DERIVED. Compares a tactical phase against the one immediately before it for the same
// side, using phasePerformance's own per-phase metrics — same "association, not causal
// effect" framing as compareAroundEvent.
function compareAdjacentPhases(match, teamSide, phaseId) {
  const perf = phasePerformance(match, teamSide);
  const idx = perf.findIndex(p => p.phaseId === phaseId);
  if (idx <= 0) return null; // no prior phase to compare against
  const before = perf[idx - 1], after = perf[idx];
  const delta = {};
  for (const key of ['ownOpportunities', 'ownShots', 'ownGoals', 'ownPBEntries', 'opponentShots', 'opponentGoals', 'turnoversWon', 'turnoversLost']) {
    delta[key] = after[key] - before[key];
  }
  return { teamSide, before, after, delta, label: 'adjacent-phase association — not a measured causal effect' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Player duel analysis
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED. Role-specific aggregates per player — deliberately NOT collapsed into one
// composite rating: a CB's defenderDuels and a FW's shooting are entirely separate
// fields, never combined into a single number.
function playerDuelAnalysis(match) {
  const byPlayer = {};
  const ensure = (p, team, side) => {
    if (!p?.name) return null;
    if (!byPlayer[p.name]) byPlayer[p.name] = {
      name: p.name, team: team || null, side: side || null,
      attackerDuels: newDuelAgg(), defenderDuels: newDuelAgg(),
      receptions: newValueAgg(), tackles: newValueAgg(), assistanceGiven: newValueAgg(),
      facedTackleAsAttacker: newValueAgg(), facedReceptionAsDefender: newValueAgg(),
      shooting: { attempts: 0, goals: 0, values: newValueAgg() },
      goalkeeping: { shotsFaced: 0, saves: 0, goalsConceded: 0, fumbles: 0, values: newValueAgg() },
    };
    const rec = byPlayer[p.name];
    if (team && !rec.team) rec.team = team;
    if (side && !rec.side) rec.side = side;
    return rec;
  };

  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
      if (DUEL_STEP_TYPES.includes(step.stepType)) {
        const attacker = step.attacker || step.dribbler;
        const won = attackerWonDuel(step);
        const lost = !won && (step.outcome === 'CLEARED' || step.outcome === 'GK_INTERCEPT' || step.outcome === 'BLOCKED');
        if (attacker) {
          const rec = ensure(attacker, step.attackingTeam, step.attackingSide);
          if (rec) {
            rec.attackerDuels.attempts++;
            if (won) rec.attackerDuels.wins++; else if (lost) rec.attackerDuels.losses++;
            addValue(rec.receptions, step.values?.reception);
            addValue(rec.facedTackleAsAttacker, step.values?.tackle);
          }
        }
        if (step.defender) {
          const rec = ensure(step.defender, step.defendingTeam, step.defendingSide);
          if (rec) {
            rec.defenderDuels.attempts++;
            if (lost) rec.defenderDuels.wins++; else if (won) rec.defenderDuels.losses++;
            addValue(rec.tackles, step.values?.tackle);
            addValue(rec.assistanceGiven, step.values?.assistance);
            addValue(rec.facedReceptionAsDefender, step.values?.reception);
          }
        }
      }
      if (SHOT_STEP_TYPES.includes(step.stepType)) {
        if (step.shooter) {
          const rec = ensure(step.shooter, step.attackingTeam, step.attackingSide);
          if (rec) {
            rec.shooting.attempts++;
            if (step.outcome === 'GOAL') rec.shooting.goals++;
            addValue(rec.shooting.values, step.values?.shot);
          }
        }
        if (step.gk) {
          const rec = ensure(step.gk, step.defendingTeam, step.defendingSide);
          if (rec) {
            rec.goalkeeping.shotsFaced++;
            if (step.outcome === 'SAVED') rec.goalkeeping.saves++;
            else if (step.outcome === 'GOAL') rec.goalkeeping.goalsConceded++;
            else if (step.outcome === 'FUMBLED') rec.goalkeeping.fumbles++;
            addValue(rec.goalkeeping.values, step.values?.gkSave);
          }
        }
      }
    }
  }

  for (const rec of Object.values(byPlayer)) {
    rec.receptions = finalizeValueAgg(rec.receptions);
    rec.tackles = finalizeValueAgg(rec.tackles);
    rec.assistanceGiven = finalizeValueAgg(rec.assistanceGiven);
    rec.facedTackleAsAttacker = finalizeValueAgg(rec.facedTackleAsAttacker);
    rec.facedReceptionAsDefender = finalizeValueAgg(rec.facedReceptionAsDefender);
    rec.shooting.avgValue = finalizeValueAgg(rec.shooting.values).avg;
    rec.shooting.values = undefined; delete rec.shooting.values;
    rec.goalkeeping.avgValue = finalizeValueAgg(rec.goalkeeping.values).avg;
    rec.goalkeeping.values = undefined; delete rec.goalkeeping.values;
  }
  return byPlayer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assistance analysis
// ─────────────────────────────────────────────────────────────────────────────

// OBSERVED (values, frequency) + DERIVED (per-player/per-zone aggregates). The Manual
// states Teamwork modifies assistance given, but this analyser has no player-personality
// input — see the `note` field. Assistance describes the DEFENDER's positioning support
// during a duel (parser.js: "X got assistance, and was close" describes the defender),
// not the attacker.
function assistanceAnalysis(match) {
  const values = [];
  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
      const a = step.values?.assistance;
      if (a?.value == null) continue;
      values.push({
        minute: opp.minute, sequence: opp.sequence,
        team: step.defendingTeam, side: step.defendingSide,
        player: step.defender || null, value: a.value, label: a.label,
        zone: ZONE_OF_STEP_TYPE[step.stepType] || null,
      });
    }
  }
  const byPlayer = {};
  for (const v of values) {
    if (!v.player?.name) continue;
    if (!byPlayer[v.player.name]) byPlayer[v.player.name] = { name: v.player.name, team: v.team, side: v.side, agg: newValueAgg() };
    byPlayer[v.player.name].agg.values.push(v.value);
  }
  for (const k of Object.keys(byPlayer)) {
    byPlayer[k] = { ...byPlayer[k], ...finalizeValueAgg(byPlayer[k].agg) };
    delete byPlayer[k].agg;
  }
  const byZone = {};
  for (const v of values) {
    if (!v.zone) continue;
    if (!byZone[v.zone]) byZone[v.zone] = newValueAgg();
    byZone[v.zone].values.push(v.value);
  }
  for (const k of Object.keys(byZone)) byZone[k] = finalizeValueAgg(byZone[k]);

  return {
    values, byPlayer, byZone,
    note: "Assistance values and frequency are observed match data. The Manual states Teamwork modifies assistance given by the player, but this analyser has no player-personality input from the match report itself — assistance patterns here must not be read backward as a Teamwork measurement.",
    confidence: parserConfidence(match),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fatigue / tiredness analysis
// ─────────────────────────────────────────────────────────────────────────────

function duelSummaryForPlayer(match, name, minuteFilter) {
  let defensiveDuels = 0, defensiveWins = 0, attackingDuels = 0, attackingWins = 0;
  for (const opp of (match?.opportunities || [])) {
    if (!minuteFilter(opp.minute)) continue;
    for (const step of opp.steps) {
      if (!DUEL_STEP_TYPES.includes(step.stepType)) continue;
      const asAttacker = (step.attacker || step.dribbler)?.name === name;
      const asDefender = step.defender?.name === name;
      if (!asAttacker && !asDefender) continue;
      const won = attackerWonDuel(step);
      if (asAttacker) { attackingDuels++; if (won) attackingWins++; }
      if (asDefender) { defensiveDuels++; if (!won && (step.outcome === 'CLEARED' || step.outcome === 'GK_INTERCEPT')) defensiveWins++; }
    }
  }
  return { defensiveDuels, defensiveWins, attackingDuels, attackingWins };
}

// OBSERVED before/after duel activity around a player's own tiredness reports —
// deliberately observational only: this function does not and cannot establish
// that Constitution/fatigue CAUSED any difference it reports. The `note` field carries
// the Manual-supported interpretation as a clearly separate, explicitly-labeled string.
function fatigueImpact(match) {
  const byPlayer = {};
  for (const ev of (match?.tacticalEvents || [])) {
    if (ev.type !== 'TIREDNESS' || !ev.player?.name) continue;
    if (!byPlayer[ev.player.name]) byPlayer[ev.player.name] = { player: ev.player, team: ev.team, side: ev.teamSide, reports: [] };
    byPlayer[ev.player.name].reports.push({ minute: ev.minute, level: ev.level, sequence: ev.sequence });
  }
  const results = [];
  for (const [name, info] of Object.entries(byPlayer)) {
    info.reports.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const firstMinute = info.reports[0].minute;
    const sub = (match.tacticalEvents || []).find(e => e.type === 'SUBSTITUTION' && e.playerOut?.name === name);
    const subMinute = sub ? sub.minute : null;

    const before = duelSummaryForPlayer(match, name, m => m < firstMinute);
    const after  = duelSummaryForPlayer(match, name, m => m >= firstMinute && (subMinute == null || m < subMinute));

    results.push({
      player: info.player, team: info.team, side: info.side,
      firstTiredMinute: firstMinute, firstTiredLevel: info.reports[0].level,
      allReports: info.reports, substitutedAtMinute: subMinute,
      before, after,
      sampleSizeHint: { before: sampleSizeHint(before.defensiveDuels + before.attackingDuels),
                         after: sampleSizeHint(after.defensiveDuels + after.attackingDuels) },
      note: "Observed before/after duel activity around this player's own tiredness reports, not a causal claim. This pattern is consistent with the Manual's documented Constitution/tiredness effect on skills later in a match — that is a separate, Manual-supported interpretation, not something this single match's numbers alone prove.",
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane analysis
// ─────────────────────────────────────────────────────────────────────────────

function emptyLaneBucket() { return { left: {}, center: {}, right: {} }; }
function bumpLane(bucket, laneKey, key) { bucket[laneKey][key] = (bucket[laneKey][key] || 0) + 1; }

// OBSERVED (positions) + DERIVED (lane bucketing). Lanes come from each player's
// reported POSITION for that action — never from preferred foot (a player mechanic, not
// a lane classifier) and never used to assert a Preferred Side tactical setting: a lane
// dominating the counts is an observed distribution, nothing more.
function laneAnalysis(match) {
  const counts = { home: emptyLaneBucket(), away: emptyLaneBucket() };
  for (const opp of (match?.opportunities || [])) {
    const first = opp.steps[0];
    const starterPos = first?.from?.position || first?.dribbler?.position || first?.shooter?.position;
    if (starterPos) bumpLane(counts[opp.teamSide], laneOf(starterPos), 'opportunityStarts');

    for (const step of opp.steps) {
      const side = step.attackingSide || opp.teamSide;
      if (!counts[side]) continue;
      if (PASS_STEP_KINDS.includes(step.stepType) && step.from?.position) {
        bumpLane(counts[side], laneOf(step.from.position), 'passes');
        if (step.stepType === 'PB_PASS') bumpLane(counts[side], laneOf(step.from.position), 'pbEntries');
      }
      if (SHOT_STEP_TYPES.includes(step.stepType) && step.shooter?.position) {
        bumpLane(counts[side], laneOf(step.shooter.position), 'shots');
        if (step.outcome === 'GOAL') bumpLane(counts[side], laneOf(step.shooter.position), 'goals');
      }
    }
  }
  for (const t of turnoverAnalysis(match)) {
    const pos = t.playerLosing?.position;
    if (pos && counts[t.losingSide]) bumpLane(counts[t.losingSide], laneOf(pos), 'turnovers');
  }
  return {
    home: counts.home, away: counts.away,
    note: "Lanes are derived from each player's reported position for that specific action, not preferred foot or a declared tactical setting. A lane dominating the counts is observed match distribution, not proof of a Preferred Side order.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Counter-attack analysis
// ─────────────────────────────────────────────────────────────────────────────

function emptyCASummary() { return { created: 0, conceded: 0, shots: 0, shotsConceded: 0, goals: 0, goalsConceded: 0, originatingCauses: [], originatingZones: [] }; }

// DERIVED, preserving the existing step-level CA ownership fix: a counter-attacking
// step belongs to the team that actually performed it (step.attackingSide after the CA
// boundary), never to the opportunity's nominal starting side.
function counterAttackAnalysis(match) {
  const perSide = { home: emptyCASummary(), away: emptyCASummary() };
  const turnovers = turnoverAnalysis(match);

  for (const opp of (match?.opportunities || [])) {
    if (!opp.isCounterAttack) continue;
    const caIdx = opp.steps.findIndex(s => s.isCA);
    if (caIdx === -1) continue;
    const caStep = opp.steps[caIdx];
    const countingSide = caStep.attackingSide, concededSide = caStep.defendingSide;
    if (!perSide[countingSide] || !perSide[concededSide]) continue;

    perSide[countingSide].created++;
    perSide[concededSide].conceded++;

    const caSteps = opp.steps.slice(caIdx);
    const shots = caSteps.filter(s => SHOT_STEP_TYPES.includes(s.stepType));
    perSide[countingSide].shots += shots.length;
    perSide[concededSide].shotsConceded += shots.length;
    const goals = shots.filter(s => s.outcome === 'GOAL').length;
    perSide[countingSide].goals += goals;
    perSide[concededSide].goalsConceded += goals;

    const origin = turnovers.find(t => t.sequence === opp.sequence && t.stepIndex === caIdx - 1);
    perSide[countingSide].originatingCauses.push(origin?.cause || null);
    perSide[countingSide].originatingZones.push(origin?.zone || null);
  }
  return perSide;
}

// ─────────────────────────────────────────────────────────────────────────────
// Set-piece analysis
// ─────────────────────────────────────────────────────────────────────────────

function emptySPCat() { return { home: { attempts: 0, duelWins: 0, duelLosses: 0, shots: 0, goals: 0 },
                                  away: { attempts: 0, duelWins: 0, duelLosses: 0, shots: 0, goals: 0 } }; }

// OBSERVED/DERIVED, from the explicit SP_*/FK_* step types only — never inferred from
// e.g. a high proportion of corners resulting in crosses (which would risk asserting a
// Set Piece Order the report never actually states).
function setPieceAnalysis(match) {
  const corner = emptySPCat(), deliveredFreeKick = emptySPCat(), directFreeKick = emptySPCat();
  for (const opp of (match?.opportunities || [])) {
    const hasCorner = opp.steps.some(s => s.stepType === 'SP_PASS');
    const hasDeliveredFK = opp.steps.some(s => s.stepType === 'FK_PASS');
    for (const step of opp.steps) {
      const side = step.attackingSide || opp.teamSide;
      if (step.stepType === 'SP_PASS') corner[side].attempts++;
      if (step.stepType === 'SP_DUEL') { if (attackerWonDuel(step)) corner[side].duelWins++; else corner[side].duelLosses++; }
      if (step.stepType === 'FK_PASS') deliveredFreeKick[side].attempts++;
      if (step.stepType === 'FK_DUEL') { if (attackerWonDuel(step)) deliveredFreeKick[side].duelWins++; else deliveredFreeKick[side].duelLosses++; }
      if (step.stepType === 'FK_SHOT') {
        directFreeKick[side].attempts++;
        if (step.outcome === 'GOAL') directFreeKick[side].goals++;
      }
      if (step.stepType === 'SHOT' && (hasCorner || hasDeliveredFK)) {
        const cat = hasCorner ? corner : deliveredFreeKick;
        cat[side].shots++;
        if (step.outcome === 'GOAL') cat[side].goals++;
      }
    }
  }
  return { corner, deliveredFreeKick, directFreeKick };
}

// ─────────────────────────────────────────────────────────────────────────────
// Goalkeeper analysis
// ─────────────────────────────────────────────────────────────────────────────

// OBSERVED/DERIVED, from shot outcomes only. Never reverse-engineers RE/GP/IN/CT/OR
// skill values or an arrow setting from the shot types faced — the `note` field makes
// that boundary explicit.
function goalkeeperAnalysis(match) {
  const byGK = {};
  const ensure = (p, team, side) => {
    if (!p?.name) return null;
    if (!byGK[p.name]) byGK[p.name] = { name: p.name, team: team || null, side: side || null,
      shotsFaced: 0, saves: 0, goalsConceded: 0, fumbles: 0, cornersConceded: 0,
      interceptions: 0, saveValues: newValueAgg() };
    return byGK[p.name];
  };
  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
      if (SHOT_STEP_TYPES.includes(step.stepType) && step.gk) {
        const rec = ensure(step.gk, step.defendingTeam, step.defendingSide);
        if (rec) {
          rec.shotsFaced++;
          if (step.outcome === 'SAVED') rec.saves++;
          else if (step.outcome === 'GOAL') rec.goalsConceded++;
          else if (step.outcome === 'FUMBLED') rec.fumbles++;
          else if (step.outcome === 'CORNER') rec.cornersConceded++;
          addValue(rec.saveValues, step.values?.gkSave);
        }
      }
      if (step.outcome === 'GK_INTERCEPT' && step.defender) {
        const rec = ensure(step.defender, step.defendingTeam, step.defendingSide);
        if (rec) rec.interceptions++;
      }
    }
  }
  for (const rec of Object.values(byGK)) {
    rec.avgSaveValue = finalizeValueAgg(rec.saveValues).avg;
    delete rec.saveValues;
  }
  return {
    byGoalkeeper: byGK,
    note: 'Shot outcomes and save values only. These do not reveal RE/GP/IN/CT/OR skill values or a goalkeeper arrow setting.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shot profile analysis
// ─────────────────────────────────────────────────────────────────────────────

// Distinct from viewer.js's classifyShotType (that one is DOM-adjacent code in the
// stats-panel section) — this file cannot depend on viewer.js, so the same small
// classification is reimplemented here from the identical step fields.
function classifyShotTypeForAnalytics(step) {
  if (step.isPenalty) return 'penalty';
  if (step.isLongShot) return 'long shot';
  if (step.stepType === 'FK_SHOT') return 'direct free kick';
  return (step.shotType || 'normal').toLowerCase();
}

// OBSERVED/DERIVED. Only uses shot types the parser/narrative actually identified — an
// observed shot type (e.g. a lob shot) is not treated as proof a specific Player Order
// was configured: FinalWhistle report text does not establish that equivalence.
function shotProfileAnalysis(match) {
  const byType = { home: {}, away: {} };
  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
      if (!SHOT_STEP_TYPES.includes(step.stepType)) continue;
      const side = step.attackingSide || opp.teamSide;
      const type = classifyShotTypeForAnalytics(step);
      if (!byType[side][type]) byType[side][type] = { attempts: 0, goals: 0, shotValues: newValueAgg(), gkValues: newValueAgg() };
      const rec = byType[side][type];
      rec.attempts++;
      if (step.outcome === 'GOAL') rec.goals++;
      addValue(rec.shotValues, step.values?.shot);
      addValue(rec.gkValues, step.values?.gkSave);
    }
  }
  for (const side of ['home', 'away']) {
    for (const type of Object.keys(byType[side])) {
      const r = byType[side][type];
      r.avgShotValue = finalizeValueAgg(r.shotValues).avg;
      r.avgGkResponse = finalizeValueAgg(r.gkValues).avg;
      delete r.shotValues; delete r.gkValues;
    }
  }
  return {
    home: byType.home, away: byType.away,
    note: 'Shot type is exactly what the narrative/parser identified for that attempt. An observed shot type does not by itself prove the corresponding Player Order was configured.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass profile analysis
// ─────────────────────────────────────────────────────────────────────────────

// OBSERVED/DERIVED. Routes describe where the ball actually moved between zones — never
// a declared Style of Play or Player Order setting. Pass "success" is not faked as
// a completed/failed boolean on the pass step itself (the parser has no such field —
// pass steps always carry outcome:null); the following duel's own outcome, already
// covered by turnoverAnalysis/playerDuelAnalysis, is the honest signal for that.
function passProfileAnalysis(match) {
  const routes = {};
  const byHeight = { home: { high: 0, low: 0 }, away: { high: 0, low: 0 } };
  const byType = { home: {}, away: {} };
  const laneRoutesToFW = { home: { wide: 0, center: 0 }, away: { wide: 0, center: 0 } };

  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
      if (!PASS_STEP_KINDS.includes(step.stepType)) continue;
      const side = step.attackingSide || opp.teamSide;

      const fromZone = (step.stepType === 'SP_PASS' || step.stepType === 'FK_PASS')
        ? 'SET_PIECE' : (ZONE_OF_POSITION[step.from?.position] || 'MID');
      const toZone = step.stepType === 'PB_PASS' ? 'PB' : (ZONE_OF_POSITION[step.to?.position] || 'MID');
      const routeKey = `${fromZone}>${toZone}`;
      if (!routes[routeKey]) routes[routeKey] = { home: 0, away: 0 };
      routes[routeKey][side]++;

      byHeight[side][step.passHeight === 'high' ? 'high' : 'low']++;
      const t = (step.passType || 'normal').toLowerCase();
      byType[side][t] = (byType[side][t] || 0) + 1;

      if (step.to?.position === 'FW') {
        laneRoutesToFW[side][laneOf(step.from?.position) === 'center' ? 'center' : 'wide']++;
      }
    }
  }
  return { routes, byHeight, byType, laneRoutesToFW,
    note: 'Routes describe where the ball moved between zones as observed, not a declared Style of Play or Player Order setting.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Player involvement chains
// ─────────────────────────────────────────────────────────────────────────────

function bumpInvolvement(obj, name, team, side) {
  if (!name) return;
  if (!obj[name]) obj[name] = { name, team: team || null, side: side || null, count: 0 };
  obj[name].count++;
}

// DERIVED — counts and outcome rates only. Deliberately no "most involved = best/worst"
// verdict anywhere in this function; a caller pairing these counts with outcome data to
// form a judgment is doing that interpretation itself, not reading it off here.
function playerInvolvementChains(match) {
  const starts = {}, progressors = {}, pbReceivers = {}, terminators = {}, shotChainDefenders = {};
  for (const opp of (match?.opportunities || [])) {
    const first = opp.steps[0];
    if (first) {
      const starter = first.from || first.dribbler || first.shooter;
      if (starter) bumpInvolvement(starts, starter.name, first.attackingTeam, first.attackingSide);
    }
    for (const step of opp.steps) {
      if (PASS_STEP_KINDS.includes(step.stepType) && step.to) bumpInvolvement(progressors, step.to.name, step.attackingTeam, step.attackingSide);
      if (step.stepType === 'PB_PASS' && step.to) bumpInvolvement(pbReceivers, step.to.name, step.attackingTeam, step.attackingSide);
    }
    const last = opp.steps[opp.steps.length - 1];
    if (last) {
      const terminator = last.shooter || last.attacker || last.dribbler || last.from;
      if (terminator) bumpInvolvement(terminators, terminator.name, last.attackingTeam, last.attackingSide);
    }
  }
  for (const chain of defensiveFailureChains(match)) {
    for (const stage of chain.stages) {
      if (stage.defender?.name) bumpInvolvement(shotChainDefenders, stage.defender.name, null, chain.defendingSide);
    }
  }
  return { starts, progressors, pbReceivers, terminators, shotChainDefenders,
    note: 'Counts and outcome rates only — high involvement is not itself a best/worst judgment.' };
}

// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    laneOf, sampleSizeHint, parserConfidence,
    opportunityFunnel, buildFunnelEntry, classifyProgressionType,
    turnoverAnalysis, classifyTurnoverCause,
    defensiveFailureChains, findFirstFailedDefensiveStage,
    phasePerformance, compareAroundEvent, compareAdjacentPhases,
    playerDuelAnalysis, assistanceAnalysis, fatigueImpact,
    laneAnalysis, counterAttackAnalysis, setPieceAnalysis, goalkeeperAnalysis,
    shotProfileAnalysis, passProfileAnalysis, playerInvolvementChains,
  };
}
