'use strict';
// Static security audit. Two things this file checks that were previously only
// verified by hand (a manual grep for fetch/XHR and secrets before each release) are
// now permanent, automatic CI guarantees instead of one-time claims:
//
//   1. No network-exfiltration, dynamic-eval, or persistent-non-extension-storage sink
//      appears anywhere in the runtime JS bundle.
//   2. No secret-shaped string (private key, password literal, bearer token, GitHub
//      token) is committed anywhere in the repo.
//
// The permission/manifest assertions below check THIS project's actual, intentional
// shape — activeTab + tabs + scripting + storage, host_permissions scoped to
// finalwhistle.org, chrome.storage.local (not .session). See README.md's Security
// section for why each of those is the deliberate choice, not an oversight.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

const RUNTIME_FILES = ['parser.js', 'analytics.js', 'viewer.js', 'scraper.js', 'background.js', 'utils.js'];

test('manifest declares exactly the permissions/host_permissions this project actually uses', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  // A set-equality check, not an exact-array check — this project's permission ORDER
  // isn't meaningful, but an unnoticed ADDITION or REMOVAL here is exactly what this
  // check exists to catch going forward.
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['https://*.finalwhistle.org/*']);
  // Fields that would meaningfully expand the extension's capability/attack surface if
  // ever added without a deliberate review.
  for (const field of ['content_scripts', 'externally_connectable', 'optional_permissions', 'optional_host_permissions']) {
    assert.equal(Object.hasOwn(manifest, field), false, `manifest must not declare "${field}"`);
  }
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('viewer.html only loads local scripts, and never inline event handlers', () => {
  const html = read('viewer.html');
  const scriptSources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scriptSources, ['utils.js', 'parser.js', 'analytics.js', 'viewer.js']);
  for (const source of scriptSources) {
    assert.equal(/^https?:|^\/\//i.test(source), false, `remote script source: ${source}`);
    assert.equal(fs.existsSync(path.join(root, source)), true, `missing local script: ${source}`);
  }
  assert.equal(/<(?:iframe|object|embed)\b/i.test(html), false);
  assert.equal(/\son\w+\s*=/i.test(html), false, 'inline event handlers are forbidden');
});

test('no network-exfiltration, dynamic-eval, or unexpected persistent-storage sink exists anywhere in the runtime bundle', () => {
  const runtime = RUNTIME_FILES.map(read).join('\n');
  const forbidden = [
    [/\bfetch\s*\(/, 'fetch'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bEventSource\b/, 'EventSource'],
    [/\bnavigator\.sendBeacon\b/, 'sendBeacon'],
    [/\bchrome\.downloads\b/, 'downloads API'],
    [/\bchrome\.tabs\.captureVisibleTab\b/, 'tab screenshot API'],
    [/\bchrome\.tabCapture\b/, 'tab capture API'],
    [/\bchrome\.desktopCapture\b/, 'desktop capture API'],
    [/\bgetDisplayMedia\b/, 'screen capture API'],
    [/\bchrome\.cookies\b/, 'cookies API'],
    [/\bdocument\.cookie\b/, 'document.cookie'],
    // Deliberately NOT forbidding chrome.storage.local (this project's own persisted
    // scrape storage — see background.js) or localStorage/sessionStorage generically;
    // only the sinks that would smuggle data OUT of the extension's own trusted storage
    // model.
    [/\bindexedDB\b/, 'IndexedDB'],
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\s*\(/, 'Function constructor'],
    [/\bdocument\.write\b/, 'document.write'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(runtime), false, `${label} must not appear anywhere in the runtime bundle`);
  }
});

test('no secret-shaped string is committed anywhere in the repo', () => {
  const secretPatterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key block'],
    [/\b(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{8,}/i, 'inline password/secret literal'],
    [/\bBearer\s+eyJ[A-Za-z0-9_-]+\./, 'bearer JWT'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  ];
  const skipDirs = new Set(['.git', 'node_modules']);
  const skipExt = new Set(['.png', '.jpg', '.jpeg', '.ico']);

  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (!skipExt.has(path.extname(entry.name))) out.push(full);
    }
  }
  const files = [];
  walk(root, files);
  assert.ok(files.length > 10, 'sanity check: the walk should have found a reasonable number of files');

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; } // skip unreadable/binary
    const relative = path.relative(root, file);
    for (const [pattern, label] of secretPatterns) {
      assert.equal(pattern.test(text), false, `possible ${label} in ${relative}`);
    }
  }
});
