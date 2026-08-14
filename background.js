'use strict';

/**
 * Extension service worker. Toolbar icon click opens/focuses the viewer tab;
 * SCRAPE_PAGE messages from viewer.js are relayed here and fulfilled by
 * injecting scraper.js into the active FinalWhistle tab via chrome.scripting.
 */
importScripts('utils.js');

// D11 (Phase D, storage hardening): tags the shape of what gets persisted to
// chrome.storage.local, so a future change to that shape has something to check against
// instead of guessing whether an old stored object predates it. viewer.js's render()
// does not currently read this — it already tolerates a completely bare
// {narrative, telemetry, homeTeam, awayTeam} object with no other fields at all (see
// viewer.test.js's old-scrape compatibility tests) — this exists purely so a REAL future
// migration has a version to branch on, without introducing a migration framework now.
const LASTSCRAPE_SCHEMA_VERSION = 1;

chrome.action.onClicked.addListener(async () => {
  const base = chrome.runtime.getURL('viewer.html');
  // '*' suffix so an already-open tab is found whether or not it carries the
  // ?autoscrape=1 / ?fresh=1 query string viewer.html gets launched with below.
  const existing = await chrome.tabs.query({ url: base + '*' });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    // Fresh launch (not already open in a tab) — the tab clears any previous
    // scrape and pulls in whatever match report is currently open itself, via
    // the ?autoscrape=1 flag reusing the normal Scrape button flow, so it opens
    // already showing current data instead of stale leftovers from last time.
    chrome.tabs.create({ url: base + '?autoscrape=1' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCRAPE_PAGE') {
    scrapeActiveTab()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, errors: [String(err)] }));
    return true;
  }
});

async function scrapeActiveTab() {
  // Query for FinalWhistle tabs directly (matches host_permissions) instead of listing
  // every tab and filtering by URL substring, and pick the most-recently-accessed one
  // with a single pass instead of sorting the whole result just to take the max.
  const tabs = await chrome.tabs.query({ url: 'https://*.finalwhistle.org/*' });

  // Prefer a tab actually on a match report (/match/ in the URL) over some other
  // FinalWhistle page (league table, team page, etc.) that happens to be more
  // recently accessed — a scrape only makes sense against a match report, so
  // being "the newest FinalWhistle tab" isn't enough on its own.
  const matchTabs = tabs.filter(t => t.url?.includes('/match/'));
  const fwTab = mostRecentlyAccessed(matchTabs.length ? matchTabs : tabs);

  if (!fwTab) {
    // Fall back to active tab
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.url?.includes('finalwhistle.org')) {
      return { ok: false, errors: ['No FinalWhistle tab found. Open a match report first.'] };
    }
    return runScraper(active.id);
  }
  return runScraper(fwTab.id);
}

async function runScraper(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['scraper.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => fwScrapeWithTelemetry(),
  });
  const data = result || { ok: false, errors: ['No result from scraper'] };
  if (data.narrative || data.telemetry) {
    await chrome.storage.local.set({ lastScrape: { ...data, schemaVersion: LASTSCRAPE_SCHEMA_VERSION } });
  }
  return data;
}
