'use strict';
// Shared between background.js (service worker, via importScripts) and viewer.js
// (extension page, via <script src>) — both need "which of these tabs was used most
// recently", so it lives in one place instead of two near-identical copies.
function mostRecentlyAccessed(tabs) {
  return tabs.reduce((latest, tab) =>
    (!latest || (tab.lastAccessed || 0) > (latest.lastAccessed || 0)) ? tab : latest, null);
}
