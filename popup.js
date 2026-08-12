function fmt(price, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
  } catch {
    return `${currency} ${price.toFixed(2)}`;
  }
}

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
    const prices = history.map((h) => h.p);
    const low = Math.min(...prices);
    const isLow = last.p <= low + 0.001;

    const row = document.createElement("div");
    row.className = "pl-item";
    row.innerHTML = `
      <div class="pl-item-top">
        <span class="pl-item-title">${escapeHtml(meta.title || "Untitled product")}</span>
        <span class="pl-item-domain">${escapeHtml(domain)}</span>
      </div>
      <div class="pl-item-mid">
        <span class="pl-item-price">${fmt(last.p, last.c)}</span>
        <span class="pl-item-verdict${isLow ? " pl-good" : ""}">${
          isLow ? "at its low" : `low was ${fmt(low, last.c)}`
        }</span>
      </div>
    `;
    row.addEventListener("click", () => chrome.tabs.create({ url: meta.url }));
    row.style.cursor = "pointer";
    list.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

main();
