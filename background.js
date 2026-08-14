'use strict';

/**
 * Extension service worker. Toolbar icon click opens/focuses the viewer tab;
 * SCRAPE_PAGE messages from viewer.js are relayed here and fulfilled by
 * injecting scraper.js into the active FinalWhistle tab via chrome.scripting.
 */
importScripts('utils.js');

// Tags the shape of what gets persisted to chrome.storage.local, so a future change to
// that shape has something to check against instead of guessing whether an old stored
// object predates it. viewer.js's render() does not currently read this — it already
// tolerates a completely bare {narrative, telemetry, homeTeam, awayTeam} object with no
// other fields at all (see viewer.test.js's old-scrape compatibility tests) — this
// exists purely so a real future migration has a version to branch on, without
// introducing a migration framework now.
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

// chrome.runtime.onMessage already only fires for this extension's own contexts by
// default (no externally_connectable is declared in manifest.json, so arbitrary web
// pages/other extensions can't reach this listener at all) — this narrows it further,
// to specifically the packaged viewer page, as defense-in-depth against any future
// content script or extension page this project might add later that shouldn't be able
// to trigger a scrape.
function isTrustedViewerSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!Number.isSafeInteger(sender.tab?.id)) return false;
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/viewer.html';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCRAPE_PAGE') {
    if (!isTrustedViewerSender(sender)) {
      sendResponse({ ok: false, errors: ['Rejected a scrape request from an unexpected sender.'] });
      return;
    }
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

// scraper.js runs INJECTED INTO FinalWhistle's own page (chrome.scripting.executeScript),
// sharing that page's JS realm — a compromised or just buggy page could tamper with what
// comes back, including prototype-polluting the object, before background.js stores or
// returns it. sanitizeScrapeResult() below (used by runScraper()) is the guard against
// that, applied to every scrape before it's persisted or handed back to the caller.
//
// It DEGRADES rather than rejects wherever the data is merely oversized but still
// usable — narrative/telemetry get truncated with a warning, not thrown away, matching
// this project's "a technicality shouldn't sink an otherwise-usable scrape" philosophy
// (scraper.js's STATS_NOT_FOUND is a warning, not a fatal error, for the same reason).
// Only a fundamentally hostile shape — not a plain record at all, or a core field with a
// type that makes no sense whatsoever — is rejected outright.
const SCRAPE_LIMITS = Object.freeze({
  narrativeChars: 250_000,
  telemetryChars: 250_000,
  teamNameChars: 160,
  statisticRows: 250,
  statisticLabelChars: 160,
  statisticValueChars: 80,
  messages: 100,
  messageChars: 2_000,
});

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizedStringArray(value, maxEntries, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => typeof entry === 'string')
    .slice(0, maxEntries)
    .map(entry => entry.length > maxChars ? entry.slice(0, maxChars) : entry);
}

function sanitizedStatistics(value) {
  if (!isPlainRecord(value)) return null;
  const clean = {};
  for (const key of Object.keys(value).slice(0, SCRAPE_LIMITS.statisticRows)) {
    const row = value[key];
    if (typeof key !== 'string' || !isPlainRecord(row) ||
        typeof row.home !== 'string' || typeof row.away !== 'string') continue;
    const label = key.slice(0, SCRAPE_LIMITS.statisticLabelChars);
    clean[label] = {
      home: row.home.slice(0, SCRAPE_LIMITS.statisticValueChars),
      away: row.away.slice(0, SCRAPE_LIMITS.statisticValueChars),
    };
  }
  return Object.keys(clean).length ? clean : null;
}

function sanitizeScrapeResult(value) {
  if (!isPlainRecord(value)) return null;
  if (value.narrative != null && typeof value.narrative !== 'string') return null;
  if (value.telemetry != null && typeof value.telemetry !== 'string') return null;

  const truncationNotes = [];
  const bound = (str, max, label) => {
    if (typeof str !== 'string') return null;
    if (str.length > max) { truncationNotes.push(`${label} exceeded the size limit and was truncated to ${max.toLocaleString()} characters.`); return str.slice(0, max); }
    return str;
  };

  const errors = sanitizedStringArray(value.errors, SCRAPE_LIMITS.messages, SCRAPE_LIMITS.messageChars);
  const warnings = sanitizedStringArray(value.warnings, SCRAPE_LIMITS.messages, SCRAPE_LIMITS.messageChars);

  // bound() must run (and populate truncationNotes) before the `warnings` field below is
  // built — object-literal properties evaluate left to right, so computing `warnings`
  // inline ahead of these calls would always see an empty truncationNotes array.
  const narrative = bound(value.narrative, SCRAPE_LIMITS.narrativeChars, 'narrative');
  const telemetry = bound(value.telemetry, SCRAPE_LIMITS.telemetryChars, 'telemetry');
  const homeTeam = bound(value.homeTeam, SCRAPE_LIMITS.teamNameChars, 'homeTeam');
  const awayTeam = bound(value.awayTeam, SCRAPE_LIMITS.teamNameChars, 'awayTeam');

  return {
    ok: errors.length === 0,
    errors,
    warnings: [...warnings, ...truncationNotes],
    narrative,
    telemetry,
    statistics: sanitizedStatistics(value.statistics),
    homeTeam,
    awayTeam,
    url: typeof value.url === 'string' ? value.url : null,
    scrapedAt: Number.isSafeInteger(value.scrapedAt) ? value.scrapedAt : Date.now(),
  };
}

async function runScraper(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['scraper.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => fwScrapeWithTelemetry(),
  });
  const data = sanitizeScrapeResult(result) || { ok: false, errors: ['No result from scraper'] };
  if (data.narrative || data.telemetry) {
    await chrome.storage.local.set({ lastScrape: { ...data, schemaVersion: LASTSCRAPE_SCHEMA_VERSION } });
  }
  return data;
}
