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
        // JSON-LD's Offer schema has no standard "was/RRP" field — that
        // claim only ever shows up as page text, so scan for it directly.
        claimedWasPrice: findClaimedWasPrice(),
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

  // ---------- 1c. Claimed "was"/RRP price ----------
  // Captures the figure the retailer wants you to compare against — a
  // struck-through "was $X", an RRP, or a "compare at" price — so it can be
  // checked against what THIS browser has actually observed, rather than
  // trusted at face value.
  function findClaimedWasPrice() {
    const priceRegex = /(?:\$|£|€)\s?\d{1,4}(?:\.\d{2})?/;

    // Prefer genuine <del>/<s>/<strike> markup first — that's an explicit,
    // unambiguous semantic signal a page can't casually get wrong.
    const strikeEls = document.querySelectorAll("del, s, strike");
    for (const el of strikeEls) {
      const text = el.textContent.trim();
      const match = text.match(priceRegex);
      if (match && text.length < 24) {
        return parseFloat(match[0].replace(/[^0-9.]/g, ""));
      }
    }

    // Fall back to the same class/id keyword heuristic used to exclude
    // these from the current-price detector — same signal, opposite intent.
    const nodes = document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]');
    for (const el of nodes) {
      const flag = `${el.className} ${el.id}`.toLowerCase();
      if (!/was|rrp|strike|compare-?at/.test(flag)) continue;
      const text = el.textContent.trim();
      const match = text.match(priceRegex);
      if (match && text.length < 24) {
        return parseFloat(match[0].replace(/[^0-9.]/g, ""));
      }
    }
    return null;
  }

  // Persistent DOM watcher. Grocery sites like Woolworths/Coles often:
  //  (a) render no price at all until a delivery/pickup location is set,
  //      which is user-paced and can't be waited out with a fixed timeout, and
  //  (b) swap between "product pages" as an in-place content change rather
  //      than a real navigation — no URL change, so nothing tied to
  //      navigation events (pushState/popstate/URL polling) ever fires.
  // Content scripts also can't reliably intercept pushState anyway: they
  // run in an isolated JS world, so patching history.pushState from here
  // patches a *different* history object than the one the page's own
  // router actually calls.
  //
  // Confirmed in testing: Coles' in-place swap is reliably caught by a
  // MutationObserver on document.body. Woolworths/IGA are not — most likely
  // because their router replaces a larger subtree in a way that leaves the
  // observer watching content that's no longer where the action is. Rather
  // than chase that framework-specific behaviour, this runs a guaranteed
  // poll (checks every 1.2s regardless of whether any mutation fired) as
  // the reliable primary mechanism, with the MutationObserver kept as a
  // cheap "usually faster" fast path on top of it.
  let activeWatcherObserver = null;
  let activeWatcherInterval = null;

  function stopDomPriceWatcher() {
    if (activeWatcherObserver) {
      activeWatcherObserver.disconnect();
      activeWatcherObserver = null;
    }
    if (activeWatcherInterval) {
      clearInterval(activeWatcherInterval);
      activeWatcherInterval = null;
      log("stopped existing DOM watcher");
    }
  }

  function currentTitleGuess() {
    return (document.querySelector('meta[property="og:title"]')?.content || document.title || "").trim();
  }

  function startDomPriceWatcher() {
    stopDomPriceWatcher();

    const override = SITE_PRICE_SELECTORS[DOMAIN] || SITE_PRICE_SELECTORS[`www.${DOMAIN}`];
    log("DOM watcher active. override selector:", override || "(none, using heuristic)");

    let lastKey = null;

    const check = async () => {
      const ogType = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() || "";
      if (!ogType.startsWith("product")) return;

      const el = override ? document.querySelector(override) : pickBestPriceElement(findPriceElements());
      if (!el) return;
      const match = el.textContent.match(/(?:\$|£|€)\s?\d{1,4}(?:\.\d{2})?/);
      if (!match) return;
      const num = parseFloat(match[0].replace(/[^0-9.]/g, ""));
      if (Number.isNaN(num) || num <= 0) return;

      const title = currentTitleGuess();
      const key = `${location.pathname}::${title}::${num}`;
      if (key === lastKey) return; // no meaningful change since last observation
      lastKey = key;

      log("DOM watcher: product/price changed ->", title, num);
      const product = buildMetaProduct(num, inferCurrencyFromDomain());
      const history = await recordObservation(product);
      renderBadge(product, history);
    };

    check();

    // Fast path: fires quickly when the framework's mutations are of a
    // kind this observer actually sees (works well on Coles).
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    activeWatcherObserver = observer;

    // Reliable path: catches everything else within ~1.2s regardless of
    // whether the observer above ever fires (needed for Woolworths/IGA).
    activeWatcherInterval = setInterval(check, 1200);

    // Generous cap, not a real limit in practice — this costs essentially
    // nothing while idle. Just avoids leaving timers alive forever on a
    // tab left open overnight.
    setTimeout(stopDomPriceWatcher, 45 * 60 * 1000);
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
      claimedWasPrice: findClaimedWasPrice(),
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
      history.push({
        p: product.price,
        c: product.currency,
        t: now,
        // "w" = the retailer's own claimed was/RRP price at the time, if any.
        // Kept per-datapoint so a claim can be checked against your actual
        // observed history, not just today's number.
        w: product.claimedWasPrice ?? null,
      });
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

  // Checks a retailer's claimed "was $X" against what THIS browser has
  // actually seen for the item — the whole point of the extension.
  // `history` includes today's just-recorded point, so we look at
  // everything before it to judge whether the claim is independently
  // corroborated by prior visits, not by today's own claim.
  function evaluateClaim(product, history) {
    if (product.claimedWasPrice == null) return null;
    const past = history.slice(0, -1);
    const was = product.claimedWasPrice;

    if (past.length < 1) {
      return {
        tone: "neutral",
        text: `Claims "was ${fmt(was, product.currency)}" — first time tracking this, can't verify yet.`,
      };
    }

    const observedMax = Math.max(...past.map((h) => h.p));
    const tolerance = was * 0.03; // small wiggle room for rounding/cent differences
    if (observedMax >= was - tolerance) {
      return {
        tone: "good",
        text: `Checks out — you've seen it at ${fmt(observedMax, product.currency)} before.`,
      };
    }
    return {
      tone: "bad",
      text: `Never seen it above ${fmt(observedMax, product.currency)} — the "was ${fmt(was, product.currency)}" claim looks inflated.`,
    };
  }

  function renderBadge(product, history) {
    document.getElementById("price-ledger-badge")?.remove();

    const prices = history.map((h) => h.p);
    const low = Math.min(...prices, product.price);
    const high = Math.max(...prices, product.price);
    const isAtLow = product.price <= low + 0.001;
    const diffFromLow = product.price - low;
    const claim = evaluateClaim(product, history);

    const badge = document.createElement("div");
    badge.id = "price-ledger-badge";
    let stateClass = isAtLow ? " pl-good" : "";
    if (claim?.tone === "bad") stateClass = " pl-alert";
    badge.className = "pl-badge" + stateClass;

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
      ${claim ? `<div class="pl-row pl-claim pl-claim-${claim.tone}">${escapeHtml(claim.text)}</div>` : ""}
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
    document.getElementById("price-ledger-badge")?.remove();

    let product = detectFromJsonLd();
    log("detectFromJsonLd:", product);
    if (!product) {
      product = detectFromMeta();
      log("detectFromMeta:", product);
    }
    if (product) {
      stopDomPriceWatcher();
      const history = await recordObservation(product);
      renderBadge(product, history);
      return;
    }
    log("no structured price yet — handing off to persistent DOM watcher");
    startDomPriceWatcher();
  }

  // ---------- 5. URL-change handling (supplementary, not primary) ----------
  // Useful for sites that DO change the URL on navigation and DO ship fresh
  // JSON-LD/meta per route (most "normal" retail sites) — re-runs detection
  // so a real route change picks up the new page's structured data quickly.
  // Note: patching history.pushState/replaceState from here does NOT work —
  // content scripts run in an isolated JS world, so that patch would only
  // ever see the isolated world's own copy of `history`, never the page's
  // real router calling the real one. Polling location.href is the only
  // part of this that's actually reliable from a content script.
  // The DOM watcher above is what carries pages (like Woolworths/Coles)
  // where content swaps in place without any URL change at all.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    log("URL change detected ->", location.href);
    setTimeout(run, 400);
  }, 1000);

  // Give client-rendered pages (React/Vue product pages) a beat to hydrate.
  if (document.readyState === "complete") {
    setTimeout(run, 600);
  } else {
    window.addEventListener("load", () => setTimeout(run, 600));
  }
})();
