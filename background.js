// Price Ledger — background service worker
// Content scripts can't call chrome.notifications directly (that API is
// only available in extension contexts), so they message this worker
// whenever they record a genuine new low, and this handles the OS
// notification plus a small "unseen alerts" badge on the toolbar icon.

const pendingNotificationUrls = {};

function fmt(price, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
  } catch {
    return `${currency} ${price.toFixed(2)}`;
  }
}

async function bumpUnseenBadge() {
  const { unseenAlertCount = 0 } = await chrome.storage.local.get("unseenAlertCount");
  const next = unseenAlertCount + 1;
  await chrome.storage.local.set({ unseenAlertCount: next });
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: "#E8A33D" });
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
        pendingNotificationUrls[notificationId] = url;
      }
    }
  );

  bumpUnseenBadge();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = pendingNotificationUrls[notificationId];
  if (url) {
    chrome.tabs.create({ url });
    delete pendingNotificationUrls[notificationId];
  }
  chrome.notifications.clear(notificationId);
});

// Clear the badge whenever the popup is opened — that's the "seen it" signal.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PRICE_LEDGER_CLEAR_BADGE") return;
  chrome.storage.local.set({ unseenAlertCount: 0 });
  chrome.action.setBadgeText({ text: "" });
});
