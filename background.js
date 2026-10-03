// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Leon Priest (GitHub: 7h3v01d)
//
// Price Ledger — background service worker
// Content scripts can't call chrome.notifications directly (that API is
// only available in extension contexts), so they message this worker
// whenever they record a genuine new low, and this handles the OS
// notification plus a small "unseen alerts" badge on the toolbar icon.

importScripts("shared.js", "ledger.js"); // fmt(), sanitizeCurrency(), createLedger(), ...

// MV3 service workers can be terminated after ~30s of inactivity and
// respawned fresh on the next event — any plain in-memory object here
// (like a bare `{}` mapping notification IDs to URLs) can vanish between
// a notification being shown and the person actually clicking it days —
// or even seconds — later. chrome.storage.session persists across worker
// restarts for the life of the browser session, which is exactly the
// right lifetime for "click this notification" state.
const SESSION_STORAGE_AVAILABLE = typeof chrome.storage.session !== "undefined";
const notifStore = SESSION_STORAGE_AVAILABLE ? chrome.storage.session : chrome.storage.local;

async function setPendingNotificationUrl(notificationId, url) {
  await notifStore.set({ [`notif:${notificationId}`]: url });
}

async function takePendingNotificationUrl(notificationId) {
  const key = `notif:${notificationId}`;
  const result = await notifStore.get(key);
  const url = result[key];
  await notifStore.remove(key);
  return url;
}

// bumpUnseenBadge() is a classic read-increment-write: two near-simultaneous
// new-low messages could both read count=5 and both write 6, losing one
// increment. The background worker is a single shared instance across
// every tab though (unlike content scripts, which each run in their own
// tab), so a simple promise chain here is a complete fix, not just a
// mitigation — every call genuinely waits for the previous one to finish
// before reading.
let badgeQueue = Promise.resolve();

function bumpUnseenBadge() {
  badgeQueue = badgeQueue.then(async () => {
    const { unseenAlertCount = 0 } = await chrome.storage.local.get("unseenAlertCount");
    const next = unseenAlertCount + 1;
    await chrome.storage.local.set({ unseenAlertCount: next });
    chrome.action.setBadgeText({ text: String(next) });
    chrome.action.setBadgeBackgroundColor({ color: "#E8A33D" });
  }).catch((err) => console.error("Price Ledger: badge update failed", err));
  return badgeQueue;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PRICE_LEDGER_NEW_LOW") return;

  const { title, price, currency, priorLow, url } = message;

  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "New low price",
      message: `${title}\n${fmt(price, currency)} — previously as low as ${fmt(priorLow, currency)}`,
      priority: 1,
    },
    (notificationId) => {
      if (url && notificationId) {
        setPendingNotificationUrl(notificationId, url);
      }
    }
  );

  bumpUnseenBadge();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const url = await takePendingNotificationUrl(notificationId);
  if (url) {
    chrome.tabs.create({ url });
  }
  chrome.notifications.clear(notificationId);
});

// Clean up the mapping if the person dismisses the notification without
// clicking it too — otherwise these accumulate for as long as the browser
// session lasts (session storage is capped at 10MB, which is a lot of
// notification URLs, but there's no reason to leave them lying around).
chrome.notifications.onClosed.addListener((notificationId) => {
  takePendingNotificationUrl(notificationId);
});

// Clear the badge whenever the popup is opened — that's the "seen it" signal.
// Queued on the same chain as bumpUnseenBadge(): unqueued, a clear landing
// between an increment's read and its write was undone by that write
// (reproduced: count 5 → alert → popup opened → stored 6, badge "6").
// Only the extension's own pages can clear it.
function clearUnseenBadge() {
  badgeQueue = badgeQueue.then(async () => {
    await chrome.storage.local.set({ unseenAlertCount: 0 });
    chrome.action.setBadgeText({ text: "" });
  }).catch((err) => console.error("Price Ledger: badge clear failed", err));
  return badgeQueue;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "PRICE_LEDGER_CLEAR_BADGE") return;
  if (!isExtensionPage(sender)) return;
  clearUnseenBadge();
});

// ---------- Ledger writes and migrations ----------
// All ledger storage writes (history, product metadata, comparison groups)
// and the storage migrations go through one serialized queue here — see
// ledger.js for why. The migration check is enqueued first, synchronously
// at worker start, so every write this worker ever handles is ordered
// after it. It runs on every start rather than only in onInstalled; the
// per-version flag makes that a single small read once migrated.
const ledger = createLedger(chrome.storage.local);

ledger.ensureMigrated(chrome.runtime.getManifest().version).catch((err) => {
  // Don't wedge writes on a failed migration; the flag isn't set, so it
  // retries on the next worker start.
  console.error("Price Ledger: storage migration failed", err);
});

function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PRICE_LEDGER_RECORD") return;
  // Only content scripts (which run in a tab on an http/https page) record
  // observations, and the domain comes from the sender's own URL.
  const obs = sender?.tab ? validateObservation(message.product, sender.url) : null;
  if (!obs) {
    sendResponse({ ok: false, error: "rejected observation" });
    return;
  }
  ledger.record(obs).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async sendResponse
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PRICE_LEDGER_GROUPS") return;
  // Comparisons are only ever edited from the extension's own history page.
  if (!isExtensionPage(sender)) {
    sendResponse({ ok: false, error: "not allowed" });
    return;
  }
  const op =
    message.op === "create" ? ledger.createGroup(message.name, message.members)
    : message.op === "delete" ? ledger.deleteGroup(message.id)
    : Promise.reject(new Error("unknown op"));
  op.then(
    (id) => sendResponse({ ok: true, id }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true;
});
