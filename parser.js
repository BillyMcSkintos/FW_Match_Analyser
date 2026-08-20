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
 *   SHOT                – goal attempt following a *_DUEL/direct MID long shot, or a
 *                         standalone follow-up attempt after a live-ball GK rebound
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

// Returns { tokens, unknownLines } rather than a bare array — a line that doesn't match
// the expected shape used to be silently dropped with no record anywhere. FinalWhistle's
// format changes without notice, so a token this parser doesn't recognize needs to be
// visible as a diagnostic, not quietly discarded as if it never existed.
function parseStreamTokens(streamText) {
  const RE = /^(\d+)'\s*-\s*([HA])\s*-\s*(\w+)(?:\s*-\s*\((\d+)\))?$/;
  const tokens = [], unknownLines = [];
  streamText.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    const m = RE.exec(line);
    if (m) tokens.push({ minute: parseInt(m[1]), side: m[2], kind: m[3],
                          value: m[4] !== undefined ? parseInt(m[4]) : null });
    else unknownLines.push(line);
  });
  return { tokens, unknownLines };
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
      // A second shot can follow a woodwork rebound without any E_* terminal token
      // between the two attempts. Treat the repeated V_SHOT as the only reliable phase
      // boundary in that sequence; otherwise it overwrites the first shot and leaves the
      // narrative with one extra live-ball SHOT phase.
      case 'V_SHOT':
        if ('shot' in phase.values) flush();
        phase.values.shot = tok.value; break;
      case 'V_REFLEX':     phase.values.gkSave      = tok.value; break;
      case 'E_CORNER': case 'E_FREE_KICK': case 'E_GOAL':
      case 'E_BLOCK': case 'E_INTERCEPTION': case 'E_FUMBLE': case 'E_OFFSIDE':
        // Only flush if this phase actually has values — two terminal events can fire
        // back-to-back with nothing in between (e.g. a fumbled save immediately followed
        // by the resulting corner, or E_TRAP_SUCCESS immediately followed by E_OFFSIDE —
        // see below), and flushing on both creates a phantom empty phase between them.
        // Tag the event and let it merge into whichever phase (the one just closed, or
        // the next one) actually has the values.
        phase.events.push(tok.kind);
        if (Object.keys(phase.values).length) flush();
        break;
      case 'E_CARD': case 'E_PENALTY_KICK': case 'E_INJURY': phase.events.push(tok.kind); break;
      // E_TRAP_SUCCESS always immediately precedes the E_OFFSIDE that actually ends the
      // phase (handled above) — not terminal by itself. E_TRAP_FAILURE means the attack
      // continues normally (more V_RECEPTION/V_TACKLING/V_SHOT tokens follow in this same
      // phase) — flushing on it would prematurely split an ongoing duel's values in two.
      case 'E_TRAP_SUCCESS': case 'E_TRAP_FAILURE': phase.events.push(tok.kind); break;
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

