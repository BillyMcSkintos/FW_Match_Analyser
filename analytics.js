'use strict';

/**
 * FinalWhistle Match Analyser — Tactical Analysis Layer
 *
 * Pure analytics layer. Consumes the parsed match model built by parser.js
 * (opportunities, steps, tacticalEvents, tacticalPhases, validation) and returns plain
 * structured analysis objects. No DOM, no WebExtension APIs, no global viewer state — every
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

// OBSERVED/DERIVED. Classifies HOW an attacking sequence was routed — deliberately
// separate from `terminalStage` (WHERE it stopped) and from `isCounterAttack`. Set
// pieces, direct free kicks and long balls bypass the normal midfield/PB progression
// entirely, so lumping them into "open play" would misrepresent how they actually
// started. A counter-attacking sequence gets its own honest category rather than
// inheriting the PARENT opportunity's isLongBallSequence/startType — those describe how
// the OTHER team's attack began, not how this sequence did; the parser has no separate
// "how did the counter itself start" classification to borrow, so this doesn't invent one.
function classifyProgressionType(seq) {
  if (seq.isCounterAttack) return 'COUNTER_ATTACK';
  if (seq.isLongBallSequence) return 'LONG_BALL';
  if (seq.startType === 'SP') return 'SET_PIECE';
  if (seq.startType === 'FK') {
    // A direct free-kick shot has no pass line at all (parser.js's phaseToSteps 'FK'
    // case only emits FK_SHOT, never FK_PASS, when phase.target is unset) — a delivered
    // free kick produces FK_PASS/FK_DUEL like a corner does.
    return seq.steps.some(s => s.stepType === 'FK_SHOT') ? 'DIRECT_FREE_KICK' : 'SET_PIECE';
  }
  return 'OPEN_PLAY'; // MID/PB/DEF starts
}

// A duel step counts as "won" by the attacking side only when the step's own OUTCOME
// says so (WON — set whenever a shot followed — or POSSESSION — the attacker took
// control outright with no contested tackle). This is the single authoritative
// definition of "won a duel" used throughout this file — never a raw value comparison,
// matching findFirstFailedDefensiveStage's explicit conservatism requirement below.
function attackerWonDuel(step) { return step.outcome === 'WON' || step.outcome === 'POSSESSION'; }

// ─────────────────────────────────────────────────────────────────────────────
// Attacking sequences — the unit every team-attribution metric should actually use
// ─────────────────────────────────────────────────────────────────────────────

// A parsed FW "opportunity" (the narrative's own "Opportunity for X" container) can
// contain TWO attacking sequences when a counter-attack happens inside it: the original
// team's sequence up to the CA boundary, and the counter-attacking team's sequence after
// it — each belongs to a genuinely different attackingSide, per parser.js's own
// step-level attackingSide/defendingSide stamping (the authoritative source for action
// ownership post-CA — see assignSides). Every metric that describes "what did this
// team's attack achieve" must be scoped to ONE sequence, never blended across both just
// because they share one parent opportunity — that blending is the exact bug class this
// function exists to close off. A non-CA opportunity is trivially its own single
// sequence, so every existing single-sequence call site keeps working unchanged.
function attackingSequencesFor(opp) {
  const steps = opp.steps || [];
  const base = { minute: opp.minute, sequence: opp.sequence, team: opp.team,
    startType: opp.startType, isLongBallSequence: opp.isLongBallSequence };
  if (!opp.isCounterAttack) return [{ ...base, steps, attackingSide: opp.teamSide, isCounterAttack: false }];
  const pre = steps.filter(s => !s.isCA);
  const post = steps.filter(s => s.isCA);
  const sequences = [];
  if (pre.length) sequences.push({ ...base, steps: pre, attackingSide: pre[0].attackingSide || opp.teamSide, isCounterAttack: false });
  if (post.length) sequences.push({ ...base, steps: post, attackingSide: post[0].attackingSide || otherSide(opp.teamSide),
    isCounterAttack: true, startType: null, isLongBallSequence: false });
  return sequences;
}

function buildFunnelEntry(seq) {
  const steps = seq.steps;
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
    minute: seq.minute, sequence: seq.sequence, team: seq.team, teamSide: seq.attackingSide,
    progressionType: classifyProgressionType(seq),
    isCounterAttack: !!seq.isCounterAttack,
    reachedMidfieldDuel, wonMidfieldDuel,
    reachedPenaltyBox, completedPenaltyBoxReception,
    shotCount, goalCount, terminalStage,
  };
}

// DERIVED. One entry per ATTACKING SEQUENCE (see attackingSequencesFor — up to two per
// FW opportunity when a counter-attack occurs), plus a per-side count summary that is
// exact arithmetic over the entries, nothing estimated. `total` therefore counts
// attacking sequences, not raw FW opportunities — a side that only ever appears via
// counter-attacks still gets its own entries and its own honest total, instead of being
// invisible because every parent opportunity nominally "belonged" to the other team.
function opportunityFunnel(match) {
  const entries = (match?.opportunities || []).flatMap(opp => attackingSequencesFor(opp).map(buildFunnelEntry));
  // FW-opportunity count is deliberately a SEPARATE, simpler tally straight off
  // match.opportunities (never through entries/sequences) — it answers "how many
  // narrative Opportunity-for-X containers did this side open", which a counter-attack
  // does not change, unlike every sequence-scoped figure below.
  const fwOpportunityCounts = { home: 0, away: 0 };
  for (const opp of (match?.opportunities || [])) if (fwOpportunityCounts[opp.teamSide] != null) fwOpportunityCounts[opp.teamSide]++;
  // Shot/goal figures are sourced from collectShotEvents() — the SAME canonical list
  // shotProfileAnalysis() reads — rather than re-derived from `entries`, so
  // funnel.shotAttempts and Σ(shot profile attempts) agree by construction, not by
  // coincidence. (They would in fact still agree even reading from `entries`, since a
  // sequence's own steps all share one attackingSide by construction of
  // attackingSequencesFor — but routing both through one shared list is the structural
  // guarantee the project's reconciliation invariants can actually check.)
  const shotEvents = collectShotEvents(match);
  const summarize = (side) => {
    const e = entries.filter(x => x.teamSide === side);
    const shots = shotEvents.filter(s => s.attackingSide === side);
    // Distinct denominators: "shots" is shot-producing SEQUENCES (how many separate
    // attacking sequences — including a counter-attack's own sequence — got a shot away
    // at all, counted from `entries` since it's a sequence-level fact); "shotAttempts"
    // is the total number of individual shot EVENTS, which can exceed it — a rebound, a
    // fumble recovery, or a set-piece continuation can all put more than one shot into a
    // single sequence.
    return {
      // "total" (and everything below it) counts ATTACKING SEQUENCES, not FW
      // opportunities — see fwOpportunities for the narrative-container count, which a
      // counter-attack does not add to or remove from for either side.
      total: e.length,
      fwOpportunities: fwOpportunityCounts[side],
      reachedMidfield: e.filter(x => x.reachedMidfieldDuel).length,
      wonMidfield: e.filter(x => x.wonMidfieldDuel).length,
      reachedPenaltyBox: e.filter(x => x.reachedPenaltyBox).length,
      shots: e.filter(x => x.shotCount > 0).length,
      shotAttempts: shots.length,
      goals: shots.filter(s => s.isGoal).length,
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
// OFFSIDE genuinely is a turnover — the attack is stopped and possession passes to the
// defense via an indirect free kick, the same kind of possession change as an
// interception or a lost tackle, just triggered by the offside law instead of a duel.
function classifyTurnoverCause(step) {
  if (step.outcome === 'GK_INTERCEPT') return 'GK_INTERCEPTION';
  if (step.outcome === 'BLOCKED') return 'BLOCKED_PASS';
  if (step.outcome === 'OFFSIDE') return 'OFFSIDE';
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
// Duel matchups — player-vs-player, not just per-player totals
// ─────────────────────────────────────────────────────────────────────────────

// Looks forward from a duel step, within the same CA-pool (mirrors viewer.js's
// stepsToChain isCA-pool split — a counter-attack boundary changes who is attacking, so
// a step before it must never be credited with a shot that only happened after it), for
// the next shot-terminal step. Used to attribute "this specific matchup's win led to a
// shot/goal" without assuming every win reaches one.
function nextShotInPool(steps, step) {
  const pool = step.isCA ? steps.filter(s => s.isCA) : steps.filter(s => !s.isCA);
  const from = pool.indexOf(step);
  if (from === -1) return null;
  return pool.slice(from + 1).find(s => SHOT_STEP_TYPES.includes(s.stepType)) || null;
}

// DERIVED. One entry per (attacker, defender, zone) pair actually observed contesting a
// duel — not every theoretical 1v1. Zone reuses ZONE_OF_STEP_TYPE (DRIB falls under
// MIDFIELD, matching where parser.js only ever creates a DRIB phase). The step's own
// recorded outcome (attackerWonDuel) is the only signal used to decide a winner — never
// a raw reception/tackle value comparison, per this file's existing convention.
// avgDefensiveValue averages whichever defensive number actually applied to that
// specific contest (a completed tackle if the control phase was reached, otherwise the
// assistance that let the defender contest positioning at all) rather than blurring the
// two different phases of a duel together.
function duelMatchups(match) {
  const byKey = new Map();
  const ensure = (attacker, attackerSide, defender, defenderSide, zone) => {
    if (!attacker?.name || !defender?.name || !zone) return null;
    const key = `${attacker.name}|${defender.name}|${zone}`;
    if (!byKey.has(key)) byKey.set(key, {
      attacker: attacker.name, attackerPosition: attacker.position || null, attackerSide,
      defender: defender.name, defenderPosition: defender.position || null, defenderSide,
      zone, contests: 0, attackerWins: 0, defenderWins: 0,
      shotsAfterAttackerWin: 0, goalsAfterAttackerWin: 0,
      receptionValues: newValueAgg(), defensiveValues: newValueAgg(),
    });
    return byKey.get(key);
  };

  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps || [];
    for (const step of steps) {
      if (!DUEL_STEP_TYPES.includes(step.stepType)) continue;
      const zone = ZONE_OF_STEP_TYPE[step.stepType] || (step.stepType === 'DRIB' ? 'MIDFIELD' : null);
      const attacker = step.attacker || step.dribbler;
      const rec = ensure(attacker, step.attackingSide, step.defender, step.defendingSide, zone);
      if (!rec) continue;
      rec.contests++;
      addValue(rec.receptionValues, step.values?.reception);
      addValue(rec.defensiveValues, step.values?.tackle ?? step.values?.assistance);
      if (attackerWonDuel(step)) {
        rec.attackerWins++;
        const shot = nextShotInPool(steps, step);
        if (shot) { rec.shotsAfterAttackerWin++; if (shot.outcome === 'GOAL') rec.goalsAfterAttackerWin++; }
      } else {
        rec.defenderWins++;
      }
    }
  }

  return [...byKey.values()].map(rec => {
    const { receptionValues, defensiveValues, ...rest } = rec;
    return {
      ...rest,
      attackerWinRate: rec.contests ? round2(rec.attackerWins / rec.contests) : null,
      avgReceptionValue: finalizeValueAgg(receptionValues).avg,
      avgDefensiveValue: finalizeValueAgg(defensiveValues).avg,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Penalty-box target / defender analysis
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED, PB_DUEL steps only. Distinguishes "reached the penalty box" (opportunityFunnel)
// from what happened to the specific player who actually contested the ball there — a
// team can reach the PB often while one target keeps losing the decisive duel, which the
// funnel alone cannot show. shots/goals look forward to the next shot in the same
// opportunity (see nextShotInPool); "corners generated" is the only "what did this
// contest lead to" signal reported besides that — a rebound's true beneficiary is
// ambiguous between the original attacker, the PB duel, and whoever recovers the loose
// ball, so it is deliberately not attributed here (see the final report for why).
function pbTargetAnalysis(match) {
  const byPlayer = new Map();
  const ensure = (p, side) => {
    if (!p?.name) return null;
    if (!byPlayer.has(p.name)) byPlayer.set(p.name, {
      player: p.name, position: p.position || null, side,
      pbContests: 0, won: 0, lost: 0, shots: 0, goals: 0, cornersGenerated: 0,
      defendersFaced: {},
    });
    return byPlayer.get(p.name);
  };

  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps || [];
    for (const step of steps) {
      if (step.stepType !== 'PB_DUEL') continue;
      const rec = ensure(step.attacker, step.attackingSide);
      if (!rec) continue;
      rec.pbContests++;
      if (attackerWonDuel(step)) rec.won++; else rec.lost++;
      if (step.defender?.name) rec.defendersFaced[step.defender.name] = (rec.defendersFaced[step.defender.name] || 0) + 1;
      if (step.outcome === 'CORNER') rec.cornersGenerated++;
      const shot = nextShotInPool(steps, step);
      if (shot) { rec.shots++; if (shot.outcome === 'GOAL') rec.goals++; }
    }
  }

  return [...byPlayer.values()].map(rec => {
    const { defendersFaced, ...rest } = rec;
    const main = Object.entries(defendersFaced).sort((a, b) => b[1] - a[1])[0];
    return { ...rest, mainDefender: main ? { name: main[0], contests: main[1] } : null };
  });
}

// DERIVED, PB_DUEL steps only — the defensive inverse of pbTargetAnalysis. Never labels
// a defender "weak"; only reports the observed contest/loss/shots-allowed counts.
function pbDefenderAnalysis(match) {
  const byPlayer = new Map();
  const ensure = (p, side) => {
    if (!p?.name) return null;
    if (!byPlayer.has(p.name)) byPlayer.set(p.name, {
      player: p.name, position: p.position || null, side,
      contests: 0, won: 0, lost: 0, shotsAllowedAfterLoss: 0, goalsAllowedAfterLoss: 0,
      opponentsFaced: {}, defensiveValues: newValueAgg(),
    });
    return byPlayer.get(p.name);
  };

  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps || [];
    for (const step of steps) {
      if (step.stepType !== 'PB_DUEL') continue;
      const rec = ensure(step.defender, step.defendingSide);
      if (!rec) continue;
      rec.contests++;
      addValue(rec.defensiveValues, step.values?.tackle ?? step.values?.assistance);
      const attacker = step.attacker;
      if (attacker?.name) rec.opponentsFaced[attacker.name] = (rec.opponentsFaced[attacker.name] || 0) + 1;
      if (attackerWonDuel(step)) {
        rec.lost++;
        const shot = nextShotInPool(steps, step);
        if (shot) { rec.shotsAllowedAfterLoss++; if (shot.outcome === 'GOAL') rec.goalsAllowedAfterLoss++; }
      } else {
        rec.won++;
      }
    }
  }

  return [...byPlayer.values()].map(rec => {
    const { opponentsFaced, defensiveValues, ...rest } = rec;
    const main = Object.entries(opponentsFaced).sort((a, b) => b[1] - a[1])[0];
    return { ...rest, avgDefensiveValue: finalizeValueAgg(defensiveValues).avg,
      mainOpponent: main ? { name: main[0], contests: main[1] } : null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Attacking routes — repeated contiguous player-progression chains
// ─────────────────────────────────────────────────────────────────────────────

// Builds ONE contiguous chain of touches from a single-side step pool: starts at the
// first pass's sender, and only extends the chain while each next pass's sender is
// literally the player the chain already ended on — a pass from someone else (a
// recovered turnover, a different phase's target) breaks the chain rather than joining
// two unrelated actions just because they occurred in the same opportunity. Appends the
// eventual shooter if a shot followed and they aren't already the chain's last node.
function buildRouteForPool(pool) {
  const passes = pool.filter(s => PASS_STEP_KINDS.includes(s.stepType) && s.from?.name && s.to?.name);
  const shot = pool.find(s => SHOT_STEP_TYPES.includes(s.stepType));
  if (!passes.length) {
    // No delivery at all: a direct free-kick shot, or a shot straight off a dribble —
    // still a one-node "route" for whoever it was, not "no route".
    const solo = shot?.shooter || pool.find(s => s.stepType === 'DRIB')?.dribbler;
    return solo?.name ? [solo] : [];
  }
  const nodes = [passes[0].from];
  for (const p of passes) {
    if (p.from.name !== nodes[nodes.length - 1]?.name) break;
    nodes.push(p.to);
  }
  if (shot?.shooter?.name && shot.shooter.name !== nodes[nodes.length - 1]?.name) nodes.push(shot.shooter);
  return nodes;
}

function routeKey(nodes) { return nodes.map(n => `${n.name}[${n.position || '?'}]`).join(' → '); }

// DERIVED. Pre-CA and post-CA steps are built as two separate routes — a counter-attack
// boundary is a change of who is attacking, not a continuation of the same team's route
// (the same convention viewer.js's stepsToChain already applies via its isCA pool split).
function attackingRoutes(match) {
  const byKey = new Map();
  for (const opp of (match?.opportunities || [])) {
    const steps = opp.steps || [];
    const pools = opp.isCounterAttack ? [steps.filter(s => !s.isCA), steps.filter(s => s.isCA)] : [steps];
    for (const pool of pools) {
      if (!pool.length) continue;
      const nodes = buildRouteForPool(pool);
      if (nodes.length < 2) continue; // a single touch is not a "route"
      const key = routeKey(nodes);
      if (!byKey.has(key)) byKey.set(key, {
        chain: nodes.map(n => ({ name: n.name, position: n.position || null })),
        side: pool[0]?.attackingSide || null,
        occurrences: 0, pbEntries: 0, shots: 0, goals: 0,
      });
      const rec = byKey.get(key);
      rec.occurrences++;
      if (pool.some(s => s.stepType === 'PB_PASS' || s.stepType === 'PB_DUEL')) rec.pbEntries++;
      const shotStep = pool.find(s => SHOT_STEP_TYPES.includes(s.stepType));
      if (shotStep) { rec.shots++; if (shotStep.outcome === 'GOAL') rec.goals++; }
    }
  }
  return [...byKey.values()].sort((a, b) => b.occurrences - a.occurrences);
}

// ─────────────────────────────────────────────────────────────────────────────
// Attack termination — where opportunities actually ended
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED, from each opportunity's own already-deduplicated finalOutcome (parser.js
// resolves a corner/rebound continuation down to the ONE outcome that actually ended the
// whole opportunity — see parser.js's TERMINAL_OUTCOMES) — never re-derives a category
// from individual step outcomes, which would risk double-counting a continuation (e.g. a
// corner won, then eventually saved) as two separate endings.
function classifyAttackTermination(opp) {
  const finalStep = opp.steps[opp.steps.length - 1];
  const outcome = opp.finalOutcome;
  const zone = finalStep ? (ZONE_OF_STEP_TYPE[finalStep.stepType] || null) : null;
  if (outcome === 'GOAL') return 'GOAL';
  if (outcome === 'SAVED') return 'SHOT_SAVED';
  if (outcome === 'FUMBLED') return 'SHOT_FUMBLED';
  if (outcome === 'POST' || outcome === 'MISSED') return 'SHOT_MISSED';
  if (outcome === 'SHOT_BLOCKED') return 'SHOT_BLOCKED';
  if (outcome === 'GK_INTERCEPT') return 'GK_INTERCEPTION';
  if (outcome === 'OFFSIDE') return 'OFFSIDE';
  if (outcome === 'CORNER') return 'SET_PIECE_CONTINUATION';
  if (outcome === 'FOUL') return 'FOUL_AWARDED';
  if (outcome === 'CLEARED' || outcome === 'BLOCKED') {
    if (zone === 'PENALTY_BOX') return outcome === 'BLOCKED' ? 'PB_DELIVERY_BLOCKED' : 'PB_LOSS';
    if (zone === 'SET_PIECE') return 'SET_PIECE_LOSS';
    return 'MIDFIELD_LOSS';
  }
  return 'OTHER_UNKNOWN';
}

function attackTermination(match) {
  const counts = { home: {}, away: {} };
  for (const opp of (match?.opportunities || [])) {
    const finalStep = opp.steps[opp.steps.length - 1];
    // The side that actually ended the opportunity — the final STEP's own
    // attackingSide, not the parent opportunity's nominal owner. A counter-attack that
    // ends the opportunity (e.g. its shot is saved) must be filed under the
    // counter-attacking side, exactly like every other step-level attribution in this
    // file; opp.teamSide is only the fallback for the (non-CA) common case.
    const side = finalStep?.attackingSide || opp.teamSide;
    if (!counts[side]) continue;
    const cat = classifyAttackTermination(opp);
    counts[side][cat] = (counts[side][cat] || 0) + 1;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensive exposure — defensiveFailureChains(), promoted to a per-defender view
// ─────────────────────────────────────────────────────────────────────────────

// DERIVED, aggregating defensiveFailureChains() per defender — no new judgment beyond
// what that function already computes. "Involved" counts any shot chain where this
// player appears as A defender at some stage; "firstFailedDefensiveStageCount" counts
// only chains where THEY were specifically the duel the attacker won outright
// (findFirstFailedDefensiveStage's own conservative definition, unchanged). Deliberately
// not phrased as "responsible for" — see this file's own note field convention.
function defensiveExposure(match) {
  const byPlayer = new Map();
  const ensure = (name, position, side) => {
    if (!name) return null;
    if (!byPlayer.has(name)) byPlayer.set(name, {
      player: name, position: position || null, side,
      shotChainsInvolvedIn: 0, firstFailedDefensiveStageCount: 0,
      shotsFollowingLoss: 0, goalsFollowingLoss: 0,
    });
    return byPlayer.get(name);
  };
  for (const chain of defensiveFailureChains(match)) {
    const seen = new Set();
    for (const stage of chain.stages) {
      if (stage.defender?.name && !seen.has(stage.defender.name)) {
        seen.add(stage.defender.name);
        ensure(stage.defender.name, stage.defender.position, chain.defendingSide).shotChainsInvolvedIn++;
      }
    }
    const failed = chain.firstFailedDefensiveStage;
    if (failed?.defender?.name) {
      const rec = ensure(failed.defender.name, failed.defender.position, chain.defendingSide);
      rec.firstFailedDefensiveStageCount++;
      rec.shotsFollowingLoss++;
      if (chain.gkOutcome === 'GOAL') rec.goalsFollowingLoss++;
    }
  }
  return [...byPlayer.values()];
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

// DERIVED player match totals. Every count below comes from a named player in the
// parsed narrative; anonymous wording such as "blocked by the opponent player" is
// deliberately not assigned to somebody by position or proximity. FinalWhistle's
// report currently exposes substitutions but not a complete starting-lineup roster,
// so minutes are available for every observed participant while a player who never
// appears anywhere in the report cannot be added honestly.
function playerStatistics(match) {
  const byKey = {};
  const keyOf = (name, side) => `${side || 'unknown'}\u0000${name}`;
  const sideFromTeam = team => {
    if (!team) return null;
    if (team === match?.meta?.homeTeam) return 'home';
    if (team === match?.meta?.awayTeam) return 'away';
    return null;
  };
  // Player identity is match-global: the same player cannot change teams during one
  // match. Establish one canonical side before aggregating actions so a conflicting
  // phase-level stamp cannot create both a home and away row. Explicit team-attributed
  // tactical events (subs/tiredness/position changes) outrank the registry, whose side
  // comes from the first observed action involving that player.
  const canonical = {};
  const setCanonical = (player, team, side, priority) => {
    if (!player?.name) return;
    const resolvedSide = sideFromTeam(team || player.team) || side || player.side || null;
    if (!resolvedSide) return;
    if (!canonical[player.name] || priority > canonical[player.name].priority)
      canonical[player.name] = { side: resolvedSide, team: team || player.team || null, priority };
  };
  for (const [name, info] of Object.entries(match?.playerRegistry || {}))
    setCanonical({ name }, info.team, info.side, 20);
  for (const ev of (match?.tacticalEvents || [])) {
    if (!ev.teamSide && !sideFromTeam(ev.team)) continue;
    if (ev.type === 'SUBSTITUTION') {
      setCanonical(ev.playerOut, ev.team, ev.teamSide, 100);
      setCanonical(ev.playerIn, ev.team, ev.teamSide, 100);
    } else if (ev.player) {
      setCanonical(ev.player, ev.team, ev.teamSide, 100);
    }
  }
  const ensure = (player, team = null, side = null) => {
    if (!player?.name) return null;
    const identity = canonical[player.name];
    const resolvedSide = identity?.side || sideFromTeam(team || player.team) || side || player.side || null;
    const resolvedTeam = identity?.team || team || player.team ||
      (resolvedSide === 'home' ? match?.meta?.homeTeam : resolvedSide === 'away' ? match?.meta?.awayTeam : null);
    const key = keyOf(player.name, resolvedSide);
    const unresolvedKey = keyOf(player.name, null);
    if (resolvedSide && !byKey[key] && byKey[unresolvedKey]) {
      byKey[key] = byKey[unresolvedKey];
      byKey[key].side = resolvedSide;
      delete byKey[unresolvedKey];
    }
    if (!byKey[key]) byKey[key] = {
      name: player.name, team: resolvedTeam, side: resolvedSide,
      positions: [], minutesPlayed: 0, shotsFaced: 0, saves: 0,
      interceptions: 0, blocks: 0,
      tackles: 0, passes: 0, completedPasses: 0, passCompletionPct: null,
      assists: 0, shots: 0, shotsOnTarget: 0, goals: 0, fouls: 0,
      // Duels competed in as EITHER attacker/dribbler or defender, combined into one
      // per-player count, per the manual's two-phase model: Position (won on OP vs DP
      // alone, no tackle attempted), Control (a tackle was contested and the attacker
      // kept the ball), Tackle (a tackle was contested and the defender won it). DRIB is
      // included — a dribble is mechanically the same 1v1 contest as a duel, just with
      // the ball carrier attempting to run past rather than receive a pass (see
      // DUEL_STEP_TYPES above, which already groups DRIB with the other duel types).
      duelsPlayed: 0, duelsWonPosition: 0, duelsWonControl: 0, duelsWonTackle: 0,
      tiredMinutes: [], veryTiredMinutes: [], yellowCards: [], injuries: [],
      substitutedInMinute: null, substitutedOutMinute: null,
      replacedPlayer: null, replacedByPlayer: null,
    };
    const rec = byKey[key];
    if (!rec.team && resolvedTeam) rec.team = resolvedTeam;
    if (player.position && !rec.positions.includes(player.position)) rec.positions.push(player.position);
    return rec;
  };

  for (const [name, info] of Object.entries(match?.playerRegistry || {})) {
    const rec = ensure({ name, side: info.side, team: info.team }, info.team, info.side);
    if (rec) for (const position of (info.positions || []))
      if (position && !rec.positions.includes(position)) rec.positions.push(position);
  }

  // A pass is completed only when its named target takes possession, or when that
  // target takes the ensuing shot. A merely attempted reception, foul, clearance, or
  // anonymous block does not become a completion; stop at the next pass so a later
  // recovery cannot retroactively complete the earlier attempt.
  const passCompleted = (steps, passIndex) => {
    const targetName = steps[passIndex]?.to?.name;
    if (!targetName) return false;
    for (let i = passIndex + 1; i < steps.length; i++) {
      const next = steps[i];
      if (PASS_STEP_KINDS.includes(next.stepType)) return false;
      if (DUEL_STEP_TYPES.includes(next.stepType) &&
          (next.attacker || next.dribbler)?.name === targetName) {
        if (next.outcome === 'POSSESSION') return true;
        if (next.outcome !== 'WON') return false;
      }
      if (SHOT_STEP_TYPES.includes(next.stepType)) return next.shooter?.name === targetName;
    }
    return false;
  };

  for (const opp of (match?.opportunities || [])) {
    let pendingAssist = null;
    const steps = opp.steps || [];
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex];
      if (PASS_STEP_KINDS.includes(step.stepType) && step.from) {
        const passer = ensure(step.from, step.attackingTeam, step.attackingSide);
        if (passer) {
          passer.passes++;
          if (passCompleted(steps, stepIndex)) passer.completedPasses++;
        }
        pendingAssist = step.to?.name ? { passer: step.from, targetName: step.to.name,
          team: step.attackingTeam, side: step.attackingSide } : null;
      }
      if (DUEL_STEP_TYPES.includes(step.stepType)) {
        const hasTackle = step.values?.tackle?.value != null;
        const attackerWon = attackerWonDuel(step);
        const offPlayer = step.attacker || step.dribbler;
        if (offPlayer) {
          const off = ensure(offPlayer, step.attackingTeam, step.attackingSide);
          if (off) {
            off.duelsPlayed++;
            if (attackerWon) { if (hasTackle) off.duelsWonControl++; else off.duelsWonPosition++; }
          }
        }
        if (step.defender) {
          const def = ensure(step.defender, step.defendingTeam, step.defendingSide);
          if (def) {
            def.duelsPlayed++;
            if (hasTackle && !attackerWon) def.duelsWonTackle++;
          }
        }
        if (step.defender && step.values?.tackle?.value != null) {
          const defender = ensure(step.defender, step.defendingTeam, step.defendingSide);
          if (defender) defender.tackles++;
        }
        if (step.outcome === 'BLOCKED' && step.defender) {
          const blocker = ensure(step.defender, step.defendingTeam, step.defendingSide);
          if (blocker) blocker.blocks++;
        }
        if (step.outcome === 'GK_INTERCEPT' && step.defender) {
          const interceptor = ensure(step.defender, step.defendingTeam, step.defendingSide);
          if (interceptor) interceptor.interceptions++;
        }
      }
      if (step.fouler) {
        const fouler = ensure(step.fouler, step.fouler.team || step.defendingTeam,
          step.fouler.side || step.defendingSide);
        if (fouler) fouler.fouls++;
      }
      if (step.yellowCard) {
        const booked = ensure(step.yellowCard, step.yellowCard.team || step.defendingTeam,
          step.yellowCard.side || step.defendingSide);
        if (booked && !booked.yellowCards.includes(opp.minute)) booked.yellowCards.push(opp.minute);
      }
      if (SHOT_STEP_TYPES.includes(step.stepType)) {
        const shooter = ensure(step.shooter, step.attackingTeam, step.attackingSide);
        if (shooter) {
          shooter.shots++;
          // These outcomes all require the ball to reach the goalkeeper/goal. POST,
          // MISSED, SHOT_BLOCKED, and the more ambiguous generic CORNER do not.
          if (['GOAL','SAVED','FUMBLED'].includes(step.outcome)) shooter.shotsOnTarget++;
          if (step.outcome === 'GOAL') {
            shooter.goals++;
            if (pendingAssist?.targetName === step.shooter?.name) {
              const assister = ensure(pendingAssist.passer, pendingAssist.team, pendingAssist.side);
              if (assister && assister !== shooter) assister.assists++;
            }
          }
        }
        const goalkeeper = ensure(step.gk, step.defendingTeam, step.defendingSide);
        if (goalkeeper) {
          goalkeeper.shotsFaced++;
          if (step.outcome === 'SAVED') goalkeeper.saves++;
        }
      }
    }
  }

  const events = [...(match?.tacticalEvents || [])]
    .sort((a, b) => (a.sequence ?? a.minute ?? 0) - (b.sequence ?? b.minute ?? 0));
  for (const ev of events) {
    if (ev.type === 'SUBSTITUTION') {
      const outgoing = ensure(ev.playerOut, ev.team, ev.teamSide);
      const incoming = ensure(ev.playerIn, ev.team, ev.teamSide);
      if (outgoing) {
        outgoing.substitutedOutMinute = ev.minute;
        outgoing.replacedByPlayer = incoming?.name || null;
      }
      if (incoming) {
        incoming.substitutedInMinute = ev.minute;
        incoming.replacedPlayer = outgoing?.name || null;
      }
    } else if (ev.player) {
      const rec = ensure(ev.player, ev.team, ev.teamSide);
      if (rec && ev.type === 'TIREDNESS') {
        const minutes = ev.level === 'VERY_TIRED' ? rec.veryTiredMinutes : rec.tiredMinutes;
        if (!minutes.includes(ev.minute)) minutes.push(ev.minute);
      }
      if (rec && ev.type === 'INJURY') {
        if (!rec.injuries.some(injury => injury.minute === ev.minute && injury.severity === ev.severity))
          rec.injuries.push({ minute: ev.minute, severity: ev.severity || null });
      }
    }
  }

  const observedMinutes = [
    ...(match?.opportunities || []).map(o => o.minute || 0),
    ...events.map(e => e.minute || 0),
  ];
  const hasExtraTime = events.some(e => e.type === 'EXTRA_TIME_BREAK') || Math.max(0, ...observedMinutes) > 90;
  const matchMinutes = hasExtraTime ? 120 : 90;
  const incoming = new Set(events
    .filter(e => e.type === 'SUBSTITUTION' && e.playerIn?.name)
    .map(e => keyOf(e.playerIn.name, e.teamSide || e.playerIn.side)));
  const onSince = {};
  for (const [key] of Object.entries(byKey)) onSince[key] = incoming.has(key) ? null : 0;
  for (const ev of events.filter(e => e.type === 'SUBSTITUTION')) {
    const outKey = ev.playerOut?.name ? keyOf(ev.playerOut.name, ev.teamSide || ev.playerOut.side) : null;
    const inKey = ev.playerIn?.name ? keyOf(ev.playerIn.name, ev.teamSide || ev.playerIn.side) : null;
    if (outKey && byKey[outKey] && onSince[outKey] != null) {
      byKey[outKey].minutesPlayed += Math.max(0, ev.minute - onSince[outKey]);
      onSince[outKey] = null;
    }
    if (inKey && byKey[inKey] && onSince[inKey] == null) onSince[inKey] = ev.minute;
  }
  for (const [key, start] of Object.entries(onSince))
    if (start != null) byKey[key].minutesPlayed += Math.max(0, matchMinutes - start);
  for (const rec of Object.values(byKey))
    rec.passCompletionPct = rec.passes ? Math.round(rec.completedPasses * 100 / rec.passes) : null;

  const positionOrder = ['GK','LB','LWB','CB','RB','RWB','DM','LM','CM','RM','LW','OM','RW','FW'];
  const sortPlayers = (a, b) => {
    const ai = positionOrder.indexOf(a.positions[0]);
    const bi = positionOrder.indexOf(b.positions[0]);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name);
  };
  const players = Object.values(byKey);
  const orderSide = side => {
    const sidePlayers = players.filter(p => p.side === side);
    const ordered = [];
    const included = new Set();
    const appendWithReplacements = player => {
      if (!player || included.has(player)) return;
      included.add(player);
      ordered.push(player);
      sidePlayers
        .filter(candidate => candidate.replacedPlayer === player.name)
        .sort((a, b) => (a.substitutedInMinute ?? 999) - (b.substitutedInMinute ?? 999))
        .forEach(appendWithReplacements);
    };
    sidePlayers.filter(p => !p.replacedPlayer).sort(sortPlayers).forEach(appendWithReplacements);
    sidePlayers.filter(p => !included.has(p)).sort(sortPlayers).forEach(appendWithReplacements);
    return ordered;
  };
  return {
    home: orderSide('home'),
    away: orderSide('away'),
    unresolved: players.filter(p => p.side !== 'home' && p.side !== 'away').sort(sortPlayers),
    matchMinutes,
    note: 'Observed named actions only. Anonymous blocks are not assigned to a player; players never named in the report cannot be reconstructed from the current scrape.',
  };
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
    // VERY_TIRED is just another reported level in the same stream — not a separate
    // event source — so it's picked out of the already-sorted reports rather than
    // tracked as its own thing during collection.
    const veryTired = info.reports.find(r => r.level === 'VERY_TIRED');
    const veryTiredMinute = veryTired ? veryTired.minute : null;

    results.push({
      player: info.player, team: info.team, side: info.side,
      firstTiredMinute: firstMinute, firstTiredLevel: info.reports[0].level,
      firstVeryTiredMinute: veryTiredMinute,
      allReports: info.reports, substitutedAtMinute: subMinute,
      minutesFromFirstTiredToSub: subMinute != null ? subMinute - firstMinute : null,
      minutesFromFirstVeryTiredToSub: (subMinute != null && veryTiredMinute != null) ? subMinute - veryTiredMinute : null,
      remainedOnPitch: subMinute == null,
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

// OBSERVED/DERIVED, built from collectShotEvents() (the same canonical list
// shotProfileAnalysis/opportunityFunnel read) rather than a third independent walk over
// opp.steps. Never reverse-engineers RE/GP/IN/CT/OR skill values or an arrow setting
// from the shot types faced — the `note` field makes that boundary explicit.
//
// Exact field definitions (per shot event naming this GK, regardless of outcome):
//   shotsFaced       — every shot event naming this GK. INCLUDES off-target/blocked
//                      attempts (MISSED/POST/SHOT_BLOCKED) whenever the narrative still
//                      named a keeper for that attempt — it is not "on-target shots".
//   onTarget         — the subset that required an actual goalkeeping response: GOAL +
//                      SAVED + FUMBLED. shotsFaced - onTarget - interceptions is not a
//                      meaningful identity (interceptions never come from a SHOT step at
//                      all — see below); use offTargetOrBlocked for the off-target count.
//   offTargetOrBlocked — MISSED + POST + SHOT_BLOCKED: the ball never reached/beat the
//                      keeper in a way that needed a save attempt.
//   saves            — SAVED only: a controlled save (onTarget subset).
//   fumbles          — FUMBLED only: an uncontrolled save (onTarget subset). Mutually
//                      exclusive with saves per shot event — a fumble is never also
//                      counted as a save on the SAME event; a genuine rebound shot is a
//                      separate SHOT step (parser.js splits it out), so it correctly
//                      increments shotsFaced again rather than double-counting one event.
//   goalsConceded    — GOAL only (onTarget subset).
//   interceptions    — from a GK_INTERCEPT outcome on a DUEL-type step, never a SHOT
//                      step at all: a GK interception is not a shot faced and is not
//                      counted in shotsFaced/onTarget/offTargetOrBlocked.
//   unresolved       — a shot event whose outcome never resolved to one of the above (an
//                      in-progress match, or a scrape cut off before the shot's
//                      resolution line was captured). Counted in shotsFaced but
//                      deliberately NOT folded into onTarget or offTargetOrBlocked —
//                      guessing which one it "would have been" isn't supported by the
//                      data. shotsFaced === onTarget + offTargetOrBlocked + unresolved
//                      always holds by construction (see reconcileScoutingReport).
//                      cornersConceded is retained for shape compatibility but is
//                      currently unreachable — 'CORNER' has never been a valid SHOT-step
//                      outcome (see parser.js's SHOT_TERMINALS); a shot deflecting behind
//                      for a corner is recorded as the DUEL step's own CORNER outcome,
//                      not this shot event's.
function goalkeeperAnalysis(match) {
  const byGK = {};
  const ensure = (p, team, side) => {
    if (!p?.name) return null;
    if (!byGK[p.name]) byGK[p.name] = { name: p.name, team: team || null, side: side || null,
      shotsFaced: 0, onTarget: 0, offTargetOrBlocked: 0, unresolved: 0,
      saves: 0, goalsConceded: 0, fumbles: 0, cornersConceded: 0,
      interceptions: 0, saveValues: newValueAgg() };
    return byGK[p.name];
  };
  for (const ev of collectShotEvents(match)) {
    if (!ev.gk?.name) continue;
    const rec = ensure(ev.gk, ev.defendingTeam, ev.defendingSide);
    if (!rec) continue;
    rec.shotsFaced++;
    if (ev.isGoal) { rec.goalsConceded++; rec.onTarget++; }
    else if (ev.isSaved) { rec.saves++; rec.onTarget++; }
    else if (ev.isFumbled) { rec.fumbles++; rec.onTarget++; }
    // CORNER is not currently a reachable SHOT-step outcome (see SHOT_TERMINALS in
    // parser.js), but is still folded into offTargetOrBlocked defensively — a shot
    // deflected behind for a corner never beat/required a save decision, so it belongs
    // in the same bucket as MISSED/POST/SHOT_BLOCKED. Leaving this branch to fall through
    // to `unresolved` (as it did previously) would silently break the
    // shotsFaced === onTarget + offTargetOrBlocked + unresolved invariant if the parser
    // ever started emitting it.
    else if (ev.result === 'CORNER') { rec.cornersConceded++; rec.offTargetOrBlocked++; }
    else if (ev.isMissed || ev.isBlocked) rec.offTargetOrBlocked++;
    else rec.unresolved++;
    if (ev.gkSaveValue != null) rec.saveValues.values.push(ev.gkSaveValue);
  }
  for (const opp of (match?.opportunities || [])) {
    for (const step of opp.steps) {
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
// Canonical shot events — the ONE place shot steps are walked; every shot-derived
// metric (funnel shot/goal counts, shot profile, GK shots-faced) must read from this
// list rather than independently re-deriving its own count, so they cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

// Technique (how it was hit) kept deliberately separate from origin/delivery context
// (isDirectFreeKick, isPenalty) — forcing both into one bucket loses information: a
// direct free kick that FinalWhistle also narrates as "Long Shot Goal Attempt" is BOTH
// a long shot AND a direct free kick, not one or the other. Only uses distinctions the
// parser/narrative actually identified (step.shotType, step.isLongShot, stepType) — an
// observed shot type is not treated as proof a specific Player Order was configured.
function shotTechnique(step) {
  if (step.isPenalty) return 'penalty';
  if (step.isLongShot) return 'long shot';
  return (step.shotType || 'normal').toLowerCase();
}

// DERIVED. attackingSide/defendingSide come from the STEP itself (falling back to the
// parent opportunity only when a step somehow lacks its own — parser.js always sets
// it, so this is defensive, not the primary path) — a counter-attack's shot belongs to
// the counter-attacking side, never to the parent opportunity's nominal owner.
function collectShotEvents(match) {
  const events = [];
  for (const opp of (match?.opportunities || [])) {
    opp.steps.forEach((step, stepIndex) => {
      if (!SHOT_STEP_TYPES.includes(step.stepType)) return;
      const attackingSide = step.attackingSide || opp.teamSide;
      events.push({
        minute: opp.minute, sequence: opp.sequence, stepIndex,
        attackingSide, defendingSide: step.defendingSide || otherSide(attackingSide),
        attackingTeam: step.attackingTeam || null, defendingTeam: step.defendingTeam || null,
        player: step.shooter || null, gk: step.gk || null,
        technique: shotTechnique(step),
        isDirectFreeKick: step.stepType === 'FK_SHOT',
        isPenalty: !!step.isPenalty,
        shotValue: step.values?.shot?.value ?? null,
        gkSaveValue: step.values?.gkSave?.value ?? null,
        result: step.outcome || null,
        isGoal: step.outcome === 'GOAL',
        isSaved: step.outcome === 'SAVED',
        isFumbled: step.outcome === 'FUMBLED',
        isBlocked: step.outcome === 'SHOT_BLOCKED',
        isMissed: step.outcome === 'MISSED' || step.outcome === 'POST',
        isCounterAttack: !!step.isCA,
      });
    });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shot profile analysis
// ─────────────────────────────────────────────────────────────────────────────

// OBSERVED/DERIVED, built from collectShotEvents() — the profile's own attempt totals
// therefore always sum to exactly the number of canonical shot events for that side, by
// construction, rather than risking a second independent walk drifting from the first.
// A direct free kick that is ALSO a long shot gets its own combined bucket label
// ("long shot (direct free kick)") instead of silently collapsing into just one of the
// two dimensions.
function shotProfileAnalysis(match) {
  const byType = { home: {}, away: {} };
  for (const ev of collectShotEvents(match)) {
    const bucket = byType[ev.attackingSide];
    if (!bucket) continue;
    const type = ev.isDirectFreeKick && ev.technique !== 'penalty' ? `${ev.technique} (direct free kick)` : ev.technique;
    if (!bucket[type]) bucket[type] = { attempts: 0, goals: 0, shotValues: newValueAgg(), gkValues: newValueAgg() };
    const rec = bucket[type];
    rec.attempts++;
    if (ev.isGoal) rec.goals++;
    if (ev.shotValue != null) rec.shotValues.values.push(ev.shotValue);
    if (ev.gkSaveValue != null) rec.gkValues.values.push(ev.gkSaveValue);
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
  const starts = {}, progressors = {}, pbReceivers = {}, pbSuppliers = {}, shotTakers = {},
        terminators = {}, shotChainDefenders = {};
  for (const opp of (match?.opportunities || [])) {
    const first = opp.steps[0];
    if (first) {
      const starter = first.from || first.dribbler || first.shooter;
      if (starter) bumpInvolvement(starts, starter.name, first.attackingTeam, first.attackingSide);
    }
    for (const step of opp.steps) {
      if (PASS_STEP_KINDS.includes(step.stepType) && step.to) bumpInvolvement(progressors, step.to.name, step.attackingTeam, step.attackingSide);
      if (step.stepType === 'PB_PASS' && step.to) bumpInvolvement(pbReceivers, step.to.name, step.attackingTeam, step.attackingSide);
      if (step.stepType === 'PB_PASS' && step.from) bumpInvolvement(pbSuppliers, step.from.name, step.attackingTeam, step.attackingSide);
      if (SHOT_STEP_TYPES.includes(step.stepType) && step.shooter) bumpInvolvement(shotTakers, step.shooter.name, step.attackingTeam, step.attackingSide);
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
  return { starts, progressors, pbReceivers, pbSuppliers, shotTakers, terminators, shotChainDefenders,
    note: 'Counts and outcome rates only — high involvement is not itself a best/worst judgment.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation invariants — development/test-only. Not surfaced in the normal
// Scouting Report; call this from a test or a manual debugging session when you need to
// verify that the headline numbers, shot profile, GK stats, and PB tables all agree with
// each other and with the canonical shot-event list. Where two analytics deliberately
// use a different scope (e.g. "shot-producing sequences" vs "total shot attempts"), that
// difference is a separate, explicitly named check rather than a forced equality.
// ─────────────────────────────────────────────────────────────────────────────
function reconcileScoutingReport(match) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const shotEvents = collectShotEvents(match);
  const funnel = opportunityFunnel(match);
  const shotProfile = shotProfileAnalysis(match);
  const gkAnalysis = goalkeeperAnalysis(match);
  const targets = pbTargetAnalysis(match);
  const defenders = pbDefenderAnalysis(match);
  const matchups = duelMatchups(match);

  for (const side of ['home', 'away']) {
    const canonicalCount = shotEvents.filter(s => s.attackingSide === side).length;
    record(`funnel.shotAttempts === canonical shot count (${side})`,
      funnel[side].shotAttempts === canonicalCount,
      { funnelShotAttempts: funnel[side].shotAttempts, canonicalCount });

    const profileSum = Object.values(shotProfile[side]).reduce((n, r) => n + r.attempts, 0);
    record(`sum(shot profile attempts) === canonical shot count (${side})`,
      profileSum === canonicalCount,
      { profileSum, canonicalCount });

    const canonicalGoals = shotEvents.filter(s => s.attackingSide === side && s.isGoal).length;
    record(`funnel.goals (shot-producing-sequence count) === canonical goal-event count (${side})`,
      funnel[side].goals === canonicalGoals,
      { funnelGoals: funnel[side].goals, canonicalGoals,
        note: 'Different scopes that should still coincide in practice: funnel.goals counts SEQUENCES containing >=1 goal, canonicalGoals counts individual goal EVENTS — a goal is always terminal (parser.js TERMINAL_OUTCOMES), so one sequence cannot contain more than one, and the two numbers should always match.' });

    const defended = shotEvents.filter(s => s.defendingSide === side).length;
    const gkRecords = Object.values(gkAnalysis.byGoalkeeper).filter(g => g.side === side);
    const gkTotal = gkRecords.reduce((n, g) => n + g.shotsFaced, 0);
    record(`sum(GK shotsFaced) === shots defended (${side})`, gkTotal === defended, { gkTotal, defended });
    for (const gk of gkRecords) {
      record(`GK ${gk.name}: shotsFaced === onTarget + offTargetOrBlocked + unresolved`,
        gk.shotsFaced === gk.onTarget + gk.offTargetOrBlocked + gk.unresolved,
        { shotsFaced: gk.shotsFaced, onTarget: gk.onTarget, offTargetOrBlocked: gk.offTargetOrBlocked, unresolved: gk.unresolved });
    }

    const targetPbTotal = targets.filter(t => t.side === side).reduce((n, t) => n + t.pbContests, 0);
    const matchupPbTotal = matchups.filter(m => m.attackerSide === side && m.zone === 'PENALTY_BOX').reduce((n, m) => n + m.contests, 0);
    record(`sum(pbTargetAnalysis contests) === sum(duelMatchups PB contests as attacker) (${side})`,
      targetPbTotal === matchupPbTotal, { targetPbTotal, matchupPbTotal });

    const defenderPbTotal = defenders.filter(d => d.side === side).reduce((n, d) => n + d.contests, 0);
    const matchupDefPbTotal = matchups.filter(m => m.defenderSide === side && m.zone === 'PENALTY_BOX').reduce((n, m) => n + m.contests, 0);
    record(`sum(pbDefenderAnalysis contests) === sum(duelMatchups PB contests as defender) (${side})`,
      defenderPbTotal === matchupDefPbTotal, { defenderPbTotal, matchupDefPbTotal });
  }

  // attackTermination must not double- or under-count opportunities: exactly one
  // termination category per opportunity, summed across both sides.
  const termination = attackTermination(match);
  const terminationTotal = Object.values(termination.home).reduce((n, c) => n + c, 0)
    + Object.values(termination.away).reduce((n, c) => n + c, 0);
  record('sum(attackTermination categories) === total opportunity count (no double-count)',
    terminationTotal === (match?.opportunities || []).length,
    { terminationTotal, opportunityCount: (match?.opportunities || []).length });

  const mismatches = checks.filter(c => !c.ok);
  return { valid: mismatches.length === 0, checks, mismatches };
}

// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    laneOf, sampleSizeHint, parserConfidence,
    opportunityFunnel, buildFunnelEntry, classifyProgressionType,
    turnoverAnalysis, classifyTurnoverCause,
    defensiveFailureChains, findFirstFailedDefensiveStage,
    phasePerformance, compareAroundEvent, compareAdjacentPhases,
    playerDuelAnalysis, playerStatistics, assistanceAnalysis, fatigueImpact,
    laneAnalysis, counterAttackAnalysis, setPieceAnalysis, goalkeeperAnalysis,
    shotProfileAnalysis, passProfileAnalysis, playerInvolvementChains,
    duelMatchups, pbTargetAnalysis, pbDefenderAnalysis,
    attackingRoutes, attackTermination, classifyAttackTermination, defensiveExposure,
    collectShotEvents, shotTechnique, attackingSequencesFor,
    reconcileScoutingReport,
  };
}
