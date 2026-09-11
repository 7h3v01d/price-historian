// Price Ledger — background service worker
// Content scripts can't call chrome.notifications directly (that API is
// only available in extension contexts), so they message this worker
// whenever they record a genuine new low, and this handles the OS
// notification plus a small "unseen alerts" badge on the toolbar icon.

importScripts("shared.js"); // brings in fmt()

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
  });
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
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PRICE_LEDGER_CLEAR_BADGE") return;
  chrome.storage.local.set({ unseenAlertCount: 0 });
  chrome.action.setBadgeText({ text: "" });
});
