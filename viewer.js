'use strict';

/**
 * FinalWhistle Match Analyser — viewer
 *
 * Renders the extension's UI from a parsed match (see parser.js): the pitch
 * visualization, opportunity list, match timeline, and the Statistics/Tactics/Analysis/
 * Narrative/Telemetry tabs, plus a local JPG export. Single file, no build step.
 * Sections below run roughly outside-in — small drawing helpers first, then the
 * top-level render() that wires a scrape result to the whole page, then interaction
 * wiring at the bottom:
 *
 *   COLOURS                     – shared color constants (home/away/goal/etc.)
 *   PITCH GEOMETRY              – SVG coordinate constants for the pitch
 *   STEPS → CHAIN SUMMARY       – adapts parser.js's steps[] into pitch-drawing shape
 *   PITCH OUTLINE / BASE FLOW /
 *   HIGHLIGHT CHAIN / MINI CHAIN – the pitch's SVG layers
 *   PASS SUMMARY / STEP DETAIL /
 *   TACTICAL EVENTS             – opportunity detail panels
 *   MATCH TIMELINE              – the 0–90' marker strip above the opportunity list
 *   OPPORTUNITY LIST RENDERING  – the scrollable list of opportunity rows
 *   STATS PANEL / TACTICS       – the other tab bodies (GAME PHASES below STATS PANEL is
 *                                 computational only — computePhaseStats now backs just
 *                                 the JPG export, not a viewer tab)
 *   ANALYSIS TAB                – pure rendering over analytics.js's plain data
 *   MAIN RENDER                 – render(scrape): parse + populate every panel
 *   HOVER / CLICK INTERACTIONS  – preview-on-hover, pin-on-click, timeline sync
 *   EXPORT — JPG SNAPSHOT       – local export as a self-contained rasterized SVG
 *   TABS / EVENT DELEGATION /
 *   BUTTONS                     – wiring at the bottom of the file
 */
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────────────────────
// COLOURS
// ─────────────────────────────────────────────────────────────────────────────
const HC   = '#6fb3d9';  // home
const AC   = '#e0925c';  // away
const CLR  = '#d9695f';  // cleared/failed
const GOLD = '#e8c468';  // goal
const LC   = 'rgba(255,255,255,0.45)'; // pitch line colour

// The game's own quality-tier tag colors (from its tag-color picker) — awesome/masterful
// and the rarer bands above it (unbelievable/legendary) all share the top tier's color.
const QUALITY_COLORS = {
  awful:'#b8534f', poor:'#a8a832', weak:'#4dd4d4', decent:'#f0ece0', good:'#c9a29c',
  excellent:'#ef9dc4', superb:'#f0a862', brilliant:'#e0812a',
  masterful:'#a8551c', awesome:'#a8551c', unbelievable:'#a8551c', legendary:'#a8551c',
};
function tierColor(label) { return QUALITY_COLORS[label] || '#8a9ab0'; }

