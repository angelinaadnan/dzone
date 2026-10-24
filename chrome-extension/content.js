// Santo Dashboard Token Sync — content script
// Runs on iris.accurate.id, detects _dsi in URL, sends to Cloudflare Worker

const WORKER_URL = 'https://dz-one.pages.dev/api/accurate';
const SYNC_INTERVAL_MS = 30_000; // cek tiap 30 detik
const STORAGE_KEY = 'last_synced_dsi';

function getDsiFromUrl() {
  try {
    return new URL(location.href).searchParams.get('_dsi') || '';
  } catch {
    return '';
  }
}

async function syncDsi(dsi, dbLabel) {
  try {
    const resp = await fetch(`${WORKER_URL}?update_dsi=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dsi, db: dbLabel }),
    });
    if (resp.ok) {
      console.log(`[Santo Sync] ✅ _dsi updated (${dbLabel}):`, dsi.slice(0, 20) + '...');
      // Show brief badge notification via storage (background script reads this)
      chrome.storage.local.set({ last_sync: { dsi: dsi.slice(0, 20), db: dbLabel, time: Date.now() } });
    } else {
      console.warn('[Santo Sync] ⚠️ Worker responded:', resp.status);
    }
  } catch (e) {
    console.warn('[Santo Sync] ❌ Failed to sync:', e.message);
  }
}

async function trySync() {
  const dsi = getDsiFromUrl();
  if (!dsi) return; // no _dsi in URL yet, wait

  // Determine which DB (ADL=74419, GROUP=131948) — from sessionStorage
  const sessionKeys = Object.keys(sessionStorage);
  const isGroup = sessionKeys.some(k => k.includes('131948'));
  const dbLabel = isGroup ? 'GROUP' : 'ADL';

  // Check if already synced this exact value
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY] === dsi) return; // already synced

  await syncDsi(dsi, dbLabel);
  await chrome.storage.local.set({ [STORAGE_KEY]: dsi });
}

// Run immediately and then poll (URL may change via pushState without page reload)
trySync();
const timer = setInterval(trySync, SYNC_INTERVAL_MS);

// Also listen for URL changes (pushState / replaceState)
const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);
history.pushState = function(...args) { origPushState(...args); trySync(); };
history.replaceState = function(...args) { origReplaceState(...args); trySync(); };
window.addEventListener('popstate', trySync);