// Tactical-construct audit — reconciled against the FinalWhistle manual (Tactics &
// Orders, Match Engine sections) and every narrative fixture in parser.test.js. This is
// the source of truth for what this parser claims to support; keep it in sync when
// adding/removing a tactical construct.
//
// OBSERVED — real "Issued order-"/admin lines this parser matches today:
//   SUBSTITUTION, POSITION_CHANGE, MENTALITY_CHANGE, PREFERRED_SIDE_CHANGE, ISOLATE,
//   TIREDNESS, INJURY, HALF_TIME, EXTRA_TIME_BREAK (a knockout-cup fixture that didn't
//   resolve in regulation; the report marks both the move into extra time and the
//   changeover between its two halves — treated the same as HALF_TIME for tiredness
//   reset, since the source text says "rest a bit" at both). Of these,
//   SUBSTITUTION/POSITION_CHANGE/TIREDNESS/HALF_TIME/PREFERRED_SIDE_CHANGE/
//   EXTRA_TIME_BREAK have direct fixture coverage (parser.test.js);
//   MENTALITY_CHANGE/ISOLATE/INJURY do not — the regex was written against manual
//   terminology and has no confirmed real-report fixture behind it yet. Not removed
//   (nothing has ever demonstrated it wrong), but flagged rather than presented as
//   fixture-proven.
//
// Offside Trap is OBSERVED too, but not as a tacticalEvents entry — "Offside trap was
// attempted by the defense team." / "Assistant referee signaled the offside flag." are
// in-play narrative text describing what happened during a specific pass, the same kind
// of thing a tackle or a save is, not a manager-issued order. It's modeled as a new
// terminal step outcome (OFFSIDE, added to TERMINAL_OUTCOMES) instead: the trap-attempt
// line itself carries no state (matching the "Penalty"/"Long Shot Goal Attempt"
// bare-marker convention), and only the flag actually ends the phase.
//
// OBSERVED — STYLE_CHANGE: FinalWhistle reports a Style of Play change as
//   "Issued order- Change (middle )?order to X". Despite the shortened source wording,
//   the product term is Style of Play, so the event updates teamState.style. Do not
//   expose or invent a separate "Middle Order" tactic — FinalWhistle has no such main
//   team-tactic label.
//
// MANUAL-DEFINED, NOT OBSERVED — real FW mechanics per the manual with no narrative
//   construct parsed for them anywhere in this codebase, and no fixture/report evidence
//   they're even exposed as narrative text (as opposed to only being visible on the
//   tactics-setup page): Marking (Zonal/Man to Man), Defence Focus, zone-based Player
//   Orders (Attacker: Normal/Quick Shot/Power Shot/
//   Heading Shot/Lob Shot/Demand High/Demand Low; Midfielder: Normal/Safe Pass/Risky
//   Pass/Deflect Pass/Long Shot/Dribble 'n' Pass/Dribble 'n' Shoot; Defence: Normal/
//   Aerial Control/Ground Control/Sliding Tackle; Goalkeeper: Normal/Interceptor/Sure
//   Hands/Organizer), Attitude Orders (Neutral/Careful/Aggressive — FW's actual term for
//   what would generically be called "aggression"), Arrow Orders (player arrows and the
//   distinct goalkeeper arrow), Set Piece Orders (Corner: Cross/Restart; Free-kick:
//   Shoot/Cross/Restart; Anchor), and Captain/Free-kick-taker/Corner-kick-taker
//   assignment. None of these get an event parser — the standing rule is that a
//   manual-defined mechanic with no observed narrative activation does not get a
//   fabricated parser. Deferred pending real match-report samples showing these as
//   narrative text (not just tactics-setup UI).
function parseNarrative(narrativeText) {
  const ls = narrativeText.split('\n').map(l => l.trim()).filter(Boolean);
  const opps = [], tactics = [], unknownNarrativeLines = [];
  let score = { home: 0, away: 0 }, minute = null, teamContext = null;
  // Shared monotonic counter across BOTH opportunities and tactical events, assigned in
  // true top-to-bottom narrative order (this single loop reads the report exactly as
  // laid out) — this is what lets tacticalStateAt() later tell whether a tactical event
  // fell before or after a same-minute opportunity, the same way each opportunity's own
  // score snapshot (see annotateScores below) fixes same-minute score ordering.
  let seq = 0;
  const nextSeq = () => seq++;
  // Every tactical event goes through this so the normalized envelope below is applied
  // uniformly instead of hand-rolled per push site. `scope` follows a simple convention:
  // 'player' when the event's payload is fundamentally about one (or two) named players
  // (a sub, a position move, tiredness, an injury) even though a sub/position change also
  // has team-wide phase-triggering consequences (see buildTacticalPhases); 'team' for a
  // team-wide order (mentality, style, preferred side, a special order like isolate);
  // 'match' for whole-match markers (half time, an extra-time break) that belong to
  // neither side.
  const mkEvent = (type, scope, fields, rawText) => {
    const s = nextSeq();
    return { id: `${type}-${minute ?? 'x'}-${s}`, sequence: s, minute, type, scope,
             source: 'narrative', certainty: 'observed', rawText, ...fields };
  };

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
    if (currentOpp) {
      currentOpp.rawLines = currentRawLines.slice();
      // Snapshot the running score as it stands right when this opportunity's own content
      // ends — in true narrative sequence order, not bucketed by minute. Two goals in the
      // same minute previously both resolved to whichever bracket line came LAST in that
      // minute, silently giving the earlier goal's opportunity the wrong scoreAfter too.
      currentOpp.scoreAtEnd = { ...score };
      opps.push(currentOpp);
    }
    currentOpp = null; inCA = false; currentRawLines = [];
  };
  const startPhase = (type) => {
    flushPhase();
    currentPhase = { phaseType: type, passer: null, target: null, defender: null, gkPlayer: null,
      passType: 'normal', passHeight: null, outcome: null, fouler: null, shotTaker: null,
      blockRecovery: null, blockRecoveryRole: null, looseBallResolution: null, yellowCard: null,
      shotType: null, shotAngle: null, missType: null, gkContextLines: [],
      passerUnderPressure: null, passContextLines: [],
      oneOnOne: false, isLongShot: false, isCA: inCA };
  };

  for (const line of ls) {
    let m;
    if (currentOpp) currentRawLines.push(line);

    // ── Admin ─────────────────────────────────────────────────────────────────
    if ((m = line.match(/^Minute (\d+)$/))) { minute = parseInt(m[1]); teamContext = null; continue; }
    if ((m = line.match(/^\[(\d+)-(\d+)\]$/))) {
      score = { home: parseInt(m[1]), away: parseInt(m[2]) };
      continue;
    }
    if (/Half Time/.test(line))                    { tactics.push(mkEvent('HALF_TIME', 'match', {}, line)); continue; }
    if (/referee blew the final whistle/.test(line)) continue;

    // Extra time: only appears when the match didn't resolve in regulation (a knockout-
    // cup fixture, per the one real report this was observed in). Both markers are
    // matched here, at admin level, specifically so they're consumed BEFORE the
    // phase-content section below ever sees them — currentPhase/currentOpp are only
    // reset by flushOpp() at the NEXT "Opportunity for" line, so a stray admin line
    // landing between an opportunity's score bracket and the following one would
    // otherwise be tested against a stale, already-finished phase and misfiled as
    // unrecognized phase content instead of being recognized here.
    if (/^The referee whistled and marked the end of regular play\./.test(line))
      { tactics.push(mkEvent('EXTRA_TIME_BREAK', 'match', { period: 'start' }, line)); continue; }
    if (/^End of first extra time, players will change sides/.test(line))
      { tactics.push(mkEvent('EXTRA_TIME_BREAK', 'match', { period: 'halfway' }, line)); continue; }

    if ((m = line.match(/^(.+?) - (.+?) \[([A-Z]+)\] looks (very tired|tired)\.$/)))
      { tactics.push(mkEvent('TIREDNESS', 'player', { team: m[1].trim(),
          player: { name: m[2].trim(), position: m[3] },
          level: m[4] === 'very tired' ? 'VERY_TIRED' : 'TIRED' }, line)); continue; }

    // Injury — appears inline within a phase, not as a standalone admin line, so it
    // has no team prefix. FinalWhistle only has two real injury tiers, Light and Severe
    // (a Light Injury can later progress to Severe) — classify explicitly rather than
    // defaulting anything unrecognized to the more severe tier, since a missing or
    // unfamiliar qualifier isn't evidence either way.
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] has suffered an? (\w+ )?injury\.$/))) {
      const qualifier = m[3]?.trim().toLowerCase();
      const severity = qualifier === 'light' ? 'LIGHT' : qualifier === 'severe' ? 'SEVERE' : 'UNKNOWN';
      tactics.push(mkEvent('INJURY', 'player',
        { player: { name: m[1].trim(), position: m[2] }, severity }, line));
      continue;
    }

    if (line.includes('Issued order-')) {
      const team = line.split(' - ')[0].trim();
      if      ((m = line.match(/Issued order- (.+?) \[([A-Z]+)\] was substituted with (.+)$/)))
        tactics.push(mkEvent('SUBSTITUTION', 'player', { team,
          playerOut: { name: m[1].trim(), position: m[2] }, playerIn: parsePlayerToken(m[3].trim()) }, line));
      else if ((m = line.match(/Issued order- (.+?) \[([A-Z]+)\] was moved to ([A-Z]+)$/)))
        tactics.push(mkEvent('POSITION_CHANGE', 'player', { team,
          player: { name: m[1].trim(), position: m[2] }, toPosition: m[3] }, line));
      else if ((m = line.match(/Issued order- Change mentality to ([A-Z_]+)$/)))
        tactics.push(mkEvent('MENTALITY_CHANGE', 'team', { team, mentality: m[1] }, line));
      else if ((m = line.match(/Issued order- Change (?:middle )?order to ([A-Z_]+)$/)))
        tactics.push(mkEvent('STYLE_CHANGE', 'team', { team, style: m[1] }, line));
      else if ((m = line.match(/Issued order- Change preferred side to ([A-Z_]+)$/)))
        tactics.push(mkEvent('PREFERRED_SIDE_CHANGE', 'team', { team, preferredSide: m[1] }, line));
      continue;
    }

    if ((m = line.match(/^Isolate Player - (.+?) \[([A-Z]+)\]$/)))
      { tactics.push(mkEvent('ISOLATE', 'team', { issuingTeam: teamContext,
          target: { name: m[1].trim(), position: m[2] } }, line)); teamContext = null; continue; }

    if (teamNames.has(line)) { teamContext = line; continue; }

    // ── Opportunity ───────────────────────────────────────────────────────────
    if ((m = line.match(/^Opportunity for (.+?)\.$/))) {
      flushOpp();
      // sequence assigned at the "Opportunity for X." line itself (not when the
      // opportunity is later flushed) — that's its actual position in narrative order,
      // which is what tacticalStateAt/buildTacticalPhases need to compare against a
      // same-minute tactical event's own sequence number.
      currentOpp = { minute, team: m[1], phases: [], scoreAtStart: { ...score }, sequence: nextSeq() };
      currentRawLines = [line]; inCA = false; continue;
    }
    if (/^Counter attack$/i.test(line)) { inCA = true; continue; }

    // ── Phase headers ─────────────────────────────────────────────────────────
    if (line === 'Midfield')    { startPhase('MID');  continue; }
    if (line === 'Penalty Box') { startPhase('PB');   continue; }
    if (line === 'Corner')      { startPhase('SP');   continue; }
    if (line === 'Free Kick')   { startPhase('FK');   continue; }
    if (line === 'Goal Attempt' || line === 'Long Shot Goal Attempt') {
      // The first goal-attempt marker belongs to the current MID/PB/SP/FK phase. Once
      // that phase already contains a shot, FinalWhistle starts another stream phase
      // for the next live-ball attempt. Split here so an arbitrary rebound chain maps
      // one narrative shot phase to one telemetry shot phase instead of overwriting the
      // preceding shooter/GK/outcome.
      if (currentPhase?.shotTaker) {
        if (REBOUND_LIVE_BALL_OUTCOMES.has(currentPhase.outcome) && currentPhase.blockRecovery)
          currentPhase.blockRecoveryRole = 'attacker';
        startPhase('SHOT');
      }
      if (currentPhase && line === 'Long Shot Goal Attempt') currentPhase.isLongShot = true;
      continue;
    }

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

    // Requested pass modifier — FinalWhistle emits this immediately before the normal
    // "attempted ... pass" line when the player is asked to use a favored/unfavored
    // delivery. Preserve the observation on the pass step; it is context, not another
    // phase and not evidence that any particular team tactic was active.
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] was requested to send (favored|unfavored) (low|high) pass\.$/))) {
      currentPhase.passRequest = {
        player: player(m[1], m[2]), preference: m[3], height: m[4],
      };
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

    // Offside trap: the defense line holds instead of engaging in a duel. A trap attempt
    // doesn't by itself determine the outcome — it's followed either by the assistant
    // referee's flag (this phase's outcome, below) or by the attack simply continuing
    // (reception/tackle lines as normal) if the trap failed — so the marker line itself
    // carries no state, matching the "Penalty"/"Long Shot Goal Attempt" bare-marker
    // convention already used elsewhere in this section.
    if (/^Offside trap was attempted by the defense team\.$/.test(line)) continue;
    // The flag ends the passage of play outright — no reception/tackle/shot ever
    // follows it, the opportunity's score bracket comes right after.
    if (/^Assistant referee signaled the offside flag\.$/.test(line)) {
      if (!TERMINAL_OUTCOMES.has(currentPhase.outcome)) currentPhase.outcome = 'OFFSIDE';
      continue;
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
      if (REBOUND_LIVE_BALL_OUTCOMES.has(currentPhase.outcome) && currentPhase.blockRecovery)
        currentPhase.looseBallResolution = 'CLEARED';
      else if (!TERMINAL_OUTCOMES.has(currentPhase.outcome)) currentPhase.outcome = 'CLEARED';
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

    // Shot angle. FinalWhistle has been observed using weak, poor, and good here. Preserve
    // the exact adjective so the viewer can display it faithfully instead of treating every
    // truthy angle as "weak" (which previously forced good to be recognized-but-discarded).
    if ((m = line.match(/has a (weak|poor|good) angle\.$/))) {
      currentPhase.shotAngle = m[1];
      continue;
    }

    // Observed passer context. This line precedes the resulting pass and describes why
    // the play was rushed; it is not a separate phase or a numeric execution modifier.
    if ((m = line.match(/^(.+?) \[([A-Z]+)\] was pressured to make a rushed play\.$/))) {
      currentPhase.passerUnderPressure = player(m[1], m[2]);
      currentPhase.passContextLines.push(line);
      continue;
    }

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

    // GK beaten outright — no save attempt described (the shot needed none to beat him).
    // Distinct from the "was X, and made Y effort to prevent goal." save-line pattern
    // below, which always includes that trailing clause; this doesn't. No state to
    // capture (the outcome comes from "GOAL!" or the stream's E_GOAL either way), but
    // explicitly recognized rather than falling through as unknown.
    if (/^(.+?) \[([A-Z]+)\] was fooled\.$/.test(line)) continue;

    // Observed goalkeeper context. Preserve the source wording as neutral metadata;
    // it is not a numeric pressure value and changes neither phase shape nor outcome.
    if ((m = line.match(/^(.+?) \[(GK)\] is under a lot of pressure right now\.$/))) {
      if (!currentPhase.gkPlayer) currentPhase.gkPlayer = player(m[1], m[2]);
      currentPhase.gkContextLines.push(line);
      continue;
    }

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

    // Woodwork — both post and crossbar use the existing POST outcome/category.
    if (/bounced off the (?:post|bar)/i.test(line)) { currentPhase.outcome = 'POST'; continue; }

    // FinalWhistle currently emits the grammatically awkward "narrow" source wording.
    // Preserve it in rawLines, but normalize the semantic qualifier for generated UI.
    if ((m = line.match(/^Missed the goal (wide|narrow)[!.]$/))) {
      currentPhase.outcome = 'MISSED';
      currentPhase.missType = m[1];
      continue;
    }

    // GOAL
    if (line === 'GOAL!') { currentPhase.outcome = 'GOAL'; continue; }

    // Reached without matching any phase-content pattern above — capture it as unknown
    // rather than silently dropping it, so a FinalWhistle wording change becomes visible
    // instead of quietly losing information. Deliberately scoped to phase content only
    // (currentPhase is truthy here, past the `if (!currentPhase) continue;` guard above)
    // rather than every line outside a phase — most of those are genuinely decorative
    // headers/separators, and flagging them too would flood diagnostics with noise
    // instead of surfacing real drift.
    unknownNarrativeLines.push({ minute, line });
  }

  flushOpp();

  // Determine home/away from first opportunity appearance. Note: parseMatch() re-resolves
  // this itself (preferring trusted scrape metadata, falling back to matching narrative
  // opportunities against stream sides) and overwrites opp.teamSide unconditionally, so
  // this is only ever the answer for a caller that uses parseNarrative() directly.
  const allTeams = [...new Set(opps.map(o => o.team))];
  const homeTeam = allTeams[0] || null;
  const awayTeam = allTeams[1] || null;
  for (const opp of opps) opp.teamSide = opp.team === homeTeam ? 'home' : 'away';
  for (const ev of tactics) if (ev.team) ev.teamSide = ev.team === homeTeam ? 'home' : ev.team === awayTeam ? 'away' : null;

  return { opportunities: opps, tacticalEvents: tactics,
           teamNames, homeTeam, awayTeam, finalScore: score, unknownNarrativeLines };
}

