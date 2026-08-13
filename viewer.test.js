'use strict';
// Regression tests for pure logic inside viewer.js (player status resolution). viewer.js
// isn't a CommonJS module — it's a plain browser <script> that expects `document`,
// `chrome`, and `location` as globals — so it's loaded here with node:vm into a minimal
// stub context rather than duplicating its logic in the test (a copy could silently
// drift from the real implementation and stop being a regression test at all).
//
// Run with:  node --test viewer.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeStubElement() {
  const el = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    children: [], textContent: '', innerHTML: '',
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return el;
}

function loadViewerContext() {
  const src = fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8');
  const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
  const sandbox = {
    console,
    document: {
      getElementById() { return makeStubElement(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeStubElement(); },
    },
    chrome: {
      storage: { local: { get(_k, cb) { if (cb) cb({}); }, set() {}, remove() {} } },
      runtime: { getURL: p => 'chrome-extension://test/' + p, sendMessage: async () => ({}) },
      tabs: { query: async () => [] },
    },
    location: { search: '' },
    URLSearchParams,
  };
  const context = vm.createContext(sandbox);
  // parser.js's functions (qualityLabel, qv, tierColor-adjacent) are referenced by
  // viewer.js at file scope in a couple of spots, so load it into the same context
  // first, mirroring how viewer.html loads parser.js before viewer.js.
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(src, context, { filename: 'viewer.js' });
  return context;
}

test('half time clears reported tiredness but preserves injury', () => {
  const ctx = loadViewerContext();
  const events = [
    { minute: 20, type: 'INJURY', player: { name: 'Player A' }, severity: 'LIGHT' },
    { minute: 30, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'TIRED' },
    { minute: 45, type: 'HALF_TIME' },
  ];
  const before = ctx.playerStatusAt(events, 'Player A', 44);
  assert.equal(before.injury, 'LIGHT');
  assert.equal(before.tiredness, 'TIRED');

  const after = ctx.playerStatusAt(events, 'Player A', 46);
  assert.equal(after.injury, 'LIGHT', 'injury must persist across half time');
  assert.equal(after.tiredness, null, 'first-half tiredness report must not carry into the second half');
});

test('tiredness reported again in the second half is tracked normally', () => {
  const ctx = loadViewerContext();
  const events = [
    { minute: 30, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'TIRED' },
    { minute: 45, type: 'HALF_TIME' },
    { minute: 70, type: 'TIREDNESS', player: { name: 'Player A' }, level: 'VERY_TIRED' },
  ];
  const late = ctx.playerStatusAt(events, 'Player A', 80);
  assert.equal(late.tiredness, 'VERY_TIRED');
});

test('an uninjured, untired player reports both as null', () => {
  const ctx = loadViewerContext();
  const result = ctx.playerStatusAt([], 'Nobody', 10);
  assert.equal(result.injury, null);
  assert.equal(result.tiredness, null);
});
