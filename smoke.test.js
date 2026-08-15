'use strict';
// Script-load-order smoke test. MANDATORY: this protects against a production-breaking
// failure class node --check cannot see.
//
// Classic <script src="..."> tags loaded into the same page share ONE global lexical
// environment. A duplicate top-level `const`/`let` name across two files only throws
// when BOTH are evaluated together in that shared scope — `node --check` runs each file
// in isolation and is blind to it. This is not hypothetical: analytics.js and viewer.js
// once both declared top-level `const LANE_MAP` and `const PASS_STEP_TYPES` with the
// same names; the extension parsed every individual file cleanly and still threw
// `SyntaxError: Identifier 'LANE_MAP' has already been declared` the moment a real
// browser (or this test) loaded them together in viewer.html's actual order.
//
// The load order below is not hand-copied from viewer.html — it's extracted directly
// from viewer.html's own <script src="..."> tags, so a reordering or a newly added
// script file is picked up automatically instead of silently drifting out of sync with
// a second, hand-maintained "order" living only in this test.
//
// Run with:  node --test smoke.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function extractScriptOrder(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const re = /<script\s+src="([^"]+)"\s*><\/script>/g;
  const files = [];
  let m;
  while ((m = re.exec(html))) files.push(m[1]);
  return files;
}

function makeStubElement() {
  return {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    children: [], textContent: '', innerHTML: '',
    addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; },
  };
}

test('viewer.html\'s own script order loads cleanly into one shared context, with no lexical collision', () => {
  const files = extractScriptOrder(path.join(__dirname, 'viewer.html'));
  assert.ok(files.length >= 3, `expected viewer.html to reference several scripts; found: ${JSON.stringify(files)}`);
  // Fail loudly (not just "0 files found") if the extraction regex itself stops matching
  // viewer.html's actual markup — an empty/wrong list would make every check below
  // vacuously pass and silently stop protecting anything.
  assert.ok(files.includes('viewer.js'), 'viewer.html should reference viewer.js — script-order extraction may be broken');

  const sandbox = {
    console,
    document: {
      getElementById() { return makeStubElement(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeStubElement(); },
      body: { addEventListener() {} },
    },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { getURL: p => 'chrome-extension://test/' + p, sendMessage: async () => ({}) },
      tabs: { query: async () => [], update: async () => {}, create: async () => {} },
      windows: { update: async () => {} },
    },
    location: { search: '' },
    URLSearchParams,
  };
  const context = vm.createContext(sandbox);

  // Every prior file must already be loaded into `context` when the next one runs
  // (never test each file in its own isolated context) — a duplicate top-level const/let
  // only surfaces once a LATER script in the SAME shared scope redeclares the same name.
  for (const file of files) {
    const filePath = path.join(__dirname, file);
    assert.ok(fs.existsSync(filePath), `viewer.html references "${file}" but that file does not exist`);
    const src = fs.readFileSync(filePath, 'utf8');
    try {
      vm.runInContext(src, context, { filename: file });
    } catch (e) {
      assert.fail(`${file} failed to load into the shared context after [${files.slice(0, files.indexOf(file)).join(', ')}] were already loaded: ${e.message}`);
    }
  }

  // Public surface each layer is expected to expose to the next (parser.js →
  // analytics.js → viewer.js). Missing any of these means a script silently failed to
  // define what a later script depends on, even if nothing threw outright.
  const expectedGlobals = [
    'parseMatch', 'tacticalStateAt', 'buildTacticalPhases', 'phaseIdAt',       // parser.js
    'opportunityFunnel', 'phasePerformance', 'defensiveFailureChains',        // analytics.js
    'turnoverAnalysis', 'counterAttackAnalysis',                              // analytics.js
    'render', 'escapeHtml',                                                   // viewer.js
  ];
  for (const name of expectedGlobals) {
    assert.notEqual(typeof context[name], 'undefined',
      `expected global "${name}" to be defined after loading all of viewer.html's scripts, but it was not`);
  }
});