// Outcomes that represent how a passage of play actually ended — once one of these is
// set, later "cleared the ball to safety" / "took control" aftermath lines describing
// what happened to the loose ball afterward must not downgrade/overwrite it.
const TERMINAL_OUTCOMES = new Set(['GOAL','SAVED','FUMBLED','POST','MISSED','BLOCKED','SHOT_BLOCKED','FOUL','CORNER','GK_INTERCEPT','OFFSIDE']);

// Which shot outcomes leave the ball genuinely live for an attacker to recover, as
// opposed to ending the passage of play outright. GOAL/MISSED are dead (the ball's left
// play entirely); SAVED is "a controlled save... genuinely ends the attacking sequence"
// (see the narrative parser's own comment above). FUMBLED (an uncontrolled save), POST
// (the woodwork, not a stop at all), and SHOT_BLOCKED (deflected but still in play) are
// the three outcomes after which "X was close and took control of the ball." can
// legitimately follow — used below to attribute a recovered rebound to the attacking
// side (blockRecoveryRole) and to record what happened if it's simply cleared away
// instead of shot again (looseBallResolution), for whichever of the three occurred.
const REBOUND_LIVE_BALL_OUTCOMES = new Set(['FUMBLED', 'POST', 'SHOT_BLOCKED']);

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
// exposed through looseBallRecovery (with blockRecovery retained as its compatibility
// alias) below, not something that changes what the shot itself was.
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
    passRequest: phase.passRequest || null,
    passerUnderPressure: phase.passerUnderPressure || null,
    passContextLines: phase.passContextLines || [],
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
      missType:   phase.missType,
      gkContextLines: phase.gkContextLines || [],
      blockRecovery: phase.blockRecovery,
      looseBallRecovery: phase.blockRecovery,
      looseBallResolution: phase.looseBallResolution,
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
    yellowCard: null, fouler: null, blockRecovery: null, looseBallRecovery: null,
    looseBallResolution: null,
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
        passRequest: phase.passRequest || null,
        passerUnderPressure: phase.passerUnderPressure || null,
        passContextLines: phase.passContextLines || [],
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
          missType:   phase.missType,
          gkContextLines: phase.gkContextLines || [],
          blockRecovery: phase.blockRecovery,
          looseBallRecovery: phase.blockRecovery,
          looseBallResolution: phase.looseBallResolution,
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
          missType:   phase.missType,
          gkContextLines: phase.gkContextLines || [],
          blockRecovery: phase.blockRecovery,
          looseBallRecovery: phase.blockRecovery,
          looseBallResolution: phase.looseBallResolution,
        }));
      } else {
        steps.push(...passDuelShotSteps(mk, phase, sv, isPenalty, 'FK_PASS', 'FK_DUEL'));
      }
      break;
    }

    case 'SHOT': {
      // A subsequent live-ball attempt after a rebound has no pass/duel of its own.
      // It still becomes the same atomic SHOT model consumed everywhere else.
      steps.push(mk('SHOT', {
        shooter:    phase.shotTaker || phase.passer,
        gk:         phase.gkPlayer,
        shotType:   phase.shotType,
        shotAngle:  phase.shotAngle,
        oneOnOne:   phase.oneOnOne,
        isLongShot: phase.isLongShot,
        isPenalty,
        values:     { shot: qv(sv.shot ?? null), gkSave: qv(sv.gkSave ?? null) },
        outcome:    phase.outcome,
        missType:   phase.missType,
        gkContextLines: phase.gkContextLines || [],
        blockRecovery: phase.blockRecovery,
        looseBallRecovery: phase.blockRecovery,
        looseBallResolution: phase.looseBallResolution,
      }));
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
    stamp(p.passRequest?.player, at, as); stamp(p.passerUnderPressure, at, as);
    stamp(p.defender, dt, ds);
    stamp(p.blockRecovery,
      p.blockRecoveryRole === 'attacker' ? at : dt,
      p.blockRecoveryRole === 'attacker' ? as : ds);
    if (p.gkPlayer) { p.gkPlayer.team = dt; p.gkPlayer.side = ds; }
    // Carried onto every step built from this phase (see phaseToSteps's mk()) so the
    // viewer can attribute a pass/duel/shot to whichever team actually performed it —
    // opp.teamSide alone is wrong once a counter-attack has flipped who's attacking,
    // since it always names the team the opportunity nominally started for.
    p.attackingTeam = at; p.attackingSide = as;
    p.defendingTeam = dt; p.defendingSide = ds;
  }
}

