// Price Ledger — shared helpers
// Loaded before content.js (as an extra content script) and before
// popup.js/history.js (as a plain <script> tag) so all three can use these
// without three copy-pasted definitions drifting out of sync.

function fmt(price, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
  } catch {
    return `${currency} ${price.toFixed(2)}`;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// How many days of tracking are required before a "was $X" claim that's
// never been corroborated gets flagged as inflated, rather than reported
// as "can't verify yet." See content.js's evaluateClaim for the full
// reasoning. Kept here so content.js, history.js, and popup.js can't
// drift out of sync on the threshold.
const MIN_DAYS_FOR_INFLATED_VERDICT = 14;
