'use strict';

/**
 * Pure playback model.
 *
 * Converts parser-owned match.opportunities[].steps[] and tacticalEvents[] into a timed
 * presentation queue. It deliberately does not parse narrative text, infer coordinates,
 * or mutate the match model. viewer.js owns the DOM/controller layer.
 */

const PB_CUE_DURATIONS = Object.freeze({
  opportunityStart: 9000,
  pass: 15000,
  duel: 14000,
  dribble: 15000,
  shotStrike: 16000,
  longShotStrike: 18000,
  shotResolve: 16000,
  goal: 20000,
  recovery: 14000,
  discipline: 15000,
  tactical: 16000,
  break: 20000,
  opportunityEnd: 9000,
});

const PB_PASS_STEPS = new Set(['START_PASS', 'PB_PASS', 'SP_PASS', 'FK_PASS']);
const PB_DUEL_STEPS = new Set(['MID_DUEL', 'PB_DUEL', 'SP_DUEL', 'FK_DUEL']);
const PB_SHOT_STEPS = new Set(['SHOT', 'FK_SHOT']);

function pbPlayer(source) {
  if (typeof source === 'string') return Object.freeze({ name: source, position: null, team: null, side: null });
  if (!source?.name) return null;
  return Object.freeze({
    name: source.name,
    position: source.position || null,
    team: source.team || null,
    side: source.side || null,
  });
}

function pbQuality(source) {
  if (!source || source.value == null) return null;
  return Object.freeze({ value: source.value, label: source.label || null });
}

function pbCue(base, fields) {
  return Object.freeze({
    opportunityIndex: null,
    stepIndex: null,
    tacticalEventIndex: null,
    minute: null,
    sequence: null,
    attackingSide: null,
    defendingSide: null,
    durationMs: 600,
    precision: 'schematic',
    sourceConfidence: 'exact',
    ...base,
    ...fields,
  });
}

function pbPassVariant(step) {
  if (step.stepType === 'SP_PASS') return 'corner';
  if (step.stepType === 'FK_PASS') return 'free-kick';
  if (step.stepType === 'PB_PASS') return 'penalty-box';
  return step.isCA ? 'counter-attack' : 'midfield';
}

function pbDuelVariant(step) {
  if (step.outcome === 'OFFSIDE') return 'offside';
  if (step.outcome === 'GK_INTERCEPT') return 'gk-intercept';
  if (step.outcome === 'FOUL') return 'foul';
  if (step.outcome === 'BLOCKED') return 'blocked';
  if (step.outcome === 'CLEARED') return 'cleared';
  return ['POSSESSION', 'WON'].includes(step.outcome) ? 'won' : 'contested';
}

function pbShotVariant(step) {
  if (step.isPenalty) return 'penalty';
  if (step.stepType === 'FK_SHOT') return 'direct-free-kick';
  if (step.isLongShot) return 'long';
  return step.shotType || 'standard';
}

function pbShotResolutionVariant(step) {
  return ({
    GOAL: 'goal', SAVED: 'save', FUMBLED: 'fumble', POST: 'woodwork',
    MISSED: 'miss', SHOT_BLOCKED: 'blocked', CORNER: 'corner',
  })[step.outcome] || String(step.outcome || 'unknown').toLowerCase();
}

function pbBaseForOpportunity(opp, opportunityIndex) {
  return {
    opportunityIndex,
    minute: opp.minute ?? null,
    sequence: opp.sequence ?? opportunityIndex,
    attackingSide: opp.teamSide || null,
    defendingSide: opp.teamSide === 'home' ? 'away' : opp.teamSide === 'away' ? 'home' : null,
    sourceConfidence: opp.streamMatchConfidence || 'exact',
  };
}