// Stream phases map 1:1 with narrative phases in sequence order — if the counts diverge,
// every value past the divergence point silently attaches to the wrong narrative phase.
// The mismatch itself is tracked structurally by parseMatch() (which already has both
// counts on hand building validation.phaseMismatches) and surfaced as a warning from
// there, rather than this function pushing a duplicate string into a passed-in array.
function buildOpportunitySteps(narPhases, streamPhases, startType) {
  const steps = [];
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

// narOpps and opportunities are built in the same order from the same source loop (one
// opportunities.push() per narOpps iteration in parseMatch), so they're guaranteed
// index-aligned — reading scoreAtStart/scoreAtEnd directly off each narOpp avoids a
// minute-keyed lookup entirely. That lookup was the actual bug: two goals in the same
// minute both resolved to whichever score bracket came LAST in that minute, so the
// earlier goal's own opportunity silently got the wrong scoreAfter. Per-opportunity
// snapshots, captured by parseNarrative in true narrative sequence order, don't have that
// ambiguity — each opportunity's own scoreAtEnd is whatever the score genuinely was right
// when ITS content finished, not whichever bracket a minute happened to end on.
function annotateScores(narOpps, opportunities) {
  for (let i = 0; i < opportunities.length; i++) {
    const narOpp = narOpps[i], opp = opportunities[i];
    opp.scoreBefore = narOpp.scoreAtStart ? { ...narOpp.scoreAtStart } : { home: 0, away: 0 };
    opp.scoreAfter  = narOpp.scoreAtEnd   ? { ...narOpp.scoreAtEnd }   : opp.scoreBefore;
  }
}

function summarizeNarrativePhase(phase, index) {
  return {
    index,
    phaseType: phase.phaseType || null,
    isCA: !!phase.isCA,
    passer: phase.passer?.name || null,
    target: phase.target?.name || null,
    defender: phase.defender?.name || null,
    shotTaker: phase.shotTaker?.name || null,
    goalkeeper: phase.gkPlayer?.name || null,
    outcome: phase.outcome || null,
    looseBallRecovery: phase.blockRecovery?.name || null,
    looseBallResolution: phase.looseBallResolution || null,
  };
}

function summarizeStreamPhase(phase, index) {
  return {
    index,
    valueKeys: Object.keys(phase?.values || {}).sort(),
    events: [...(phase?.events || [])],
  };
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
     step.shooter, step.gk, step.fouler, step.yellowCard,
     step.blockRecovery, step.looseBallRecovery]
      .forEach(upsert);
  };
  for (const opp of opportunities) for (const s of opp.steps) players(s);
  for (const ev of tacticalEvents) {
    const t = ev.team ? { team: ev.team, side: ev.teamSide } : null;
    if (ev.type === 'SUBSTITUTION')    { upsert({...ev.playerOut,...t}); upsert({...ev.playerIn,...t}); }
    if (ev.type === 'POSITION_CHANGE') upsert({...ev.player,...t});
    if (ev.type === 'TIREDNESS')       upsert({...ev.player,...t});
    // INJURY's narrative line has no team prefix at all (see parseNarrative), so `t` is
    // always null here — this still registers the player's name/position so a player
    // whose only mention in the whole match is an injury report isn't dropped entirely.
    // Their team/side, if resolvable at all, comes from wherever else they're observed
    // (a step, another tactical event) — see parseMatch's post-registry teamSide pass.
    if (ev.type === 'INJURY')          upsert({...ev.player,...t});
  }
  const result = {};
  for (const [name, d] of Object.entries(reg))
    result[name] = { team: d.team, side: d.side, positions: [...d.positions].sort() };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// TACTICAL STATE