// ── Narrative colorizing ──────────────────────────────────────────────────────
// Raw narrative lines are plain engine text ("Name [POS] attempted low weak pass...") —
// tag player names by team side (via the match's playerRegistry) and quality words by
// their tier color, so the narrative reads with the same color language as the rest of
// the UI instead of being a flat wall of grey text.
// Most text rendered through this file (player/team names, warnings, errors, raw stat
// labels) comes from FinalWhistle's own page rather than arbitrary internet content, but
// team/player names are themselves other managers' free-text choices — a hostile name
// (or an unlucky one containing "<") reaching innerHTML unescaped is a real HTML/script
// injection path, not just a theoretical one. Escape every such value before interpolating.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const QUALITY_WORD_RE = /\b(legendary|unbelievable|masterful|awesome|brilliant|superb|excellent|good|decent|weak|poor|awful)\b/gi;
const PLAYER_TOKEN_RE = /([\p{L}.'’\- ]+?) \[([A-Z]+)\]/gu;
function colorizeNarrativeLine(line, registry) {
  let html = escapeHtml(line);
  html = html.replace(PLAYER_TOKEN_RE, (full, name, pos) => {
    const side = registry?.[name.trim()]?.side;
    const col  = side === 'home' ? HC : side === 'away' ? AC : null;
    return col ? `<span style="color:${col};font-weight:600">${name}</span> [${pos}]` : full;
  });
  html = html.replace(QUALITY_WORD_RE, m => `<span style="color:${tierColor(m.toLowerCase())}">${m}</span>`);
  return html;
}

// ── Telemetry colorizing ──────────────────────────────────────────────────────
// Same token shape parser.js's own stream-token regex expects ("34' - A - V_SHOT -
// (75)") — this is a display-only decorator, not a second parser. It colors the H/A
// side with the same home/away colors used everywhere else, and the numeric value
// with the same qualityLabel()/tierColor() tier scale the narrative's quality WORDS
// already use, appending the tier word so a bare number reads the same way a
// narrative line already does ("75 superb", not just "75").
const TELEMETRY_LINE_RE = /^(\d+)'\s*-\s*([HA])\s*-\s*(\w+)(?:\s*-\s*\((\d+)\))?$/;
function colorizeTelemetryLine(line) {
  const m = line.match(TELEMETRY_LINE_RE);
  if (!m) return escapeHtml(line);
  const [, minute, side, kind, valStr] = m;
  const sideCol = side === 'H' ? HC : AC;
  let valueHtml = '';
  if (valStr != null) {
    const val   = parseInt(valStr, 10);
    const label = qualityLabel(val); // from parser.js — same tier scale as everywhere else
    const col   = tierColor(label);
    valueHtml = ` - <span style="color:${col};font-weight:600">(${val}</span> ` +
      `<span style="color:${col};font-style:italic">${label}</span>` +
      `<span style="color:${col};font-weight:600">)</span>`;
  }
  return `${minute}' - <span style="color:${sideCol};font-weight:700">${side}</span> - ` +
    `<span style="color:#8fa8c8">${kind}</span>${valueHtml}`;
}

// Wrap the full narrative in one <div class="raw-line" data-opp-idx="N"> per line, so a
// timeline marker click can locate and scroll to the exact block for that opportunity.
// Narrative opportunities are consumed by parser.js strictly in file order (narOpps is
// pushed to match.opportunities in the same order it's encountered), so counting
// "Opportunity for X." lines here as they're walked gives the same index directly —
// no need to replicate any of the narrative parser's actual classification logic.
function renderColorizedNarrative(narrativeText, registry) {
  let oppIdx = -1;     // real match.opportunities index of the last "Opportunity for" line seen
  let attached = false; // whether the CURRENT line is still inside that opportunity's own content
  return narrativeText.split('\n').map(line => {
    const trimmed = line.trim();
    if (/^Opportunity for .+\.$/.test(trimmed)) { oppIdx++; attached = true; }
    // A new "Minute N" line always precedes either the next opportunity or trailing
    // admin content (tiredness reports, substitutions, order changes) that belongs to
    // neither the opportunity just finished nor whichever one starts later — parser.js's
    // own currentOpp stays open across all of that (it only closes on the next
    // "Opportunity for" line), so without this, clicking an early opportunity's marker
    // would highlight several unrelated minutes of filler right along with it. Detach
    // until the next real "Opportunity for" line reattaches — note this only toggles
    // whether the current run of lines counts, it must never reset oppIdx itself, or the
    // next opportunity would collide with the one before it instead of advancing past it.
    else if (/^Minute \d+$/.test(trimmed)) attached = false;
    return `<div class="raw-line" data-opp-idx="${attached ? oppIdx : -1}">${colorizeNarrativeLine(line, registry)}</div>`;
  }).join('');
}

// Same idea for telemetry, which has no per-opportunity marker line — instead, each
// opportunity's stream block starts at an O_*_START token, and parser.js's parseMatch
// assigns blocks to narrative opportunities via a per-(minute, side) sequential cursor
// (first "5' H" block goes to the first minute-5 home opportunity, second to the second,
// etc.). Mirroring that exact same deterministic rule here — not re-deriving any of the
// actual phase/value logic, just which line range belongs to which opportunity — keeps
// the anchors aligned with the real assignment. Home always corresponds to stream side
// 'H': parser.js derives homeTeam/awayTeam directly from teamMap.H/teamMap.A, so the
// mapping holds by construction, not by a coincidence this code has to guess at.
function renderColorizedTelemetry(telemetryText, match) {
  const lines = telemetryText.split('\n');
  const blocks = [];
  lines.forEach((line, i) => {
    const m = line.trim().match(TELEMETRY_LINE_RE);
    if (m && m[3].startsWith('O_')) blocks.push({ lineIdx: i, minute: parseInt(m[1], 10), side: m[2] });
  });
  const blockOppIdx = new Array(blocks.length).fill(-1);
  const used = new Array(blocks.length).fill(false);
  (match?.opportunities || []).forEach((opp, idx) => {
    const side = opp.teamSide === 'home' ? 'H' : 'A';
    const bi = blocks.findIndex((b, i) => !used[i] && b.minute === opp.minute && b.side === side);
    if (bi !== -1) { used[bi] = true; blockOppIdx[bi] = idx; }
  });
  let blockPtr = -1;
  return lines.map((line, i) => {
    if (blockPtr + 1 < blocks.length && blocks[blockPtr + 1].lineIdx === i) blockPtr++;
    let oppIdx = blockPtr >= 0 ? blockOppIdx[blockPtr] : -1;
    // A block's own O_*_START token establishes its minute; every telemetry line already
    // carries its own minute prefix, so if a later line within the same block drifts to a
    // different minute (trailing C_* coaching/order tokens reported at a later minute,
    // absorbed into the block by groupStreamBlocks since they precede the next O_ token)
    // it no longer belongs to that opportunity's highlighted range — same "detach on
    // minute change" fix as the narrative panel, just driven by the line's own number
    // instead of a separate marker line.
    if (oppIdx !== -1) {
      const lm = line.trim().match(TELEMETRY_LINE_RE);
      if (lm && parseInt(lm[1], 10) !== blocks[blockPtr].minute) oppIdx = -1;
    }
    return `<div class="raw-line" data-opp-idx="${oppIdx}">${colorizeTelemetryLine(line)}</div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// PITCH GEOMETRY  (500×820 SVG units, pitch field inside padding BY/BX)
// ─────────────────────────────────────────────────────────────────────────────
const PW=500, PH=820, BX=28, BY=32;
const BW=PW-BX*2, BH=PH-BY*2;
const MX=PW/2, MY=BY+BH/2;
const LBW=Math.round(BW*.570), LBH=Math.round(BH*.171), LBX=(PW-LBW)/2;
const SBW=Math.round(BW*.281), SBH=Math.round(BH*.071), SBX=(PW-SBW)/2;
const GW=Math.round(BW*.148), GH=16, GX=(PW-GW)/2;
const CCR=Math.round(BH*.097), ARC=CCR;
const PSd=Math.round(BH*.114), PST=BY+PSd, PSB=BY+BH-PSd;
const ARC_DX=Math.round(Math.sqrt(ARC*ARC-(LBH-PSd)*(LBH-PSd)));
const CAR=8;

// Lane X positions (home = left=left, away mirrors)
const VX  = { left: BX+BW*.175, center: MX, right: BX+BW*.825 };
const OVX = { left: BX+BW*.825, center: MX, right: BX+BW*.175 };

// Position → lane
const LANE_MAP = {
  GK:'center', LB:'left', CB:'center', RB:'right',
  LWB:'left', DM:'center', RWB:'right',
  LM:'left', CM:'center', RM:'right',
  LW:'left', OM:'center', RW:'right', FW:'center'
};

// Home (H) attacks UP → smaller Y = opponent goal (top)
const P_GK=BY+BH-55, P_DEF=BY+BH-LBH-22, P_DM=MY+Math.round(BH*.10);
const P_MID=MY-40, P_AM=MY-Math.round(BH*.14), P_FW=BY+LBH+28;
// Away (A) attacks DOWN → larger Y = home goal (bottom)
const O_GK=BY+55, O_DEF=BY+LBH+22, O_DM=MY-Math.round(BH*.10);
const O_MID=MY+40, O_AM=MY+Math.round(BH*.14), O_FW=BY+BH-LBH-28;

const ROW_H = { GK:P_GK, LB:P_DEF,CB:P_DEF,RB:P_DEF, LWB:P_DM,DM:P_DM,RWB:P_DM,
                LM:P_MID,CM:P_MID,RM:P_MID, LW:P_AM,OM:P_AM,RW:P_AM, FW:P_FW };
const ROW_A = { GK:O_GK, LB:O_DEF,CB:O_DEF,RB:O_DEF, LWB:O_DM,DM:O_DM,RWB:O_DM,
                LM:O_MID,CM:O_MID,RM:O_MID, LW:O_AM,OM:O_AM,RW:O_AM, FW:O_FW };

// Y landmarks for highlight chain
const PY = { start:P_DEF, mid:P_MID, pb:BY+LBH, att:PST, goal:BY };
const AY = { start:O_DEF, mid:O_MID, pb:BY+BH-LBH, att:PSB, goal:BY+BH };

function posX(pos, side) {
  return (side==='home' ? VX : OVX)[LANE_MAP[pos]||'center'];
}
function posY(pos, side) {
  return (side==='home' ? ROW_H : ROW_A)[pos] || (side==='home' ? P_MID : O_MID);
}
function pXY(pos, side) { return { x:posX(pos,side), y:posY(pos,side) }; }

// Nudge a node's X position toward the average lane of its chain neighbours (source/target
// of the pass reaching or leaving it), so the pitch reads as the ball's actual path rather
// than every player of a given role always sitting at the identical fixed slot.
const LANE_ORDER = { left:0, center:1, right:2 };
function lane(pos) { return LANE_MAP[pos] || 'center'; }
function nudgedXY(pos, side, neighbours) {
  const base = pXY(pos, side);
  const ns = (neighbours || []).filter(Boolean);
  if (!ns.length) return base;
  const myLane  = LANE_ORDER[lane(pos)];
  const avgLane = ns.reduce((sum, p) => sum + LANE_ORDER[lane(p)], 0) / ns.length;
  const V = side === 'home' ? VX : OVX;
  const laneStep = Math.abs(V.right - V.left) / 2;
  return { x: base.x + (avgLane - myLane) * laneStep * 0.22, y: base.y };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEPS → CHAIN SUMMARY  (adapter from new model to pitch/minichain)
// ─────────────────────────────────────────────────────────────────────────────
function stepsToChain(opp) {
  const steps = opp.steps || [];
  const isCA  = !!opp.isCounterAttack;
  // When the opportunity turned into a counter-attack, the CA portion is the actual story —
  // draw only from CA-flagged steps rather than letting the earlier (now-irrelevant) team's
  // failed move win by array order, which is what happened before this fix.
  const pool  = isCA ? steps.filter(s => s.isCA) : steps;
  const find  = type => pool.find(s => s.stepType === type);

  // A blocked pass can create another START_PASS/MID_DUEL pair inside the same
  // opportunity (the loose ball is recovered and play continues). Using the first pair
  // made the pitch stop at the block even when the recovered route later produced a
  // goal. Pair each start pass with its following duel, then use the last pair that
  // actually advanced as the main route. Earlier failed attempts remain available as
  // subdued context on the pitch.
  const midPairs = [];
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].stepType !== 'START_PASS') continue;
    let duel = null;
    for (let j = i + 1; j < pool.length && pool[j].stepType !== 'START_PASS'; j++) {
      if (pool[j].stepType === 'MID_DUEL') { duel = pool[j]; break; }
    }
    midPairs.push({ pass: pool[i], duel });
  }
  const advancedPair = [...midPairs].reverse().find(pair =>
    ['POSSESSION', 'WON'].includes(pair.duel?.outcome));
  const primaryMidPair = advancedPair || midPairs[midPairs.length - 1] || null;
  const startPass = primaryMidPair?.pass || find('START_PASS');
  const midDuel   = primaryMidPair?.duel || find('MID_DUEL');
  const pbPass    = find('PB_PASS');
  const pbDuel    = find('PB_DUEL');
  const shot      = find('SHOT');
  const fkShot    = find('FK_SHOT');
  const sp        = find('SP_PASS');

  const effectiveMid  = midDuel;
  const effectivePb   = pbDuel;
  const effectiveShot = shot || fkShot;

  // A long ball skips the midfield contest entirely (see isLongBallSequence below) — there's no
  // real mid duel to have "won", but the ball did legitimately advance past that stage.
  const isLongBallSequence = !!opp.isLongBallSequence;
  const midWon = ['POSSESSION','WON'].includes(effectiveMid?.outcome) || isLongBallSequence;

  const pbReached  = !!(pbPass || effectivePb || sp);
  const pbAdvanced = pbReached && !['CLEARED','BLOCKED','GK_INTERCEPT','FOUL']
                       .includes(effectivePb?.outcome);

  const shotOut = effectiveShot?.outcome;
  const gkRes   = shotOut === 'GOAL' ? 'goal'
                : shotOut === 'SAVED' ? 'save'
                : ['POST','MISSED','SHOT_BLOCKED'].includes(shotOut) ? 'miss' : null;

  const isInt = effectivePb?.outcome === 'GK_INTERCEPT'
             || steps.find(s => s.outcome === 'GK_INTERCEPT');

  // A shot taken straight off the midfield duel (no Penalty Box phase at all) — the
  // pitch chain needs to draw this as mid-duel → goal, not gate it behind pbRes==='adv'.
  const directShot = !pbReached && !!effectiveShot;

  return {
    sP:       startPass?.from?.position   || null,
    sName:    startPass?.from?.name       || null,
    mP:       startPass?.to?.position     || effectiveMid?.attacker?.position || null,
    mName:    startPass?.to?.name         || effectiveMid?.attacker?.name     || null,
    mDefP:    effectiveMid?.defender?.position || null,
    mDefName: effectiveMid?.defender?.name     || null,
    pbP:      pbPass?.from?.position      || effectivePb?.attacker?.position  || null,
    pbName:   pbPass?.from?.name          || effectivePb?.attacker?.name      || null,
    rP:       pbPass?.to?.position        || effectivePb?.attacker?.position  || null,
    rName:    pbPass?.to?.name            || effectivePb?.attacker?.name      || null,
    pbDefP:   effectivePb?.defender?.position || null,
    pbDefName:effectivePb?.defender?.name     || null,
    shP:      effectiveShot?.shooter?.position || null,
    shName:   effectiveShot?.shooter?.name     || null,
    gkName:   effectiveShot?.gk?.name          || null,
    midOut:   midWon ? 'advanced' : 'cleared',
    pbReached,
    pbOut:    isInt ? 'int' : pbAdvanced ? 'attempt' : 'cleared',
    pbRes:    pbAdvanced ? 'adv' : 'cleared',
    attOut:   gkRes,
    gkRes,
    sQ:       startPass?.values?.pass?.value  ?? null,
    pbQ:      pbPass?.values?.pass?.value     ?? null,
    sPassH:   startPass?.passHeight === 'high' ? 'High' : null,
    pbPassH:  pbPass?.passHeight    === 'high' ? 'High' : null,
    isLongShot: effectiveShot?.isLongShot || false,
    shType:   effectiveShot?.isLongShot ? 'Long Shot' : effectiveShot?.shotType || null,
    shotQ:    effectiveShot?.values?.shot?.value   ?? null,
    gkQ:      effectiveShot?.values?.gkSave?.value ?? null,
    isCA,
    isPenalty: effectiveShot?.isPenalty || false,
    directShot,
    isLongBallSequence,
    earlierFailedPasses: midPairs
      .filter(pair => pair !== primaryMidPair && !['POSSESSION', 'WON'].includes(pair.duel?.outcome))
      .map(pair => ({
        from: pair.pass?.from?.position || null,
        to: pair.pass?.to?.position || pair.duel?.attacker?.position || null,
        defender: pair.duel?.defender?.position || null,
        outcome: pair.duel?.outcome || 'BLOCKED',
      })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PITCH OUTLINE SVG
// ─────────────────────────────────────────────────────────────────────────────
function renderPitchOutline() {
  const s = [];
  // Striped grass
  for (let i=0;i<14;i++) {
    s.push(`<rect x="${BX}" y="${BY+i*(BH/14)}" width="${BW}" height="${BH/14+.5}" fill="${i%2===0?'#1b3f1b':'#1f4820'}"/>`);
  }
  // Outer boundary
  s.push(`<rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" fill="none" stroke="${LC}" stroke-width="2" rx="${CAR}"/>`);
  // Halfway line
  s.push(`<line x1="${BX}" y1="${MY}" x2="${BX+BW}" y2="${MY}" stroke="${LC}" stroke-width="1.5"/>`);
  // Centre circle + dot
  s.push(`<circle cx="${MX}" cy="${MY}" r="${CCR}" fill="none" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<circle cx="${MX}" cy="${MY}" r="3" fill="${LC}"/>`);
  // Top penalty area + arc + small box
  s.push(`<rect x="${LBX}" y="${BY}" width="${LBW}" height="${LBH}" fill="rgba(255,255,255,.04)" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<path d="M${MX-ARC_DX} ${BY+LBH} A${ARC} ${ARC} 0 0 0 ${MX+ARC_DX} ${BY+LBH}" fill="none" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<rect x="${SBX}" y="${BY}" width="${SBW}" height="${SBH}" fill="none" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<rect x="${GX}" y="${BY-GH}" width="${GW}" height="${GH}" fill="rgba(255,255,255,.03)" stroke="${LC}" stroke-width="2"/>`);
  s.push(`<circle cx="${MX}" cy="${PST}" r="3" fill="${LC}"/>`);
  // Bottom penalty area + arc + small box
  s.push(`<rect x="${LBX}" y="${BY+BH-LBH}" width="${LBW}" height="${LBH}" fill="rgba(255,255,255,.04)" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<path d="M${MX-ARC_DX} ${BY+BH-LBH} A${ARC} ${ARC} 0 0 1 ${MX+ARC_DX} ${BY+BH-LBH}" fill="none" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<rect x="${SBX}" y="${BY+BH-SBH}" width="${SBW}" height="${SBH}" fill="none" stroke="${LC}" stroke-width="1.5"/>`);
  s.push(`<rect x="${GX}" y="${BY+BH}" width="${GW}" height="${GH}" fill="rgba(255,255,255,.03)" stroke="${LC}" stroke-width="2"/>`);
  s.push(`<circle cx="${MX}" cy="${PSB}" r="3" fill="${LC}"/>`);
  // Team goal labels
  s.push(`<text x="${MX}" y="${BY-GH-8}" text-anchor="middle" font-size="9" fill="${AC}" font-family="monospace" letter-spacing="2" opacity=".6">AWAY GOAL</text>`);
  s.push(`<text x="${MX}" y="${BY+BH+GH+12}" text-anchor="middle" font-size="9" fill="${HC}" font-family="monospace" letter-spacing="2" opacity=".6">HOME GOAL</text>`);
  return s.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE FLOW  — aggregate pass network
// ─────────────────────────────────────────────────────────────────────────────
function buildBaseFlow(opportunities, side) {
  const edgeCounts = {}, nodeCounts = {};
  const add = (from, to) => {
    if (!from || !to || from === to) return;
    const k = `${from}|${to}`;
    edgeCounts[k] = (edgeCounts[k]||0)+1;
    nodeCounts[from] = (nodeCounts[from]||0)+1;
    nodeCounts[to]   = (nodeCounts[to]||0)+1;
  };
  opportunities.forEach(opp => {
    const chainSide = opp.isCounterAttack ? (opp.teamSide === 'home' ? 'away' : 'home') : opp.teamSide;
    if (chainSide !== side) return;
    const c = stepsToChain(opp);
    if (c.sP && c.mP)                   add(c.sP, c.mP);
    if (c.midOut === 'advanced' && c.rP) add(c.mP||c.pbP, c.rP);
    if (c.pbRes === 'adv' && c.shP && c.shP !== c.rP) add(c.rP, c.shP);
    if (c.gkRes === 'goal' && c.shP)    add(c.shP, 'GOAL');
  });
  return { edgeCounts, nodeCounts };
}

const NODE_R = 9; // position nodes are all the same size — only edge width encodes frequency

// A small filled triangle pointing along the from→to direction, tipped just outside the
// target node so it isn't hidden underneath it (nodes paint on top of edges below). The
// aggregate flow's edgeCounts keys are already directional ("${from}|${to}"), but a plain
// line between two nodes doesn't show which way the ball actually moved — this does.
// backoff is how far back from (tx,ty) the tip sits — callers whose (tx,ty) is a node's
// *center* (the aggregate base-flow edges below) pass the node's radius plus a small gap;
// callers whose (tx,ty) is already a point on the node's boundary (gLine, further down —
// its endpoints are pre-offset via edgePt) just need a couple of units of clearance.
function arrowHead(fx, fy, tx, ty, col, opacity, backoff = 0) {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const size = 6;
  const tipX = tx - ux * backoff, tipY = ty - uy * backoff;
  const baseX = tipX - ux * size, baseY = tipY - uy * size;
  const perpX = -uy * size * 0.55, perpY = ux * size * 0.55;
  return `<polygon points="${tipX},${tipY} ${baseX + perpX},${baseY + perpY} ${baseX - perpX},${baseY - perpY}" fill="${col}" opacity="${opacity}"/>`;
}

function renderBaseFlow(edgeCounts, nodeCounts, side) {
  const col   = side === 'home' ? HC : AC;
  const edges = Object.entries(edgeCounts);
  const maxE  = Math.max(1, ...edges.map(([,v])=>v));
  const lw    = n => 1.5 + n/maxE*10;
  const s     = [];

  // Edges
  edges.filter(([k]) => !k.includes('GOAL')).forEach(([key, count]) => {
    const [from, to] = key.split('|');
    const fp = pXY(from, side), tp = pXY(to, side);
    const mx = (fp.x+tp.x)/2, my = (fp.y+tp.y)/2;
    const w  = lw(count);
    s.push(`<line x1="${fp.x}" y1="${fp.y}" x2="${tp.x}" y2="${tp.y}" stroke="${col}" stroke-width="${w+4}" opacity=".05" stroke-linecap="round"/>`);
    s.push(`<line x1="${fp.x}" y1="${fp.y}" x2="${tp.x}" y2="${tp.y}" stroke="${col}" stroke-width="${w}" opacity=".3" stroke-linecap="round"/>`);
    s.push(arrowHead(fp.x, fp.y, tp.x, tp.y, col, .65, NODE_R + 2));
    s.push(`<rect x="${mx-9}" y="${my-6}" width="18" height="12" rx="2" fill="#030a14" opacity=".8"/>`);
    s.push(`<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="9" font-family="monospace" opacity=".65">${count}</text>`);
  });

  // Goal edge
  const goalEdge = edges.find(([k]) => k.endsWith('|GOAL'));
  if (goalEdge) {
    const [shPos] = goalEdge[0].split('|');
    const sp = pXY(shPos, side);
    const gy = side === 'home' ? PY.goal : AY.goal;
    s.push(`<line x1="${sp.x}" y1="${sp.y}" x2="${MX}" y2="${gy}" stroke="${GOLD}" stroke-width="${lw(goalEdge[1])+1}" opacity=".5" stroke-linecap="round"/>`);
    s.push(arrowHead(sp.x, sp.y, MX, gy, GOLD, .75, 14));
    s.push(`<circle cx="${MX}" cy="${gy}" r="12" fill="${GOLD}" opacity=".2"/>`);
    s.push(`<circle cx="${MX}" cy="${gy}" r="5"  fill="${GOLD}" opacity=".7"/>`);
    s.push(`<text x="${MX}" y="${gy}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="#030a14" font-weight="bold">${goalEdge[1]}</text>`);
  }

  // Position nodes — all the same size; only the edges (passes between them) vary in width
  Object.entries(nodeCounts).filter(([p])=>p!=='GOAL').forEach(([pos]) => {
    const {x, y} = pXY(pos, side);
    s.push(`<circle cx="${x}" cy="${y}" r="${NODE_R+2}" fill="${col}" opacity=".08"/>`);
    s.push(`<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="#060d18" stroke="${col}" stroke-width="1.5" opacity=".8"/>`);
    s.push(`<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="8" font-family="monospace" opacity=".9">${escapeHtml(pos)}</text>`);
  });

  return s.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGHLIGHT CHAIN  — one opportunity traced on pitch
// ─────────────────────────────────────────────────────────────────────────────
// Abbreviations for the pitch's compact line labels — derived from parser.js's
// qualityLabel() (the single source of truth for tier boundaries) rather than
// re-declaring the numeric thresholds here, which had drifted into two copies.
const Q_ABBR = {
  legendary:'awe', unbelievable:'awe', masterful:'awe', awesome:'awe',
  brilliant:'bri', superb:'sup', excellent:'exc', good:'good',
  decent:'dec', weak:'wk', poor:'poor', awful:'aw',
};
function qLabel(n) {
  if (n == null) return '';
  return Q_ABBR[qualityLabel(n)] || '';
}

function gLine(x1,y1,x2,y2,col,label,pct=.5,dashed=false) {
  const mx=x1+(x2-x1)*pct, my=y1+(y2-y1)*pct;
  const dash = dashed ? ' stroke-dasharray="5,4"' : '';
  const s = [
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="3.5" opacity=".12" stroke-linecap="round"${dash}/>`,
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1.5" opacity=".85" stroke-linecap="round"${dash}/>`,
    // Every gLine call already terminates at a point on the destination node's own
    // boundary circle (callers pre-offset via edgePt), so this only needs a couple of
    // units of backoff for clearance, not a full node-radius one — shows which way the
    // ball actually moved through this stage of the chain (pass, interception, shot, ...).
    arrowHead(x1, y1, x2, y2, col, .85, 2),
  ];
  if (label) {
    const labelWidth = Math.max(28, String(label).length * 6 + 8);
    s.push(
      `<rect x="${mx-labelWidth/2}" y="${my-7}" width="${labelWidth}" height="14" rx="2" fill="#030a14" opacity=".9"/>`,
      `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="9" font-family="monospace" opacity=".9">${escapeHtml(label)}</text>`
    );
  }
  return s.join('');
}

// pos/atkPos/defPos are position codes (parser.js only ever captures them via a
// \[([A-Z]+)\] narrative regex, so today they can't contain HTML metacharacters) — escaped
// anyway so this stays safe even if a future parser change ever loosens that constraint,
// rather than relying solely on an upstream regex forever.
function playerNode(x,y,pos,col,outline=false) {
  return [
    `<circle cx="${x}" cy="${y}" r="12" fill="#060d18" stroke="${col}" stroke-width="${outline?2:1.5}" opacity="${outline?1:.8}"/>`,
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="8" font-family="monospace" font-weight="bold">${escapeHtml(pos)||'?'}</text>`,
  ].join('');
}

function duelNode(x,y,atkCol,defCol,outcome,atkPos,defPos) {
  // Split circle: left = attacker's position, right = defender's — self-explanatory
  // without a legend, same convention as the plain position nodes elsewhere on the pitch.
  // The outer ring still colors by outcome (attacker's color = won, red = lost).
  const won  = ['POSSESSION','WON','advanced'].includes(outcome);
  const ring = won ? atkCol : CLR;
  return [
    `<circle cx="${x}" cy="${y}" r="13" fill="#060d18" stroke="${ring}" stroke-width="2" opacity=".9"/>`,
    `<path d="M${x} ${y-13} A13 13 0 0 1 ${x} ${y+13}" fill="${atkCol}" opacity=".25"/>`,
    `<path d="M${x} ${y-13} A13 13 0 0 0 ${x} ${y+13}" fill="${defCol}" opacity=".25"/>`,
    `<text x="${x-6}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${atkCol}" font-size="7" font-family="monospace" font-weight="bold">${escapeHtml(atkPos)||'?'}</text>`,
    `<text x="${x+6}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${defCol}" font-size="7" font-family="monospace" font-weight="bold">${escapeHtml(defPos)||'?'}</text>`,
  ].join('');
}

function renderHighlightChain(opp) {
  const c      = stepsToChain(opp);
  // During a counter-attack the team crediting the opportunity is the one that just got
  // countered — the side actually attacking (and whose colour/goal-direction applies) flips.
  const side   = c.isCA ? (opp.teamSide === 'home' ? 'away' : 'home') : opp.teamSide;
  const col    = side === 'home' ? HC : AC;
  const defCol = side === 'home' ? AC : HC;
  const Y      = side === 'home' ? PY : AY;
  const s      = [];

  if (!c.sP && !c.mP && !c.isLongBallSequence) return '';

  if (c.isCA) {
    const bx = side === 'home' ? VX.left - 8 : OVX.right + 8;
    s.push(`<rect x="${bx-15}" y="${Y.start-9}" width="30" height="18" rx="3" fill="#030a14" opacity=".92" stroke="${col}" stroke-width="1"/>`);
    s.push(`<text x="${bx}" y="${Y.start}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="9" font-family="monospace" font-weight="bold" letter-spacing="1">CA</text>`);
  }

  // Preserve a blocked/failed attempt that preceded a recovered successful route. It is
  // intentionally quieter than the primary chain, but still explains why the next pass
  // begins from a different player after a loose-ball recovery.
  for (const failed of c.earlierFailedPasses || []) {
    if (!failed.from || !failed.to) continue;
    const from = pXY(failed.from, side);
    const to = nudgedXY(failed.to, side, [failed.from]);
    s.push(`<g data-chain-context="earlier-failed-pass" opacity=".55">` +
      gLine(from.x, from.y, to.x, to.y, CLR, 'blocked', .5, c.isCA) +
      playerNode(from.x, from.y, failed.from, col) +
      duelNode(to.x, to.y, col, defCol, failed.outcome, failed.to, failed.defender) +
      `</g>`);
  }

  const DR = 14; // duel node radius for edge offsets
  function edgePt(from, to, r) {
    const dx=to.x-from.x, dy=to.y-from.y, d=Math.hypot(dx,dy);
    if (d<1) return from;
    return { x:from.x+dx/d*r, y:from.y+dy/d*r };
  }

  let mxy;
  if (c.isLongBallSequence) {
    // A long ball skips the midfield stage entirely (LB/RB delivers straight into the
    // box) — there's no start pass or mid duel to draw, just the passer, who becomes
    // the hub the PB stage below connects from.
    mxy = c.pbP ? pXY(c.pbP, side) : { x:MX, y:Y.start };
    s.push(playerNode(mxy.x, mxy.y, c.pbP, col, true));
  } else {
    const sxy = c.sP ? pXY(c.sP, side) : { x:MX, y:Y.start };
    mxy = c.mP ? nudgedXY(c.mP, side, [c.sP, c.rP || c.pbP]) : { x:MX, y:Y.mid };

    // ── Start pass line ─────────────────────────────────────────────────────────
    const sDep = edgePt(sxy, mxy, 12);
    const mArr = edgePt(mxy, sxy, DR);
    s.push(gLine(sDep.x, sDep.y, mArr.x, mArr.y, col, c.sQ ? qLabel(c.sQ) : null, .5, c.isCA));
    if (c.sPassH === 'High') {
      const mx=sDep.x+(mArr.x-sDep.x)*.65, my=sDep.y+(mArr.y-sDep.y)*.65;
      s.push(`<rect x="${mx-11}" y="${my-7}" width="22" height="14" rx="2" fill="#030a14" opacity=".9"/>`);
      s.push(`<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="#d4a850" font-size="9" font-family="monospace" opacity=".9">high</text>`);
    }

    // ── Start passer node ───────────────────────────────────────────────────────
    s.push(playerNode(sxy.x, sxy.y, c.sP, col, true));

    // ── Mid duel ────────────────────────────────────────────────────────────────
    s.push(duelNode(mxy.x, mxy.y, col, defCol, c.midOut, c.mP, c.mDefP));

    if (c.midOut !== 'advanced') {
      return `<g opacity="1">${s.join('')}</g>`;
    }
  }

  // A long shot taken straight off the midfield duel has no Penalty Box phase at all —
  // skip the PB pass/duel drawing and go straight from the mid duel to the shot.
  let rxy;
  if (c.directShot) {
    rxy = mxy;
  } else {
    // ── PB pass ───────────────────────────────────────────────────────────────
    rxy = c.rP ? nudgedXY(c.rP, side, [c.pbP || c.mP, c.shP]) : { x:MX, y:Y.pb };
    const pbPasser = c.pbP ? pXY(c.pbP, side) : mxy;

    const pbDep = edgePt(pbPasser, rxy, DR);
    const pbArr = edgePt(rxy, pbPasser, DR);
    s.push(gLine(pbDep.x, pbDep.y, pbArr.x, pbArr.y, col, c.pbQ ? qLabel(c.pbQ) : null, .5, c.isCA));
    if (c.pbPassH === 'High') {
      const mx=pbDep.x+(pbArr.x-pbDep.x)*.65, my=pbDep.y+(pbArr.y-pbDep.y)*.65;
      s.push(`<rect x="${mx-11}" y="${my-7}" width="22" height="14" rx="2" fill="#030a14" opacity=".9"/>`);
      s.push(`<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="#d4a850" font-size="9" font-family="monospace" opacity=".9">high</text>`);
    }

    // ── PB duel / GK intercept ──────────────────────────────────────────────────
    if (c.pbOut === 'int') {
      const intY = side === 'home' ? O_GK : P_GK;
      const ixy  = { x:MX, y:intY };
      s.push(gLine(pbArr.x, pbArr.y, ixy.x, ixy.y, '#d4a850', 'int'));
      s.push(`<circle cx="${ixy.x}" cy="${ixy.y}" r="10" fill="#d4a850" opacity=".3"/>`);
      s.push(`<text x="${ixy.x}" y="${ixy.y}" text-anchor="middle" dominant-baseline="central" fill="#d4a850" font-size="9" font-family="monospace" font-weight="bold">GK</text>`);
    } else {
      s.push(duelNode(rxy.x, rxy.y, col, defCol, c.pbOut === 'attempt' ? 'WON' : 'cleared', c.rP, c.pbDefP));
    }

    if (c.pbRes !== 'adv') {
      return `<g opacity="1">${s.join('')}</g>`;
    }
  }

  // ── Shot ────────────────────────────────────────────────────────────────────
  // Penalties are taken from the spot, not wherever the box duel happened — route
  // the shot from the fixed penalty mark instead of the normal receiver position.
  const gy   = side === 'home' ? PY.goal : AY.goal;
  const gkxy = { x:MX, y:gy };
  const shxy = c.isPenalty ? { x:MX, y: side === 'home' ? PST : PSB }
             : c.isLongShot && c.shP ? pXY(c.shP, side) : rxy;

  const shCol = c.gkRes === 'goal' ? GOLD : c.gkRes === 'save' ? '#999' : c.gkRes === 'miss' ? '#d4954a' : col;

  if (c.isPenalty) {
    // Dashed connector from the box duel (where the foul happened) to the penalty spot —
    // this is a restart, not continuous play, same visual language as the CA dashing.
    s.push(gLine(rxy.x, rxy.y, shxy.x, shxy.y, '#d4a850', null, .5, true));
    s.push(`<circle cx="${shxy.x}" cy="${shxy.y}" r="9" fill="none" stroke="${shCol}" stroke-width="1.5" opacity=".6"/>`);
    s.push(`<circle cx="${shxy.x}" cy="${shxy.y}" r="2.5" fill="${shCol}" opacity=".9"/>`);
    s.push(`<rect x="${shxy.x-13}" y="${shxy.y+12}" width="26" height="13" rx="2" fill="#030a14" opacity=".9"/>`);
    s.push(`<text x="${shxy.x}" y="${shxy.y+18}" text-anchor="middle" dominant-baseline="central" fill="${shCol}" font-size="8" font-family="monospace" font-weight="bold">PK</text>`);
  }

  const shDep = edgePt(shxy, gkxy, DR);
  s.push(gLine(shDep.x, shDep.y, gkxy.x, gkxy.y, shCol,
    c.shotQ ? qLabel(c.shotQ) : null, .5, c.isCA));

  // GK node
  if (c.gkRes === 'goal') {
    s.push(`<circle cx="${gkxy.x}" cy="${gkxy.y}" r="16" fill="${GOLD}" opacity=".35"/>`);
    s.push(`<text x="${gkxy.x}" y="${gkxy.y}" text-anchor="middle" dominant-baseline="central" fill="${GOLD}" font-size="14">⚽</text>`);
  } else {
    s.push(`<circle cx="${gkxy.x}" cy="${gkxy.y}" r="12" fill="#060d18" stroke="${shCol}" stroke-width="1.5" opacity=".8"/>`);
    s.push(`<text x="${gkxy.x}" y="${gkxy.y}" text-anchor="middle" dominant-baseline="central" fill="${shCol}" font-size="8" font-family="monospace" font-weight="bold">GK</text>`);
  }

  return `<g opacity="1">${s.join('')}</g>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MINI CHAIN  — small inline SVG showing chain status
// ─────────────────────────────────────────────────────────────────────────────
function renderMiniChain(opp) {
  const c   = stepsToChain(opp);
  const chainSide = c.isCA ? (opp.teamSide === 'home' ? 'away' : 'home') : opp.teamSide;
  const col = chainSide === 'home' ? HC : AC;
  const D=4, W=78, H=14;
  const mOk = c.midOut === 'advanced';
  const pbOk = c.pbReached;
  const aOk  = c.pbOut === 'attempt';
  const isInt= c.pbOut === 'int';
  const goal = c.gkRes === 'goal', save = c.gkRes === 'save', miss = c.gkRes === 'miss';
  const dash = c.isCA ? ' stroke-dasharray="2,2"' : '';

  const mC  = mOk  ? col : CLR;
  const pbC = isInt ? '#d4a850' : (pbOk && aOk) ? col : pbOk ? CLR : '#1a2540';
  const aC  = aOk && goal ? GOLD : aOk && save ? '#888' : aOk && miss ? '#d4954a' : aOk ? col : '#1a2540';

  const s = [`<svg width="${W}" height="${H}" style="flex-shrink:0;display:block">`];
  // connector lines
  s.push(`<line x1="12" y1="7" x2="26" y2="7" stroke="${col}" stroke-width="1" opacity=".5"${dash}/>`);
  if (mOk) s.push(`<line x1="30" y1="7" x2="46" y2="7" stroke="${col}" stroke-width="1" opacity=".5"${dash}/>`);
  if (pbOk && aOk) s.push(`<line x1="50" y1="7" x2="66" y2="7" stroke="${col}" stroke-width="1" opacity=".5"${dash}/>`);
  // dots
  s.push(`<circle cx="8"  cy="7" r="${D}" fill="${col}" opacity=".9"/>`);
  s.push(`<circle cx="28" cy="7" r="${D}" fill="${mC}"  opacity=".9"/>`);
  if (pbOk) s.push(`<circle cx="48" cy="7" r="${D}" fill="${pbC}" opacity=".9"/>`);
  if (aOk)  s.push(`<circle cx="68" cy="7" r="${D}" fill="${aC}"  opacity=".9"/>`);
  if (goal) s.push(`<text x="68" y="8" text-anchor="middle" dominant-baseline="central" font-size="9" fill="${GOLD}">⚽</text>`);
  s.push('</svg>');
  return s.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS SUMMARY overlay
// ─────────────────────────────────────────────────────────────────────────────
function buildPassSummary(opp) {
  if (!opp) return '';
  const c    = stepsToChain(opp);
  const chainSide = c.isCA ? (opp.teamSide === 'home' ? 'away' : 'home') : opp.teamSide;
  const col  = chainSide === 'home' ? HC : AC;
  const team = chainSide === 'home' ? _match?.meta?.homeTeam : _match?.meta?.awayTeam;
  const qColor = q => tierColor(qualityLabel(q)); // qualityLabel() comes from parser.js

  const nameTag = (name, pos) => name
    ? `${escapeHtml(name.split(' ').pop())} <span class="ps-pos">[${escapeHtml(pos)||'?'}]</span>`
    : escapeHtml(pos)||'?';

  // List every pass in the displayed attacking sequence. A fixed Start/PB summary used
  // to omit a recovered second midfield pass and made the chain detail disagree with the
  // narrative. Counter-attacks intentionally show their CA steps only, matching the
  // highlighted pitch route and the team named in the header.
  const pool = c.isCA ? (opp.steps || []).filter(step => step.isCA) : (opp.steps || []);
  let startPassNumber = 0;
  const rows = pool.filter(step => ['START_PASS', 'PB_PASS', 'SP_PASS', 'FK_PASS'].includes(step.stepType))
    .map(step => {
      if (step.stepType === 'START_PASS') startPassNumber++;
      const type = step.stepType === 'START_PASS' ? (startPassNumber === 1 ? 'Start' : 'Recovery')
        : step.stepType === 'PB_PASS' ? (opp.isLongBallSequence ? 'Long Ball' : 'PB Action')
        : step.stepType === 'SP_PASS' ? 'Corner' : 'Free Kick';
      return {
        from: nameTag(step.from?.name, step.from?.position),
        to: nameTag(step.to?.name, step.to?.position),
        type,
        q: step.values?.pass?.value ?? null,
      };
    });

  if (!rows.length) return '';
  let html = `<div class="ps-title"><span>Chain detail</span></div>`;
  html += `<div class="ps-team" style="color:${col};border-color:${col}44">${escapeHtml(team)}</div>`;
  rows.forEach(r => {
    const qc = r.q ? qColor(r.q) : '#8a9ab0';
    html += `<div class="ps-row">
      <span class="ps-route" style="color:${col}">${r.from} → ${r.to}</span>
      <span style="font-size:11px;color:#8a9ab0">${r.type}</span>
      ${r.q ? `<span class="ps-q" style="color:${qc}">${r.q}</span>` : ''}
    </div>`;
  });
  if (c.shotQ) {
    html += `<div class="ps-row">
      <span class="ps-route" style="color:${col}">${nameTag(c.shName, c.shP)} → ${nameTag(c.gkName, 'GK')}</span>
      <span style="font-size:11px;color:#8a9ab0">${c.directShot ? 'Mid Action' : 'PB Action'}</span>
      <span class="ps-q" style="color:${qColor(c.shotQ)}">${c.shotQ}</span>
    </div>`;
  }
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP DETAIL HTML  (expand on row click)
// ─────────────────────────────────────────────────────────────────────────────
const STEP_TYPE_CSS = {
  // PB_PASS and DRIB (the action taken after winning the Mid Duel) share MID_DUEL's color
  // to visually group that stage, even though their labels are now concrete (PASS/DRIBBLE).
  START_PASS:'stype-start', MID_DUEL:'stype-mid', DRIB:'stype-mid',
  PB_PASS:'stype-mid',      PB_DUEL:'stype-pbduel', SHOT:'stype-shot',
  SP_PASS:'stype-sp',       SP_DUEL:'stype-spduel', FK_SHOT:'stype-fk',
  FK_PASS:'stype-fk',       FK_DUEL:'stype-fkduel',
};
// Labeled by what actually happened (SHOT/PASS/DRIBBLE/CORNER), not by an artificial stage
// name — the preceding duel row already establishes the stage, so this stays concrete.
const STEP_TYPE_LBL = {
  START_PASS:'START', MID_DUEL:'MID DUEL', DRIB:'DRIBBLE',
  PB_PASS:'PASS', PB_DUEL:'PB DUEL', SHOT:'SHOT',
  SP_PASS:'CORNER', SP_DUEL:'CORNER DUEL', FK_SHOT:'FK SHOT',
  FK_PASS:'FREE KICK', FK_DUEL:'FK DUEL',
};
const OUT_CSS = {
  GOAL:'ob-goal', POST:'ob-post', SAVED:'ob-saved', FUMBLED:'ob-fumbled', MISSED:'ob-post',
  GK_INTERCEPT:'ob-intercept', BLOCKED:'ob-blocked', SHOT_BLOCKED:'ob-blocked', CORNER:'ob-corner',
  FOUL:'ob-foul', CLEARED:'ob-cleared', POSSESSION:'ob-won', WON:'ob-won', FREE_KICK:'ob-fk',
  OFFSIDE:'ob-foul',
};
const OUT_LBL = {
  GOAL:'GOAL', POST:'post', SAVED:'saved', FUMBLED:'fumbled', MISSED:'missed wide',
  GK_INTERCEPT:'intercept', BLOCKED:'blocked', SHOT_BLOCKED:'shot blocked', CORNER:'corner',
  FOUL:'foul', CLEARED:'cleared', POSSESSION:'won', WON:'won', FREE_KICK:'free kick',
  OFFSIDE:'offside',
};
function outcomeLabel(outcome, missType = null) {
  if (outcome === 'MISSED') {
    if (missType === 'narrow') return 'missed narrowly';
    if (missType === 'wide') return 'missed wide';
    return 'missed';
  }
  return OUT_LBL[outcome] || outcome || '';
}

function lv(label, qvObj) {
  // lv('Pass', {value:75, label:'superb'}) → "Pass: 75 superb", as a fixed-width slot so
  // the same stat position (e.g. Ast after Rec) lands at the same X on every row, instead
  // of drifting based on how long the preceding stat's quality word happened to be.
  // A quality value of exactly 0 is legitimate (the "awful" tier bottoms out at 0, not
  // 1), so it must be treated as present — only null/undefined means "no value here".
  if (qvObj?.value == null) return null;
  const color = tierColor(qvObj.label);
  return `<span class="val-item"><span class="val-lbl">${label}:</span><span class="val-num" style="color:${color}">${qvObj.value}</span><span class="val-word">${qvObj.label||''}</span></span>`;
}
// ── Player status (injury/tiredness) ─────────────────────────────────────────────────
// Resolved from tacticalEvents at render time: walk events up to a given minute, tracking
// the most recent injury/tiredness onset per player.
//
// HALF_TIME (and EXTRA_TIME_BREAK, the same "players rest a bit" mechanic when a match
// goes beyond regulation) clears only the reported TIREDNESS, not injuries. FinalWhistle
// gives a Constitution recovery at each such break (+0.44 CO per minute played since the
// last one, capped at +20), which this extension has no way to reconstruct (it doesn't
// track hidden CO state) — so rather than guess at a post-break fatigue number, a
// pre-break tiredness report simply isn't carried forward. An injury is a different kind
// of state entirely: FinalWhistle injuries persist across every break (they don't heal),
// so clearing them here would misreport a still-injured player as fit.
// nm() calls this for every player shown in the step table — a step with two players
// (most of them) calls it twice, so a match with many opportunities repeats the same
// from-the-start walk over tacticalEvents dozens of times over. Cache by player+minute;
// _statusCache is cleared in render() whenever a new match's tacticalEvents are loaded,
// since a stale entry could otherwise coincidentally match a same-named player at the
// same minute in a different match.
let _statusCache = new Map();
function playerStatusAt(events, playerName, minute) {
  const key = playerName + '|' + minute;
  if (_statusCache.has(key)) return _statusCache.get(key);
  let injury = null, tiredness = null;
  for (const ev of events) {
    if (ev.minute != null && ev.minute > minute) break;
    if (ev.type === 'HALF_TIME' || ev.type === 'EXTRA_TIME_BREAK') { tiredness = null; continue; }
    if (ev.player?.name !== playerName) continue;
    if (ev.type === 'INJURY')    injury    = ev.severity;
    if (ev.type === 'TIREDNESS') tiredness = ev.level;
  }
  const result = { injury, tiredness };
  _statusCache.set(key, result);
  return result;
}
// Numeric penalties are the manual's stated fixed values (Tiredness: 5%/20% skill
// penalty at the tired/very-tired thresholds; Light Injury is -1 to all skills and
// -10% to CO) — the manual doesn't give an exact per-minute accumulation formula for
// tiredness in between, so this shows the two documented thresholds rather than
// inventing an interpolated number. UNKNOWN (an injury description the parser doesn't
// recognize as either "light" or "severe") intentionally shows no numeric penalty —
// only LIGHT's effect is actually documented, so guessing a number for an unrecognized
// tier would be less honest than just flagging that the player is injured.
function statusDetail(injury, tiredness) {
  if (injury === 'SEVERE')        return ' 🚑';
  if (injury === 'LIGHT')         return ' 🩹<span class="p-status-pct">-1/-10%CO</span>';
  if (injury === 'UNKNOWN')       return ' 🩹';
  if (tiredness === 'VERY_TIRED') return ' 😴<span class="p-status-pct">-20%</span>';
  if (tiredness === 'TIRED')      return ' 🫩<span class="p-status-pct">-5%</span>';
  return '';
}

function nm(p, minute) {
  if (!p?.name) return '–';
  let status = '';
  if (minute != null && _statusEvents) {
    const st = playerStatusAt(_statusEvents, p.name, minute);
    status = statusDetail(st.injury, st.tiredness);
  }
  return `<span class="p-nm">${escapeHtml(p.name.split(' ').pop())}</span> <span class="p-pos">[${escapeHtml(p.position)||'?'}]</span>${status}`;
}

function renderStepDetail(opp) {
  const rows = opp.steps.map(s => {
    const v   = s.values || {};
    const cls = STEP_TYPE_CSS[s.stepType] || 'stype-mid';
    const lbl = s.isPenalty ? 'PENALTY' : (STEP_TYPE_LBL[s.stepType] || s.stepType);
    const oc  = OUT_CSS[s.outcome]  || 'ob-won';
    const ol  = outcomeLabel(s.outcome, s.missType);
    const caCls = s.isCA ? ' ca-step' : '';

    let players = '';
    let vals    = '';
    switch (s.stepType) {
      case 'START_PASS': case 'PB_PASS': case 'SP_PASS': case 'FK_PASS':
        players = `${nm(s.from, opp.minute)} <span class="p-arr">→</span> ${nm(s.to, opp.minute)}`;
        vals = [
          lv('Pass', v.pass),
          s.passHeight==='high' ? '<span class="flag-hi">high</span>' : null,
          (s.passType && s.passType!=='normal') ? `<span class="flag-pt">${s.passType}</span>` : null,
        ].filter(Boolean).join(' ');
        break;
      case 'MID_DUEL': case 'PB_DUEL': case 'SP_DUEL': case 'FK_DUEL':
        players = `${nm(s.attacker, opp.minute)} <span class="p-vs">vs</span> ${nm(s.defender, opp.minute)}`;
        vals = [
          lv('Rec',  v.reception),
          lv('Ast',  v.assistance),
          lv('Tack', v.tackle),
          s.fouler     ? `<span class="flag-foul">foul ${escapeHtml(s.fouler.name?.split(' ').pop())}</span>` : null,
          s.yellowCard ? `<span class="flag-yc">YC ${escapeHtml(s.yellowCard.name?.split(' ').pop())}</span>` : null,
        ].filter(Boolean).join('  ');
        break;
      case 'DRIB':
        players = `${nm(s.dribbler, opp.minute)} <span class="p-vs">dribbles</span> ${nm(s.defender, opp.minute)}`;
        vals = [
          lv('Rec',  v.reception),
          lv('Ast',  v.assistance),
          lv('Tack', v.tackle),
        ].filter(Boolean).join('  ');
        break;
      case 'SHOT': case 'FK_SHOT':
        players = `${nm(s.shooter, opp.minute)} <span class="p-vs">vs</span> ${nm(s.gk, opp.minute)}`;
        vals = [
          // These describe the shot itself (type/angle/situation), so they come before
          // Sh/Sa — trailing after Sa read as if they described the save instead.
          (s.shotType && s.shotType !== 'goal') ? `<span class="flag-pt">${s.shotType}</span>` : null,
          s.shotAngle  ? '<span class="flag-warn">weak angle</span>' : null,
          s.oneOnOne   ? '<span class="flag-warn">1v1</span>'        : null,
          s.isLongShot ? '<span class="flag-pt">long</span>'         : null,
          lv('Sh', v.shot),
          lv('Sa', v.gkSave),
        ].filter(Boolean).join('  ');
        break;
    }

    return `<tr class="step-tr${caCls}">
      <td><span class="stype ${cls}">${lbl}</span></td>
      <td style="padding-left:6px">${players}</td>
      <td style="padding-left:8px">${vals}</td>
      <td style="text-align:right;white-space:nowrap">${ol?`<span class="out-badge ${oc}">${ol}</span>`:''}</td>
    </tr>`;
  });
  return `<table class="step-table">${rows.join('')}</table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TACTICAL EVENTS  — substitutions, position/mentality/style changes, half time
// ─────────────────────────────────────────────────────────────────────────────
const TACTICAL_KINDS = new Set(['SUBSTITUTION','POSITION_CHANGE','MENTALITY_CHANGE','STYLE_CHANGE','PREFERRED_SIDE_CHANGE','ISOLATE','HALF_TIME','EXTRA_TIME_BREAK']);

function lastName(p) { return escapeHtml(p?.name?.split(' ').pop()) || '?'; }

// Mentality and Style orders directly shift a team's opportunity volume (manual: Very
// Attacking +20%, Short Passes -2 opportunities, etc.) — comparing the opportunity rate
// and shot conversion in a window before vs. after the change is a cheap way to see
// whether the order actually moved anything, rather than just logging that it happened.
const TACTICAL_IMPACT_WINDOW = 15; // minutes each side
function tacticalImpact(ev) {
  if (!ev.teamSide || ev.minute == null || !_match?.opportunities) return null;
  const lo = Math.max(0, ev.minute - TACTICAL_IMPACT_WINDOW);
  const hi = Math.min(90, ev.minute + TACTICAL_IMPACT_WINDOW);
  const beforeMins = ev.minute - lo, afterMins = hi - ev.minute;
  if (beforeMins < 3 || afterMins < 3) return null; // too close to kickoff/final whistle to mean anything

  const of = (fromMin, toMin) => _match.opportunities.filter(o =>
    o.teamSide === ev.teamSide && o.minute >= fromMin && o.minute < toMin);
  const before = of(lo, ev.minute), after = of(ev.minute, hi);
  const rate = (arr, mins) => (arr.length / mins * TACTICAL_IMPACT_WINDOW).toFixed(1);
  const shotPct = arr => arr.length ? Math.round(arr.filter(o => o.hasShot).length / arr.length * 100) : null;

  return {
    beforeRate: rate(before, beforeMins), afterRate: rate(after, afterMins),
    beforeShotPct: shotPct(before), afterShotPct: shotPct(after),
  };
}

function impactTag(ev) {
  const imp = tacticalImpact(ev);
  if (!imp) return '';
  return ` <span class="tac-impact">opp/15m ${imp.beforeRate}→${imp.afterRate} · shots ${imp.beforeShotPct??'–'}%→${imp.afterShotPct??'–'}%</span>`;
}

function renderTacticalRow(ev) {
  if (ev.type === 'HALF_TIME') return `<div class="tac-half">— HALF TIME —</div>`;
  if (ev.type === 'EXTRA_TIME_BREAK') {
    const label = ev.period === 'halfway' ? 'END OF FIRST EXTRA TIME' : 'EXTRA TIME';
    return `<div class="tac-half">— ${label} —</div>`;
  }

  // ISOLATE carries issuingTeam instead of team, so parseMatch never resolves its teamSide.
  let side = ev.teamSide;
  if (!side && ev.issuingTeam && _match?.meta) {
    side = ev.issuingTeam === _match.meta.homeTeam ? 'home'
         : ev.issuingTeam === _match.meta.awayTeam ? 'away' : null;
  }
  const col = side === 'home' ? HC : side === 'away' ? AC : '#8a9ab0';
  let icon = '•', text = '';
  switch (ev.type) {
    case 'SUBSTITUTION':
      icon = '⇄';
      text = `${lastName(ev.playerOut)} <span class="p-arr">→</span> ${lastName(ev.playerIn)} <span class="p-pos">[${escapeHtml(ev.playerIn?.position)||'?'}]</span>`;
      break;
    case 'POSITION_CHANGE':
      icon = '↕';
      text = `${lastName(ev.player)} <span class="p-pos">[${escapeHtml(ev.player?.position)||'?'}]</span> <span class="p-arr">→</span> <span class="p-pos">[${escapeHtml(ev.toPosition)}]</span>`;
      break;
    case 'MENTALITY_CHANGE':
      icon = '⚙';
      text = `Mentality <span class="p-arr">→</span> ${escapeHtml(ev.mentality)}${impactTag(ev)}`;
      break;
    case 'STYLE_CHANGE':
      icon = '⚙';
      text = `Style of Play <span class="p-arr">→</span> ${escapeHtml(ev.style)}${impactTag(ev)}`;
      break;
    case 'ISOLATE':
      icon = '🎯';
      text = `Isolate ${lastName(ev.target)} <span class="p-pos">[${escapeHtml(ev.target?.position)||'?'}]</span>`;
      break;
    case 'PREFERRED_SIDE_CHANGE':
      icon = '⚙';
      text = `Preferred side <span class="p-arr">→</span> ${escapeHtml(ev.preferredSide)}${impactTag(ev)}`;
      break;
  }
  return `<div class="tac-row" style="border-left-color:${col}">
    <span class="tac-min">${ev.minute!=null ? ev.minute+"'" : ''}</span>
    <span class="tac-icon" style="color:${col}">${icon}</span>
    <span class="tac-text">${text}</span>
  </div>`;
}

function buildTimeline(match) {
  const items = [];
  // idx always indexes into the full, unfiltered match.opportunities array — hover/click
  // handlers elsewhere resolve rows via that original index, so filtering must never
  // renumber it.
  (match.opportunities || []).forEach((opp, idx) => {
    if (_teamFilter !== 'both' && opp.teamSide !== _teamFilter) return;
    items.push({ kind:'opp', minute: opp.minute ?? 0, opp, idx });
  });
  (match.tacticalEvents || []).filter(ev => TACTICAL_KINDS.has(ev.type))
    .filter(ev => _teamFilter === 'both' || !ev.teamSide || ev.teamSide === _teamFilter)
    .forEach(ev => items.push({ kind:'tactical', minute: ev.minute ?? 0, ev }));
  // Tactical events for a minute are shown just before that minute's opportunities.
  items.sort((a, b) => (a.minute - b.minute) || (a.kind === 'tactical' ? -1 : 1));
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH TIMELINE  — horizontal 0-90' summary above the opportunity list
// ─────────────────────────────────────────────────────────────────────────────
const TL_W = 1000, TL_H = 60, TL_PAD = 16, TL_AXIS_Y = 30;
// FinalWhistle's narrative only ever emits a plain integer minute ("Minute 34") — parser.js
// has no stoppage-time token (e.g. "45+2") anywhere in its output, opp.minute is always a
// bare int. There's nothing to place near the end of a half beyond the clamp below; if the
// parser ever starts exposing stoppage minutes, this is the one spot that would need to change.
function tlClampMinute(m) { return Math.max(0, Math.min(90, m ?? 0)); }
function tlX(minute) { return TL_PAD + (tlClampMinute(minute) / 90) * (TL_W - TL_PAD * 2); }

const TL_SET_PIECE_STEPS = new Set(['SP_PASS', 'SP_DUEL', 'FK_PASS', 'FK_DUEL', 'FK_SHOT']);
function isSetPieceOpp(opp) {
  return opp.steps.some(s => s.isPenalty || TL_SET_PIECE_STEPS.has(s.stepType));
}

// Half-time score, read straight off already-annotated opportunities (opp.scoreAfter is
// the running score computed by parser.js's annotateScores) — not re-derived from raw
// narrative. Only shown once a HALF_TIME tactical event has actually been seen, so a match
// that hasn't reached the break yet doesn't get a premature/misleading score label.
function htScoreLabel(match) {
  const hadHalfTime = (match.tacticalEvents || []).some(ev => ev.type === 'HALF_TIME');
  if (!hadHalfTime) return null;
  const firstHalf = (match.opportunities || []).filter(o => o.minute != null && o.minute <= 45);
  const score = firstHalf.length ? firstHalf[firstHalf.length - 1].scoreAfter : { home: 0, away: 0 };
  return score ? `HT ${score.home}–${score.away}` : null;
}

// Multiple opportunities can land within a few minutes (or the same minute) of each other —
// stagger their Y position in small deterministic steps so markers stay individually
// clickable instead of stacking exactly on top of one another. This is simple proximity
// clustering by X order, not real collision detection: whenever the gap to the previous
// marker is smaller than one lane-width, it's treated as part of the same cluster and
// pushed to the next stagger lane (alternating above/below the axis).
const TL_LANE_GAP = 20;  // min X gap (svg units) before two markers are considered stacked
const TL_LANE_STEP = 7;  // vertical offset per stagger lane
function tlAssignLanes(markers) {
  const sorted = [...markers].sort((a, b) => a.x - b.x);
  let clusterX = -Infinity, lane = 0;
  sorted.forEach(m => {
    lane = (m.x - clusterX > TL_LANE_GAP) ? 0 : lane + 1;
    clusterX = m.x;
    m.y = TL_AXIS_Y + (lane === 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2) * TL_LANE_STEP);
  });
  return markers;
}

function renderMatchTimeline(match) {
  const markers = (match.opportunities || [])
    .map((opp, idx) => ({ opp, idx }))
    .filter(({ opp }) => _teamFilter === 'both' || opp.teamSide === _teamFilter)
    .map(({ opp, idx }) => ({
      opp, idx, x: tlX(opp.minute),
      col: opp.teamSide === 'home' ? HC : AC,
      r: opp.hasGoal ? 7 : opp.hasShot ? 4 : 3,
      setPiece: isSetPieceOpp(opp),
    }));
  tlAssignLanes(markers);

  const s = [];
  s.push(`<line x1="${TL_PAD}" y1="${TL_AXIS_Y}" x2="${TL_W - TL_PAD}" y2="${TL_AXIS_Y}" stroke="#1e2c47" stroke-width="2"/>`);

  // Half-time divider
  const htX = tlX(45);
  s.push(`<line x1="${htX}" y1="6" x2="${htX}" y2="${TL_H - 10}" stroke="#3a4a6a" stroke-width="1.5" stroke-dasharray="3,3"/>`);
  const ht = htScoreLabel(match);
  if (ht) s.push(`<text x="${htX}" y="10" text-anchor="middle" font-size="9" fill="#8a9ab0" font-family="monospace">${escapeHtml(ht)}</text>`);

  // Minute labels
  s.push(`<text x="${TL_PAD}" y="${TL_H - 2}" text-anchor="start" font-size="10" fill="#5a6f8c" font-family="monospace">0'</text>`);
  s.push(`<text x="${TL_W / 2}" y="${TL_H - 2}" text-anchor="middle" font-size="10" fill="#5a6f8c" font-family="monospace">45'</text>`);
  s.push(`<text x="${TL_W - TL_PAD}" y="${TL_H - 2}" text-anchor="end" font-size="10" fill="#5a6f8c" font-family="monospace">90'</text>`);

  // Markers — plain markers first, goals last, so a goal always paints on top of a
  // same-minute non-goal marker instead of risking being hidden underneath it.
  const plain = markers.filter(m => !m.opp.hasGoal);
  const goals = markers.filter(m => m.opp.hasGoal);
  [...plain, ...goals].forEach(m => {
    const { opp, idx, x, y, col, r, setPiece } = m;
    const fill = opp.hasGoal ? GOLD : col;
    const outLbl = outcomeLabel(opp.finalOutcome, opp.finalMissType).toUpperCase();
    const teamName = opp.teamSide === 'home' ? (match.meta?.homeTeam || 'Home') : (match.meta?.awayTeam || 'Away');
    const tip = `${opp.minute}' · ${teamName} · ${outLbl}`;
    // Goals get a pulsing halo plus a ⚽ glyph on the dot itself (the same convention
    // already used for a goal on the pitch's GK node) — size/color alone reads as "just a
    // bigger dot" in a dense timeline; the ball makes it unmistakable at a glance.
    const glow = opp.hasGoal
      ? `<circle class="tl-goal-glow" cx="${x}" cy="${y}" r="${r + 5}" fill="${GOLD}" opacity=".3"/>`
      : '';
    const ring = setPiece ? `<circle cx="${x}" cy="${y}" r="${r + 2.5}" fill="none" stroke="${fill}" stroke-width="1" opacity=".45"/>` : '';
    const ballGlyph = opp.hasGoal
      ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${r + 3}">⚽</text>`
      : '';
    // A transparent oversized circle enlarges the click/hover target beyond the visible
    // dot without changing how big the marker actually looks.
    s.push(`<g class="tl-marker${opp.hasGoal ? ' tl-goal' : ''}" data-idx="${idx}">
      ${glow}${ring}
      <circle cx="${x}" cy="${y}" r="${r + 5}" fill="transparent"/>
      <circle class="tl-dot" cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity=".9"/>
      ${ballGlyph}
      <title>${escapeHtml(tip)}</title>
    </g>`);
  });

  return `<svg viewBox="0 0 ${TL_W} ${TL_H}" preserveAspectRatio="none" class="timeline-svg">${s.join('')}</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPPORTUNITY LIST RENDERING
// ─────────────────────────────────────────────────────────────────────────────
const OUT_COL = {
  GOAL: GOLD, POST:'#d4954a', SAVED:'#999', FUMBLED:'#e0895a', MISSED:'#d4954a',
  GK_INTERCEPT:'#d4a850', BLOCKED:'#8a6acd', SHOT_BLOCKED:'#8a6acd', CORNER:'#4a8acd',
  FOUL:'#c8902a', CLEARED:'#8a9ab0', POSSESSION:'#8a9ab0', WON:'#8a9ab0',
};

function renderOppList(match) {
  const items = buildTimeline(match);
  let html = '';
  items.forEach(item => {
    if (item.kind === 'tactical') { html += renderTacticalRow(item.ev); return; }

    const { opp, idx } = item;
    const isHome = opp.teamSide === 'home';
    const col    = isHome ? HC : AC;
    const isGoal = opp.hasGoal;
    const c      = stepsToChain(opp);

    const startCls = opp.isLongBallSequence          ? 'st-long'
                   : opp.startType === 'GK'  ? 'st-gk'
                   : opp.startType === 'MID' ? 'st-mid'
                   : opp.isCounterAttack     ? 'st-ca'
                   : 'st-def';
    const startLbl = opp.isLongBallSequence ? 'LONG' : (opp.startType || '?');

    const outCol = OUT_COL[opp.finalOutcome] || '#8a9ab0';
    const isPenalty = opp.steps.some(s => s.isPenalty);
    const outLbl = outcomeLabel(opp.finalOutcome, opp.finalMissType) + (isPenalty ? ' (pen)' : '');

    html += `<div class="opp-row ${isHome?'home':'away'}${isGoal?' goal-row':''}"
                 data-idx="${idx}">
      <span class="opp-min" style="color:${isGoal?GOLD:col}">${opp.minute}'</span>
      ${renderMiniChain(opp)}
      <span class="opp-start ${startCls}">${startLbl}</span>
      <span style="font-size:12px;font-weight:600;color:${outCol};min-width:64px">${outLbl}</span>
      <span class="opp-score${isGoal?' changed':''}">${opp.scoreAfter.home}–${opp.scoreAfter.away}</span>
    </div>
    <div class="step-block" id="steps-${idx}">${renderStepDetail(opp)}</div>`;
  });
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS PANEL
// ─────────────────────────────────────────────────────────────────────────────
function statBarRow(label, homeDisplay, awayDisplay, hv, av) {
  const tot = hv + av || 1, hpct = Math.round(hv / tot * 100);
  // label/homeDisplay/awayDisplay are sometimes raw cells straight from the site's own
  // stats table (renderGroupedStats) — escape unconditionally rather than trusting every
  // caller to have already sanitized internally-derived text too.
  label = escapeHtml(label); homeDisplay = escapeHtml(homeDisplay); awayDisplay = escapeHtml(awayDisplay);
  return `<div style="margin-bottom:7px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
      <span style="font-size:12px;font-weight:700;color:${HC}">${homeDisplay}</span>
      <span style="font-size:12px;color:#8a9ab0;text-transform:uppercase;letter-spacing:1px">${label}</span>
      <span style="font-size:12px;font-weight:700;color:${AC}">${awayDisplay}</span>
    </div>
    <div style="display:flex;height:3px;border-radius:2px;overflow:hidden;background:#0a1525">
      <div style="width:${hpct}%;background:${HC};opacity:.7"></div>
      <div style="flex:1;background:${AC};opacity:.7"></div>
    </div>
  </div>`;
}

// Player Orders (shot types) and Player Orders (pass types) are named, distinct
// mechanics per the manual — e.g. quick/power/heading/lob shot each have their own
// miss/rebound trade-offs, and safe/risky/deflect pass each have their own block-chance
// trade-offs. Aggregating what actually got used tells you if the configured orders are
// firing as expected, not just what the raw pass/shot quality numbers were.
function classifyShotType(s) {
  if (s.isPenalty)  return 'penalty';
  if (s.isLongShot) return 'long shot';
  return (s.shotType || 'normal').toLowerCase();
}
function classifyPassType(s) {
  return (s.passType || 'normal').toLowerCase();
}
function buildTypeCounts(opportunities, stepTypes, classify) {
  const counts = { home: {}, away: {} };
  opportunities.forEach(opp => {
    opp.steps.forEach(s => {
      if (!stepTypes.includes(s.stepType)) return;
      const key = classify(s);
      if (!key) return;
      // The step's own attackingSide, not opp.teamSide — a counter-attack flips who's
      // actually attacking partway through the opportunity, so the opportunity's nominal
      // starting side is wrong for any step after that boundary.
      const side = s.attackingSide || opp.teamSide;
      counts[side][key] = (counts[side][key] || 0) + 1;
    });
  });
  return counts;
}
function renderTypeDistribution(title, counts) {
  const keys = [...new Set([...Object.keys(counts.home), ...Object.keys(counts.away)])]
    .sort((a, b) => ((counts.home[b]||0)+(counts.away[b]||0)) - ((counts.home[a]||0)+(counts.away[a]||0)));
  if (!keys.length) return '';
  let html = `<div class="dist-title">${title}</div>`;
  keys.forEach(k => {
    const hv = counts.home[k] || 0, av = counts.away[k] || 0;
    html += statBarRow(k, hv, av, hv, av);
  });
  return html;
}
// isLongBallSequence describes the opportunity's own structural start (a back/wing-back
// delivering straight into the box), which is unambiguous and always belongs to
// opp.teamSide — a counter-attack can't happen on the very first step, so that part isn't
// affected by the attribution bug the shot/goal counts below are guarding against.
function computeLongBallStats(opportunities) {
  const home = opportunities.filter(o => o.teamSide === 'home' && o.isLongBallSequence);
  const away = opportunities.filter(o => o.teamSide === 'away' && o.isLongBallSequence);
  // A shot/goal only counts toward "→ shot"/"→ goal" if it belongs to the SAME side
  // that played the long ball. If the sequence turned into a counter-attack and the
  // opponent shot or scored instead, that's a long ball that was lost, not one that
  // produced a shot — opp.hasShot/opp.hasGoal alone can't tell the difference.
  const hasOwnShot = o => o.steps.some(s =>
    (s.stepType === 'SHOT' || s.stepType === 'FK_SHOT') && (s.attackingSide || o.teamSide) === o.teamSide);
  const hasOwnGoal = o => o.steps.some(s =>
    s.outcome === 'GOAL' && (s.attackingSide || o.teamSide) === o.teamSide);
  const shots = arr => arr.filter(hasOwnShot).length;
  const goals = arr => arr.filter(hasOwnGoal).length;
  return {
    home: { attempted: home.length, shots: shots(home), goals: goals(home) },
    away: { attempted: away.length, shots: shots(away), goals: goals(away) },
  };
}
function renderLongBallSummary(opportunities) {
  const s = computeLongBallStats(opportunities);
  if (!s.home.attempted && !s.away.attempted) return '';
  let html = `<div class="dist-title">Long Balls</div>`;
  html += statBarRow('attempted', s.home.attempted, s.away.attempted, s.home.attempted, s.away.attempted);
  html += statBarRow('→ shot', s.home.shots, s.away.shots, s.home.shots, s.away.shots);
  if (s.home.goals || s.away.goals)
    html += statBarRow('→ goal', s.home.goals, s.away.goals, s.home.goals, s.away.goals);
  return html;
}

// ── Delivery to forwards ─────────────────────────────────────────────────────────
// The site's own "Ball Left/Center/Right" stat is a general zone-of-play tally across
// every player — it doesn't say anything specific about how the FW himself gets fed.
// Built directly instead: every pass step whose receiver plays FW, grouped by the lane
// the pass came FROM (using the same LANE_MAP the pitch view already uses) and by
// whether it was a high or low ball.
const PASS_STEP_TYPES_FOR_STATS = ['START_PASS','PB_PASS','SP_PASS','FK_PASS'];
function buildFWDelivery(opportunities) {
  const laneCounts = { home: {}, away: {} };
  const heightCounts = { home: {}, away: {} };
  opportunities.forEach(opp => {
    opp.steps.forEach(s => {
      if (!PASS_STEP_TYPES_FOR_STATS.includes(s.stepType) || s.to?.position !== 'FW') return;
      // Same fix as buildTypeCounts — attribute by the pass step's own side, which can
      // differ from opp.teamSide once a counter-attack has flipped the attacking team.
      const side = s.attackingSide || opp.teamSide;
      const fromLane = lane(s.from?.position);
      laneCounts[side][fromLane] = (laneCounts[side][fromLane] || 0) + 1;
      const h = s.passHeight === 'high' ? 'high' : 'low';
      heightCounts[side][h] = (heightCounts[side][h] || 0) + 1;
    });
  });
  return { laneCounts, heightCounts };
}
function renderFWDelivery(opportunities) {
  const { laneCounts, heightCounts } = buildFWDelivery(opportunities);
  const total = ['home','away'].reduce((n, side) =>
    n + Object.values(laneCounts[side]).reduce((a, b) => a + b, 0), 0);
  if (!total) return '';
  let html = `<div class="dist-title">Delivery to Forwards</div>`;
  html += `<div class="qt-hint">Every pass received by an FW, by the lane it came from and whether it was a high or low ball.</div>`;
  ['left','center','right'].forEach(l => {
    const hv = laneCounts.home[l] || 0, av = laneCounts.away[l] || 0;
    if (hv || av) html += statBarRow(`from ${l}`, hv, av, hv, av);
  });
  ['low','high'].forEach(h => {
    const hv = heightCounts.home[h] || 0, av = heightCounts.away[h] || 0;
    if (hv || av) html += statBarRow(`${h} ball`, hv, av, hv, av);
  });
  return html;
}

// ── Execution quality scatter + chain pressure ────────────────────────────────────
// The old single "chain total" metric silently summed attacker-side and defender-side
// numbers together — e.g. a brilliant TACKLE (good for the defense) counted the exact
// same direction as a brilliant PASS (good for the attack), so a high "total" could mean
// either side dominated. That's why it didn't say anything legible about good/bad or
// offense/defense. Split by who the value actually belongs to instead:
//   offense: pass, reception, shot   — the attacking side's own execution
//   defense: assistance, tackle, gkSave — the defending side's resistance (assistance is
//     the defender's support per the manual/narrative: "X got assistance, and was close"
//     describes the DEFENDER's positioning, not the attacker's)
// A second bug beyond attribution: this used to be a SUM across every step in the chain,
// so a longer chain scored higher even at identical per-action execution — a 3-action
// chain averaging 67 and a 5-action chain averaging 64 would plot as if the 5-action one
// were dramatically stronger, purely because it had more actions to add up. Averaging
// instead of summing removes that length bias; the sum is still meaningful on its own
// terms (more sustained buildup IS more pressure applied, not better execution) so it's
// kept as a separate, explicitly-labeled stat below instead of being conflated with
// quality in the same number.
const OFFENSE_KEYS = ['pass', 'reception', 'shot'];
const DEFENSE_KEYS = ['assistance', 'tackle', 'gkSave'];
function sumStepValues(steps, keys) {
  let total = 0, count = 0;
  steps.forEach(s => {
    const v = s.values || {};
    keys.forEach(k => { if (v[k]?.value != null) { total += v[k].value; count++; } });
  });
  return { total, count };
}
// The side a chain's execution should be attributed to — whoever's step ended the
// sequence (the shot, or the last duel if it never reached one), not opp.teamSide, which
// names the wrong team for anything after a counter-attack boundary.
function terminalSideOf(opp) {
  const finalStep = opp.steps[opp.steps.length - 1];
  return finalStep?.attackingSide || opp.teamSide;
}
function renderQualityScatter(opportunities) {
  const pts = opportunities.map(o => {
    // Sum offense/defense only from steps on the terminal side — after a counter-attack,
    // the steps before the CA boundary belong to the OTHER team, and summing both sides'
    // values into one dot would mix two different teams' execution into a single number.
    const side = terminalSideOf(o);
    const sideSteps = o.steps.filter(s => (s.attackingSide || o.teamSide) === side);
    const offRes = sumStepValues(sideSteps, OFFENSE_KEYS), defRes = sumStepValues(sideSteps, DEFENSE_KEYS);
    return {
      off: offRes.count ? offRes.total / offRes.count : 0,
      def: defRes.count ? defRes.total / defRes.count : 0,
      goal: o.hasGoal, shot: o.hasShot, side,
    };
  });
  if (pts.length < 6) return '';

  const W = 320, H = 220, PL = 20, PR = 14, PT = 10, PB = 24;
  const maxOff = Math.max(10, ...pts.map(p => p.off));
  const maxDef = Math.max(10, ...pts.map(p => p.def));
  const x = v => PL + (v / maxOff) * (W - PL - PR);
  const y = v => (H - PB) - (v / maxDef) * (H - PB - PT);

  const s = [];
  // Faint gridlines at the midpoint of each axis, so a dot's quadrant reads at a glance.
  s.push(`<line x1="${x(maxOff/2)}" y1="${PT}" x2="${x(maxOff/2)}" y2="${H-PB}" stroke="#1a2540" stroke-width="1" stroke-dasharray="3,3"/>`);
  s.push(`<line x1="${PL}" y1="${y(maxDef/2)}" x2="${W-PR}" y2="${y(maxDef/2)}" stroke="#1a2540" stroke-width="1" stroke-dasharray="3,3"/>`);
  s.push(`<line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="#2a3a5a" stroke-width="1"/>`);
  s.push(`<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H-PB}" stroke="#2a3a5a" stroke-width="1"/>`);
  // Dots: gold+large = goal, mid opacity = reached a shot but no goal, faint+small = never
  // got a shot away — so "good" vs "bad" reads directly off size/brightness, not a legend.
  pts.forEach(p => {
    const col = p.goal ? GOLD : (p.side === 'home' ? HC : AC);
    const r   = p.goal ? 5 : p.shot ? 3.5 : 2.5;
    const op  = p.goal ? .95 : p.shot ? .55 : .28;
    s.push(`<circle cx="${x(p.off)}" cy="${y(p.def)}" r="${r}" fill="${col}" opacity="${op}"/>`);
  });
  s.push(`<text x="${(PL+W-PR)/2}" y="${H-8}" text-anchor="middle" font-size="9" fill="#5a6f8c" font-family="monospace" letter-spacing="1">AVG OFFENSE (pass + reception + shot) →</text>`);
  s.push(`<text x="0" y="0" text-anchor="middle" font-size="9" fill="#5a6f8c" font-family="monospace" letter-spacing="1" transform="translate(11 ${(PT+H-PB)/2}) rotate(-90)">AVG DEFENSE (assist + tackle + save) →</text>`);

  return `<div class="dist-title">Execution Quality</div>
    <div class="qt-hint">One dot per opportunity. X/Y are the AVERAGE value per action on the attacking/defending
      side (not a total — a longer chain doesn't score higher here just for having more actions in it; see Chain
      Pressure below for the volume-of-buildup version of this). Gold = goal, bright = reached a shot, faint =
      didn't. If the theory holds, gold dots should cluster bottom-right — strong offense, weak defense.</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;background:#050b14;border-radius:6px;border:1px solid #1a2540">${s.join('')}</svg>`;
}

// "Pressure" = how much total attacking value a team's successful (shot-reaching)
// sequences generate, on average — deliberately NOT normalized by chain length the way
// Execution Quality above is, since a team sustaining a longer buildup before a shot IS
// applying more pressure, not executing better. The two metrics are answering different
// questions on purpose, and are now both available instead of the old single number that
// conflated them.
function renderChainPressure(opportunities) {
  const totals = { home: [], away: [] };
  opportunities.forEach(o => {
    if (!o.hasShot) return;
    const side = terminalSideOf(o);
    if (!totals[side]) return;
    const sideSteps = o.steps.filter(s => (s.attackingSide || o.teamSide) === side);
    totals[side].push(sumStepValues(sideSteps, OFFENSE_KEYS).total);
  });
  if (!totals.home.length && !totals.away.length) return '';
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const homeAvg = avg(totals.home), awayAvg = avg(totals.away);
  return `<div class="dist-title">Chain Pressure</div>
    <div class="qt-hint">Average TOTAL attacking value (summed across the whole chain, not averaged per action)
      among sequences that reached a shot — a volume-of-buildup signal, distinct from Execution Quality above.</div>
    ${statBarRow('avg. chain value', homeAvg, awayAvg, homeAvg, awayAvg)}`;
}

// The site's own stats table comes back as one flat, alphabetically-ish ordered dump —
// group it into a read that actually tells a story (territory → what came of it → how
// they moved the ball → how each side stopped the other → discipline) instead of a wall
// of unrelated rows. Matched case-insensitively since the exact casing is whatever the
// site's table happens to render, not something this extension controls.
const STAT_GROUPS = [
  { title: 'Territory & Flow', hint: 'Who controlled the ball and where the play happened.',
    keys: ['Ball Possession','Opportunities','Start Left','Start Center','Start Right','Ball Left','Ball Center','Ball Right'] },
  { title: 'Attacking Output', hint: 'What came of that territory.',
    keys: ['Goal Attempts','Goals','Long Shots','Corners','Counter Attacks'] },
  { title: 'Passing', hint: "How each side tried to move the ball forward." ,
    keys: ['High Pass','Low Pass'] },
  { title: 'Defensive Actions', hint: 'How each side stopped the other.',
    keys: ['Blocked','Interceptions','Fumbles','Ball Cleared Center','Ball Cleared Left','Ball Cleared Right','Trap Attempt','Trap Success','Offsides'] },
  { title: 'Discipline', hint: 'Fouls, cards, and the free kicks they gave away.',
    keys: ['Fouls','Cards','Free Kicks'] },
];
function renderGroupedStats(stats) {
  const used = new Set();
  let html = '';
  STAT_GROUPS.forEach(group => {
    const rowKeys = group.keys
      .map(k => Object.keys(stats).find(sk => sk.toLowerCase() === k.toLowerCase()))
      .filter(Boolean);
    if (!rowKeys.length) return;
    html += `<div class="dist-title">${group.title}</div><div class="qt-hint">${group.hint}</div>`;
    rowKeys.forEach(key => {
      used.add(key);
      const { home, away } = stats[key];
      html += statBarRow(key, home, away, parseFloat(home)||0, parseFloat(away)||0);
    });
  });
  // Anything the site reports that isn't in a known group still needs to be shown, not
  // silently dropped — the site's stat set can change without this list keeping up.
  const leftover = Object.keys(stats).filter(k => !used.has(k));
  if (leftover.length) {
    html += `<div class="dist-title">Other</div>`;
    leftover.forEach(key => {
      const { home, away } = stats[key];
      html += statBarRow(key, home, away, parseFloat(home)||0, parseFloat(away)||0);
    });
  }
  return html;
}

function renderPlayerStatisticsTeam(label, side, players) {
  if (!players.length) return '';
  const count = n => n ? escapeHtml(String(n)) : '<span class="zero">–</span>';
  const minutes = values => values?.length
    ? `<span class="minute">${values.map(n => `${escapeHtml(String(n))}'`).join(', ')}</span>`
    : '<span class="zero">–</span>';
  const rows = players.map(p => {
    const positions = (p.positions || []).join('/');
    const flags = [
      ...(p.yellowCards || []).map(n => `<span class="player-flag card" title="Yellow card at ${escapeHtml(String(n))}'">🟨 ${escapeHtml(String(n))}'</span>`),
      ...(p.injuries || []).map(injury => {
        const severity = injury.severity ? `${injury.severity[0]}${injury.severity.slice(1).toLowerCase()} ` : '';
        return `<span class="player-flag injury" title="${escapeHtml(severity)}injury at ${escapeHtml(String(injury.minute))}'">🩹 ${escapeHtml(severity)}${escapeHtml(String(injury.minute))}'</span>`;
      }),
    ].join('');
    return `<tr>
    <td class="${p.replacedPlayer ? 'player-substitute' : ''}" title="${escapeHtml(p.name)}${p.replacedPlayer ? ` replaced ${escapeHtml(p.replacedPlayer)} at ${escapeHtml(String(p.substitutedInMinute))}'` : ''}">${p.replacedPlayer ? '<span class="sub-arrow">↳</span>' : ''}${escapeHtml(p.name)}${positions ? ` <span class="player-position">[${escapeHtml(positions)}]</span>` : ''}${p.substitutedInMinute != null ? ` <span class="sub-minute">${escapeHtml(String(p.substitutedInMinute))}'</span>` : ''}${flags ? ` <span class="player-flags">${flags}</span>` : ''}</td>
    <td>${escapeHtml(String(p.minutesPlayed))}</td>
    <td>${count(p.shotsFaced)}</td><td>${count(p.saves)}</td><td>${count(p.interceptions)}</td><td>${count(p.blocks)}</td>
    <td>${count(p.tackles)}</td><td>${escapeHtml(String(p.passes))} (${escapeHtml(String(p.completedPasses))})</td>
    <td>${p.passCompletionPct == null ? '<span class="zero">–</span>' : `${escapeHtml(String(p.passCompletionPct))}%`}</td>
    <td>${count(p.assists)}</td><td>${count(p.shots)}</td><td>${count(p.shotsOnTarget)}</td><td>${count(p.goals)}</td><td>${count(p.fouls)}</td>
    <td>${minutes(p.tiredMinutes)}</td><td>${minutes(p.veryTiredMinutes)}</td>
  </tr>`;
  }).join('');
  return `<div class="player-stats-team ${side}"><span>${escapeHtml(label)}</span><span>${players.length} players observed</span></div>
    <div class="player-stats-scroll"><table class="player-stats-table">
      <thead><tr><th>Player</th><th title="Minutes played">Min</th>
        <th title="All parsed shots naming this goalkeeper">Shots faced</th><th>Saves</th><th title="Interceptions">Interceptions</th><th>Blocks</th><th>Tackles</th>
        <th title="Passes attempted, with completed passes in parentheses">Passes (completed)</th><th title="Completed passes divided by attempted passes">Pass %</th>
        <th>Assists</th><th>Shots</th><th title="Shots resulting in a goal, save, or goalkeeper fumble">On target</th><th>Goals</th><th>Fouls</th>
        <th title="First minute reported tired">Tired (min)</th>
        <th title="First minute reported very tired">Very tired (min)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function renderPlayerStatistics(match, homeTeam, awayTeam) {
  if (!match) return '';
  const data = playerStatistics(match);
  if (!data.home.length && !data.away.length && !data.unresolved.length) return '';
  let html = `<div class="player-stats"><div class="dist-title">Player Statistics</div>
    <div class="qt-hint">${escapeHtml(data.note)} Minutes are derived from observed substitutions over a ${data.matchMinutes}-minute match.</div>`;
  html += renderPlayerStatisticsTeam(homeTeam || match.meta?.homeTeam || 'Home', 'home', data.home);
  html += renderPlayerStatisticsTeam(awayTeam || match.meta?.awayTeam || 'Away', 'away', data.away);
  html += renderPlayerStatisticsTeam('Side unresolved', 'unknown', data.unresolved);
  return html + '</div>';
}

function renderStats(stats, homeTeam, awayTeam, opportunities, match = null) {
  let html = `<div style="padding:8px;overflow-y:auto;flex:1">`;
  html += renderPlayerStatistics(match, homeTeam, awayTeam);
  if (stats && Object.keys(stats).length) {
    html += renderGroupedStats(stats);
  } else {
    html += `<div class="no-data" style="padding:20px 0">No statistics.</div>`;
  }
  if (opportunities?.length) {
    html += renderTypeDistribution('Shot Types', buildTypeCounts(opportunities, ['SHOT','FK_SHOT'], classifyShotType));
    html += renderTypeDistribution('Pass Types', buildTypeCounts(opportunities, ['START_PASS','PB_PASS','SP_PASS','FK_PASS'], classifyPassType));
    html += renderLongBallSummary(opportunities);
    html += renderFWDelivery(opportunities);
    html += renderQualityScatter(opportunities);
    html += renderChainPressure(opportunities);
  }
  html += '</div>';
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// GAME PHASES  — opportunities/shots/goals by fixed 0-90' window. There is no longer a
// dedicated Phases tab for this (see the Tactics tab's own Tactical Phases section for the
// dynamic, material-change-triggered equivalent) — these fixed windows are kept only
// because the JPG export's full-view scope still uses computePhaseStats for its compact
// per-window table (see renderExportPhaseTable below). Like the rest of this file,
// phaseIndexOf clamps any minute above 90 into the last window, which silently folds
// extra-time opportunities into 70-90' rather than giving them their own bucket — a
// known, not-yet-addressed gap for a match that goes to extra time.
const GAME_PHASES = [
  { label: '0–30\'',  hi: 30 },
  { label: '30–45\'', hi: 45 },
  { label: '45–70\'', hi: 70 },
  { label: '70–90\'', hi: 90 },
];
function phaseIndexOf(minute) {
  // parser.js has no stoppage-time token — opp.minute is always a plain 0-90 int — but
  // clamp defensively anyway so a stray out-of-range value still lands in a bucket
  // instead of silently falling out of every phase's totals.
  const m = Math.max(0, Math.min(90, minute ?? 0));
  for (let i = 0; i < GAME_PHASES.length; i++) if (m < GAME_PHASES[i].hi) return i;
  return GAME_PHASES.length - 1; // minute === 90 belongs to the last window
}
function computePhaseStats(match) {
  const stats = GAME_PHASES.map(p => ({
    label: p.label,
    home: { opps: 0, shots: 0, goals: 0 },
    away: { opps: 0, shots: 0, goals: 0 },
  }));
  (match?.opportunities || []).forEach(opp => {
    const phase = stats[phaseIndexOf(opp.minute)];
    if (!phase) return;
    // The opportunity itself belongs to whichever team created it — that's a legitimate
    // "who generated this attacking chance" count regardless of how the sequence later
    // resolved, so opp.teamSide is correct here.
    phase[opp.teamSide].opps++;
    // A shot/goal, though, belongs to whoever actually took it — attribute per SHOT/
    // FK_SHOT step's own attackingSide rather than blindly crediting opp.teamSide, which
    // is wrong for any step recorded after a counter-attack boundary. This also means a
    // second shot within the same opportunity (a rebound) is counted correctly instead of
    // collapsing into one opp.hasShot/opp.hasGoal boolean.
    opp.steps.forEach(s => {
      if (s.stepType !== 'SHOT' && s.stepType !== 'FK_SHOT') return;
      const bucket = phase[s.attackingSide || opp.teamSide];
      if (!bucket) return;
      bucket.shots++;
      if (s.outcome === 'GOAL') bucket.goals++;
    });
  });
  return stats;
}
// ─────────────────────────────────────────────────────────────────────────────
// TACTICS  — main team tactics, tiredness, substitutions, and observed changes by team
// ─────────────────────────────────────────────────────────────────────────────
// Tiredness reports aren't single events the way a substitution is — the same player can
// be reported tired more than once over the match (tired at 40', very tired at 70') — so
// unlike the other three categories these are grouped per player, each showing their full
// sequence of reports, rather than listed as one flat chronological row per event.
function groupTirednessByPlayer(events) {
  const byPlayer = new Map();
  events.forEach(ev => {
    const key = ev.player?.name || '?';
    if (!byPlayer.has(key)) byPlayer.set(key, { player: ev.player, entries: [] });
    byPlayer.get(key).entries.push({ minute: ev.minute, level: ev.level });
  });
  const groups = [...byPlayer.values()];
  groups.forEach(g => g.entries.sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0)));
  groups.sort((a, b) => (a.entries[0]?.minute ?? 0) - (b.entries[0]?.minute ?? 0));
  return groups;
}
function renderTirednessGroup(g, col) {
  // Same 😴/🫩 convention statusDetail() already uses for the tired/very-tired badge
  // shown next to a player's name elsewhere in the app.
  const badges = g.entries.map(e => {
    const icon = e.level === 'VERY_TIRED' ? '😴' : '🫩';
    return `<span class="tac-impact">${icon}${e.minute != null ? ' ' + e.minute + "'" : ''}</span>`;
  }).join(' ');
  return `<div class="tac-row" style="border-left-color:${col}">
    <span class="tac-text"><span class="p-nm" style="color:${col}">${lastName(g.player)}</span> <span class="p-pos">[${escapeHtml(g.player?.position) || '?'}]</span></span>
    <span style="margin-left:auto;white-space:nowrap">${badges}</span>
  </div>`;
}

// ── Tactical Phases ───────────────────────────────────────────────────────────────────
// A compact timeline answering "when did this team's configuration change, and what
// changed": one card per dynamic tactical phase (parser.js's buildTacticalPhases —
// starts a new phase only on a material change, never on an opportunity/shot/score/
// tiredness alone). Shown first in the Tactics tab, before its supporting event lists.
// This is distinct from GAME_PHASES' fixed 0–30/30–45/45–70/70–90 windows above
// (computational only now, no longer its own tab — see that section's own comment):
// these are dynamic,
// material-change-triggered phases, not fixed clock windows.
// Only fields parser.js actually populated are shown; a setting still genuinely
// unpopulated (offside, player orders, aggression, arrows — none of these are exposed by
// any narrative construct this parser currently recognizes, see parser.js's
// tactical-construct audit comment) renders as "—", never guessed or filled in.
// The five Manual-defined main team tactics are always shown, including unknown values.
// mentality/style/preferredSide can differ phase to phase because the report exposes
// change events for them. Marking/defenceFocus currently only come from the match page's
// pre-match summary, because no confirmed change wording has been observed for them.
function renderTacticalPhaseRow(phase, col) {
  const period = phase.endMinute != null ? `${phase.startMinute}–${phase.endMinute}'` : `${phase.startMinute}'+`;
  const ts = phase.state.teamState;
  const tacticRows = [
    ['Mentality', ts.mentality],
    ['Style of Play', ts.style],
    ['Marking', ts.marking],
    ['Defence Focus', ts.defenceFocus],
    ['Preferred Side', ts.preferredSide],
  ].map(([label, value]) =>
    `<span><b>${label}:</b> ${escapeHtml(value || '—')}</span>`).join('');
  const changes = phase.triggeredBy.length
    ? phase.triggeredBy.map(renderTacticalRow).join('')
    : '<div class="qt-hint">Initial state — no tactical changes observed yet.</div>';
  return `<div style="margin-bottom:8px;padding:6px 8px;border-left:2px solid ${col};background:#0d1526">
    <div style="font-size:11px;color:${col};font-weight:700">${escapeHtml(period)}</div>
    <div class="tactic-values" style="margin:4px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:3px 10px;font-size:10px;color:#8fa8c8">${tacticRows}</div>
    ${changes}
  </div>`;
}

function renderTacticalPhasesSection(match, side, col) {
  const phases = match.tacticalPhases?.[side] || [];
  if (!phases.length) return '';
  return `<div class="dist-title">Tactical Phases (${phases.length})</div>` +
    phases.map(p => renderTacticalPhaseRow(p, col)).join('');
}

function renderSquadColumn(match, side) {
  const events = (match.tacticalEvents || []).filter(ev => ev.teamSide === side);
  const byMinute = (a, b) => (a.minute ?? 0) - (b.minute ?? 0);

  const tiredness   = groupTirednessByPlayer(events.filter(ev => ev.type === 'TIREDNESS'));
  const subs        = events.filter(ev => ev.type === 'SUBSTITUTION').sort(byMinute);
  const posChanges  = events.filter(ev => ev.type === 'POSITION_CHANGE').sort(byMinute);
  const tacticChanges = events.filter(ev =>
    ev.type === 'MENTALITY_CHANGE' || ev.type === 'STYLE_CHANGE' || ev.type === 'PREFERRED_SIDE_CHANGE'
  ).sort(byMinute);

  const teamName = side === 'home' ? (match.meta?.homeTeam || 'Home') : (match.meta?.awayTeam || 'Away');
  const col = side === 'home' ? HC : AC;
  const section = (title, count, rowsHtml, emptyLabel) =>
    `<div class="dist-title">${escapeHtml(title)} (${count})</div>` +
    (count ? rowsHtml : `<div class="qt-hint">${emptyLabel}</div>`);

  let html = `<div style="flex:1;min-width:0">`;
  html += `<div class="ps-team" style="color:${col};border-color:${col}44">${escapeHtml(teamName)}</div>`;
  html += renderTacticalPhasesSection(match, side, col);
  html += section('Tiredness', tiredness.length, tiredness.map(g => renderTirednessGroup(g, col)).join(''), 'No tiredness reports.');
  html += section('Substitutions', subs.length, subs.map(renderTacticalRow).join(''), 'No substitutions.');
  html += section('Position Changes', posChanges.length, posChanges.map(renderTacticalRow).join(''), 'No position changes.');
  html += section('Tactic Changes', tacticChanges.length, tacticChanges.map(renderTacticalRow).join(''), 'No tactic changes observed.');
  html += `</div>`;
  return html;
}

function renderSquadTab(match) {
  if (!match?.tacticalEvents) return '<div class="no-data" style="padding:20px 0">No match data.</div>';
  return `<div style="padding:8px;overflow-y:auto;flex:1;display:flex;gap:16px">` +
    renderSquadColumn(match, 'home') + renderSquadColumn(match, 'away') +
    `</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS TAB
// ─────────────────────────────────────────────────────────────────────────────
// Pure rendering over analytics.js's plain data — no analysis logic lives here. Numbers
// and neutral deltas only: nowhere in this section does a "good tactic" / "successful
// change" verdict get attached to a comparison (analytics.js's own explicit constraint) —
// that judgment is left to the reader, not asserted by the UI.

function fmtDelta(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + n; }

// Takes the already-computed `perf` array and the index into it, rather than calling
// analytics.js's compareAdjacentPhases(match, side, phaseId) —
// that function independently re-runs phasePerformance() (which itself re-runs
// turnoverAnalysis() over every opportunity) from scratch on every call. Called once per
// phase card, that turned "compute phasePerformance for this side" into an O(phases)
// repeat of the same whole-match computation for no different result — the delta here is
// simple subtraction over two rows analytics.js already handed back once.
function renderPhaseComparisonCard(perfRow, prevPerfRow, col) {
  const period = perfRow.endMinute != null ? `${perfRow.startMinute}–${perfRow.endMinute}'` : `${perfRow.startMinute}'+`;
  const deltaLine = prevPerfRow
    ? `<div class="qt-hint">Δ vs previous phase: opportunities ${fmtDelta(perfRow.ownOpportunities - prevPerfRow.ownOpportunities)}, shots ${fmtDelta(perfRow.ownShots - prevPerfRow.ownShots)}, shots conceded ${fmtDelta(perfRow.opponentShots - prevPerfRow.opponentShots)}</div>`
    : '';
  const degradedTag = perfRow.confidence === 'degraded' ? ' · <span title="Telemetry alignment is degraded for part of this match">⚠ degraded</span>' : '';
  return `<div style="margin-bottom:8px;padding:6px 8px;border-left:2px solid ${col};background:#0d1526">
    <div style="font-size:11px;color:${col};font-weight:700">${escapeHtml(period)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px;margin:4px 0">
      <span>Opportunities: <b>${perfRow.ownOpportunities}</b> / ${perfRow.opponentOpportunities}</span>
      <span>PB entries: <b>${perfRow.ownPBEntries}</b> / ${perfRow.opponentPBEntries}</span>
      <span>Shots: <b>${perfRow.ownShots}</b> / ${perfRow.opponentShots}</span>
      <span>Goals: <b>${perfRow.ownGoals}</b> / ${perfRow.opponentGoals}</span>
    </div>
    <div class="qt-hint">${perfRow.sampleSize} opportunit${perfRow.sampleSize===1?'y':'ies'} in this phase — ${perfRow.confidenceHint}${degradedTag}</div>
    ${deltaLine}
  </div>`;
}

function renderPhaseComparisonSection(match, side, col) {
  const perf = phasePerformance(match, side); // computed once, reused for every card below
  if (!perf.length) return '';
  return `<div class="dist-title">Tactical Phase Comparison (${perf.length})</div>` +
    `<div class="qt-hint">Own / Opponent counts per material tactical-state phase (see the Tactics tab for what changed at each boundary). The Δ line is a neutral numeric comparison against the previous phase, not a verdict on whether the change helped.</div>` +
    perf.map((p, i) => renderPhaseComparisonCard(p, i > 0 ? perf[i - 1] : null, col)).join('');
}

function renderFunnelSection(match) {
  const funnel = opportunityFunnel(match);
  const row = (label, home, away, homeTotal, awayTotal) => {
    const hp = homeTotal ? Math.round(home / homeTotal * 100) : 0;
    const ap = awayTotal ? Math.round(away / awayTotal * 100) : 0;
    return statBarRow(label, `${home} (${hp}%)`, `${away} (${ap}%)`, home, away);
  };
  let html = `<div class="dist-title">Opportunity Funnel</div>`;
  html += `<div class="qt-hint">Where each side's opportunities progressed to, using the step model directly (not narrative keyword guessing). Percentages are of that side's own total.</div>`;
  html += row('Total opportunities', funnel.home.total, funnel.away.total, funnel.home.total, funnel.away.total);
  html += row('Reached midfield duel', funnel.home.reachedMidfield, funnel.away.reachedMidfield, funnel.home.total, funnel.away.total);
  html += row('Reached penalty box', funnel.home.reachedPenaltyBox, funnel.away.reachedPenaltyBox, funnel.home.total, funnel.away.total);
  html += row('Shots', funnel.home.shots, funnel.away.shots, funnel.home.total, funnel.away.total);
  html += row('Goals', funnel.home.goals, funnel.away.goals, funnel.home.total, funnel.away.total);
  if (funnel.confidence === 'degraded')
    html += `<div class="qt-hint">⚠ Telemetry alignment is degraded for part of this match — counts above are exact (they come from narrative outcomes, not telemetry values).</div>`;
  return html;
}

function renderDefensiveBreakdownSection(match, side, col) {
  const chains = defensiveFailureChains(match).filter(c => c.defendingSide === side);
  const title = `<div class="dist-title">Defensive Breakdown — shots conceded (${chains.length})</div>`;
  if (!chains.length) return title + `<div class="qt-hint">No shots conceded.</div>`;
  const rows = chains.map(c => {
    // Same .opp-row + data-idx convention the Opportunities list and timeline already
    // use — reuses the existing hover/click pitch-highlight wiring (hoverOpp/clickOpp)
    // rather than duplicating any of the pitch rendering here.
    const idx = (match.opportunities || []).findIndex(o => o.sequence === c.sequence);
    const fail = c.firstFailedDefensiveStage;
    const failTxt = fail
      ? `${STEP_TYPE_LBL[fail.stepType] || fail.stepType} lost by ${lastName(fail.defender)}`
      : 'no preceding duel lost (set piece / direct shot)';
    const oc = OUT_COL[c.gkOutcome] || '#8a9ab0';
    const ol = outcomeLabel(c.gkOutcome, c.missType);
    return `<div class="opp-row ${side}" data-idx="${idx}">
      <span class="opp-min" style="color:${col}">${c.minute}'</span>
      <span style="font-size:11px;flex:1;padding:0 6px">${escapeHtml(failTxt)}</span>
      <span style="font-size:12px;font-weight:600;color:${oc}">${escapeHtml(ol)}</span>
    </div>`;
  }).join('');
  return title +
    `<div class="qt-hint">One row per opponent shot. "First failed defensive stage" is the earliest duel the attacker won outright (never a raw value comparison) — set pieces/direct shots with no preceding duel show none. Hover or click a row to highlight it on the pitch.</div>` +
    rows;
}

function renderAnalysisTab(match) {
  if (!match?.opportunities?.length) return '<div class="no-data" style="padding:20px 0">No match data.</div>';
  const homeName = match.meta?.homeTeam || 'Home', awayName = match.meta?.awayTeam || 'Away';
  let html = `<div style="padding:8px;overflow-y:auto;flex:1">`;
  html += renderFunnelSection(match);
  html += `<div class="ps-team" style="color:${HC};border-color:${HC}44;margin-top:14px">${escapeHtml(homeName)}</div>`;
  html += renderPhaseComparisonSection(match, 'home', HC);
  html += renderDefensiveBreakdownSection(match, 'home', HC);
  html += `<div class="ps-team" style="color:${AC};border-color:${AC}44;margin-top:14px">${escapeHtml(awayName)}</div>`;
  html += renderPhaseComparisonSection(match, 'away', AC);
  html += renderDefensiveBreakdownSection(match, 'away', AC);
  html += `</div>`;
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN RENDER
// ─────────────────────────────────────────────────────────────────────────────
let _match       = null;
let _hFlowData   = null;
let _aFlowData   = null;
let _statusEvents = null; // sorted tacticalEvents used to resolve injury/tiredness at a given minute
let _teamFilter   = 'both'; // 'both' | 'home' | 'away' — which opportunities the list shows
// The raw scrape object (url/homeTeam/awayTeam/scrapedAt) render()'s own `scrape`
// parameter goes out of scope once render() returns — JPG export needs it later (for the
// filename and the export header), so it's kept here rather than re-threaded everywhere.
let _lastRenderedScrape = null;

// The pitch is a static shell of layered <g> groups, rebuilt only when what they show
// actually changes (a fresh scrape, or a Home/Away/Both filter switch — both go through
// buildBasePitch). Hovering an opportunity is by far the hottest interaction on this
// page (fires on every mouseover across the whole list) and only ever needs to touch
// #chain-highlight — it used to go through buildBasePitch too, meaning every hover
// destroyed and reparsed the pitch outline plus both flow networks (dozens of edges/
// nodes each) just to swap in one highlighted chain. setHighlight() below updates only
// the highlight layer and the flow layers' opacity, leaving the rest of the SVG alone.
function buildBasePitch() {
  const wrap = $('pitch-container');
  if (!wrap) return;
  // Respect the Home/Away/Both filter — showing the opponent's flow lines while only
  // their opportunities are hidden from the list would be misleading.
  const showHome = _teamFilter !== 'away';
  const showAway = _teamFilter !== 'home';
  const hFlow = (showHome && _hFlowData) ? renderBaseFlow(_hFlowData.edgeCounts, _hFlowData.nodeCounts, 'home') : '';
  const aFlow = (showAway && _aFlowData) ? renderBaseFlow(_aFlowData.edgeCounts, _aFlowData.nodeCounts, 'away') : '';
  // Set innerHTML on a plain div — browser correctly namespace-parses the SVG tag
  wrap.innerHTML = `<svg viewBox="0 0 500 820" xmlns="http://www.w3.org/2000/svg"
    style="height:100%;width:auto;max-width:100%;max-height:calc(100vh - 80px);display:block">
    <g id="pitch-outline">${renderPitchOutline()}</g>
    <g id="flow-home">${hFlow}</g>
    <g id="flow-away">${aFlow}</g>
    <g id="chain-highlight"></g>
  </svg>`;
}

function setHighlight(chainHtml, dim = false) {
  const highlight = $('chain-highlight');
  if (!highlight) return; // pitch not built yet — nothing to highlight
  highlight.innerHTML = chainHtml;
  // Aggregate match flow is useful with nothing selected, but the previous 15% opacity
  // still competed with long multi-stage chains. Reduce it to a near-watermark while
  // inspecting one opportunity so direction arrows and outcome nodes remain legible.
  const op = dim ? '0.04' : '1';
  const homeFlow = $('flow-home'), awayFlow = $('flow-away');
  if (homeFlow) homeFlow.style.opacity = op;
  if (awayFlow) awayFlow.style.opacity = op;
}
let _hoveredIdx  = null;

// Build a compact issue-ready report instead of copying the entire match narrative.
// The three surrounding lines on either side of each unknown line preserve the parser
// context needed to recognise new FinalWhistle wording without unnecessarily including
// every player/action in the match.
function narrativeContexts(narrative, unknownLines, radius = 3) {
  const sourceLines = String(narrative || '').split(/\r?\n/);
  let searchFrom = 0;
  return (unknownLines || []).map((entry, index) => {
    const target = String(entry?.line ?? entry).trim();
    let lineIndex = sourceLines.findIndex((line, i) => i >= searchFrom && line.trim() === target);
    if (lineIndex < 0) lineIndex = sourceLines.findIndex(line => line.trim() === target);
    if (lineIndex < 0) return { minute: entry?.minute ?? null, line: target, context: [] };
    searchFrom = lineIndex + 1;
    const start = Math.max(0, lineIndex - radius);
    const end = Math.min(sourceLines.length, lineIndex + radius + 1);
    return {
      minute: entry?.minute ?? null,
      line: target,
      context: sourceLines.slice(start, end).map((line, offset) => ({
        sourceLine: start + offset + 1,
        unrecognized: start + offset === lineIndex,
        text: line,
      })),
      occurrence: index + 1,
    };
  });
}

function buildDiagnosticReport(scrape = _lastRenderedScrape, match = _match) {
  const validation = match?.validation || {};
  const manifestVersion = ext?.runtime?.getManifest
    ? ext.runtime.getManifest().version : 'unknown';
  const scrapedDate = new Date(scrape?.scrapedAt);
  const scrapedAt = Number.isNaN(scrapedDate.getTime()) ? String(scrape?.scrapedAt || 'unknown') : scrapedDate.toISOString();
  const finalScore = match?.meta?.finalScore;
  const score = finalScore ? `${finalScore.home ?? '?'}-${finalScore.away ?? '?'}` : 'unknown';
  const unknownNarrative = validation.unknownNarrativeLines || [];
  const details = {
    extensionVersion: manifestVersion,
    matchUrl: scrape?.url || 'unknown',
    scrapedAt,
    homeTeam: match?.meta?.homeTeam || scrape?.homeTeam || 'unknown',
    awayTeam: match?.meta?.awayTeam || scrape?.awayTeam || 'unknown',
    finalScore: score,
    validationConfidence: validation.confidence || 'unknown',
    opportunityCounts: {
      narrative: validation.narrativeOpportunityCount ?? null,
      telemetry: validation.telemetryOpportunityCount ?? null,
      matched: validation.matchedBlocks?.length ?? null,
    },
  };
  const diagnostics = {
    scrapeErrors: scrape?.errors || [],
    scrapeWarnings: scrape?.warnings || [],
    parserWarnings: match?.warnings || [],
    unknownNarrativeLines: unknownNarrative,
    narrativeContexts: narrativeContexts(scrape?.narrative, unknownNarrative),
    unknownTelemetryLines: validation.unknownTelemetryLines || [],
    unmatchedNarrativeBlocks: validation.unmatchedNarrativeBlocks || [],
    unusedTelemetryBlocks: validation.unusedTelemetryBlocks || [],
    phaseMismatches: validation.phaseMismatches || [],
    unresolvedTacticalEvents: validation.unresolvedTacticalEvents || [],
  };
  return [
    '# FinalWhistle Match Analyser diagnostic',
    '',
    'Please paste this report into a GitHub issue. It contains compact parser diagnostics plus only nearby or structural narrative context, not the complete match narrative.',
    '',
    '## Match',
    '',
    ...Object.entries(details).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`),
    '',
    '## Diagnostics',
    '',
    '    ' + JSON.stringify(diagnostics, null, 2).replace(/\n/g, '\n    '),
    '',
  ].join('\n');
}

async function writeClipboardText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard copy was rejected by the browser.');
}

async function copyDiagnostics(button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  try {
    await writeClipboardText(buildDiagnosticReport());
    button.textContent = 'Copied!';
  } catch (error) {
    console.error('Could not copy diagnostics', error);
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = originalLabel;
    button.disabled = false;
  }, 1800);
}

function showErrors(errors, warnings) {
  let html = '';
  // Mostly internally-authored message templates, but caught-exception messages end up
  // in here too (e.message) and aren't guaranteed to be free of HTML metacharacters.
  if (errors?.length)
    html += `<div class="err-banner">${errors.map(e=>`<div>${escapeHtml(e)}</div>`).join('')}</div>`;
  if (warnings?.length)
    html += `<div class="warn-banner"><div class="warn-banner-row"><div class="warn-messages">${warnings.map(w=>`<span class="tag-warn">WARN</span> ${escapeHtml(w)}`).join('<br>')}</div><button type="button" class="copy-diagnostics" id="btn-copy-diagnostics" title="Copy an issue-ready troubleshooting report">Copy diagnostics</button></div></div>`;
  $('errors').innerHTML = html;
  const copyButton = $('btn-copy-diagnostics');
  if (warnings?.length && copyButton) copyButton.addEventListener('click', () => copyDiagnostics(copyButton));
}

// ── Scorers / assists (for the header) ───────────────────────────────────────────
// The "assist" isn't a field the parser tags directly — it's the last pass step before
// the goal whose target is the scorer (the pass that actually put them through), which
// covers the normal case (PB_PASS/SP_PASS/FK_PASS/START_PASS → shot) and naturally comes
// back null for solo efforts (dribble from deep, direct free kick) where no such pass exists.
// (Reuses PASS_STEP_TYPES_FOR_STATS, defined above with buildFWDelivery — this used to be
// declared a second time here with an identical value; consolidated to one.)
function findAssist(opp, goalStep) {
  const shooterName = goalStep.shooter?.name;
  if (!shooterName) return null;
  let assist = null;
  for (const s of opp.steps) {
    if (s === goalStep) break;
    if (PASS_STEP_TYPES_FOR_STATS.includes(s.stepType) && s.to?.name === shooterName) assist = s.from;
  }
  return assist;
}
function buildScorers(match) {
  const rows = [];
  (match?.opportunities || []).forEach(opp => {
    const goalStep = opp.steps.find(s => s.outcome === 'GOAL');
    if (!goalStep) return;
    // On a counter-attack the scoring team is the opposite of opp.teamSide (the team
    // that started the opportunity is the one that just got countered) — the shooter's
    // own .side, stamped per-phase by assignSides in parser.js, is already correct
    // regardless of CA, so use that instead of assuming the opportunity's starting side.
    rows.push({
      minute: opp.minute, teamSide: goalStep.shooter?.side || opp.teamSide,
      scorer: goalStep.shooter, assist: findAssist(opp, goalStep),
      isPenalty: !!goalStep.isPenalty,
    });
  });
  return rows.sort((a, b) => a.minute - b.minute);
}
// A player who scored (or assisted) more than once collapses onto one line with every
// minute listed — "Høgh (2', 33', 35')" — rather than repeating their name per goal, the
// same convention as a real match report.
function groupByPlayer(scorers, pick) {
  const order = [], byKey = new Map();
  scorers.forEach(s => {
    const p = pick(s);
    if (!p?.name) return;
    const key = p.name + '|' + s.teamSide;
    if (!byKey.has(key)) { const e = { name: p.name, teamSide: s.teamSide, mins: [] }; byKey.set(key, e); order.push(e); }
    byKey.get(key).mins.push({ minute: s.minute, isPenalty: !!s.isPenalty });
  });
  order.forEach(e => e.mins.sort((a, b) => a.minute - b.minute));
  return order.sort((a, b) => a.mins[0].minute - b.mins[0].minute);
}
function renderPlayerGroupItem(e) {
  const mins = e.mins.map(m => `${m.minute}'${m.isPenalty ? ' pen' : ''}`).join(', ');
  return `<div class="scorer-item">${escapeHtml(e.name.split(' ').pop())} <span class="scorer-min">(${mins})</span></div>`;
}
function renderScorersRow(scorers) {
  if (!scorers.length) return '';
  const byScorer = groupByPlayer(scorers, s => s.scorer);
  const byAssist = groupByPlayer(scorers.filter(s => s.assist?.name), s => s.assist);
  const col = (entries, side) => entries.filter(e => e.teamSide === side).map(renderPlayerGroupItem).join('');

  // Scorers: two columns, mirroring the score line above (home left, away right).
  let html = `<div class="meta-scorers">` +
    `<div class="meta-scorers-col home">${col(byScorer, 'home')}</div>` +
    `<div class="meta-scorers-col away">${col(byScorer, 'away')}</div>` +
  `</div>`;

  // Assists: same left/right split, but as a distinct, de-emphasized row under a
  // divider — a goal report separates "who scored" from "who set it up" rather than
  // burying the assist as a footnote on the scorer line.
  if (byAssist.length) {
    html += `<div class="meta-divider"></div>` +
      `<div class="meta-assists">` +
        `<div class="meta-scorers-col home assist">${col(byAssist, 'home')}</div>` +
        `<div class="meta-assist-label">Assists</div>` +
        `<div class="meta-scorers-col away assist">${col(byAssist, 'away')}</div>` +
      `</div>`;
  }
  return html;
}

// Runs an optional secondary panel's render function and writes its HTML into the given
// panel element — but if it throws, the panel shows a small, clearly-labeled, escaped
// error message instead of taking the rest of render() down with it. Never silent: the
// real error still goes to console.error for debugging.
function renderPanelSafely(panelId, label, renderFn) {
  const el = $(panelId);
  try {
    const html = renderFn();
    if (el) el.innerHTML = html;
  } catch (e) {
    console.error(`${label} panel render error`, e);
    if (el) el.innerHTML = `<div class="err-banner">${escapeHtml(label)} unavailable: ${escapeHtml(e.message)}</div>`;
  }
}

function render(scrape) {
  _lastRenderedScrape = scrape;
  // Parse first so we have final score for the header + any parse warnings
  _match = null;
  let parseWarnings = [];
  if (scrape.narrative) {
    try {
      // Trusted scrape metadata (the site's own team-name elements) takes priority over
      // parseMatch's own narrative/stream-based inference — see parser.js for why that
      // matters when one team never creates a single matched opportunity.
      _match = parseMatch(scrape.telemetry||'', scrape.narrative, { homeTeam: scrape.homeTeam, awayTeam: scrape.awayTeam, initialTactics: scrape.initialTactics });
      parseWarnings = _match.warnings || [];
      _statusEvents = [...(_match.tacticalEvents||[])].sort((a,b) => (a.minute??0) - (b.minute??0));
      _statusCache.clear();
    }
    catch(e) { showErrors([...(scrape.errors||[]), 'PARSE_ERROR: '+e.message], scrape.warnings); }
  }
  showErrors(scrape.errors, [...(scrape.warnings||[]), ...parseWarnings]);
  $('tabs').style.display = 'flex';

  // Header: teams + final score (after parse so score is available)
  const meta = $('meta-bar');
  meta.style.display = 'flex'; meta.style.flexDirection = 'column'; meta.style.width = '100%';
  const fs = _match?.meta?.finalScore;
  const homeTeam = _match?.meta?.homeTeam || scrape.homeTeam || '?';
  const awayTeam = _match?.meta?.awayTeam || scrape.awayTeam || '?';
  const scoreStr = (fs && (fs.home > 0 || fs.away > 0)) ? `${fs.home} – ${fs.away}` : 'vs';
  meta.innerHTML =
    `<div class="meta-ts-row">scraped ${new Date(scrape.scrapedAt).toLocaleTimeString()}</div>` +
    `<div class="meta-top">` +
      `<span class="home">${escapeHtml(homeTeam)}</span>` +
      `<span class="header-score">${scoreStr}</span>` +
      `<span class="away">${escapeHtml(awayTeam)}</span>` +
    `</div>` +
    renderScorersRow(buildScorers(_match));

  // Raw panels — colorized the same way the per-opportunity hover raw-text panel
  // already is (player names by team side, quality words by tier), plus the same
  // treatment applied to the telemetry's numeric values via colorizeTelemetryLine. Each
  // line is also tagged with data-opp-idx so a timeline marker click can scroll straight
  // to the block for that opportunity (see clickTimelineMarker/scrollToRawLine).
  const registry = _match?.playerRegistry;
  $('raw-narrative-box').innerHTML = scrape.narrative
    ? renderColorizedNarrative(scrape.narrative, registry)
    : 'No narrative.';
  $('raw-telemetry-box').innerHTML = scrape.telemetry
    ? renderColorizedTelemetry(scrape.telemetry, _match)
    : 'No telemetry.';

  if (!_match?.opportunities?.length) {
    $('opp-list').innerHTML = `<div class="no-data">${scrape.narrative ? 'Parse failed.' : 'No match data.'}</div>`;
    $('timeline-wrap').style.display = 'none';
    $('timeline-wrap').innerHTML = '';
    return;
  }

  const { opportunities } = _match;
  // Opportunities is core — if this throws, something is seriously wrong with the
  // just-parsed match, not with one optional panel, so it's allowed to propagate rather
  // than being isolated away like the panels below (see renderPanelSafely above).
  renderOppSummaryAndList();

  // Stats / Tactics / Analysis are independent secondary panels — a
  // bug in any ONE of them (most likely Analysis, the newest and most complex) must not
  // blank out the others or stop the pitch from building below. Each gets its own
  // try/catch and degrades to a locally-scoped, escaped error message in its own panel
  // rather than either crashing the whole viewer or silently swallowing the exception
  // (still logged via console.error either way).
  renderPanelSafely('panel-stats', 'Statistics', () => renderStats(scrape.statistics, scrape.homeTeam, scrape.awayTeam, opportunities, _match));
  renderPanelSafely('panel-squad', 'Tactics', () => renderSquadTab(_match));
  renderPanelSafely('panel-analysis', 'Analysis', () => renderAnalysisTab(_match));

  // Pitch — rebuild entire SVG as one string (SVG namespace safe)
  try {
    _hFlowData = buildBaseFlow(opportunities, 'home');
    _aFlowData = buildBaseFlow(opportunities, 'away');
    buildBasePitch();
  } catch(e) {
    showErrors([...(scrape.errors||[]), 'PITCH_ERROR: '+e.message]);
  }
  updateExportControls();
}

// Filter pills + opportunity list — separated from render() so switching the Home/Away/
// Both filter can just re-render the list without re-parsing or re-scraping.
function renderOppSummaryAndList() {
  if (!_match?.opportunities?.length) return;
  const { opportunities } = _match;
  const h = opportunities.filter(o=>o.teamSide==='home').length;
  const a = opportunities.filter(o=>o.teamSide==='away').length;
  const g = opportunities.filter(o=>o.hasGoal).length;
  $('opp-summary').style.display = 'flex';
  $('opp-summary').innerHTML =
    `<span class="filter-pill${_teamFilter==='both'?' active':''}" data-filter="both">Both (${opportunities.length})</span>` +
    `<span class="filter-pill${_teamFilter==='home'?' active':''}" data-filter="home">Home (${h})</span>` +
    `<span class="filter-pill${_teamFilter==='away'?' active':''}" data-filter="away">Away (${a})</span>` +
    `<span class="opp-summary-hint">${g} goal${g!==1?'s':''} · click = expand · hover = pitch</span>`;
  $('opp-list').innerHTML = renderOppList(_match);

  const tlWrap = $('timeline-wrap');
  tlWrap.style.display = 'block';
  tlWrap.innerHTML = renderMatchTimeline(_match);
}

// ─────────────────────────────────────────────────────────────────────────────
// HOVER / CLICK INTERACTIONS
// ─────────────────────────────────────────────────────────────────────────────
// Renders one opportunity's pitch highlight chain, pass summary, and raw-narrative
// overlay — the actual "show this opportunity's detail" work, shared by hoverOpp (live
// preview while the mouse is over a row/marker) and unhoverOpp's pinned-opportunity
// restore (see clickOpp) so there's one implementation of what "showing an opportunity
// on the pitch" means, not two that could drift apart.
function showPitchDetail(opp, dim) {
  try { setHighlight(renderHighlightChain(opp), dim); } catch(e) { console.error('pitch highlight error', e); }
  const ps = $('pass-summary');
  ps.style.display = 'block';
  ps.innerHTML = buildPassSummary(opp);
  if (opp.rawLines?.length) {
    $('raw-panel').style.display = 'block';
    $('raw-text').innerHTML = opp.rawLines
      .map(l => colorizeNarrativeLine(l, _match.playerRegistry))
      .join('\n');
  }
}

function hoverOpp(idx) {
  if (!_match) return;
  // mouseover re-fires for every child element inside the row (mini-chain SVG shapes,
  // the minute label, the badge, ...) — without this guard each of those redundantly
  // triggers a full pitch SVG rebuild while the mouse never actually left the row.
  if (idx === _hoveredIdx) return;
  _hoveredIdx = idx;
  const opp = _match.opportunities[idx];
  // Highlight row — match by data-idx (the original, unfiltered opportunity index), not
  // DOM position: when the Home/Away filter is active, filtered-out rows are missing from
  // this NodeList, so DOM position no longer lines up with the opportunity's real index.
  document.querySelectorAll('.opp-row').forEach(r => {
    r.classList.toggle('hovered', parseInt(r.dataset.idx) === idx);
  });
  document.querySelectorAll('.tl-marker').forEach(m => {
    m.classList.toggle('hovered', parseInt(m.dataset.idx) === idx);
  });
  showPitchDetail(opp, true);
}

function unhoverOpp() {
  if (_hoveredIdx === null) return;
  _hoveredIdx = null;
  document.querySelectorAll('.opp-row').forEach(r => r.classList.remove('hovered'));
  document.querySelectorAll('.tl-marker').forEach(m => m.classList.remove('hovered'));

  // Clicking an opportunity pins its pitch detail so it survives the mouse leaving the
  // row (see clickOpp/syncPinnedState) — the currently-expanded step-block IS that pinned
  // state, so revert to showing whichever one is open instead of going blank.
  const pinnedIdx = getPinnedIdx();
  const pinnedOpp = pinnedIdx !== null && _match ? _match.opportunities[pinnedIdx] : null;
  if (pinnedOpp) { showPitchDetail(pinnedOpp, true); return; }

  setHighlight('', false);
  $('pass-summary').style.display = 'none';
  $('raw-panel').style.display = 'none';
}

// The currently-expanded step-block IS the pin/selection state — there's no separate
// variable to keep in sync, just a query for whichever block has .open. Shared by every
// reader of that state (unhoverOpp above, syncPinnedState below, and JPG export).
function getPinnedIdx() {
  const openBlock = document.querySelector('.step-block.open');
  if (!openBlock) return null;
  const idx = parseInt(openBlock.id.replace('steps-', ''), 10);
  return Number.isSafeInteger(idx) ? idx : null;
}

// Called from clickOpp so every path that can open/close a row (a direct row click, or a
// timeline marker click via clickTimelineMarker) stays in sync, including the JPG export
// controls (the "possession" export scope is only enabled while something is pinned).
function syncPinnedState() {
  const idx = getPinnedIdx();
  document.querySelectorAll('.tl-marker').forEach(m => {
    m.classList.toggle('selected', parseInt(m.dataset.idx) === idx);
  });
  document.querySelectorAll('.opp-row').forEach(r => {
    r.classList.toggle('pinned', parseInt(r.dataset.idx) === idx);
  });
  updateExportControls();
}
function markTimelineSelected(idx) {
  document.querySelectorAll('.tl-marker').forEach(m => {
    m.classList.toggle('selected', parseInt(m.dataset.idx) === idx);
  });
}

// Highlights the raw-line block(s) tagged with this opportunity's index inside a raw
// panel (Narrative or Telemetry) and scrolls the first into view — the same navigation
// job scrollIntoView-on-the-row does for the Opportunities tab, just against the
// data-opp-idx anchors renderColorizedNarrative/renderColorizedTelemetry attach to each
// line instead of a single row element.
function scrollToRawLine(boxId, idx) {
  const box = $(boxId);
  if (!box) return;
  box.querySelectorAll('.raw-line.raw-hl').forEach(el => {
    el.classList.remove('raw-hl'); el.style.borderLeftColor = '';
  });
  const lines = box.querySelectorAll(`.raw-line[data-opp-idx="${idx}"]`);
  if (!lines.length) return;
  const opp = _match?.opportunities?.[idx];
  const col = opp?.teamSide === 'home' ? HC : opp?.teamSide === 'away' ? AC : '#6fb3d9';
  lines.forEach(el => { el.classList.add('raw-hl'); el.style.borderLeftColor = col; });
  lines[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  markTimelineSelected(idx);
}

function clickOpp(idx) {
  const block = $(`steps-${idx}`);
  if (!block) return;
  const isOpen = block.classList.contains('open');
  // Close all
  document.querySelectorAll('.step-block').forEach(b => b.classList.remove('open'));
  if (!isOpen) block.classList.add('open');
  syncPinnedState();

  // Un-pinning while the mouse has already left the row (e.g. via a marker click that
  // toggled the same opportunity closed) should drop back to blank instead of leaving a
  // stale chain on screen with nothing selected to justify it.
  if (isOpen && _hoveredIdx === null) {
    setHighlight('', false);
    $('pass-summary').style.display = 'none';
    $('raw-panel').style.display = 'none';
  }
}

// Clicking a timeline marker locates the matching opportunity row, scrolls it into view,
// and reuses the exact same interactions a real row click/hover would trigger — hoverOpp
// for the pitch highlight/chain detail, clickOpp for the expand + selection state — rather
// than building a second, parallel selection system just for the timeline.
function clickTimelineMarker(idx) {
  // The pitch/chain-detail panel on the right isn't tab-gated — it's always visible
  // regardless of which left-hand tab is active — so this always updates it, the same
  // "normal" hover behavior a row click gets on the Opportunities tab.
  hoverOpp(idx);

  // The timeline is shared across every tab (it sits alongside the filter pills, not
  // inside any one panel). On Narrative/Telemetry, "take me to that part" means jumping
  // to the matching block within the tab the user is already on, not away from it —
  // mirroring the exact row-scroll+select interaction the Opportunities tab already has,
  // just anchored to data-opp-idx-tagged raw-line blocks instead of an opp-row. Statistics
  // has no per-minute content to anchor to, so it falls back to switching tabs.
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'raw-narrative') return scrollToRawLine('raw-narrative-box', idx);
  if (activeTab === 'raw-telemetry') return scrollToRawLine('raw-telemetry-box', idx);

  activateTab('opps');
  const row = document.querySelector(`.opp-row[data-idx="${idx}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  clickOpp(idx);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — JPG SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────
// A self-contained SVG is built entirely from already-parsed match data (no DOM
// screenshot, no external image/font references), then rasterized locally to a JPG via
// <canvas> — nothing is uploaded anywhere (see the Security section in README.md).
// Reuses this project's own pitch/flow/highlight/timeline renderers (renderPitchOutline,
// buildBaseFlow/renderBaseFlow, renderHighlightChain, renderMatchTimeline,
// computePhaseStats) rather than building a second copy of the same drawing logic just
// for export — arrows are always plain inline polygons (see arrowHead() above), so
// there's no <marker>/href/url() indirection to worry about in
// assertSelfContainedExportSvg below.
//
// The full-view scope shows the pinned possession's chain detail + narrative excerpt
// (mirroring what's already visible in the live right-overlay panel) plus a compact
// per-window opportunity/shot/goal table (computePhaseStats — see its own comment above
// for the extra-time clamping caveat that applies here too) — a snapshot of the app's
// own current state, not a rendering of every opportunity row in the list.

const EXPORT_MAX_DISPLAY_CHARS = 240;
const COMPACT_EXPORT_WIDTH = 1600;
const COMPACT_EXPORT_HEIGHT = 1200;
const FULL_VIEW_EXPORT_WIDTH = 1920;
const FULL_VIEW_EXPORT_HEIGHT = 1080;
const EXPORT_MAX_BYTES = 5_000_000;
const MAX_POSSESSION_INDEX = 999;
const EXPORT_MATCH_ID_RE = /\/match\/([a-z0-9-]{4,80})(?:\/|$)/i;
const EXPORT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function exportDimensions(scope) {
  return scope === 'full-view'
    ? { width: FULL_VIEW_EXPORT_WIDTH, height: FULL_VIEW_EXPORT_HEIGHT }
    : { width: COMPACT_EXPORT_WIDTH, height: COMPACT_EXPORT_HEIGHT };
}

/** Remove XML 1.0-invalid code points, then escape every XML delimiter — export text
 * reaches the SVG via raw string concatenation, not innerHTML, so it needs its own
 * escaping pass distinct from escapeHtml() above. */
function escapeXmlText(value) {
  let clean = '';
  for (const char of String(value ?? '')) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)) {
      clean += char;
    }
  }
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** At most maxChars Unicode code points, ellipsis included, hard-capped at EXPORT_MAX_DISPLAY_CHARS. */
function truncateDisplay(value, maxChars = 120) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) return '';
  const limit = Math.min(maxChars, EXPORT_MAX_DISPLAY_CHARS);
  if (limit === 0) return '';
  const prefix = [];
  let exceeded = false;
  for (const char of String(value ?? '')) {
    if (prefix.length === limit) { exceeded = true; break; }
    prefix.push(char);
  }
  if (!exceeded) return prefix.join('');
  if (limit === 1) return '…';
  prefix.length = limit - 1;
  return `${prefix.join('')}…`;
}

/** Best-effort match-id token for a local filename. Unlike canonicalMatchUrl (the
 * WRONG_PAGE gate in scraper.js), a filename doesn't need to reject anything: an
 * id-shaped token is used if the URL loosely matches FinalWhistle's already-established
 * /match/ convention (see background.js's "prefer actual match tabs" logic), and a
 * timestamp is used otherwise — graceful degradation rather than throwing on any
 * deviation, consistent with this project's parsing philosophy (see parser.js). */
function exportMatchId(url, scrapedAt) {
  if (typeof url === 'string') {
    const match = EXPORT_MATCH_ID_RE.exec(url);
    if (match) return match[1].toLowerCase();
  }
  const stamp = Number.isFinite(scrapedAt) ? scrapedAt : Date.now();
  return `unknown-${stamp}`;
}

function buildExportFilename(url, scope, scrapedAt, possessionIndex = null) {
  const id = exportMatchId(url, scrapedAt);
  if (scope === 'possession' && Number.isSafeInteger(possessionIndex) &&
      possessionIndex >= 0 && possessionIndex <= MAX_POSSESSION_INDEX) {
    return `finalwhistle-match-${id}-possession-${String(possessionIndex + 1).padStart(3, '0')}.jpg`;
  }
  if (scope === 'overview') return `finalwhistle-match-${id}-overview.jpg`;
  return `finalwhistle-match-${id}-full-view.jpg`;
}

function exportChainRows(opp) {
  const c = stepsToChain(opp);
  const nameTag = (name, pos) => name ? `${name.split(' ').pop()} [${pos || '?'}]` : (pos || '?');
  const rows = [];
  if (c.sP && c.mP) rows.push({ from: nameTag(c.sName, c.sP), to: nameTag(c.mName, c.mP), type: 'Start', q: c.sQ });
  if (c.pbP && c.rP) rows.push({
    from: nameTag(c.pbName, c.pbP), to: nameTag(c.rName, c.rP),
    type: c.isLongBallSequence ? 'Long Ball' : 'Mid Action', q: c.pbQ,
  });
  if (c.shotQ) rows.push({
    from: nameTag(c.shName, c.shP), to: nameTag(c.gkName, 'GK'),
    type: c.directShot ? 'Mid Action' : 'PB Action', q: c.shotQ,
  });
  return rows;
}

function renderExportChainDetail(x, y, width, opp) {
  const rows = opp ? exportChainRows(opp) : [];
  const height = opp ? Math.max(110, 60 + rows.length * 26) : 90;
  let svg = `<g data-export-section="chain-detail">` +
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="#040912" fill-opacity=".95" stroke="#1a2540"/>` +
    `<text x="${x + 12}" y="${y + 22}" fill="#8a9ab0" font-size="11" font-family="${EXPORT_MONO}" letter-spacing="2">CHAIN DETAIL</text>`;
  if (!opp) {
    svg += `<text x="${x + 12}" y="${y + 46}" fill="#9fb0c4" font-size="13" font-family="${EXPORT_MONO}">No possession pinned.</text>`;
  } else if (!rows.length) {
    svg += `<text x="${x + 12}" y="${y + 46}" fill="#9fb0c4" font-size="13" font-family="${EXPORT_MONO}">No bounded route summary available.</text>`;
  } else {
    const col = opp.teamSide === 'home' ? HC : AC;
    let cursor = y + 44;
    rows.forEach(row => {
      svg += `<text x="${x + 12}" y="${cursor}" fill="${col}" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXmlText(truncateDisplay(`${row.from} → ${row.to}`, 40))}</text>` +
        `<text x="${x + width - 48}" y="${cursor}" text-anchor="end" fill="#8a9ab0" font-size="10" font-family="${EXPORT_MONO}">${escapeXmlText(row.type)}</text>` +
        `<text x="${x + width - 12}" y="${cursor}" text-anchor="end" fill="${row.q ? tierColor(qualityLabel(row.q)) : '#8a9ab0'}" font-size="12" font-weight="700" font-family="${EXPORT_MONO}">${escapeXmlText(row.q ?? '')}</text>`;
      cursor += 26;
    });
  }
  svg += '</g>';
  return { svg, height };
}

function renderExportNarrative(x, y, width, height, opp) {
  const maxLines = Math.max(3, Math.floor((height - 40) / 19));
  const lines = [];
  for (const rawLine of (opp?.rawLines || [])) {
    if (lines.length >= maxLines) break;
    lines.push(truncateDisplay(String(rawLine).trim(), 60));
  }
  if (!lines.length) lines.push(opp ? 'No narrative lines were available for this possession.' : 'Pin a possession to show its narrative.');
  const text = lines.map((line, index) =>
    `<text x="${x + 12}" y="${y + 30 + index * 19}" fill="#cdd6e5" font-size="12" font-family="${EXPORT_MONO}">${escapeXmlText(line)}</text>`
  ).join('');
  return `<g data-export-section="narrative">` +
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="#050b14" fill-opacity=".95" stroke="#1a2540"/>` +
    `<text x="${x + 12}" y="${y + 20}" fill="#8a9ab0" font-size="11" font-family="${EXPORT_MONO}" letter-spacing="2">NARRATIVE</text>` +
    text + `</g>`;
}

function renderExportPhaseTable(x, y) {
  const stats = computePhaseStats(_match);
  let cursor = y;
  let svg = `<g data-export-section="phase-summary">` +
    `<text x="${x}" y="${cursor}" fill="#9fb0c4" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif" letter-spacing="1">OPPS / SHOTS / GOALS BY WINDOW</text>`;
  cursor += 22;
  svg += `<text x="${x + 220}" y="${cursor}" fill="${HC}" font-size="10" font-family="${EXPORT_MONO}" text-anchor="middle">HOME</text>` +
    `<text x="${x + 320}" y="${cursor}" fill="${AC}" font-size="10" font-family="${EXPORT_MONO}" text-anchor="middle">AWAY</text>`;
  cursor += 20;
  stats.forEach(s => {
    svg += `<text x="${x}" y="${cursor}" fill="#cdd6e5" font-size="12" font-family="${EXPORT_MONO}">${escapeXmlText(s.label)}</text>` +
      `<text x="${x + 220}" y="${cursor}" fill="${HC}" font-size="12" font-family="${EXPORT_MONO}" text-anchor="middle">${s.home.opps}/${s.home.shots}/${s.home.goals}</text>` +
      `<text x="${x + 320}" y="${cursor}" fill="${AC}" font-size="12" font-family="${EXPORT_MONO}" text-anchor="middle">${s.away.opps}/${s.away.shots}/${s.away.goals}</text>`;
    cursor += 22;
  });
  return svg + '</g>';
}

function exportSummaryLines(scope, opp) {
  if (scope === 'overview') {
    const opportunities = _match.opportunities;
    return [
      ['View', 'Whole-match overview'],
      ['Home starting opportunities', opportunities.filter(o => o.teamSide === 'home').length],
      ['Away starting opportunities', opportunities.filter(o => o.teamSide === 'away').length],
      ['Shot opportunities', opportunities.filter(o => o.hasShot).length],
      ['Goals', opportunities.filter(o => o.hasGoal).length],
      ['Counters', opportunities.filter(o => o.isCounterAttack).length],
    ];
  }
  return [
    ['View', `Pinned possession ${getPinnedIdx() + 1}`],
    ['Minute', `${opp.minute ?? '?'}'`],
    ['Opportunity started by', opp.team || opp.teamSide || '?'],
    ['Score after', `${opp.scoreAfter?.home ?? 0}-${opp.scoreAfter?.away ?? 0}`],
    ['Outcome', outcomeLabel(opp.finalOutcome, opp.finalMissType) || 'Unknown'],
  ];
}

// Reuses the live scorers row logic (buildScorers/groupByPlayer) but as SVG <text>,
// since renderScorersRow's own output is HTML.
function renderExportScorers(x, y, width) {
  const scorers = buildScorers(_match);
  if (!scorers.length) return '';
  const byScorer = groupByPlayer(scorers, s => s.scorer);
  const summarize = side => byScorer.filter(e => e.teamSide === side).map(e => {
    const player = (e.name || '?').split(/\s+/).filter(Boolean).at(-1) || '?';
    const minutes = e.mins.map(m => `${m.minute}'${m.isPenalty ? ' pen' : ''}`).join(', ');
    return `${player} (${minutes})`;
  }).join(' · ');
  const home = truncateDisplay(summarize('home'), 48);
  const away = truncateDisplay(summarize('away'), 48);
  const sans = 'ui-sans-serif, system-ui, sans-serif';
  return (home ? `<text x="${x}" y="${y}" fill="${HC}" font-size="11" font-family="${sans}">${escapeXmlText(home)}</text>` : '') +
    (away ? `<text x="${x + width}" y="${y}" text-anchor="end" fill="${AC}" font-size="11" font-family="${sans}">${escapeXmlText(away)}</text>` : '');
}

// A complete "<svg viewBox=...>...</svg>" string from one of this file's own live
// renderers (e.g. renderMatchTimeline) nests directly inside the export SVG as a
// positioned sub-viewport — SVG natively supports this, so the live renderer is reused
// byte-for-byte instead of re-implementing its layout here. The CSS classes it carries
// (tl-marker, tl-dot, ...) have no effect without the page stylesheet, but every visual
// property that matters (fill/stroke color, radius) is already set via inline attributes.
function embedNestedSvg(innerSvg, x, y, width, height) {
  const viewBoxMatch = /viewBox="([^"]+)"/.exec(innerSvg);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${width} ${height}`;
  const inner = innerSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${viewBox}" preserveAspectRatio="none">${inner}</svg>`;
}

function assertSelfContainedExportSvg(svg) {
  if (svg.length > 1_000_000 ||
      /<(?:foreignObject|image)\b|<(?!svg\b)[^>]+\b(?:xlink:)?href\s*=|<[^>]+\b(?:style|fill|stroke|filter|mask|clip-path)="[^"]*\burl\s*\(/i.test(svg)) {
    throw new Error('EXPORT_SVG_INVALID: The local presentation did not pass its self-contained SVG check.');
  }
}

function buildCompactExportSvg(scope) {
  const pinnedIdx = getPinnedIdx();
  const opp = scope === 'possession' && Number.isSafeInteger(pinnedIdx) ? _match.opportunities[pinnedIdx] : null;
  if (scope === 'possession' && !opp) {
    throw new Error('NO_PINNED_POSSESSION: Click a possession before exporting it.');
  }
  const { width, height } = exportDimensions(scope);
  const homeTeam = truncateDisplay(_match.meta?.homeTeam || _lastRenderedScrape?.homeTeam || 'Home', 20);
  const awayTeam = truncateDisplay(_match.meta?.awayTeam || _lastRenderedScrape?.awayTeam || 'Away', 20);
  const fs = _match.meta?.finalScore;
  const score = fs ? `${fs.home ?? 0} – ${fs.away ?? 0}` : 'vs';
  const homeFlow = renderBaseFlow(_hFlowData?.edgeCounts || {}, _hFlowData?.nodeCounts || {}, 'home');
  const awayFlow = renderBaseFlow(_aFlowData?.edgeCounts || {}, _aFlowData?.nodeCounts || {}, 'away');
  const highlight = opp ? renderHighlightChain(opp) : '';
  const flowOpacity = opp ? '.16' : '1';
  const summary = exportSummaryLines(scope, opp).map(([label, value], index) => {
    const y = 335 + index * 58;
    return `<text x="790" y="${y}" fill="#71839b" font-size="19" font-family="${EXPORT_MONO}" letter-spacing="1">${escapeXmlText(label)}</text>` +
      `<text x="790" y="${y + 26}" fill="#e4e9f5" font-size="25" font-family="${EXPORT_MONO}">${escapeXmlText(truncateDisplay(String(value), 42))}</text>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-export-scope="${scope}">` +
    `<rect width="${width}" height="${height}" fill="#060d18"/>` +
    `<text x="80" y="78" fill="#8a9ab0" font-size="22" font-family="${EXPORT_MONO}" letter-spacing="4">FINALWHISTLE MATCH ANALYSER · LOCAL</text>` +
    `<text x="80" y="135" fill="${HC}" font-size="30" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXmlText(homeTeam)}</text>` +
    `<text x="800" y="135" text-anchor="middle" fill="#e4e9f5" font-size="38" font-weight="700" font-family="${EXPORT_MONO}">${escapeXmlText(score)}</text>` +
    `<text x="1520" y="135" text-anchor="end" fill="${AC}" font-size="30" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXmlText(awayTeam)}</text>` +
    `<line x1="80" y1="165" x2="1520" y2="165" stroke="#1a2540" stroke-width="2"/>` +
    `<g transform="translate(90 210) scale(1.12)">${renderPitchOutline()}` +
      `<g opacity="${flowOpacity}">${homeFlow}${awayFlow}</g>${highlight}</g>` +
    `<rect x="750" y="235" width="770" height="700" rx="18" fill="#091321" stroke="#1a2540" stroke-width="2"/>` +
    `<text x="790" y="290" fill="#9fb0c4" font-size="25" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif">${scope === 'overview' ? 'MATCH OVERVIEW' : 'PINNED POSSESSION'}</text>` +
    summary +
    `<text x="80" y="1180" fill="#5a6f8c" font-size="17" font-family="${EXPORT_MONO}">Local export only — nothing is uploaded.</text>` +
    `</svg>`;
  assertSelfContainedExportSvg(svg);
  return svg;
}

function buildFullViewExportSvg() {
  const { width, height } = exportDimensions('full-view');
  const pinnedIdx = getPinnedIdx();
  const opp = Number.isSafeInteger(pinnedIdx) ? _match.opportunities[pinnedIdx] : null;
  const homeTeam = truncateDisplay(_match.meta?.homeTeam || _lastRenderedScrape?.homeTeam || 'Home', 28);
  const awayTeam = truncateDisplay(_match.meta?.awayTeam || _lastRenderedScrape?.awayTeam || 'Away', 28);
  const fs = _match.meta?.finalScore;
  const score = fs ? `${fs.home ?? 0} – ${fs.away ?? 0}` : 'vs';
  const scrapedAt = Number.isFinite(_lastRenderedScrape?.scrapedAt)
    ? new Date(_lastRenderedScrape.scrapedAt).toLocaleTimeString() : 'unknown';
  const homeFlow = renderBaseFlow(_hFlowData?.edgeCounts || {}, _hFlowData?.nodeCounts || {}, 'home');
  const awayFlow = renderBaseFlow(_aFlowData?.edgeCounts || {}, _aFlowData?.nodeCounts || {}, 'away');
  const highlight = opp ? renderHighlightChain(opp) : '';
  const flowOpacity = opp ? '.15' : '1';
  const viewLabel = opp ? `PINNED POSSESSION ${pinnedIdx + 1}` : 'WHOLE MATCH';
  const chain = renderExportChainDetail(1530, 20, 380, opp);
  const narrativeY = 30 + chain.height;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-export-scope="full-view">` +
    `<rect width="${width}" height="${height}" fill="#060d18"/>` +
    `<rect x="0" y="0" width="600" height="${height}" fill="#090f1e"/>` +
    `<text x="300" y="17" text-anchor="middle" fill="#5a6f8c" font-size="10" font-family="${EXPORT_MONO}" letter-spacing="1">scraped ${escapeXmlText(scrapedAt)}</text>` +
    `<text x="10" y="45" fill="${HC}" font-size="14" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXmlText(homeTeam)}</text>` +
    `<text x="300" y="45" text-anchor="middle" fill="#e4e9f5" font-size="20" font-weight="700" font-family="${EXPORT_MONO}" letter-spacing="3">${escapeXmlText(score)}</text>` +
    `<text x="590" y="45" text-anchor="end" fill="${AC}" font-size="14" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXmlText(awayTeam)}</text>` +
    renderExportScorers(10, 68, 580) +
    `<line x1="10" y1="104" x2="590" y2="104" stroke="#1a2540"/>` +
    `<text x="10" y="130" fill="#9fb0c4" font-size="14" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif" letter-spacing="1">FW ANALYSER · LOCAL</text>` +
    `<text x="590" y="130" text-anchor="end" fill="#5a6f8c" font-size="9" font-family="${EXPORT_MONO}">SESSION-ONLY · FULL VIEW JPG</text>` +
    `<line x1="0" y1="145" x2="600" y2="145" stroke="#1a2540"/>` +
    embedNestedSvg(renderMatchTimeline(_match), 0, 150, 600, 58) +
    `<line x1="0" y1="212" x2="600" y2="212" stroke="#1a2540"/>` +
    renderExportPhaseTable(10, 240) +
    `<line x1="600" y1="0" x2="600" y2="${height}" stroke="#1a2540"/>` +
    `<text x="1060" y="31" text-anchor="middle" fill="#9fb0c4" font-size="13" font-family="${EXPORT_MONO}" letter-spacing="2">FULL ANALYSER VIEW · ${escapeXmlText(viewLabel)}</text>` +
    `<text x="1060" y="52" text-anchor="middle" fill="#5a6f8c" font-size="10" font-family="${EXPORT_MONO}">LOCAL EXPORT ONLY · NOTHING IS UPLOADED</text>` +
    `<g transform="translate(775 65) scale(1.14)">${renderPitchOutline()}` +
      `<g opacity="${flowOpacity}">${homeFlow}${awayFlow}</g>${highlight}</g>` +
    chain.svg + renderExportNarrative(1530, narrativeY, 380, 1050 - narrativeY, opp) +
    `</svg>`;
  assertSelfContainedExportSvg(svg);
  return svg;
}

function buildExportSvg(scope) {
  if (!_match?.opportunities?.length) {
    throw new Error('NO_EXPORTABLE_MATCH: Scrape a valid match before exporting.');
  }
  if (!['full-view', 'overview', 'possession'].includes(scope)) {
    throw new Error('EXPORT_SVG_INVALID: Choose a valid export scope.');
  }
  return scope === 'full-view' ? buildFullViewExportSvg() : buildCompactExportSvg(scope);
}

async function createExportJpeg(scope) {
  const svg = buildExportSvg(scope);
  const { width, height } = exportDimensions(scope);
  const filename = buildExportFilename(
    _lastRenderedScrape?.url, scope, _lastRenderedScrape?.scrapedAt,
    scope === 'possession' ? getPinnedIdx() : null,
  );
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = svgUrl;
    try { await image.decode(); }
    catch { throw new Error('EXPORT_RASTER_FAILED: The browser could not decode the local SVG presentation.'); }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('EXPORT_RASTER_FAILED: A local canvas could not be created.');
    context.fillStyle = '#060d18';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob || blob.type !== 'image/jpeg' || blob.size < 1_000 || blob.size > EXPORT_MAX_BYTES) {
      throw new Error('EXPORT_ENCODING_FAILED: Chrome did not create a bounded JPG.');
    }
    return { blob, filename };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function updateExportControls() {
  const scopeEl = $('export-scope');
  if (!scopeEl) return;
  const hasMatch = !!_match?.opportunities?.length;
  const hasPin = hasMatch && Number.isSafeInteger(getPinnedIdx());
  scopeEl.disabled = !hasMatch;
  const possessionOption = $('export-possession-option');
  if (possessionOption) possessionOption.disabled = !hasPin;
  if (!hasPin && scopeEl.value === 'possession') scopeEl.value = 'full-view';
  $('btn-save-jpg').disabled = !hasMatch || (scopeEl.value === 'possession' && !hasPin);
}

async function saveJpg() {
  const scope = $('export-scope').value;
  $('btn-save-jpg').disabled = true;
  $('status').textContent = 'Building JPG…';
  try {
    const { blob, filename } = await createExportJpeg(scope);
    const jpegUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = jpegUrl;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(jpegUrl);
    }
    $('status').textContent = 'JPG download started';
  } catch (error) {
    $('status').textContent = 'Export failed';
    $('errors').innerHTML = `<div class="err-banner">${escapeHtml(String(error?.message || 'EXPORT_FAILED: The JPG could not be created.'))}</div>`;
  } finally {
    updateExportControls();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────────────────────
function activateTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $(`panel-${name}`)?.classList.add('active');
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// ─────────────────────────────────────────────────────────────────────────────
// OPP LIST EVENT DELEGATION  (inline handlers blocked by extension CSP)
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('mouseover', e => {
  const row = e.target.closest('.opp-row');
  if (row?.dataset.idx !== undefined) { hoverOpp(parseInt(row.dataset.idx)); return; }
  const marker = e.target.closest('.tl-marker');
  if (marker?.dataset.idx !== undefined) hoverOpp(parseInt(marker.dataset.idx));
});
document.addEventListener('mouseout', e => {
  const row = e.target.closest('.opp-row');
  if (row && !row.contains(e.relatedTarget)) { unhoverOpp(); return; }
  const marker = e.target.closest('.tl-marker');
  if (marker && !marker.contains(e.relatedTarget)) unhoverOpp();
});
document.addEventListener('click', e => {
  const row = e.target.closest('.opp-row');
  if (row?.dataset.idx !== undefined) clickOpp(parseInt(row.dataset.idx));

  const marker = e.target.closest('.tl-marker');
  if (marker?.dataset.idx !== undefined) clickTimelineMarker(parseInt(marker.dataset.idx));

  const pill = e.target.closest('.filter-pill');
  if (pill?.dataset.filter) {
    _teamFilter = pill.dataset.filter;
    unhoverOpp(); // no-op if nothing was hovered — the explicit buildBasePitch below covers that case
    renderOppSummaryAndList();
    buildBasePitch(); // filter changes which flow layer(s) show, so this needs the full rebuild
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUTTONS
// ─────────────────────────────────────────────────────────────────────────────
$('btn-scrape').addEventListener('click', async () => {
  $('status').textContent = 'Scraping…'; $('btn-scrape').disabled = true;
  try {
    const data = await ext.runtime.sendMessage({ type: 'SCRAPE_PAGE' });
    render(data);
    $('status').textContent = data.ok ? 'OK' : `${data.errors?.length||0} error(s)`;
  } catch(e) {
    $('errors').innerHTML = `<div class="err-banner">Error: ${escapeHtml(e.message)}</div>`;
    $('status').textContent = 'Error';
  } finally { $('btn-scrape').disabled = false; }
});

$('btn-load').addEventListener('click', async () => {
  const s = await ext.storage.local.get('lastScrape');
  if (s.lastScrape) { render(s.lastScrape); $('status').textContent = 'Loaded'; }
  else $('status').textContent = 'Nothing stored';
});

$('btn-clear').addEventListener('click', async () => {
  await ext.storage.local.remove('lastScrape');
  _match = null;
  _lastRenderedScrape = null;
  $('status').textContent = 'Cleared';
  ['errors','meta-bar','opp-summary','timeline-wrap'].forEach(id => { const e=$( id); if(e){ e.innerHTML=''; e.style.display=''; }});
  $('tabs').style.display = 'none';
  $('opp-list').innerHTML = '<div class="no-data">Scrape a match to begin</div>';
  _hFlowData = null; _aFlowData = null;
  buildBasePitch();
  updateExportControls();
});

// Open a FinalWhistle tab (focusing one if it's already open) plus a second, blank
// analyser tab — so a different match can be picked over there and scraped into its
// own tab, side by side with this one, without touching what's currently on screen
// here. The new tab deliberately does NOT auto-load from storage (see the ?fresh=1
// branch below) — storage.local's "lastScrape" is a single shared slot, and loading
// it here would just show whatever this tab's own last scrape was.
$('btn-new-tab').addEventListener('click', async () => {
  const fwTabs = await ext.tabs.query({ url: '*://*.finalwhistle.org/*' });
  if (fwTabs.length) {
    const mostRecent = mostRecentlyAccessed(fwTabs);
    if (mostRecent) {
      await ext.tabs.update(mostRecent.id, { active: true });
      await ext.windows.update(mostRecent.windowId, { focused: true });
    } else {
      await ext.tabs.create({ url: 'https://www.finalwhistle.org' });
    }
  } else {
    await ext.tabs.create({ url: 'https://www.finalwhistle.org' });
  }
  await ext.tabs.create({ url: ext.runtime.getURL('viewer.html') + '?fresh=1' });
});

$('btn-save-jpg').addEventListener('click', saveJpg);
$('export-scope').addEventListener('change', updateExportControls);
updateExportControls();

// Launch behavior depends on how this tab was opened:
//   ?autoscrape=1 — fresh launch via the toolbar icon (background.js) — clear any
//                   previous scrape and pull in the current match immediately,
//                   reusing the exact same flow as clicking Scrape by hand.
//   ?fresh=1      — opened via "New Tab" above, for comparing a different match —
//                   start blank and wait for the user to Scrape once ready.
//   (neither)     — plain viewer.html (e.g. a reload) — auto-load the last scrape.
const _launchParams = new URLSearchParams(location.search);
if (_launchParams.get('autoscrape') === '1') {
  ext.storage.local.remove('lastScrape').then(() => $('btn-scrape').click());
} else if (_launchParams.get('fresh') === '1') {
  $('status').textContent = 'Pick a match on FinalWhistle, then Scrape';
} else {
  ext.storage.local.get('lastScrape').then(({lastScrape}) => {
    if (lastScrape) { render(lastScrape); $('status').textContent = 'Loaded'; }
  });
}
