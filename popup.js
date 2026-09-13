async function main() {
  const all = await chrome.storage.local.get(null);

  const entries = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith("meta:")) continue;
    const match = key.match(/^meta:([^:]+):(.+)$/);
    if (!match) continue;
    const [, domain, productKey] = match;
    const historyKey = `history:${domain}:${productKey}`;
    const meta = all[key];
    const history = all[historyKey] || [];
    if (!history.length) continue;
    entries.push({ domain, productKey, meta, history });
  }

  entries.sort((a, b) => (b.meta.lastSeen || 0) - (a.meta.lastSeen || 0));

  const list = document.getElementById("list");
  if (!entries.length) {
    list.innerHTML = `<p class="pl-empty">No products tracked yet. Browse a product page and check back here.</p>`;
    return;
  }

  list.innerHTML = "";
  for (const { domain, meta, history } of entries) {
    const last = history[history.length - 1];
    const isCurrencyUnknown = last.c == null;

    let midHtml;
    let claimFlag = false;

    if (isCurrencyUnknown) {
      // filterSameCurrency() correctly returns nothing comparable for an
      // unknown currency — Math.min() on that empty result would silently
      // produce Infinity and misleadingly claim "at its low" for a price
      // that was never actually compared against anything.
      midHtml = `
        <span class="pl-item-price">${fmt(last.p, null)}</span>
        <span class="pl-item-verdict">currency unknown</span>
      `;
    } else {
      // Only compare within the current currency — the same fix applied
      // to the badge and history chart. An earlier version of this file
      // predated that fix and compared raw prices across currencies.
      const sameCurrencyHistory = filterSameCurrency(history, last.c);
      const low = Math.min(...sameCurrencyHistory.map((h) => h.p));
      const isLow = last.p <= low + 0.001;
      // evaluateClaimAt() comes from shared.js — the same canonical
      // evaluator the badge and history chart use, so this can't
      // silently disagree with them about the same claim the way it
      // used to.
      const claim = evaluateClaimAt(history, history.length - 1);
      claimFlag = claim?.tone === "bad";
      midHtml = `
        <span class="pl-item-price">${fmt(last.p, last.c)}</span>
        <span class="pl-item-verdict${isLow ? " pl-good" : ""}">${
          isLow ? "at its low" : `low was ${fmt(low, last.c)}`
        }</span>
      `;
    }

    const row = document.createElement("div");
    row.className = "pl-item";
    row.innerHTML = `
      <div class="pl-item-top">
        <span class="pl-item-title">${escapeHtml(meta.title || "Untitled product")}</span>
        <span class="pl-item-domain">${escapeHtml(domain)}</span>
      </div>
      <div class="pl-item-mid">
        ${midHtml}
      </div>
      ${claimFlag ? `<div class="pl-item-flag">⚠ "was" claim not corroborated by your history</div>` : ""}
    `;
    row.addEventListener("click", () => chrome.tabs.create({ url: meta.url }));
    row.style.cursor = "pointer";
    list.appendChild(row);
  }
}

main();
chrome.runtime.sendMessage({ type: "PRICE_LEDGER_CLEAR_BADGE" });

document.getElementById("open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});