// ─────────────────────────────────────────────────────────────────────────────

// Initial tactical state. No FinalWhistle scrape source currently supplies initial
// lineup/tactics settings — only what the narrative itself reports as CHANGES — so every
// field starts unknown. Convention: `null` everywhere, chosen over the string 'unknown' so
// there's exactly one falsy "nothing here" value to check throughout this module. Never
// derive any of this from opportunity patterns (e.g. guessing initial mentality from
// opportunity volume) — that would be INFERRED, not OBSERVED/DERIVED, and this module is
// explicitly scoped to the latter two (see the Evidence model in README.md).
//
// `formation` is deliberately NOT a field here — see deriveFormation below, computed
// separately from `players` at query time so a DERIVED value never sits inside the same
// object as fields that are purely OBSERVED-via-events, keeping the OBSERVED/DERIVED
// distinction visible in the shape of the data, not just in a comment.
// The five main tactics are seeded from the match page's pre-match summary. Mentality,
// Style of Play, and Preferred Side then update from their observed narrative events;
// marking and defence focus have no narrative-observed change event at all yet, so the
// kickoff value is the only thing this parser can ever say about them for the whole
// match — which is still strictly more honest than showing null throughout.
function initialTeamState(seed) {
  return {
    mentality: seed?.mentality ?? null, style: seed?.style ?? null,
    marking: seed?.marking ?? null, defenceFocus: seed?.defenceFocus ?? null,
    preferredSide: seed?.preferredSide ?? null,
    offside: null, playerOrders: null, aggression: null, arrows: null,
    // isolate: zone-sensitive per the manual ("Isolate player (Penalty Box & Midfield)"),
    // but the narrative line ("Isolate Player - X [POS]") never names a zone — only the
    // target player — so `zone` stays null rather than guessed as PB/Midfield/both. An
    // array (not a single slot) to hold the shape the manual implies even though only one
    // player can be isolated at a time — a new ISOLATE order replaces this array's single
    // entry, it does not accumulate.
    specialOrders: { isolate: [] },
  };
}

// Player state kept structurally separate from team state (not flattened together).
// A player only enters this map once they're first observed — there is no initial-lineup
// scrape source to seed a full 11-a-side roster from — so `onPitch` only ever reflects
// "we have evidence this player is out there", never a real starting-XI-vs-bench fact for
// someone never mentioned at all.
function initialPlayerState(name, position) {
  return { name, position: position || null, onPitch: true, order: null, aggression: null,
           arrow: null, tiredness: null, injury: null };
}

