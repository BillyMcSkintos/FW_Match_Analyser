'use strict';

/**
 * FinalWhistle Match Parser
 *
 * Produces a flat steps[] array per opportunity.
 * Each step is one atomic engine action:
 *
 *   START_PASS        – initiating pass (GK/DEF → MID, or winning MID → next MID)
 *   MID_DUEL           – midfield duel (positioning then control)
 *   PB_PASS / PB_DUEL   – pass into penalty box + attacker vs defender duel there
 *   SP_PASS / SP_DUEL   – corner restart pass + duel (same shape as PB)
 *   FK_PASS / FK_DUEL   – free kick restart pass + duel (same shape as PB), used when
 *                         the free kick is delivered rather than shot directly
 *   FK_SHOT            – direct free kick shot (no pass line at all)
 *   SHOT                – goal attempt, following a *_DUEL step or a direct MID long shot
 *   DRIB                – dribble attempt (between any two phases)
 *
 * Counter-attack: steps after CA boundary have isCA=true and sides flipped.
 *
 * Stream value distribution per stream phase:
 *   V_PASS                        → pass step
 *   V_ASSISTANCE/RECEPTION/TACKLE  → duel step
 *   V_SHOT / V_REFLEX             → shot step
 */

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY
// ─────────────────────────────────────────────────────────────────────────────

const QUALITY_BANDS = [
  { label: 'legendary',    min: 120 },
  { label: 'unbelievable', min: 110 },
  { label: 'masterful',    min: 100 },
  { label: 'awesome',      min: 90  },
  { label: 'brilliant',    min: 80  },
  { label: 'superb',       min: 70  },
  { label: 'excellent',    min: 60  },
  { label: 'good',         min: 50  },
  { label: 'decent',       min: 40  },
  { label: 'weak',         min: 30  },
  { label: 'poor',         min: 15  },
  { label: 'awful',        min: 0   },
];

function qualityLabel(n) {
  if (n == null) return null;
  for (const { label, min } of QUALITY_BANDS) if (n >= min) return label;
  return 'awful';
}

