'use strict';
// Shared fixture builders used by more than one *.test.js file. Test-only — never
// loaded by viewer.html or shipped in the packaged extension (see package.json's
// webExt.ignoreFiles). Keep this file small: a helper only belongs here once it's
// actually duplicated verbatim across two or more test files, not preemptively.

const HA = { homeTeam: 'Home Team', awayTeam: 'Away Team' };

// A minimal, real midfield-opportunity narrative block (used by both parser.test.js and
// analytics.test.js as a throwaway "just needs a valid opportunity" fixture).
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

// A stub DOM element shape sufficient for viewer.js's rendering code to run against in
// node:vm without a real DOM (used by both viewer.test.js and smoke.test.js).
function makeStubElement() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], textContent: '', innerHTML: '',
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

module.exports = { HA, midOppLines, midTelemetryLines, makeStubElement };