// Structural formation derived from currently-known on-pitch player positions.
// Deliberately no human-friendly "4-4-2" label: with no initial-lineup source, `players`
// is built up entirely from narrative mentions observed so far, so having all 11 on-pitch
// players known at any given moment will be rare — a shorthand label would misrepresent a
// partial squad as the whole picture nearly every time it was shown. `complete` tells a
// caller whether this is actually the full XI or a partial reconstruction.
const POSITION_ZONE = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  DM: 'DM',
  CM: 'MID', LM: 'MID', RM: 'MID',
  OM: 'OM', LW: 'OM', RW: 'OM',
  FW: 'FW',
};
function deriveFormation(players) {
  const counts = { GK: 0, DEF: 0, DM: 0, MID: 0, OM: 0, FW: 0 };
  let playerCount = 0;
  for (const p of Object.values(players)) {
    if (!p.onPitch || !p.position) continue;
    const zone = POSITION_ZONE[p.position];
    if (!zone) continue;
    counts[zone]++;
    playerCount++;
  }
  return { counts, playerCount, complete: playerCount === 11 };
}

// Reconstructs a team's tactical state (team-level settings + every known player's
// state) at a specific point in the match. Pure — never mutates `match`.
//
// Same-minute ordering uses `sequence`, exactly the way annotateScores (above) uses
// narrative sequence instead of a minute-keyed lookup for scores: two tactical events (or
// an event and an opportunity) at the same minute are still strictly ordered by when they
// actually appeared in the report.
//
// `sequence` is optional. Without it, any event sharing the EXACT requested minute is
// ambiguous — did it happen before or after the moment being asked about? Rather than
// silently guessing either way, that boundary is marked `uncertain: true` and same-minute
// events are excluded from the applied state (i.e. this returns the last state that was
// UNAMBIGUOUSLY established before the requested minute).
function tacticalStateAt(match, teamSide, minute, sequence) {
  const allEvents = match?.tacticalEvents || [];

  const isBefore = (ev) => {
    if (ev.minute == null || minute == null) return false;
    if (ev.minute < minute) return true;
    if (ev.minute > minute) return false;
    if (sequence == null) return false; // same minute, no way to disambiguate — exclude
    return ev.sequence != null && ev.sequence < sequence;
  };

  const relevant = allEvents.filter(ev => ev.scope === 'match' || ev.teamSide === teamSide);
  const uncertain = sequence == null &&
    relevant.some(ev => ev.minute === minute);

  const applied = relevant.filter(isBefore).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  const teamState = initialTeamState(match?.meta?.initialTactics?.[teamSide]);
  const players = {};
  const ensurePlayer = (p) => {
    if (!p?.name) return null;
    if (!players[p.name]) players[p.name] = initialPlayerState(p.name, p.position);
    else if (p.position && !players[p.name].position) players[p.name].position = p.position;
    return players[p.name];
  };

  for (const ev of applied) {
    switch (ev.type) {
      case 'MENTALITY_CHANGE':
        teamState.mentality = ev.mentality; break;
      case 'STYLE_CHANGE':
        teamState.style = ev.style; break;
      case 'ISOLATE':
        // Special Order set by the issuing team, targeting an OPPONENT player (per the
        // manual's Conditional Orders section: "Then Isolate - isolate one of the
        // opponent players") — it's the issuing team's own tactical state that changed
        // ("who we are currently isolating"), not a fact about the target player
        // themself, so it lives here rather than mutating that player's own record.
        // A new order replaces the array's single entry (the manual: "you can choose to
        // isolate only one player") rather than accumulating one per event.
        teamState.specialOrders = { ...teamState.specialOrders,
          isolate: [{ player: ev.target || null, zone: null }] };
        break;
      case 'PREFERRED_SIDE_CHANGE':
        teamState.preferredSide = ev.preferredSide; break;
      case 'SUBSTITUTION': {
        const out = ensurePlayer(ev.playerOut);
        if (out) out.onPitch = false;
        const inP = ensurePlayer(ev.playerIn);
        if (inP) {
          inP.onPitch = true;
          // Only what FinalWhistle actually states about the incoming player (their
          // identity/position) — never inherit the outgoing player's order/aggression/
          // arrow. Nothing here copies those fields across players, by construction.
          if (ev.playerIn?.position) inP.position = ev.playerIn.position;
        }
        break;
      }
      case 'POSITION_CHANGE': {
        const p = ensurePlayer(ev.player);
        if (p) p.position = ev.toPosition;
        break;
      }
      case 'TIREDNESS': {
        const p = ensurePlayer(ev.player);
        if (p) p.tiredness = ev.level;
        break;
      }
      case 'INJURY': {
        const p = ensurePlayer(ev.player);
        if (p) p.injury = ev.severity;
        break;
      }
      case 'HALF_TIME':
      case 'EXTRA_TIME_BREAK':
        // Same rule already established by viewer.js's playerStatusAt: a tiredness report
        // doesn't carry across a break where players "rest a bit" (no way to reconstruct
        // the Constitution recovery bonus without hidden CO state), but injuries persist —
        // FinalWhistle injuries don't heal at any break, half time or extra time alike.
        for (const name of Object.keys(players)) players[name].tiredness = null;
        break;
    }
  }

  return {
    teamState, players, formation: deriveFormation(players),
    uncertain, asOf: { minute, sequence: sequence ?? null },
  };
}

// A new tactical phase begins only on a MATERIAL state change for `teamSide` —
// mentality, style, a substitution, a position change, an isolate order, or a preferred
// side change (the only change types this file observes at all; see the
// tactical-construct audit comment above parseNarrative for what's deliberately
// excluded). An opportunity, a shot, a tiredness report, or a score change never splits
// a phase on its own — they're still readable as context via tacticalStateAt for any
// minute inside whichever phase they fall in.
const PHASE_TRIGGER_TYPES = new Set(['MENTALITY_CHANGE', 'STYLE_CHANGE', 'SUBSTITUTION', 'POSITION_CHANGE', 'ISOLATE', 'PREFERRED_SIDE_CHANGE']);