function qv(n) {
  if (n == null) return null;
  return { value: n, label: qualityLabel(n) };
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAM PARSER
// ─────────────────────────────────────────────────────────────────────────────

function parseStreamTokens(streamText) {
  const RE = /^(\d+)'\s*-\s*([HA])\s*-\s*(\w+)(?:\s*-\s*\((\d+)\))?$/;
  return streamText.split('\n').map(l => l.trim()).filter(Boolean).reduce((acc, line) => {
    const m = RE.exec(line);
    if (m) acc.push({ minute: parseInt(m[1]), side: m[2], kind: m[3],
                       value: m[4] !== undefined ? parseInt(m[4]) : null });
    return acc;
  }, []);
}

function groupStreamBlocks(tokens) {
  const segs = []; let cur = null;
  for (const tok of tokens) {
    if (tok.kind.startsWith('O_')) { if (cur) segs.push(cur); cur = { header: tok, tokens: [] }; }
    else if (cur) cur.tokens.push(tok);
  }
  if (cur) segs.push(cur);
  return segs.map(s => buildStreamBlock(s, false));
}

function buildStreamBlock(seg, isCA) {
  const { header, tokens } = seg;
  const startType = isCA ? 'CA' : header.kind.replace('O_','').replace('_START','');
  const caIdx = tokens.findIndex(t => t.kind === 'E_COUNTER_ATTACK');
  let mainTokens = tokens, counterAttack = null;
  if (caIdx !== -1) {
    mainTokens = tokens.slice(0, caIdx);
    counterAttack = buildStreamBlock(
      { header: { ...tokens[caIdx], kind: 'O_CA_START' }, tokens: tokens.slice(caIdx+1) }, true);
  }
  return { minute: header.minute, attackingSide: header.side, startType, isCounterAttack: isCA,
           phases: buildStreamPhases(mainTokens), counterAttack };
}

function buildStreamPhases(tokens) {
  const phases = []; let phase = { values: {}, events: [] }; let hasPass = false;
  const flush = () => {
    if (phase.events.length || Object.keys(phase.values).length) phases.push(phase);
    phase = { values: {}, events: [] }; hasPass = false;
  };
  for (const tok of tokens) {
    switch (tok.kind) {
      case 'V_PASS':
        if (hasPass || Object.keys(phase.values).length) flush();
        phase.values.pass = tok.value; hasPass = true; break;
      case 'V_ASSISTANCE':
        if ('assistance' in phase.values) flush();
        phase.values.assistance = tok.value; break;
      case 'V_RECEPTION':  phase.values.reception = tok.value; break;
      case 'V_TACKLING':   phase.values.tackle     = tok.value; break;
      case 'V_SHOT':       phase.values.shot        = tok.value; break;
      case 'V_REFLEX':     phase.values.gkSave      = tok.value; break;
      case 'E_CORNER': case 'E_FREE_KICK': case 'E_GOAL':
      case 'E_BLOCK': case 'E_INTERCEPTION': case 'E_FUMBLE':
        // Only flush if this phase actually has values — two terminal events can fire
        // back-to-back with nothing in between (e.g. a fumbled save immediately followed
        // by the resulting corner), and flushing on both creates a phantom empty phase
        // between them. Tag the event and let it merge into whichever phase (the one just
        // closed, or the next one) actually has the values.
        phase.events.push(tok.kind);
        if (Object.keys(phase.values).length) flush();
        break;
      case 'E_CARD': case 'E_PENALTY_KICK': case 'E_INJURY': phase.events.push(tok.kind); break;
      default:
        // C_* tokens are tactical/coaching metadata (subs, player orders, moves) that
        // can trail after a phase-ending event — not gameplay, so they must not be
        // absorbed as phase events or they create a phantom trailing phase with no values.
        if (!tok.kind.startsWith('C_')) phase.events.push(tok.kind);
    }
  }
  if (Object.keys(phase.values).length) {
    phases.push(phase);
  } else if (phase.events.length) {
    // A terminal event with no values of its own — e.g. E_FUMBLE tagging the same shot
    // E_GOAL just closed (confirmed real ordering: V_SHOT, V_REFLEX, E_GOAL, E_FUMBLE) —
    // has nothing after it to merge forward into the way the back-to-back case above
    // does. Attach it to the phase that was just closed instead of letting it become a
    // phantom trailing phase with no values, which would otherwise inflate the stream
    // phase count past the narrative's and misattribute every value after it.
    if (phases.length) phases[phases.length - 1].events.push(...phase.events);
    else phases.push(phase);
  }
  return phases;
}

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE PARSER  →  internal phases (converted to steps after stream merge)
// ─────────────────────────────────────────────────────────────────────────────

function parseNarrative(narrativeText) {
  const ls = narrativeText.split('\n').map(l => l.trim()).filter(Boolean);
  const opps = [], tactics = [], scoreByMin = {};
  let score = { home: 0, away: 0 }, minute = null, teamContext = null;

  // Quick scan for team names
  const teamNames = new Set();
  for (const line of ls) {
    let m;
    if ((m = line.match(/^Opportunity for (.+?)\.$/)))               teamNames.add(m[1]);
    if ((m = line.match(/^(.+?) - (?:Issued order-|[A-Z][a-z]+)/))) teamNames.add(m[1].trim());
  }

  let currentOpp = null, currentPhase = null, inCA = false, currentRawLines = [];

  const flushPhase = () => {
    // Mirror the stream side's flush(): a phase that never got a real action (no passer —
    // e.g. a pass-blocked recovery that goes straight to "cleared the ball to safety" with
    // no further pass attempt) has no stream-side counterpart, and pushing it as its own
    // phase creates a narrative-vs-stream count mismatch in the opposite direction.
    if (currentPhase && currentOpp && currentPhase.passer) { currentOpp.phases.push(currentPhase); }
    currentPhase = null;
  };
  const flushOpp = () => {
    flushPhase();
    if (currentOpp) { currentOpp.rawLines = currentRawLines.slice(); opps.push(currentOpp); }
    currentOpp = null; inCA = false; currentRawLines = [];
  };
  const startPhase = (type) => {
    flushPhase();
    currentPhase = { phaseType: type, passer: null, target: null, defender: null, gkPlayer: null,
      passType: 'normal', passHeight: null, outcome: null, fouler: null, shotTaker: null,
      blockRecovery: null, yellowCard: null, shotType: null, shotAngle: null,
      oneOnOne: false, isLongShot: false, isCA: inCA };
  };

  for (const line of ls) {
    let m;
    if (currentOpp) currentRawLines.push(line);

    // ── Admin ─────────────────────────────────────────────────────────────────
    if ((m = line.match(/^Minute (\d+)$/))) { minute = parseInt(m[1]); teamContext = null; continue; }
    if ((m = line.match(/^\[(\d+)-(\d+)\]$/))) {
      score = { home: parseInt(m[1]), away: parseInt(m[2]) };
      if (minute !== null) scoreByMin[minute] = { ...score }; continue;
    }
    if (/Half Time/.test(line))                    { tactics.push({ minute, type: 'HALF_TIME' }); continue; }
    if (/referee blew the final whistle/.test(line)) continue;

    if ((m = line.match(/^(.+?) - (.+?) \[([A-Z]+)\] looks (very tired|tired)\.$/)))
      { tactics.push({ minute, type: 'TIREDNESS', team: m[1].trim(),
          player: { name: m[2].trim(), position: m[3] },
          level: m[4] === 'very tired' ? 'VERY_TIRED' : 'TIRED' }); continue; }

    // Injury — appears inline within a phase, not as a standalone admin line, so it
    // has no team prefix. FinalWhistle only has two real injury tiers, Light and Severe
    // (a Light Injury can later progress to Severe) — classify explicitly rather than
    // defaulting anything unrecognized to the more severe tier, since a missing or
    // unfamiliar qualifier isn't evidence either way.
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] has suffered an? (\w+ )?injury\.$/))) {
      const qualifier = m[3]?.trim().toLowerCase();
      const severity = qualifier === 'light' ? 'LIGHT' : qualifier === 'severe' ? 'SEVERE' : 'UNKNOWN';
      tactics.push({ minute, type: 'INJURY',
        player: { name: m[1].trim(), position: m[2] }, severity });
      continue;
    }

    if (line.includes('Issued order-')) {
      const team = line.split(' - ')[0].trim();
      if      ((m = line.match(/Issued order- (.+?) \[([A-Z]+)\] was substituted with (.+)$/)))
        tactics.push({ minute, type: 'SUBSTITUTION', team,
          playerOut: { name: m[1].trim(), position: m[2] }, playerIn: parsePlayerToken(m[3].trim()) });
      else if ((m = line.match(/Issued order- (.+?) \[([A-Z]+)\] was moved to ([A-Z]+)$/)))
        tactics.push({ minute, type: 'POSITION_CHANGE', team,
          player: { name: m[1].trim(), position: m[2] }, toPosition: m[3] });
      else if ((m = line.match(/Issued order- Change mentality to ([A-Z_]+)$/)))
        tactics.push({ minute, type: 'MENTALITY_CHANGE', team, mentality: m[1] });
      else if ((m = line.match(/Issued order- Change (?:middle )?order to ([A-Z_]+)$/)))
        tactics.push({ minute, type: 'STYLE_CHANGE', team, style: m[1] });
      continue;
    }

    if ((m = line.match(/^Isolate Player - (.+?) \[([A-Z]+)\]$/)))
      { tactics.push({ minute, type: 'ISOLATE', issuingTeam: teamContext,
          target: { name: m[1].trim(), position: m[2] } }); teamContext = null; continue; }

    if (teamNames.has(line)) { teamContext = line; continue; }

    // ── Opportunity ───────────────────────────────────────────────────────────
    if ((m = line.match(/^Opportunity for (.+?)\.$/))) {
      flushOpp();
      currentOpp = { minute, team: m[1], phases: [], scoreAtStart: { ...score } };
      currentRawLines = [line]; inCA = false; continue;
    }
    if (/^Counter attack$/i.test(line)) { inCA = true; continue; }

    // ── Phase headers ─────────────────────────────────────────────────────────
    if (line === 'Midfield')    { startPhase('MID');  continue; }
    if (line === 'Penalty Box') { startPhase('PB');   continue; }
    if (line === 'Corner')      { startPhase('SP');   continue; }
    if (line === 'Free Kick')   { startPhase('FK');   continue; }
    if (line === 'Goal Attempt') continue;

    if (!currentPhase) continue;

    // ── Phase content ─────────────────────────────────────────────────────────

    // "considered his options" → duel was won; dribble follows
    if (/considered his options/.test(line)) {
      startPhase('DRIB');
      currentPhase.passType = 'dribble';
      continue;
    }

    // Set piece restart taker
    if (/has decided to restart the attack/.test(line)) {
      if ((m = line.match(/^(.+?) \[([A-Z]+)\] has decided to restart/)))
        currentPhase.passer = player(m[1], m[2]);
      continue;
    }

    // Pass line — "attempted" for open-play MID/PB passes, "made" for corner/free-kick restarts
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] (?:attempted|made) (low|high) \w+(?: (\w+))? pass to (.+?) \[([A-Z]+)\]$/))) {
      currentPhase.passer     = player(m[1], m[2]);
      currentPhase.passHeight = m[3];
      currentPhase.passType   = m[4] || 'normal';
      currentPhase.target     = player(m[5], m[6]); continue;
    }

    // Assistance line (defender positioning)
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] got \w+ assistance, and was .+\.$/))) {
      currentPhase.defender = player(m[1], m[2]); continue;
    }

    // Reception + tackle (already captured above)
    if (/made \w+ reception, .+ made \w+ tackle\./.test(line)) continue;

    // Won duel outright (no tackle)
    if (/made \w+ reception and took control/.test(line)) { currentPhase.outcome = 'POSSESSION'; continue; }

    // Dribble attempt (contested — opponent got a tackle in)
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] made \w+ dribble attempt, (.+?) \[([A-Z]+)\] made \w+ tackle\.$/))) {
      currentPhase.passer   = player(m[1], m[2]);
      currentPhase.passType = 'dribble';
      currentPhase.target   = null;
      currentPhase.defender = player(m[3], m[4]); continue;
    }

    // Dribble won outright — no opposing tackle mentioned
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] made \w+ dribble and took control of the ball\.$/))) {
      currentPhase.passer   = player(m[1], m[2]);
      currentPhase.passType = 'dribble';
      currentPhase.target   = null;
      currentPhase.outcome  = 'POSSESSION'; continue;
    }

    // Cleared — only the primary outcome if nothing more meaningful already happened here
    if (/cleared the ball to safety/.test(line)) {
      if ((m = line.match(/^(.+?) \[([A-Z]+)\] cleared/)))
        if (!currentPhase.defender) currentPhase.defender = player(m[1], m[2]);
      if (!TERMINAL_OUTCOMES.has(currentPhase.outcome)) currentPhase.outcome = 'CLEARED';
      continue;
    }

    // Took control
    if (/\[([A-Z]+)\] took control of the ball/.test(line)) {
      if (!TERMINAL_OUTCOMES.has(currentPhase.outcome)) currentPhase.outcome = 'POSSESSION';
      continue;
    }

    // Foul
    if (/committed a foul/.test(line)) {
      if ((m = line.match(/^(.+?) \[([A-Z]+)\] committed a foul/)))
        { currentPhase.fouler = player(m[1], m[2]); currentPhase.outcome = 'FOUL'; } continue;
    }

    // Corner — outfield players "sent ball to corner", goalkeepers "directed ball to corner"
    if (/(?:sent|directed) ball to corner/.test(line)) {
      if ((m = line.match(/^(.+?) \[([A-Z]+)\] (?:sent|directed) ball to corner/)))
        if (!currentPhase.defender) currentPhase.defender = player(m[1], m[2]);
      currentPhase.outcome = 'CORNER'; continue;
    }

    // Yellow card
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] was handed a yellow card/)))
      { currentPhase.yellowCard = player(m[1], m[2]); continue; }

    // GK interception
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] intercepted the ball/)))
      { currentPhase.defender = player(m[1], m[2]); currentPhase.outcome = 'GK_INTERCEPT'; continue; }

    // Pass blocked — the recovery that follows is a genuinely new duel with its own
    // stream values (confirmed against real telemetry), so split it into a fresh phase
    // of the same type rather than letting the recovery's fields overwrite this one's.
    if (/The pass was blocked/.test(line)) {
      currentPhase.outcome = 'BLOCKED';
      startPhase(currentPhase.phaseType);
      continue;
    }
    // Shot blocked — this ends the passage of play; any aftermath text (loose ball,
    // clearance) describes what happened next, not the outcome of this shot, so it
    // stays on this same phase and is guarded from overwriting the outcome above.
    if (/The shot was blocked/.test(line)) { currentPhase.outcome = 'SHOT_BLOCKED'; continue; }
    if (/The ball is now free/.test(line)) continue;
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] was close and took control/)))
      { currentPhase.blockRecovery = player(m[1], m[2]); continue; }

    // 1v1
    if (/one on one with the keeper/.test(line)) { currentPhase.oneOnOne = true; continue; }

    // Weak angle
    if (/has a weak angle/.test(line)) { currentPhase.shotAngle = 'weak'; continue; }

    // Long shot marker
    if (/Long Shot Goal Attempt/.test(line)) { currentPhase.isLongShot = true; continue; }

    // Shot line — also captures GK name for FK shots. Always records who actually took
    // the shot (shotTaker), separately from passer: for a normal PB/SP/FK-delivery
    // sequence the shooter is whoever received the pass (phase.target), which is who the
    // step-building code uses by default — but a penalty's taker is not always the same
    // player who was fouled (FinalWhistle supports a designated taker-priority order), so
    // when this line names someone else, that identity must not be silently discarded.
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] made \w+(?: (\w+))? shot\.$/))) {
      currentPhase.shotTaker = player(m[1], m[2]);
      if (!currentPhase.passer) currentPhase.passer = currentPhase.shotTaker;
      if (m[3] && m[3] !== 'goal') currentPhase.shotType = m[3]; continue;
    }

    // Bare "Penalty" marker line preceding the goal attempt — no state to capture here
    // (isPenalty comes from the stream's E_PENALTY_KICK event), but explicitly
    // acknowledging it documents that it's expected, not an unrecognized line.
    if (line === 'Penalty') continue;

    // GK save line
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] was .+?, and made \w+ effort to prevent goal\.$/))) {
      currentPhase.gkPlayer = player(m[1], m[2]);
      if (!currentPhase.defender) currentPhase.defender = currentPhase.gkPlayer; continue;
    }

    // GK caught — a controlled save. This genuinely ends the attacking sequence: the
    // opportunity's next line is always the score bracket / next minute, never a
    // continuation.
    if (/managed to get hold of the ball/.test(line)) { currentPhase.outcome = 'SAVED'; continue; }

    // GK fumble/parry — NOT the same as a controlled save: the shot was kept out but the
    // ball stayed live. Distinct outcome rather than folding into SAVED so a
    // genuinely controlled save can still cleanly end the opportunity while a fumble does
    // not silently masquerade as one. Whatever follows in the narrative resolves it: an
    // immediate "GOAL!"/corner still overrides unconditionally (as already happens today),
    // and FUMBLED is in TERMINAL_OUTCOMES so a recovering player's later "cleared"/"took
    // control" aftermath text can't quietly relabel the shot itself as merely cleared.
    if (/bounced the ball back|could not handle the ball/.test(line)) { currentPhase.outcome = 'FUMBLED'; continue; }

    // Post
    if (/bounced off the post/.test(line)) { currentPhase.outcome = 'POST'; continue; }

    // Missed wide
    if (/Missed the goal wide/.test(line)) { currentPhase.outcome = 'MISSED'; continue; }

    // GOAL
    if (line === 'GOAL!') { currentPhase.outcome = 'GOAL'; continue; }
  }

  flushOpp();

  // Determine home/away from first opportunity appearance
  const allTeams = [...new Set(opps.map(o => o.team))];
  const homeTeam = allTeams[0] || null;
  const awayTeam = allTeams[1] || null;
  for (const opp of opps) opp.teamSide = opp.team === homeTeam ? 'home' : 'away';
  for (const ev of tactics) if (ev.team) ev.teamSide = ev.team === homeTeam ? 'home' : ev.team === awayTeam ? 'away' : null;

  return { opportunities: opps, tacticalEvents: tactics, scoreByMinute: scoreByMin,
           teamNames, homeTeam, awayTeam, finalScore: score };
}