function pbStepCues(opp, opportunityIndex, step, stepIndex) {
  const base = {
    ...pbBaseForOpportunity(opp, opportunityIndex),
    stepIndex,
    attackingSide: step.attackingSide || opp.teamSide || null,
    defendingSide: step.defendingSide ||
      ((step.attackingSide || opp.teamSide) === 'home' ? 'away' : 'home'),
    isCounterAttack: !!step.isCA,
  };
  const cues = [];

  if (PB_PASS_STEPS.has(step.stepType)) {
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-pass`,
      kind: 'flow.pass',
      variant: pbPassVariant(step),
      phase: step.stepType,
      actor: pbPlayer(step.from),
      target: pbPlayer(step.to),
      passHeight: step.passHeight || null,
      passType: step.passType || null,
      quality: pbQuality(step.values?.pass),
      outcome: step.outcome || null,
      durationMs: PB_CUE_DURATIONS.pass,
    }));
  } else if (PB_DUEL_STEPS.has(step.stepType)) {
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-duel`,
      kind: 'flow.duel',
      variant: pbDuelVariant(step),
      phase: step.stepType,
      actor: pbPlayer(step.attacker),
      opponent: pbPlayer(step.defender),
      receptionQuality: pbQuality(step.values?.reception),
      tackleQuality: pbQuality(step.values?.tackle),
      assistanceQuality: pbQuality(step.values?.assistance),
      outcome: step.outcome || null,
      durationMs: PB_CUE_DURATIONS.duel,
    }));
  } else if (step.stepType === 'DRIB') {
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-dribble`,
      kind: 'flow.dribble',
      variant: step.outcome === 'POSSESSION' ? 'won' : 'contested',
      phase: step.stepType,
      actor: pbPlayer(step.dribbler),
      opponent: pbPlayer(step.defender),
      dribbleQuality: pbQuality(step.values?.reception),
      tackleQuality: pbQuality(step.values?.tackle),
      outcome: step.outcome || null,
      durationMs: PB_CUE_DURATIONS.dribble,
    }));
  } else if (PB_SHOT_STEPS.has(step.stepType)) {
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-strike`,
      kind: 'shot.strike',
      variant: pbShotVariant(step),
      phase: step.stepType,
      actor: pbPlayer(step.shooter),
      goalkeeper: pbPlayer(step.gk),
      shotType: step.shotType || null,
      shotAngle: step.shotAngle || null,
      oneOnOne: !!step.oneOnOne,
      isLongShot: !!step.isLongShot,
      isPenalty: !!step.isPenalty,
      quality: pbQuality(step.values?.shot),
      outcome: null,
      durationMs: step.isLongShot ? PB_CUE_DURATIONS.longShotStrike : PB_CUE_DURATIONS.shotStrike,
    }));
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-resolve`,
      kind: 'shot.resolve',
      variant: pbShotResolutionVariant(step),
      phase: step.stepType,
      actor: pbPlayer(step.shooter),
      goalkeeper: pbPlayer(step.gk),
      quality: pbQuality(step.values?.shot),
      goalkeeperQuality: pbQuality(step.values?.gkSave),
      outcome: step.outcome || null,
      missType: step.missType || null,
      looseBallResolution: step.looseBallResolution || null,
      durationMs: step.outcome === 'GOAL' ? PB_CUE_DURATIONS.goal : PB_CUE_DURATIONS.shotResolve,
    }));
  }

  if (step.yellowCard) {
    const cardSide = step.yellowCard.side || base.defendingSide;
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-yellow-card`,
      kind: 'incident.card',
      variant: 'yellow',
      actor: pbPlayer(step.yellowCard),
      attackingSide: cardSide,
      defendingSide: cardSide === 'home' ? 'away' : cardSide === 'away' ? 'home' : null,
      outcome: 'YELLOW_CARD',
      durationMs: PB_CUE_DURATIONS.discipline,
    }));
  }

  if (step.looseBallRecovery || step.blockRecovery) {
    const recovery = step.looseBallRecovery || step.blockRecovery;
    const recoverySide = recovery.side || base.attackingSide;
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-step-${stepIndex}-recovery`,
      kind: 'flow.recovery',
      variant: step.looseBallResolution === 'CLEARED' ? 'recovered-and-cleared' : 'recovered',
      actor: pbPlayer(recovery),
      attackingSide: recoverySide,
      defendingSide: recoverySide === 'home' ? 'away' : recoverySide === 'away' ? 'home' : null,
      outcome: step.looseBallResolution || null,
      durationMs: PB_CUE_DURATIONS.recovery,
    }));
  }

  return cues;
}

function pbTacticalCue(event, tacticalEventIndex) {
  const isBreak = event.type === 'HALF_TIME' || event.type === 'EXTRA_TIME_BREAK';
  return pbCue({
    tacticalEventIndex,
    minute: event.minute ?? null,
    sequence: event.sequence ?? null,
    sourceConfidence: event.teamSide || event.scope === 'match' ? 'exact' : 'degraded',
  }, {
    id: `event-${tacticalEventIndex}-${String(event.type || 'unknown').toLowerCase()}`,
    kind: isBreak ? 'match.break' : 'match.event',
    variant: String(event.type || 'unknown').toLowerCase().replaceAll('_', '-'),
    eventType: event.type || null,
    rawText: event.rawText || null,
    teamSide: event.teamSide || null,
    actor: pbPlayer(event.player || event.target || event.playerOut),
    secondaryActor: pbPlayer(event.playerIn),
    value: event.mentality || event.style || event.preferredSide || event.level || event.severity || event.period || null,
    durationMs: isBreak ? PB_CUE_DURATIONS.break : PB_CUE_DURATIONS.tactical,
  });
}

function buildPlaybackCues(match, options = {}) {
  const opportunities = match?.opportunities || [];
  const tacticalEvents = match?.tacticalEvents || [];
  const requestedOpportunity = Number.isInteger(options.opportunityIndex)
    ? options.opportunityIndex : null;
  const items = [];

  opportunities.forEach((opp, opportunityIndex) => {
    if (requestedOpportunity !== null && opportunityIndex !== requestedOpportunity) return;
    items.push({ type: 'opportunity', sequence: opp.sequence ?? opportunityIndex, opp, opportunityIndex });
  });
  if (requestedOpportunity === null) {
    tacticalEvents.forEach((event, tacticalEventIndex) => {
      items.push({ type: 'tactical', sequence: event.sequence ?? Number.MAX_SAFE_INTEGER, event, tacticalEventIndex });
    });
  }
  items.sort((a, b) => a.sequence - b.sequence || (a.type === 'tactical' ? -1 : 1));

  const cues = [];
  for (const item of items) {
    if (item.type === 'tactical') {
      cues.push(pbTacticalCue(item.event, item.tacticalEventIndex));
      continue;
    }
    const { opp, opportunityIndex } = item;
    const base = pbBaseForOpportunity(opp, opportunityIndex);
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-start`,
      kind: 'opportunity.start',
      variant: opp.isCounterAttack ? 'counter-attack' : String(opp.startType || 'open-play').toLowerCase(),
      team: opp.team || null,
      scoreBefore: opp.scoreBefore || null,
      durationMs: PB_CUE_DURATIONS.opportunityStart,
    }));
    (opp.steps || []).forEach((step, stepIndex) => {
      cues.push(...pbStepCues(opp, opportunityIndex, step, stepIndex));
    });
    cues.push(pbCue(base, {
      id: `opp-${opportunityIndex}-end`,
      kind: 'opportunity.end',
      variant: String(opp.finalOutcome || 'complete').toLowerCase(),
      outcome: opp.finalOutcome || null,
      scoreAfter: opp.scoreAfter || null,
      durationMs: PB_CUE_DURATIONS.opportunityEnd,
    }));
  }
  return Object.freeze(cues);
}

function playbackPartialOpportunity(match, cue) {
  if (!Number.isInteger(cue?.opportunityIndex)) return null;
  const source = match?.opportunities?.[cue.opportunityIndex];
  if (!source) return null;
  let steps;
  if (cue.kind === 'opportunity.start') steps = [];
  else if (cue.kind === 'opportunity.end' || !Number.isInteger(cue.stepIndex)) steps = [...(source.steps || [])];
  else steps = (source.steps || []).slice(0, cue.stepIndex + 1);
  return {
    ...source,
    steps,
    playbackFocusStepIndex: Number.isInteger(cue.stepIndex) ? cue.stepIndex : null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PB_CUE_DURATIONS,
    buildPlaybackCues,
    playbackPartialOpportunity,
  };
}