function buildTacticalPhases(match, teamSide) {
  const triggers = (match?.tacticalEvents || [])
    .filter(ev => PHASE_TRIGGER_TYPES.has(ev.type) && ev.teamSide === teamSide)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  // Multiple material changes issued in the same minute (e.g. a substitution, a position
  // move and a mentality change all at 62') form ONE phase transition, not one micro-phase
  // per event — they read as a single tactical adjustment. Sequence order still fully
  // determines what counts as before/after this boundary for opportunity association
  // (see phaseIdAt below); grouping by minute only changes how many rows the phase LIST
  // itself shows.
  const groups = [];
  for (const ev of triggers) {
    const last = groups[groups.length - 1];
    if (last && last.minute === ev.minute) last.events.push(ev);
    else groups.push({ minute: ev.minute, events: [ev] });
  }

  const boundaries = [
    { minute: 0, sequence: -1, events: [] }, // Phase 1: match start, initial (unknown) state
    ...groups.map(g => ({ minute: g.minute, sequence: g.events[g.events.length - 1].sequence, events: g.events })),
  ];

  return boundaries.map((b, i) => {
    const next = boundaries[i + 1];
    // sequence+1 so the state includes this boundary's own triggering event(s) — without
    // it, tacticalStateAt would exclude the very changes that just defined this phase.
    const state = tacticalStateAt(match, teamSide, b.minute, b.sequence + 1);
    return {
      id: `${teamSide}-phase-${i}`,
      teamSide,
      startMinute: b.minute, startSequence: b.sequence,
      endMinute: next ? next.minute : null, endSequence: next ? next.sequence : null,
      state,
      // The full triggering event objects, not a stripped-down copy — so a UI consumer
      // (or a test) can reuse the same per-type rendering it already has for the tactical
      // event timeline, rather than needing a second, parallel formatting path just for
      // phase-boundary descriptions.
      triggeredBy: b.events,
      certainty: 'derived',
    };
  });
}