// Outcomes that represent how a passage of play actually ended — once one of these is
// set, later "cleared the ball to safety" / "took control" aftermath lines describing
// what happened to the loose ball afterward must not downgrade/overwrite it.
const TERMINAL_OUTCOMES = new Set(['GOAL','SAVED','FUMBLED','POST','MISSED','BLOCKED','SHOT_BLOCKED','FOUL','CORNER','GK_INTERCEPT']);

function player(name, position) { return { name: name.trim(), position }; }
function parsePlayerToken(str) {
  const m = str?.trim().match(/^(.+?)\s+\[([A-Z]+)\]$/);
  return m ? { name: m[1].trim(), position: m[2] } : { name: str?.trim(), position: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEPS  —  convert narrative phases + stitched stream values → flat steps[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert one narrative phase (with stream values already stitched onto it)
 * into 1–3 atomic steps.
 *
 * Value distribution:
 *   V_PASS        → pass step (START_PASS / PB_PASS)
 *   V_ASSISTANCE  → duel step (MID_DUEL / PB_DUEL / DRIB / SP)
 *   V_RECEPTION   → duel step
 *   V_TACKLING    → duel step
 *   V_SHOT        → shot step (SHOT / FK_SHOT)
 *   V_REFLEX      → shot step
 */
// FUMBLED (a save the GK didn't control — see the narrative parser above) belongs here
// alongside SAVED: the attacker did get a shot away and the preceding duel should read
// as won either way. What happens to the loose ball afterward is a separate concern,
// captured via blockRecovery below, not something that changes what the shot itself was.
const SHOT_TERMINALS = ['GOAL','SAVED','FUMBLED','POST','MISSED','SHOT_BLOCKED'];

// PB, SP (corner), and FK-with-delivery phases all resolve the same way: a pass into
// the box, the attacker/defender duel over it, and an optional shot if one followed.
// They differ only in which step-type names they tag the pass/duel with.
function passDuelShotSteps(mk, phase, sv, isPenalty, passStepType, duelStepType) {
  const steps = [];
  steps.push(mk(passStepType, {
    from:       phase.passer,
    to:         phase.target,
    passType:   phase.passType,
    passHeight: phase.passHeight,
    values:     { pass: qv(sv.pass ?? null) },
    outcome:    null,
  }));
  const duelOutcome = SHOT_TERMINALS.includes(phase.outcome) ? 'WON' : phase.outcome;
  steps.push(mk(duelStepType, {
    attacker:   phase.target,
    defender:   phase.defender,
    values:     { assistance: qv(sv.assistance ?? null),
                  reception:  qv(sv.reception   ?? null),
                  tackle:     qv(sv.tackle       ?? null) },
    outcome:    duelOutcome,
    fouler:     phase.fouler,
    yellowCard: phase.yellowCard,
    // Who picked up a loose ball after a blocked pass or a fumbled save (MID_DUEL
    // already exposed this; PB/SP/FK duels silently dropped it until now).
    blockRecovery: phase.blockRecovery,
  }));
  const hasShot = sv.shot != null || SHOT_TERMINALS.includes(phase.outcome);
  if (hasShot) {
    steps.push(mk('SHOT', {
      // Prefer the shot line's own named player over the box-duel winner — almost always
      // the same person, except a penalty, where FinalWhistle's designated taker can
      // differ from whoever was actually fouled.
      shooter:    phase.shotTaker || phase.target,
      gk:         phase.gkPlayer,
      shotType:   phase.shotType,
      shotAngle:  phase.shotAngle,
      oneOnOne:   phase.oneOnOne,
      isLongShot: phase.isLongShot,
      isPenalty,
      values:     { shot: qv(sv.shot ?? null), gkSave: qv(sv.gkSave ?? null) },
      outcome:    phase.outcome,
    }));
  }
  return steps;
}

function phaseToSteps(phase, streamValues, streamEvents) {
  const sv = streamValues || {};
  const isPenalty = !!streamEvents?.includes('E_PENALTY_KICK');
  const steps = [];

  const mk = (stepType, extra) => ({
    stepType, isCA: phase.isCA || false,
    attackingTeam: phase.attackingTeam, attackingSide: phase.attackingSide,
    defendingTeam: phase.defendingTeam, defendingSide: phase.defendingSide,
    yellowCard: null, fouler: null, blockRecovery: null,
    ...extra,
  });

  switch (phase.phaseType) {

    case 'MID': {
      // Step 1: the initiating / midfield pass
      steps.push(mk('START_PASS', {
        from:        phase.passer,
        to:          phase.target,
        passType:    phase.passType,
        passHeight:  phase.passHeight,
        values:      { pass: qv(sv.pass ?? null) },
        outcome:     null,
      }));
      // Step 2: the midfield duel. A long shot taken straight from midfield (no Penalty
      // Box phase at all) still ends up with a shot-terminal outcome on this same phase —
      // that belongs to the SHOT step below, not the duel, so normalize it here.
      const midDuelOutcome = SHOT_TERMINALS.includes(phase.outcome) ? 'WON' : phase.outcome;
      steps.push(mk('MID_DUEL', {
        attacker:     phase.target || phase.passer,   // who received
        defender:     phase.defender,
        values:       { assistance: qv(sv.assistance ?? null),
                        reception:  qv(sv.reception  ?? null),
                        tackle:     qv(sv.tackle      ?? null) },
        outcome:      midDuelOutcome,
        fouler:       phase.fouler,
        blockRecovery:phase.blockRecovery,
        yellowCard:   phase.yellowCard,
      }));
      // Step 3: a direct shot from midfield ("Long Shot Goal Attempt" with no Penalty
      // Box phase in between) — previously silently dropped since this phaseType never
      // checked for shot data at all.
      const hasShot = sv.shot != null || SHOT_TERMINALS.includes(phase.outcome);
      if (hasShot) {
        steps.push(mk('SHOT', {
          shooter:    phase.shotTaker || phase.target || phase.passer,
          gk:         phase.gkPlayer,
          shotType:   phase.shotType,
          shotAngle:  phase.shotAngle,
          oneOnOne:   phase.oneOnOne,
          isLongShot: true,
          isPenalty,
          values:     { shot: qv(sv.shot ?? null), gkSave: qv(sv.gkSave ?? null) },
          outcome:    phase.outcome,
        }));
      }
      break;
    }

    case 'DRIB': {
      steps.push(mk('DRIB', {
        dribbler:  phase.passer,
        defender:  phase.defender,
        values:    { assistance: qv(sv.assistance ?? null),
                     reception:  qv(sv.reception  ?? null),  // dribble quality
                     tackle:     qv(sv.tackle      ?? null) },
        outcome:   phase.outcome,
      }));
      break;
    }

    case 'PB': {
      steps.push(...passDuelShotSteps(mk, phase, sv, isPenalty, 'PB_PASS', 'PB_DUEL'));
      break;
    }

    case 'SP': {
      // Corner restart: same pass → duel → (optional shot) shape as Mid/PB, not one
      // merged row — the delivery and the box contest for it are distinct moments.
      steps.push(...passDuelShotSteps(mk, phase, sv, isPenalty, 'SP_PASS', 'SP_DUEL'));
      break;
    }

    case 'FK': {
      // A free kick has the same duality as a corner: a direct shot at goal (no pass line
      // at all — narrative goes straight to the shot), or a passed delivery that continues
      // the attack into its own duel (and possibly a shot after that). No target means no
      // pass line ever matched, i.e. a direct shot.
      if (!phase.target) {
        steps.push(mk('FK_SHOT', {
          shooter:    phase.passer,
          gk:         phase.gkPlayer,
          isLongShot: phase.isLongShot,
          shotType:   phase.shotType,
          values:     { shot: qv(sv.shot ?? null), gkSave: qv(sv.gkSave ?? null) },
          outcome:    phase.outcome,
        }));
      } else {
        steps.push(...passDuelShotSteps(mk, phase, sv, isPenalty, 'FK_PASS', 'FK_DUEL'));
      }
      break;
    }

    default:
      // Unknown phase type — pass through raw
      steps.push(mk(phase.phaseType || 'UNKNOWN', { raw: phase }));
  }

  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE — assign sides, stitch stream values, build steps
// ─────────────────────────────────────────────────────────────────────────────

function assignSides(phases, attackTeam, attackSide, defendTeam, defendSide) {
  for (const p of phases) {
    const at = p.isCA ? defendTeam : attackTeam;
    const as = p.isCA ? defendSide : attackSide;
    const dt = p.isCA ? attackTeam : defendTeam;
    const ds = p.isCA ? attackSide : defendSide;
    const stamp = (pl, team, side) => pl && (pl.team = team, pl.side = side);
    stamp(p.passer,  at, as); stamp(p.target,  at, as); stamp(p.shotTaker, at, as);
    stamp(p.defender, dt, ds); stamp(p.blockRecovery, dt, ds);
    if (p.gkPlayer) { p.gkPlayer.team = dt; p.gkPlayer.side = ds; }
    // Carried onto every step built from this phase (see phaseToSteps's mk()) so the
    // viewer can attribute a pass/duel/shot to whichever team actually performed it —
    // opp.teamSide alone is wrong once a counter-attack has flipped who's attacking,
    // since it always names the team the opportunity nominally started for.
    p.attackingTeam = at; p.attackingSide = as;
    p.defendingTeam = dt; p.defendingSide = ds;
  }
}

function buildOpportunitySteps(narPhases, streamPhases, startType, warnings) {
  // Flatten stream phases including any CA sub-block phases
  // Stream phases map 1:1 with narrative phases in sequence order — if the
  // counts diverge, every value past the divergence point silently attaches
  // to the wrong narrative phase, so surface it instead of guessing.
  const steps = [];
  if (streamPhases.length && narPhases.length !== streamPhases.length) {
    warnings?.push(`PHASE_COUNT_MISMATCH: ${narPhases.length} narrative phase(s) vs ` +
      `${streamPhases.length} stream phase(s) — values may be misattributed.`);
  }

  for (let i = 0; i < narPhases.length; i++) {
    const sp = streamPhases[i] || { values: {}, events: [] };
    const np = narPhases[i];

    // Fill any stream outcome that narrative didn't capture
    if (!np.outcome && sp.events.length) {
      const ev = sp.events[sp.events.length - 1];
      np.outcome = ev === 'E_GOAL' ? 'GOAL'
                 : ev === 'E_BLOCK' ? 'BLOCKED'
                 : ev === 'E_INTERCEPTION' ? 'GK_INTERCEPT'
                 : ev === 'E_CORNER' ? 'CORNER'
                 : ev === 'E_FREE_KICK' ? 'FREE_KICK'
                 : ev.replace('E_','');
    }

    const phaseSteps = phaseToSteps(np, sp.values, sp.events);
    steps.push(...phaseSteps);
  }

  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE + REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

function annotateScores(opportunities, scoreByMinute) {
  let running = { home: 0, away: 0 };
  for (const opp of opportunities) {
    opp.scoreBefore = { ...running };
    if (opp.hasGoal && scoreByMinute[opp.minute]) running = { ...scoreByMinute[opp.minute] };
    opp.scoreAfter = { ...running };
  }
}

function buildPlayerRegistry(opportunities, tacticalEvents) {
  const reg = {};
  const upsert = (p) => {
    if (!p?.name) return;
    if (!reg[p.name]) reg[p.name] = { team: null, side: null, positions: new Set() };
    if (p.team  && !reg[p.name].team)  reg[p.name].team  = p.team;
    if (p.side  && !reg[p.name].side)  reg[p.name].side  = p.side;
    if (p.position) reg[p.name].positions.add(p.position);
  };
  const players = (step) => {
    [step.from, step.to, step.attacker, step.defender, step.dribbler,
     step.shooter, step.gk, step.fouler, step.yellowCard, step.blockRecovery]
      .forEach(upsert);
  };
  for (const opp of opportunities) for (const s of opp.steps) players(s);
  for (const ev of tacticalEvents) {
    const t = ev.team ? { team: ev.team, side: ev.teamSide } : null;
    if (ev.type === 'SUBSTITUTION')    { upsert({...ev.playerOut,...t}); upsert({...ev.playerIn,...t}); }
    if (ev.type === 'POSITION_CHANGE') upsert({...ev.player,...t});
    if (ev.type === 'TIREDNESS')       upsert({...ev.player,...t});
  }
  const result = {};
  for (const [name, d] of Object.entries(reg))
    result[name] = { team: d.team, side: d.side, positions: [...d.positions].sort() };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function parseMatch(streamText, narrativeText) {
  const warnings     = [];
  const streamTokens = parseStreamTokens(streamText);
  const streamBlocks = groupStreamBlocks(streamTokens);
  const narResult    = parseNarrative(narrativeText);
  const { opportunities: narOpps, tacticalEvents, scoreByMinute, finalScore } = narResult;

  // Build stream lookup by minute
  const streamByMinute = {};
  const indexBlock = (block) => {
    if (!streamByMinute[block.minute]) streamByMinute[block.minute] = [];
    streamByMinute[block.minute].push(block);
  };
  for (const b of streamBlocks) indexBlock(b);

  // Map H/A → team names from first matching opportunity
  const teamMap = { H: null, A: null };
  const narrativeTeams = [...new Set(narOpps.map(o => o.team))];
  for (const narOpp of narOpps) {
    const candidates = (streamByMinute[narOpp.minute] || []);
    if (candidates.length) {
      const side = candidates[0].attackingSide;
      if (!teamMap[side]) teamMap[side] = narOpp.team;
      const oSide = side === 'H' ? 'A' : 'H';
      if (!teamMap[oSide]) {
        teamMap[oSide] = narrativeTeams.find(t => t !== narOpp.team) || null;
      }
      if (teamMap.H && teamMap.A) break;
    }
  }

  const homeTeam   = teamMap.H;
  const awayTeam   = teamMap.A;
  const sideOf     = t  => t  === homeTeam ? 'home' : t  === awayTeam ? 'away' : null;
  const streamSide = ts => ts === 'home'   ? 'H'    : 'A';

  for (const narOpp of narOpps) narOpp.teamSide = sideOf(narOpp.team);
  for (const ev of tacticalEvents) if (ev.team) ev.teamSide = sideOf(ev.team);

  const blockCursors = {};
  const opportunities = [];

  for (const narOpp of narOpps) {
    const ss  = streamSide(narOpp.teamSide);
    const key = `${narOpp.minute}|${ss}`;
    blockCursors[key] = blockCursors[key] || 0;

    const pool  = (streamByMinute[narOpp.minute] || []).filter(b => b.attackingSide === ss);
    const block = pool[blockCursors[key]] || null;
    blockCursors[key]++;

    // How sure are we this opportunity got paired with the RIGHT stream block? If only
    // one candidate existed for this (minute, side), there was nothing to get wrong. If
    // several did, pairing fell to blockCursors' next-in-line order — correct as long as
    // every real block parsed cleanly, but a single missing/malformed one upstream would
    // silently shift every later same-(minute,side) pairing without any other symptom.
    // Surfacing that here beats a confidently-wrong number with no way to tell.
    const streamMatchConfidence = !block ? 'none' : pool.length > 1 ? 'uncertain' : 'exact';

    const allStreamPhases = block
      ? [...block.phases, ...(block.counterAttack?.phases || [])]
      : [];

    const defTeam = narOpp.team === homeTeam ? awayTeam : homeTeam;
    const defSide = narOpp.teamSide === 'home' ? 'away' : 'home';
    assignSides(narOpp.phases, narOpp.team, narOpp.teamSide, defTeam, defSide);

    const steps = buildOpportunitySteps(narOpp.phases, allStreamPhases, block?.startType || 'DEF', warnings);

    const hasGoal = steps.some(s => s.outcome === 'GOAL');
    const hasShot = steps.some(s => s.stepType === 'SHOT' || s.stepType === 'FK_SHOT');
    const hasCard = steps.some(s => s.yellowCard);
    const finalStep = steps[steps.length - 1];

    // Long Balls (per the manual's Style of Play section): a back/wing-back delivers
    // straight into the box, skipping the midfield contest entirely — no block chance,
    // just an aerial duel. Structurally that's an opportunity whose first step is a
    // PB_PASS with no preceding START_PASS/MID_DUEL at all.
    const firstStep = steps[0];
    const isLongBallSequence = firstStep?.stepType === 'PB_PASS'
      && ['LB','RB','LWB','RWB'].includes(firstStep.from?.position);

    opportunities.push({
      minute:          narOpp.minute,
      team:            narOpp.team,
      teamSide:        narOpp.teamSide,
      startType:       block?.startType || null,
      isLongBallSequence,
      isCounterAttack: steps.some(s => s.isCA),
      scoreBefore:     null,
      scoreAfter:      null,
      hasGoal, hasShot, hasCard,
      finalOutcome:    finalStep?.outcome || null,
      steps,
      rawLines:            narOpp.rawLines || [],
      streamMatchConfidence,
      narrativePhaseCount: narOpp.phases.length,
      streamPhaseCount:    allStreamPhases.length,
    });
  }

  annotateScores(opportunities, scoreByMinute);
  const playerRegistry = buildPlayerRegistry(opportunities, tacticalEvents);

  // Surface stream-match confidence through the same warnings the UI already shows,
  // rather than leaving it as a data field nobody looks at. One aggregate line per
  // category instead of one per opportunity, so a match with many uncertain pairings
  // doesn't bury the warnings banner.
  const noneCount = opportunities.filter(o => o.streamMatchConfidence === 'none').length;
  const uncertainCount = opportunities.filter(o => o.streamMatchConfidence === 'uncertain').length;
  if (noneCount) warnings.push(`${noneCount} opportunit${noneCount === 1 ? 'y has' : 'ies have'} no matching telemetry — values for ${noneCount === 1 ? 'it' : 'them'} are narrative-only.`);
  if (uncertainCount) warnings.push(`${uncertainCount} opportunit${uncertainCount === 1 ? 'y' : 'ies'} shared a minute+side with another and may be paired with the wrong telemetry block if an earlier one was malformed.`);

  return { meta: { homeTeam, awayTeam, finalScore }, playerRegistry, opportunities, tacticalEvents, warnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMatch, parseStreamTokens, groupStreamBlocks,
                     parseNarrative, qualityLabel, qv };
}
