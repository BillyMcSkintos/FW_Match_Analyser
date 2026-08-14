'use strict';
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

  const startPass = find('START_PASS');
  const midDuel   = find('MID_DUEL');
  const pbPass    = find('PB_PASS');
  const pbDuel    = find('PB_DUEL');
  const shot      = find('SHOT');
  const fkShot    = find('FK_SHOT');
  const sp        = find('SP_PASS');

  const effectiveMid  = midDuel;
  const effectivePb   = pbDuel;
  const effectiveShot = shot || fkShot;

  // A long ball skips the midfield contest entirely (see isLongBall below) — there's no
  // real mid duel to have "won", but the ball did legitimately advance past that stage.
  const isLongBall = !!opp.isLongBall;
  const midWon = ['POSSESSION','WON'].includes(effectiveMid?.outcome) || isLongBall;

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
    isLongBall,
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
    s.push(`<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="8" font-family="monospace" opacity=".9">${pos}</text>`);
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
  if (label) s.push(
    `<rect x="${mx-14}" y="${my-7}" width="28" height="14" rx="2" fill="#030a14" opacity=".9"/>`,
    `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="9" font-family="monospace" opacity=".9">${label}</text>`
  );
  return s.join('');
}

function playerNode(x,y,pos,col,outline=false) {
  return [
    `<circle cx="${x}" cy="${y}" r="12" fill="#060d18" stroke="${col}" stroke-width="${outline?2:1.5}" opacity="${outline?1:.8}"/>`,
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="8" font-family="monospace" font-weight="bold">${pos||'?'}</text>`,
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
    `<text x="${x-6}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${atkCol}" font-size="7" font-family="monospace" font-weight="bold">${atkPos||'?'}</text>`,
    `<text x="${x+6}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${defCol}" font-size="7" font-family="monospace" font-weight="bold">${defPos||'?'}</text>`,
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

  if (!c.sP && !c.mP && !c.isLongBall) return '';

  if (c.isCA) {
    const bx = side === 'home' ? VX.left - 8 : OVX.right + 8;
    s.push(`<rect x="${bx-15}" y="${Y.start-9}" width="30" height="18" rx="3" fill="#030a14" opacity=".92" stroke="${col}" stroke-width="1"/>`);
    s.push(`<text x="${bx}" y="${Y.start}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="9" font-family="monospace" font-weight="bold" letter-spacing="1">CA</text>`);
  }

  const DR = 14; // duel node radius for edge offsets
  function edgePt(from, to, r) {
    const dx=to.x-from.x, dy=to.y-from.y, d=Math.hypot(dx,dy);
    if (d<1) return from;
    return { x:from.x+dx/d*r, y:from.y+dy/d*r };
  }

  let mxy;
  if (c.isLongBall) {
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
  const col  = opp.teamSide === 'home' ? HC : AC;
  const team = opp.teamSide === 'home' ? _match?.meta?.homeTeam : _match?.meta?.awayTeam;
  const qColor = q => tierColor(qualityLabel(q)); // qualityLabel() comes from parser.js

  const nameTag = (name, pos) => name
    ? `${escapeHtml(name.split(' ').pop())} <span class="ps-pos">[${escapeHtml(pos)||'?'}]</span>`
    : escapeHtml(pos)||'?';

  const rows = [];
  if (c.sP && c.mP) rows.push({
    from: nameTag(c.sName, c.sP), to: nameTag(c.mName, c.mP), type:'Start', q: c.sQ
  });
  if (c.pbP && c.rP) rows.push({
    from: nameTag(c.pbName, c.pbP), to: nameTag(c.rName, c.rP),
    type: c.isLongBall ? 'Long Ball' : 'Mid Action', q: c.pbQ
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
};
const OUT_LBL = {
  GOAL:'GOAL', POST:'post', SAVED:'saved', FUMBLED:'fumbled', MISSED:'missed wide',
  GK_INTERCEPT:'intercept', BLOCKED:'blocked', SHOT_BLOCKED:'shot blocked', CORNER:'corner',
  FOUL:'foul', CLEARED:'cleared', POSSESSION:'won', WON:'won', FREE_KICK:'free kick',
};

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
// HALF_TIME clears only the reported TIREDNESS, not injuries. FinalWhistle gives a
// Constitution recovery at the break (+0.44 CO per first-half minute played, capped at
// +20), which this extension has no way to reconstruct (it doesn't track hidden CO
// state) — so rather than guess at a second-half fatigue number, a first-half tiredness
// report simply isn't carried forward. An injury is a different kind of state entirely:
// FinalWhistle injuries persist across half time (they don't heal at the break), so
// clearing them here would misreport a still-injured player as fit.
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
    if (ev.type === 'HALF_TIME') { tiredness = null; continue; }
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
    const ol  = OUT_LBL[s.outcome]  || (s.outcome||'');
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
const TACTICAL_KINDS = new Set(['SUBSTITUTION','POSITION_CHANGE','MENTALITY_CHANGE','STYLE_CHANGE','ISOLATE','HALF_TIME']);

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
      text = `Style <span class="p-arr">→</span> ${escapeHtml(ev.style)}${impactTag(ev)}`;
      break;
    case 'ISOLATE':
      icon = '🎯';
      text = `Isolate ${lastName(ev.target)} <span class="p-pos">[${escapeHtml(ev.target?.position)||'?'}]</span>`;
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
    const outLbl = (OUT_LBL[opp.finalOutcome] || opp.finalOutcome || '').toUpperCase();
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

    const startCls = opp.isLongBall          ? 'st-long'
                   : opp.startType === 'GK'  ? 'st-gk'
                   : opp.startType === 'MID' ? 'st-mid'
                   : opp.isCounterAttack     ? 'st-ca'
                   : 'st-def';
    const startLbl = opp.isLongBall ? 'LONG' : (opp.startType || '?');

    const outCol = OUT_COL[opp.finalOutcome] || '#8a9ab0';
    const isPenalty = opp.steps.some(s => s.isPenalty);
    const outLbl = (OUT_LBL[opp.finalOutcome] || '') + (isPenalty ? ' (pen)' : '');

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
      counts[opp.teamSide][key] = (counts[opp.teamSide][key] || 0) + 1;
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
function renderLongBallSummary(opportunities) {
  const home = opportunities.filter(o => o.teamSide === 'home' && o.isLongBall);
  const away = opportunities.filter(o => o.teamSide === 'away' && o.isLongBall);
  if (!home.length && !away.length) return '';
  const shots = arr => arr.filter(o => o.hasShot).length;
  const goals = arr => arr.filter(o => o.hasGoal).length;
  let html = `<div class="dist-title">Long Balls</div>`;
  html += statBarRow('attempted', home.length, away.length, home.length, away.length);
  html += statBarRow('→ shot', shots(home), shots(away), shots(home), shots(away));
  if (goals(home) || goals(away))
    html += statBarRow('→ goal', goals(home), goals(away), goals(home), goals(away));
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
      const side = opp.teamSide;
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

// ── Offense vs. defense scatter ──────────────────────────────────────────────────
// The old single "chain total" metric silently summed attacker-side and defender-side
// numbers together — e.g. a brilliant TACKLE (good for the defense) counted the exact
// same direction as a brilliant PASS (good for the attack), so a high "total" could mean
// either side dominated. That's why it didn't say anything legible about good/bad or
// offense/defense. Split by who the value actually belongs to instead:
//   offense: pass, reception, shot   — the attacking side's own execution
//   defense: assistance, tackle, gkSave — the defending side's resistance (assistance is
//     the defender's support per the manual/narrative: "X got assistance, and was close"
//     describes the DEFENDER's positioning, not the attacker's)
// Plotting one dot per opportunity on those two axes, colored by outcome, shows directly
// whether goals cluster where offense is high and defense is low — the actual question
// "does chain quality predict goals" is asking, instead of one ambiguous number.
const OFFENSE_KEYS = ['pass', 'reception', 'shot'];
const DEFENSE_KEYS = ['assistance', 'tackle', 'gkSave'];
function sumStepValues(opp, keys) {
  let total = 0;
  opp.steps.forEach(s => {
    const v = s.values || {};
    keys.forEach(k => { if (v[k]?.value != null) total += v[k].value; });
  });
  return total;
}
function renderQualityScatter(opportunities) {
  const pts = opportunities.map(o => ({
    off: sumStepValues(o, OFFENSE_KEYS), def: sumStepValues(o, DEFENSE_KEYS),
    goal: o.hasGoal, shot: o.hasShot, side: o.teamSide,
  }));
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
  s.push(`<text x="${(PL+W-PR)/2}" y="${H-8}" text-anchor="middle" font-size="9" fill="#5a6f8c" font-family="monospace" letter-spacing="1">OFFENSE (pass + reception + shot) →</text>`);
  s.push(`<text x="0" y="0" text-anchor="middle" font-size="9" fill="#5a6f8c" font-family="monospace" letter-spacing="1" transform="translate(11 ${(PT+H-PB)/2}) rotate(-90)">DEFENSE (assist + tackle + save) →</text>`);

  return `<div class="dist-title">Offense vs Defense</div>
    <div class="qt-hint">One dot per opportunity. X = attacking side's execution, Y = defending side's resistance
      (assistance/tackle/save — higher is <em>better for the defense</em>). Gold = goal, bright = reached a shot,
      faint = didn't. If the theory holds, gold dots should cluster bottom-right — strong offense, weak defense.</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;background:#050b14;border-radius:6px;border:1px solid #1a2540">${s.join('')}</svg>`;
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

function renderStats(stats, homeTeam, awayTeam, opportunities) {
  let html = `<div style="padding:8px;overflow-y:auto;flex:1">`;
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
  }
  html += '</div>';
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASES  — opportunities/shots/goals/possession by game window
// ─────────────────────────────────────────────────────────────────────────────
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
    const bucket = stats[phaseIndexOf(opp.minute)]?.[opp.teamSide];
    if (!bucket) return;
    bucket.opps++;
    if (opp.hasShot) bucket.shots++;
    if (opp.hasGoal) bucket.goals++;
  });
  return stats;
}
function renderPhaseStats(match) {
  if (!match?.opportunities?.length) return '<div class="no-data" style="padding:20px 0">No match data.</div>';
  const stats = computePhaseStats(match);
  let html = `<div style="padding:8px;overflow-y:auto;flex:1">`;
  // The site's own Ball Possession stat is a single match-wide figure, not broken down by
  // time — there's no parsed data giving a real per-window possession share. Opportunity
  // share (each side's fraction of opportunities in that window) is the closest confident
  // proxy derivable from what's actually parsed, so it's labeled as exactly that rather
  // than passed off as the site's own possession number.
  html += `<div class="qt-hint">Opportunities/shots/goals are exact counts per window. "Poss." is each side's share of opportunities in that window, used as a proxy — FinalWhistle's own Ball Possession stat isn't broken down by time.</div>`;
  stats.forEach(s => {
    const totalOpps = s.home.opps + s.away.opps;
    const homePoss = totalOpps ? Math.round(s.home.opps / totalOpps * 100) : 0;
    const awayPoss = totalOpps ? 100 - homePoss : 0;
    html += `<div class="dist-title">${escapeHtml(s.label)}</div>`;
    html += statBarRow('Opportunities', s.home.opps, s.away.opps, s.home.opps, s.away.opps);
    html += statBarRow('Shots', s.home.shots, s.away.shots, s.home.shots, s.away.shots);
    if (s.home.goals || s.away.goals)
      html += statBarRow('Goals', s.home.goals, s.away.goals, s.home.goals, s.away.goals);
    html += statBarRow('Poss. (by opp. share)', homePoss + '%', awayPoss + '%', homePoss, awayPoss);
  });
  html += '</div>';
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQUAD  — tiredness/subs/position/mentality & style changes, split by team
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

function renderSquadColumn(match, side) {
  const events = (match.tacticalEvents || []).filter(ev => ev.teamSide === side);
  const byMinute = (a, b) => (a.minute ?? 0) - (b.minute ?? 0);

  const tiredness   = groupTirednessByPlayer(events.filter(ev => ev.type === 'TIREDNESS'));
  const subs        = events.filter(ev => ev.type === 'SUBSTITUTION').sort(byMinute);
  const posChanges  = events.filter(ev => ev.type === 'POSITION_CHANGE').sort(byMinute);
  const mentaStyle  = events.filter(ev => ev.type === 'MENTALITY_CHANGE' || ev.type === 'STYLE_CHANGE').sort(byMinute);

  const teamName = side === 'home' ? (match.meta?.homeTeam || 'Home') : (match.meta?.awayTeam || 'Away');
  const col = side === 'home' ? HC : AC;
  const section = (title, count, rowsHtml, emptyLabel) =>
    `<div class="dist-title">${escapeHtml(title)} (${count})</div>` +
    (count ? rowsHtml : `<div class="qt-hint">${emptyLabel}</div>`);

  let html = `<div style="flex:1;min-width:0">`;
  html += `<div class="ps-team" style="color:${col};border-color:${col}44">${escapeHtml(teamName)}</div>`;
  html += section('Tiredness', tiredness.length, tiredness.map(g => renderTirednessGroup(g, col)).join(''), 'No tiredness reports.');
  html += section('Substitutions', subs.length, subs.map(renderTacticalRow).join(''), 'No substitutions.');
  html += section('Position Changes', posChanges.length, posChanges.map(renderTacticalRow).join(''), 'No position changes.');
  html += section('Mentality & Style', mentaStyle.length, mentaStyle.map(renderTacticalRow).join(''), 'No mentality/style changes.');
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
// MAIN RENDER
// ─────────────────────────────────────────────────────────────────────────────
let _match       = null;
let _hFlowData   = null;
let _aFlowData   = null;
let _statusEvents = null; // sorted tacticalEvents used to resolve injury/tiredness at a given minute
let _teamFilter   = 'both'; // 'both' | 'home' | 'away' — which opportunities the list shows

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
  const op = dim ? '0.15' : '1';
  const homeFlow = $('flow-home'), awayFlow = $('flow-away');
  if (homeFlow) homeFlow.style.opacity = op;
  if (awayFlow) awayFlow.style.opacity = op;
}
let _hoveredIdx  = null;

function showErrors(errors, warnings) {
  let html = '';
  // Mostly internally-authored message templates, but caught-exception messages end up
  // in here too (e.message) and aren't guaranteed to be free of HTML metacharacters.
  if (errors?.length)
    html += `<div class="err-banner">${errors.map(e=>`<div>${escapeHtml(e)}</div>`).join('')}</div>`;
  if (warnings?.length)
    html += `<div class="warn-banner">${warnings.map(w=>`<span class="tag-warn">WARN</span> ${escapeHtml(w)}`).join('<br>')}</div>`;
  $('errors').innerHTML = html;
}

// ── Scorers / assists (for the header) ───────────────────────────────────────────
// The "assist" isn't a field the parser tags directly — it's the last pass step before
// the goal whose target is the scorer (the pass that actually put them through), which
// covers the normal case (PB_PASS/SP_PASS/FK_PASS/START_PASS → shot) and naturally comes
// back null for solo efforts (dribble from deep, direct free kick) where no such pass exists.
const PASS_STEP_TYPES = ['START_PASS','PB_PASS','SP_PASS','FK_PASS'];
function findAssist(opp, goalStep) {
  const shooterName = goalStep.shooter?.name;
  if (!shooterName) return null;
  let assist = null;
  for (const s of opp.steps) {
    if (s === goalStep) break;
    if (PASS_STEP_TYPES.includes(s.stepType) && s.to?.name === shooterName) assist = s.from;
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

function render(scrape) {
  // Parse first so we have final score for the header + any parse warnings
  _match = null;
  let parseWarnings = [];
  if (scrape.narrative) {
    try {
      _match = parseMatch(scrape.telemetry||'', scrape.narrative);
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
  renderOppSummaryAndList();

  // Stats
  $('panel-stats').innerHTML = renderStats(scrape.statistics, scrape.homeTeam, scrape.awayTeam, opportunities);
  $('panel-phases').innerHTML = renderPhaseStats(_match);
  $('panel-squad').innerHTML = renderSquadTab(_match);

  // Pitch — rebuild entire SVG as one string (SVG namespace safe)
  try {
    _hFlowData = buildBaseFlow(opportunities, 'home');
    _aFlowData = buildBaseFlow(opportunities, 'away');
    buildBasePitch();
  } catch(e) {
    showErrors([...(scrape.errors||[]), 'PITCH_ERROR: '+e.message]);
  }
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
  const openBlock = document.querySelector('.step-block.open');
  if (openBlock && _match) {
    const pinnedIdx = parseInt(openBlock.id.replace('steps-', ''));
    const pinnedOpp = _match.opportunities[pinnedIdx];
    if (pinnedOpp) { showPitchDetail(pinnedOpp, true); return; }
  }

  setHighlight('', false);
  $('pass-summary').style.display = 'none';
  $('raw-panel').style.display = 'none';
}

// The currently-expanded step-block IS the pin/selection state — there's no separate
// variable to keep in sync, just a query for whichever block has .open, mirrored onto the
// matching timeline marker and opp-row. Called from clickOpp so every path that can open/
// close a row (a direct row click, or a timeline marker click via clickTimelineMarker)
// stays in sync.
function syncPinnedState() {
  const openBlock = document.querySelector('.step-block.open');
  const openIdx = openBlock ? openBlock.id.replace('steps-', '') : null;
  const idx = openIdx == null ? null : parseInt(openIdx);
  document.querySelectorAll('.tl-marker').forEach(m => {
    m.classList.toggle('selected', parseInt(m.dataset.idx) === idx);
  });
  document.querySelectorAll('.opp-row').forEach(r => {
    r.classList.toggle('pinned', parseInt(r.dataset.idx) === idx);
  });
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
    const data = await chrome.runtime.sendMessage({ type: 'SCRAPE_PAGE' });
    render(data);
    $('status').textContent = data.ok ? 'OK' : `${data.errors?.length||0} error(s)`;
  } catch(e) {
    $('errors').innerHTML = `<div class="err-banner">Error: ${escapeHtml(e.message)}</div>`;
    $('status').textContent = 'Error';
  } finally { $('btn-scrape').disabled = false; }
});

$('btn-load').addEventListener('click', async () => {
  const s = await chrome.storage.local.get('lastScrape');
  if (s.lastScrape) { render(s.lastScrape); $('status').textContent = 'Loaded'; }
  else $('status').textContent = 'Nothing stored';
});

$('btn-clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('lastScrape');
  _match = null;
  $('status').textContent = 'Cleared';
  ['errors','meta-bar','opp-summary','timeline-wrap'].forEach(id => { const e=$( id); if(e){ e.innerHTML=''; e.style.display=''; }});
  $('tabs').style.display = 'none';
  $('opp-list').innerHTML = '<div class="no-data">Scrape a match to begin</div>';
  _hFlowData = null; _aFlowData = null;
  buildBasePitch();
});

// Open a FinalWhistle tab (focusing one if it's already open) plus a second, blank
// analyser tab — so a different match can be picked over there and scraped into its
// own tab, side by side with this one, without touching what's currently on screen
// here. The new tab deliberately does NOT auto-load from storage (see the ?fresh=1
// branch below) — storage.local's "lastScrape" is a single shared slot, and loading
// it here would just show whatever this tab's own last scrape was.
$('btn-new-tab').addEventListener('click', async () => {
  const fwTabs = await chrome.tabs.query({ url: '*://*.finalwhistle.org/*' });
  if (fwTabs.length) {
    const mostRecent = mostRecentlyAccessed(fwTabs);
    await chrome.tabs.update(mostRecent.id, { active: true });
    await chrome.windows.update(mostRecent.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://www.finalwhistle.org' });
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?fresh=1' });
});

// Launch behavior depends on how this tab was opened:
//   ?autoscrape=1 — fresh launch via the toolbar icon (background.js) — clear any
//                   previous scrape and pull in the current match immediately,
//                   reusing the exact same flow as clicking Scrape by hand.
//   ?fresh=1      — opened via "New Tab" above, for comparing a different match —
//                   start blank and wait for the user to Scrape once ready.
//   (neither)     — plain viewer.html (e.g. a reload) — auto-load the last scrape.
const _launchParams = new URLSearchParams(location.search);
if (_launchParams.get('autoscrape') === '1') {
  chrome.storage.local.remove('lastScrape').then(() => $('btn-scrape').click());
} else if (_launchParams.get('fresh') === '1') {
  $('status').textContent = 'Pick a match on FinalWhistle, then Scrape';
} else {
  chrome.storage.local.get('lastScrape', ({lastScrape}) => {
    if (lastScrape) { render(lastScrape); $('status').textContent = 'Loaded'; }
  });
}