// Which tactical phase (by id) covers a given narrative sequence position. Opportunity
// sequences are always strictly between two distinct trigger sequences (or before the
// first / after the last) since every opportunity and every tactical event draws from the
// same shared, never-repeated counter — so the boundary comparison below never has to
// resolve a tie between an opportunity and the trigger that defines a phase edge.
function phaseIdAt(phases, sequence) {
  for (const phase of phases) {
    if (sequence > phase.startSequence && (phase.endSequence == null || sequence <= phase.endSequence))
      return phase.id;
  }
  return phases.length ? phases[phases.length - 1].id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} streamText
 * @param {string} narrativeText
 * @param {{homeTeam?: string, awayTeam?: string, initialTactics?: {home: object, away: object}}} [meta]
 *   — trusted scrape metadata (the site's own DOM elements, not narrative/telemetry text).
 *   homeTeam/awayTeam: authoritative when both are provided; without them, team identity
 *   falls back to matching narrative opportunities against stream attacking sides, which
 *   has no way to resolve a team that never had a single matched opportunity.
 *   initialTactics: each side's pre-match mentality/style/marking/defenceFocus/
 *   preferredSide, scraped from the match page's own summary card (see scraper.js) — the
 *   narrative/telemetry streams only ever report CHANGES, never a starting value, so this
 *   is the only source for what a team's settings actually were at kickoff. Seeds
 *   initialTeamState() via tacticalStateAt; see that function's own comment for which
 *   fields then keep updating from narrative events and which stay frozen at this value.
 */
function parseMatch(streamText, narrativeText, meta) {
  const warnings = [];
  const { tokens: streamTokens, unknownLines: unknownTelemetryLines } = parseStreamTokens(streamText);
  const streamBlocks = groupStreamBlocks(streamTokens);
  const narResult    = parseNarrative(narrativeText);
  const { opportunities: narOpps, tacticalEvents, unknownNarrativeLines, finalScore } = narResult;

  // Build stream lookup by minute
  const streamByMinute = {};
  const indexBlock = (block) => {
    if (!streamByMinute[block.minute]) streamByMinute[block.minute] = [];
    streamByMinute[block.minute].push(block);
  };
  for (const b of streamBlocks) indexBlock(b);

  // Map H/A → team names. Trusted metadata wins outright — it's the page's own labeling,
  // not an inference, and it's the only way to resolve a team that never created a single
  // matched opportunity (inference has nothing to anchor to for that team at all). Without
  // it, fall back to matching each narrative opportunity's team against whichever stream
  // side attacked at that minute.
  let homeTeam = null, awayTeam = null;
  if (meta?.homeTeam && meta?.awayTeam) {
    homeTeam = meta.homeTeam;
    awayTeam = meta.awayTeam;
  } else {
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
    homeTeam = teamMap.H;
    awayTeam = teamMap.A;
  }

  const sideOf     = t  => t  === homeTeam ? 'home' : t  === awayTeam ? 'away' : null;
  const streamSide = ts => ts === 'home'   ? 'H'    : 'A';

  for (const narOpp of narOpps) narOpp.teamSide = sideOf(narOpp.team);
  // ISOLATE carries issuingTeam instead of team (it's a team-wide special order, not
  // attributed the same way an "Issued order-" line is) — resolve its side here too so
  // every team-scoped tactical event carries a usable teamSide, rather than leaving it to
  // an ad-hoc fallback wherever the event happens to be consumed.
  for (const ev of tacticalEvents) {
    if (ev.team) ev.teamSide = sideOf(ev.team);
    else if (ev.issuingTeam) ev.teamSide = sideOf(ev.issuingTeam);
  }

  const blockCursors = {};
  const opportunities = [];
  const consumedBlocks = new Set();
  const matchedBlocks = [];
  const unmatchedNarrativeBlocks = [];
  const phaseMismatches = [];

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

    if (block) {
      consumedBlocks.add(block);
      matchedBlocks.push({ minute: narOpp.minute, side: ss, team: narOpp.team, confidence: streamMatchConfidence });
    } else {
      unmatchedNarrativeBlocks.push({ minute: narOpp.minute, side: ss, team: narOpp.team });
    }

    const allStreamPhases = block
      ? [...block.phases, ...(block.counterAttack?.phases || [])]
      : [];

    const defTeam = narOpp.team === homeTeam ? awayTeam : homeTeam;
    const defSide = narOpp.teamSide === 'home' ? 'away' : 'home';
    assignSides(narOpp.phases, narOpp.team, narOpp.teamSide, defTeam, defSide);

    const steps = buildOpportunitySteps(narOpp.phases, allStreamPhases, block?.startType || 'DEF');

    if (allStreamPhases.length && narOpp.phases.length !== allStreamPhases.length) {
      phaseMismatches.push({
        minute: narOpp.minute, team: narOpp.team,
        narrativePhaseCount: narOpp.phases.length, streamPhaseCount: allStreamPhases.length,
        narrativePhases: narOpp.phases.map(summarizeNarrativePhase),
        streamPhases: allStreamPhases.map(summarizeStreamPhase),
      });
    }

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
      sequence:        narOpp.sequence,
      team:            narOpp.team,
      teamSide:        narOpp.teamSide,
      startType:       block?.startType || null,
      isLongBallSequence,
      isCounterAttack: steps.some(s => s.isCA),
      scoreBefore:     null,
      scoreAfter:      null,
      hasGoal, hasShot, hasCard,
      finalOutcome:    finalStep?.outcome || null,
      finalMissType:   [...steps].reverse().find(s =>
        (s.stepType === 'SHOT' || s.stepType === 'FK_SHOT') && s.missType)?.missType || null,
      steps,
      rawLines:            narOpp.rawLines || [],
      streamMatchConfidence,
      narrativePhaseCount: narOpp.phases.length,
      streamPhaseCount:    allStreamPhases.length,
    });
  }

  annotateScores(narOpps, opportunities);
  const playerRegistry = buildPlayerRegistry(opportunities, tacticalEvents);

  // INJURY's narrative line has no team prefix at all (see parseNarrative), so it never
  // gets a teamSide from the loop above. Now that playerRegistry has aggregated team/side
  // for every player observed anywhere else in the match (a step, a substitution...), an
  // injured player's side is usually resolvable from their own name — a deterministic
  // lookup, not a guess. Stays null (honestly) for a player never observed anywhere else.
  for (const ev of tacticalEvents) {
    if (ev.teamSide || !ev.player?.name) continue;
    const reg = playerRegistry[ev.player.name];
    if (reg?.side) { ev.teamSide = reg.side; ev.team = reg.team; }
  }

  // Dynamic tactical phases per side, then associate each opportunity with the phase (by
  // id) in force for both its own team and the opponent at the moment it happened — keyed
  // by narrative sequence, not minute, for the same reason annotateScores keys scores
  // that way.
  const phaseSource = { tacticalEvents, meta: { initialTactics: meta?.initialTactics || null } };
  const tacticalPhases = {
    home: buildTacticalPhases(phaseSource, 'home'),
    away: buildTacticalPhases(phaseSource, 'away'),
  };
  for (const opp of opportunities) {
    opp.tacticalContext = {
      homePhaseId: phaseIdAt(tacticalPhases.home, opp.sequence),
      awayPhaseId: phaseIdAt(tacticalPhases.away, opp.sequence),
    };
  }

  const unusedTelemetryBlocks = streamBlocks
    .filter(b => !consumedBlocks.has(b))
    .map(b => ({ minute: b.minute, side: b.attackingSide }));

  const uncertainCount = opportunities.filter(o => o.streamMatchConfidence === 'uncertain').length;

  // A tactical event whose team could never be resolved (the player it names was never
  // observed anywhere else in the match either) means part of the tactical
  // reconstruction for this match is incomplete — surfaced the same way as every other
  // match-level diagnostic below rather than a separate warning system. This is a
  // genuinely different kind of uncertainty than telemetry/narrative pairing
  // (`confidence` above), so it gets its own field instead of being folded into that enum.
  const unresolvedTacticalEvents = tacticalEvents
    .filter(ev => ev.scope !== 'match' && !ev.teamSide)
    .map(ev => ({ id: ev.id, type: ev.type, minute: ev.minute }));

  // Structured diagnostics for the whole match, not just per-opportunity — a match can
  // "look" fine opportunity-by-opportunity (every one paired with SOME block) while still
  // having leftover telemetry blocks nothing claimed, which is just as much a sign
  // something's misaligned. 'degraded' covers every way that can happen: an opportunity
  // with no matching block, a leftover unmatched block, an ambiguous same-(minute,side)
  // pairing, or a phase count that doesn't agree with the block it WAS paired to.
  const validation = {
    narrativeOpportunityCount: narOpps.length,
    telemetryOpportunityCount: streamBlocks.length,
    matchedBlocks,
    unmatchedNarrativeBlocks,
    unusedTelemetryBlocks,
    phaseMismatches,
    unknownTelemetryLines,
    unknownNarrativeLines,
    unresolvedTacticalEvents,
    confidence: (unmatchedNarrativeBlocks.length || unusedTelemetryBlocks.length ||
                 phaseMismatches.length || uncertainCount) ? 'degraded' : 'exact',
  };

  // Human-readable warnings, derived from the structured diagnostics above rather than
  // computed a second time — one aggregate line per category so a match with many issues
  // doesn't bury the warnings banner in one-line-per-instance noise.
  if (unmatchedNarrativeBlocks.length)
    warnings.push(`${unmatchedNarrativeBlocks.length} opportunit${unmatchedNarrativeBlocks.length === 1 ? 'y has' : 'ies have'} no matching telemetry — values for ${unmatchedNarrativeBlocks.length === 1 ? 'it are' : 'them are'} narrative-only.`);
  if (uncertainCount)
    warnings.push(`${uncertainCount} opportunit${uncertainCount === 1 ? 'y' : 'ies'} shared a minute+side with another and may be paired with the wrong telemetry block if an earlier one was malformed.`);
  if (unusedTelemetryBlocks.length)
    warnings.push(`${unusedTelemetryBlocks.length} telemetry block${unusedTelemetryBlocks.length === 1 ? '' : 's'} never matched a narrative opportunity.`);
  for (const pm of phaseMismatches)
    warnings.push(`PHASE_COUNT_MISMATCH: ${pm.narrativePhaseCount} narrative phase(s) vs ${pm.streamPhaseCount} stream phase(s) at minute ${pm.minute} (${pm.team}) — values may be misattributed.`);
  if (unknownTelemetryLines.length)
    warnings.push(`${unknownTelemetryLines.length} unrecognized telemetry line(s) — FinalWhistle's format may have changed.`);
  if (unknownNarrativeLines.length)
    warnings.push(`${unknownNarrativeLines.length} unrecognized narrative line(s) within an opportunity — FinalWhistle's wording may have changed.`);
  if (unresolvedTacticalEvents.length)
    warnings.push(`${unresolvedTacticalEvents.length} tactical event(s) could not be attributed to a side — the named player wasn't observed anywhere else in the match. Partial tactical state.`);

  return { meta: { homeTeam, awayTeam, finalScore, initialTactics: meta?.initialTactics || null },
           playerRegistry, opportunities, tacticalEvents, tacticalPhases, warnings, validation };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMatch, parseStreamTokens, groupStreamBlocks,
                     parseNarrative, qualityLabel, qv,
                     tacticalStateAt, buildTacticalPhases, phaseIdAt, deriveFormation };
}
