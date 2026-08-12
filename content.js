// Price Ledger — content script
// Detects a product + its current price on the page, logs it to local
// history, and shows a small badge comparing today's price to what this
// browser has actually observed before.

(() => {
  const DOMAIN = location.hostname.replace(/^www\./, "");
  // Flip this to true (or run `localStorage.setItem('pl-debug','1')` in the
  // console on the page you're testing) to get step-by-step console logs
  // of what detection found and rejected.
  const DEBUG = (() => {
    try { return localStorage.getItem("pl-debug") === "1"; } catch { return false; }
  })();
  const log = (...args) => DEBUG && console.log("[PriceLedger]", ...args);

  // ---------- 1. Extract product + price ----------

  function parseJsonLdProducts() {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    const products = [];
    for (const node of nodes) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        collectProducts(item, products);
      }
    }
    return products;
  }

  // Rough currency inference from the domain when a page doesn't declare
  // one explicitly. Better than silently lying with a "USD" default.
  const TLD_CURRENCY = {
    "com.au": "AUD", ".au": "AUD",
    "co.uk": "GBP", ".uk": "GBP",
    "co.nz": "NZD", ".nz": "NZD",
    ".ca": "CAD",
    ".eu": "EUR", ".de": "EUR", ".fr": "EUR", ".es": "EUR", ".it": "EUR", ".nl": "EUR", ".ie": "EUR",
    ".jp": "JPY",
    ".in": "INR",
    ".sg": "SGD",
    ".hk": "HKD",
    ".ch": "CHF",
  };

  function inferCurrencyFromDomain() {
    const host = DOMAIN.toLowerCase();
    for (const suffix of Object.keys(TLD_CURRENCY)) {
      if (host.endsWith(suffix)) return TLD_CURRENCY[suffix];
    }
    return "USD";
  }

  function collectProducts(node, out, depth = 0) {
    if (!node || typeof node !== "object" || depth > 4) return;
    const type = node["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (isProduct) out.push(node);
    // Some sites nest Product under @graph
    if (Array.isArray(node["@graph"])) {
      for (const child of node["@graph"]) collectProducts(child, out, depth + 1);
    }
  }

  function extractOfferPrice(offers) {
    if (!offers) return null;
    const list = Array.isArray(offers) ? offers : [offers];
    for (const offer of list) {
      const price = offer.price ?? offer.lowPrice ?? offer?.priceSpecification?.price;
      if (price !== undefined && price !== null && price !== "") {
        const currency = offer.priceCurrency ?? offer?.priceSpecification?.priceCurrency ?? inferCurrencyFromDomain();
        const num = parseFloat(String(price).replace(/[^0-9.]/g, ""));
        if (!Number.isNaN(num) && num > 0) return { price: num, currency };
      }
    }
    return null;
  }

  function detectFromJsonLd() {
    const products = parseJsonLdProducts();
    for (const p of products) {
      const priceInfo = extractOfferPrice(p.offers);
      if (!priceInfo) continue;
      const id = p.gtin13 || p.gtin || p.gtin12 || p.gtin8 || p.mpn || p.sku || null;
      return {
        title: (p.name || document.title || "").trim().slice(0, 140),
        image: firstImage(p.image),
        productKey: id ? `id:${id}` : `name:${normalize(p.name || document.title)}`,
        price: priceInfo.price,
        currency: priceInfo.currency,
      };
    }
    return null;
  }

  function firstImage(image) {
    if (!image) return null;
    if (typeof image === "string") return image;
    if (Array.isArray(image)) return typeof image[0] === "string" ? image[0] : image[0]?.url || null;
    return image.url || null;
  }

  function normalize(str) {
    return (str || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  // Fallback for pages without JSON-LD: meta tags + a scan for itemprop price.
  // Gated carefully — this path is the one that misfired on listing/search
  // pages, treating "some price on the page" as "the product's price".
  function detectFromMeta() {
    const ogType = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() || "";
    const isDeclaredProductPage = ogType.startsWith("product");

    // Facebook/OG product price meta is scoped to a single product by spec —
    // still only trust it when the page also self-identifies as a product.
    const ogPriceEl =
      document.querySelector('meta[property="product:price:amount"]') ||
      document.querySelector('meta[property="og:price:amount"]');

    if (isDeclaredProductPage && ogPriceEl) {
      const num = parseFloat(String(ogPriceEl.content).replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(num) && num > 0) {
        const currency =
          document.querySelector('meta[property="product:price:currency"]')?.content ||
          document.querySelector('meta[property="og:price:currency"]')?.content ||
          inferCurrencyFromDomain();
        return buildMetaProduct(num, currency);
      }
    }

    // itemprop="price" is far riskier — listing/search pages often contain
    // many of these (one per result card). Only trust it when: the page
    // declares itself a product page via og:type, AND there's exactly one
    // match on the page (so we're not grabbing the first of many cards).
    if (isDeclaredProductPage) {
      const itemPropEls = document.querySelectorAll('[itemprop="price"]');
      if (itemPropEls.length === 1) {
        const raw = itemPropEls[0].getAttribute("content") || itemPropEls[0].textContent;
        const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
        if (!Number.isNaN(num) && num > 0) {
          return buildMetaProduct(num, inferCurrencyFromDomain());
        }
      }
    }

    return null;
  }

  // ---------- 1b. Last-resort DOM scan ----------
  // Some storefronts (Woolworths among them) ship no JSON-LD Product, no
  // og:price meta, and no itemprop="price" — the price only exists as text
  // rendered client-side after the page loads. This heuristic looks for it
  // directly. It's inherently fuzzier than structured data, so it's gated
  // hard: only runs on pages that already declared og:type=product, and it
  // actively avoids "was $X" / per-unit price text.

  // Known-good CSS selectors for specific sites, when you (or a future me)
  // has inspected the real markup and found something more reliable than
  // the generic heuristic below. Add entries as {domain: selector}.
  const SITE_PRICE_SELECTORS = {
    // Woolworths' price class has a CSS-module hash suffix that changes on
    // redeploy (e.g. "...price-lead__vlm8f") — matching the stable prefix
    // instead of the full class survives those rebuilds.
    "www.woolworths.com.au": '[class*="product-price_component_price-lead"]',
  };

  function findPriceElements() {
    const priceRegex = /(?:\$|£|€)\s?\d{1,4}(?:\.\d{2})?/;
    const nodes = document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]');
    const candidates = [];
    for (const el of nodes) {
      const text = el.textContent.trim();
      if (!priceRegex.test(text) || text.length > 24) continue;
      const flag = `${el.className} ${el.id}`.toLowerCase();
      // Skip strikethrough "was" prices, RRPs, and per-unit ($/100g) prices —
      // we want the actual current total price, not a comparison figure.
      if (/was|rrp|strike|compare|save|per-?unit|unit-?price/.test(flag)) continue;
      candidates.push(el);
    }
    // Prefer leaf-most matches so we don't grab a wrapper containing both
    // the real price and a "was" price as one blob.
    return candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  }

  function pickBestPriceElement(candidates) {
    if (!candidates.length) return null;
    return candidates.sort((a, b) => {
      const fa = parseFloat(getComputedStyle(a).fontSize) || 0;
      const fb = parseFloat(getComputedStyle(b).fontSize) || 0;
      return fb - fa; // biggest text first — usually the featured price
    })[0];
  }

  // Persistent DOM watcher — replaces the old fixed-timeout approach.
  // Grocery sites like Woolworths/Coles often render no price at all (or a
  // placeholder) until the shopper picks a delivery/pickup location, which
  // is a user-paced action that can take far longer than any fixed
  // timeout. Instead of giving up, this keeps watching for the page's
  // lifetime (capped at 3 minutes to avoid burning CPU on abandoned tabs)
  // and fires every time a valid, changed price shows up — including
  // re-firing if the price updates after the shopper sets their location.
  function startDomPriceWatcher() {
    const ogType = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() || "";
    log("og:type =", ogType || "(none)");
    if (!ogType.startsWith("product")) {
      log("skipping DOM watch: page doesn't declare og:type=product");
      return;
    }

    const override = SITE_PRICE_SELECTORS[DOMAIN] || SITE_PRICE_SELECTORS[`www.${DOMAIN}`];
    log("DOM watcher active. override selector:", override || "(none, using heuristic)");

    let lastPrice = null;

    const check = async () => {
      const el = override ? document.querySelector(override) : pickBestPriceElement(findPriceElements());
      if (!el) return;
      const match = el.textContent.match(/(?:\$|£|€)\s?\d{1,4}(?:\.\d{2})?/);
      if (!match) return;
      const num = parseFloat(match[0].replace(/[^0-9.]/g, ""));
      if (Number.isNaN(num) || num <= 0) return;
      if (num === lastPrice) return; // already recorded this exact value
      lastPrice = num;
      log("DOM watcher found price:", num, `(from "${el.textContent.trim()}")`);
      const product = buildMetaProduct(num, inferCurrencyFromDomain());
      const history = await recordObservation(product);
      renderBadge(product, history);
    };

    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => observer.disconnect(), 3 * 60 * 1000);
  }

  function buildMetaProduct(price, currency) {
    const title =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title;
    const image = document.querySelector('meta[property="og:image"]')?.content || null;

    return {
      title: (title || "").trim().slice(0, 140),
      image,
      productKey: `name:${normalize(title)}`,
      price,
      currency,
    };
  }

  // ---------- 2. Storage ----------

  function historyKey(productKey) {
    return `history:${DOMAIN}:${productKey}`;
  }
  function metaKey(productKey) {
    return `meta:${DOMAIN}:${productKey}`;
  }

  async function loadHistory(productKey) {
    const key = historyKey(productKey);
    const result = await chrome.storage.local.get(key);
    return result[key] || [];
  }

  async function recordObservation(product) {
    const key = historyKey(product.productKey);
    const mKey = metaKey(product.productKey);
    const history = await loadHistory(product.productKey);

    const now = Date.now();
    const last = history[history.length - 1];
    // Avoid spamming duplicate points on the same day at the same price.
    const sameDay = last && new Date(last.t).toDateString() === new Date(now).toDateString();
    if (!last || last.p !== product.price || !sameDay) {
      history.push({ p: product.price, c: product.currency, t: now });
    }
    // Cap history length so storage doesn't grow unbounded.
    const trimmed = history.slice(-200);

    await chrome.storage.local.set({
      [key]: trimmed,
      [mKey]: {
        title: product.title,
        image: product.image,
        url: location.href,
        lastSeen: now,
      },
    });

    return trimmed;
  }

  // ---------- 3. Badge UI ----------

  function fmt(price, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
    } catch {
      return `${currency} ${price.toFixed(2)}`;
    }
  }

  function buildSparkline(history) {
    if (history.length < 2) return "";
    const prices = history.map((h) => h.p);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const w = 96, h = 28, pad = 3;
    const range = max - min || 1;
    const pts = prices.map((p, i) => {
      const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" class="pl-spark" preserveAspectRatio="none">
      <polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.6" />
    </svg>`;
  }

  function renderBadge(product, history) {
    document.getElementById("price-ledger-badge")?.remove();

    const prices = history.map((h) => h.p);
    const low = Math.min(...prices, product.price);
    const high = Math.max(...prices, product.price);
    const isAtLow = product.price <= low + 0.001;
    const diffFromLow = product.price - low;

    const badge = document.createElement("div");
    badge.id = "price-ledger-badge";
    badge.className = "pl-badge" + (isAtLow ? " pl-good" : "");

    const verdict = isAtLow
      ? history.length > 1
        ? "Lowest you've seen"
        : "First time tracking this"
      : `${fmt(diffFromLow, product.currency)} above your low`;

    badge.innerHTML = `
      <div class="pl-row pl-head">
        <span class="pl-dot"></span>
        <span class="pl-title">${escapeHtml(truncate(product.title, 34))}</span>
        <button class="pl-close" title="Dismiss">&times;</button>
      </div>
      <div class="pl-row pl-price-row">
        <span class="pl-price">${fmt(product.price, product.currency)}</span>
        ${buildSparkline(history)}
      </div>
      <div class="pl-row pl-verdict">${verdict}</div>
      ${
        history.length > 1
          ? `<div class="pl-row pl-meta">Low ${fmt(low, product.currency)} · High ${fmt(high, product.currency)} · ${history.length} checks</div>`
          : `<div class="pl-row pl-meta">Come back later — history builds as you browse.</div>`
      }
    `;

    badge.querySelector(".pl-close").addEventListener("click", () => badge.remove());
    document.documentElement.appendChild(badge);
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- 4. Run ----------

  async function run() {
    let product = detectFromJsonLd();
    log("detectFromJsonLd:", product);
    if (!product) {
      product = detectFromMeta();
      log("detectFromMeta:", product);
    }
    if (product) {
      const history = await recordObservation(product);
      renderBadge(product, history);
      return;
    }
    log("no structured price yet — handing off to persistent DOM watcher");
    startDomPriceWatcher();
  }

  // Give client-rendered pages (React/Vue product pages) a beat to hydrate.
  if (document.readyState === "complete") {
    setTimeout(run, 600);
  } else {
    window.addEventListener("load", () => setTimeout(run, 600));
  }
})();
