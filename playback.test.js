'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMatch } = require('./parser.js');
const { buildPlaybackCues, playbackPartialOpportunity } = require('./playback.js');

function fixture(name) {
  const dir = path.join(__dirname, 'fixtures', name);
  const narrative = fs.readFileSync(path.join(dir, 'narrative.txt'), 'utf8');
  const telemetry = fs.readFileSync(path.join(dir, 'telemetry.txt'), 'utf8');
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  return parseMatch(telemetry, narrative, {
    homeTeam: expected.homeTeam || 'Home Team',
    awayTeam: expected.awayTeam || 'Away Team',
  });
}

test('open-play opportunity becomes ordered start, flow, shot and end cues', () => {
  const match = fixture('open-play');
  const cues = buildPlaybackCues(match, { opportunityIndex: 0 });
  assert.deepEqual(cues.map(c => c.kind), [
    'opportunity.start', 'flow.pass', 'flow.duel', 'flow.pass', 'flow.duel',
    'shot.strike', 'shot.resolve', 'opportunity.end',
  ]);
  assert.equal(cues.find(c => c.kind === 'shot.resolve').outcome, 'GOAL');
  assert.equal(cues.every(c => c.precision === 'schematic'), true);
});

test('counter-attack rebound chain preserves both shots, recoveries and away ownership', () => {
  const match = fixture('rebound-second-shot-save');
  const cues = buildPlaybackCues(match);
  const strikes = cues.filter(c => c.kind === 'shot.strike');
  const resolutions = cues.filter(c => c.kind === 'shot.resolve');
  const recoveries = cues.filter(c => c.kind === 'flow.recovery');
  assert.deepEqual(strikes.map(c => [c.actor.name, c.attackingSide, c.variant]), [
    ['Marin Burgă', 'away', 'standard'],
    ['Ceferino Hinojosa', 'away', 'lob'],
  ]);
  assert.deepEqual(resolutions.map(c => [c.variant, c.goalkeeper.name]), [
    ['fumble', 'Vlastimil Šindelář'], ['save', 'Vlastimil Šindelář'],
  ]);
  const reboundRecovery = recoveries.find(c => c.actor?.name === 'Ceferino Hinojosa');
  assert.ok(reboundRecovery, 'the first-shot fumble should retain its named recovery');
  assert.equal(reboundRecovery.attackingSide, 'away');
});

test('recovery and clearance remain cues after the second fumble without a third shot', () => {
  const match = fixture('rebound-second-shot-clearance');
  const cues = buildPlaybackCues(match);
  assert.equal(cues.filter(c => c.kind === 'shot.strike').length, 2);
  const lastRecovery = cues.filter(c => c.kind === 'flow.recovery').at(-1);
  assert.equal(lastRecovery.actor.name, 'Eusebio Caruso');
  assert.equal(lastRecovery.attackingSide, 'away', 'recovery ownership follows the named player, not the preceding shot');
  assert.equal(lastRecovery.variant, 'recovered-and-cleared');
  assert.equal(lastRecovery.outcome, 'CLEARED');
});

test('tactical events share the parser sequence order with opportunities', () => {
  const match = fixture('same-minute-tactical-events');
  const cues = buildPlaybackCues(match);
  const firstOpportunity = cues.findIndex(c => c.kind === 'opportunity.start');
  const tactical = cues.filter(c => c.kind === 'match.event');
  assert.ok(tactical.length >= 3);
  assert.equal(tactical.every(c => cues.indexOf(c) < firstOpportunity), true);
});

test('string-valued tactical actors remain visible in playback', () => {
  const cues = buildPlaybackCues({ opportunities: [], tacticalEvents: [
    { type: 'INJURY', minute: 8, sequence: 1, player: 'Named Player' },
  ] });
  assert.equal(cues[0].actor.name, 'Named Player');
});

test('opportunity scope excludes other opportunities and match-level tactical events', () => {
  const match = fixture('open-play');
  const cues = buildPlaybackCues(match, { opportunityIndex: 1 });
  assert.equal(cues.every(c => c.opportunityIndex === 1), true);
  assert.equal(cues.some(c => c.kind === 'match.event'), false);
});

test('partial opportunity is non-mutating and focuses a later rebound shot', () => {
  const match = fixture('rebound-second-shot-save');
  const originalSteps = match.opportunities[0].steps;
  const secondStrike = buildPlaybackCues(match).filter(c => c.kind === 'shot.strike')[1];
  const partial = playbackPartialOpportunity(match, secondStrike);
  assert.notEqual(partial, match.opportunities[0]);
  assert.notEqual(partial.steps, originalSteps);
  assert.equal(partial.steps.at(-1).shooter.name, 'Ceferino Hinojosa');
  assert.equal(partial.playbackFocusStepIndex, secondStrike.stepIndex);
  assert.equal(match.opportunities[0].steps, originalSteps, 'source opportunity must not be mutated');
});

test('cue model does not invent coordinates, save direction, cross or red-card fields', () => {
  const cues = buildPlaybackCues(fixture('rebound-second-shot-post'));
  for (const cue of cues) {
    for (const unsupported of ['x', 'y', 'saveDirection', 'cross', 'redCard']) {
      assert.equal(Object.hasOwn(cue, unsupported), false, `${cue.id} invented ${unsupported}`);
    }
  }
});

test('normal-speed cues remain visible long enough to read each action', () => {
  const cues = buildPlaybackCues(fixture('open-play'), { opportunityIndex: 0 });
  const actions = cues.filter(c => ['flow.pass', 'flow.duel', 'shot.strike', 'shot.resolve'].includes(c.kind));
  assert.equal(actions.every(c => c.durationMs >= 2800), true);
  assert.equal(cues.find(c => c.kind === 'shot.resolve' && c.variant === 'goal').durationMs, 4000);
});
