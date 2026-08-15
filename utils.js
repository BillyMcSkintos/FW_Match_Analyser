'use strict';
// Tiny WebExtension compatibility boundary. Firefox exposes the Promise-based
// `browser` namespace; Chromium exposes the same MV3 APIs through `chrome`.
// `var` is deliberate: classic extension scripts share one global environment, and
// this file is loaded by both viewer.html and the background context.
var ext = globalThis.browser ?? globalThis.chrome;

// Shared between background.js (service worker/event page) and viewer.js — both need
// "which of these tabs was used most recently", so it lives in one place instead of
// two near-identical copies. If lastAccessed is unavailable, prefer the sole active or
// sole matching tab; never silently choose an arbitrary tab from an unordered set.
function mostRecentlyAccessed(tabs) {
  const timestamped = tabs.filter(tab => Number.isFinite(tab.lastAccessed));
  if (timestamped.length) {
    return timestamped.reduce((latest, tab) =>
      (!latest || tab.lastAccessed > latest.lastAccessed) ? tab : latest, null);
  }
  const active = tabs.filter(tab => tab.active === true);
  if (active.length === 1) return active[0];
  return tabs.length === 1 ? tabs[0] : null;
}
