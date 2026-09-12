// Price Ledger — content script
// Detects a product + its current price on the page, logs it to local
// history, and shows a small badge comparing today's price to what this
// browser has actually observed before.

(() => {
  const DOMAIN = location.hostname.replace(/^www\./, "");

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
    // No TLD signal — genuinely unknown, not "probably USD." A .com
    // retailer can localize prices for AU/UK/etc visitors with no
    // structured currency metadata at all; guessing USD would mislabel
    // real evidence rather than honestly recording that we don't know.
    // fmt() and filterSameCurrency() both handle a null currency
    // correctly (displaying "(currency unknown)" instead of a wrong
    // label, and still grouping same-unknown-currency observations
    // together for comparison purposes).
    return null;
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

    // A Product with multiple offers at genuinely different exact prices
    // (e.g. size/color variants each priced separately) is ambiguous from
    // JSON-LD alone — there's no reliable way to tell which variant
    // corresponds to what's actually shown on this specific page.
    // Confidently picking the first one risks silently tracking the
    // wrong variant's price; rejecting is safer than guessing.
    const distinctExactPrices = new Set(
      list
        .map((o) => o.price)
        .filter((p) => p !== undefined && p !== null && p !== "")
        .map((p) => parsePriceAmount(String(p)))
        .filter((p) => p != null)
        .map((p) => p.toFixed(2))
    );
    if (distinctExactPrices.size > 1) return null;

    for (const offer of list) {
      // An exact `price` is a real, displayed price for this offer. A
      // `lowPrice` (from an AggregateOffer, e.g. across sellers or
      // variants) or a `priceSpecification.price` is a range floor or
      // derived figure — plausible, but not the same confidence level as
      // "this is literally the price shown." Tracked separately so
      // candidate scoring below can prefer the former.
      const hasExactPrice = offer.price !== undefined && offer.price !== null && offer.price !== "";
      const price = offer.price ?? offer.lowPrice ?? offer?.priceSpecification?.price;
      if (price !== undefined && price !== null && price !== "") {
        const rawCurrency = offer.priceCurrency ?? offer?.priceSpecification?.priceCurrency;
        const currency = sanitizeCurrency(rawCurrency, inferCurrencyFromDomain());
        const num = parsePriceAmount(String(price));
        if (num != null) return { price: num, currency, isExact: hasExactPrice };
      }
    }
    return null;
  }

  // A rough, deliberately simple similarity check — not fuzzy-matching
  // for its own sake, just enough to tell "this Product's name is
  // basically the page's title" from "this is some unrelated Product
  // object that happened to be on the page" (e.g. a related-items widget).
  function titleSimilarity(candidateName, pageTitle) {
    if (!candidateName || !pageTitle) return 0;
    const a = candidateName.toLowerCase().trim();
    const b = pageTitle.toLowerCase().trim();
    if (!a || !b) return 0;
    if (a === b) return 1;
    return a.includes(b) || b.includes(a) ? 0.5 : 0;
  }

  function detectFromJsonLd() {
    const products = parseJsonLdProducts();
    const pageTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || "";

    // A page can embed multiple Product objects (variants, related items,
    // a whole listing's worth of JSON-LD). Taking "the first one with any
    // usable offer" risked picking the wrong one entirely. Score every
    // candidate instead and take the best.
    //
    // Identity correspondence dominates price-quality, not the other way
    // around: a candidate whose name actually matches the page (weight
    // ×10) always outranks an unrelated candidate that merely has an
    // exact price (+2) rather than a range floor (+0) — an earlier
    // version weighted these the other way and could pick a completely
    // unrelated recommended-item's exact price over the actual product's
    // range-floor price, which is a worse failure than the one this
    // scoring was originally built to prevent.
    let best = null;
    let bestScore = -Infinity;
    for (const p of products) {
      const priceInfo = extractOfferPrice(p.offers);
      if (!priceInfo) continue;
      const score = titleSimilarity(p.name, pageTitle) * 10 + (priceInfo.isExact ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { p, priceInfo };
      }
    }
    if (!best) return null;

    const { p, priceInfo } = best;
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
      const num = parsePriceAmount(String(ogPriceEl.content));
      if (num != null) {
        const rawCurrency =
          document.querySelector('meta[property="product:price:currency"]')?.content ||
          document.querySelector('meta[property="og:price:currency"]')?.content;
        const currency = sanitizeCurrency(rawCurrency, inferCurrencyFromDomain());
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
        const num = parsePriceAmount(String(raw));
        if (num != null) {
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
    const looksLikePrice = /(?:\$|£|€)\s?\d/;
    const nodes = document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]');
    const candidates = [];
    for (const el of nodes) {
      const text = el.textContent.trim();
      if (!looksLikePrice.test(text) || text.length > 24) continue;
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
    // Prefer genuine <del>/<s>/<strike> markup first — that's an explicit,
    // unambiguous semantic signal a page can't casually get wrong.
    const strikeEls = document.querySelectorAll("del, s, strike");
    for (const el of strikeEls) {
      const text = el.textContent.trim();
      if (text.length >= 24) continue;
      const price = extractPriceFromText(text);
      if (price != null) return price;
    }

    // Fall back to the same class/id keyword heuristic used to exclude
    // these from the current-price detector — same signal, opposite intent.
    const nodes = document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]');
    for (const el of nodes) {
      const flag = `${el.className} ${el.id}`.toLowerCase();
      if (!/was|rrp|strike|compare-?at/.test(flag)) continue;
      const text = el.textContent.trim();
      if (text.length >= 24) continue;
      const price = extractPriceFromText(text);
      if (price != null) return price;
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
  let activeWatcherTimeoutId = null;

  function stopDomPriceWatcher() {
    if (activeWatcherObserver) {
      activeWatcherObserver.disconnect();
      activeWatcherObserver = null;
    }
    if (activeWatcherInterval) {
      clearInterval(activeWatcherInterval);
      activeWatcherInterval = null;
    }
    if (activeWatcherTimeoutId) {
      clearTimeout(activeWatcherTimeoutId);
      activeWatcherTimeoutId = null;
    }
  }

  function currentTitleGuess() {
    return (document.querySelector('meta[property="og:title"]')?.content || document.title || "").trim();
  }

  function startDomPriceWatcher() {
    stopDomPriceWatcher();

    const override = SITE_PRICE_SELECTORS[DOMAIN] || SITE_PRICE_SELECTORS[`www.${DOMAIN}`];

    let lastKey = null;

    const check = async () => {
      const ogType = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() || "";
      if (!ogType.startsWith("product")) return;

      const el = override ? document.querySelector(override) : pickBestPriceElement(findPriceElements());
      if (!el) return;
      const num = extractPriceFromText(el.textContent);
      if (num == null) return;

      // Build the product (including its claimed was-price, if any) before
      // the dedupe check — a claim appearing/disappearing/changing with the
      // price otherwise unchanged is still a real change worth recording,
      // so it needs to be part of the key, not just price/title/pathname.
      const product = buildMetaProduct(num, inferCurrencyFromDomain());
      const title = currentTitleGuess();
      const key = `${location.pathname}::${title}::${num}::${product.claimedWasPrice ?? "none"}`;
      if (key === lastKey) return; // no meaningful change since last observation
      lastKey = key;

      const { history, isNewLow, priorLow } = await recordObservation(product);
      renderBadge(product, history);
      if (isNewLow) notifyNewLow(product, priorLow);
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
    // tab left open overnight. Tracked and cleared in stopDomPriceWatcher()
    // so a restart doesn't leave a stale timer that kills the new watcher
    // early (that was a real bug: without tracking this, restarting the
    // watcher — e.g. on a real page navigation — left the old 45-minute
    // timer armed, which could then fire and stop the brand-new watcher
    // well short of its own intended lifetime).
    activeWatcherTimeoutId = setTimeout(stopDomPriceWatcher, 45 * 60 * 1000);
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

  // recordObservation() is a read-modify-write against chrome.storage.local:
  // load history, mutate it, write the whole thing back. This content
  // script deliberately runs both a MutationObserver AND a 1.2s poll at
  // the same time (see startDomPriceWatcher) as two paths to catch the
  // same price change, which means it can genuinely call this function
  // twice in close succession for what's logically one observation. A
  // simple promise-chain lock serializes those calls so the second one
  // always sees the first one's write, rather than both reading the same
  // stale history and one silently overwriting the other's result.
  //
  // This does NOT protect against a second browser TAB observing the same
  // product concurrently — that would need writes centralized in the
  // background service worker (each content script/tab has its own
  // separate JS context, so an in-page lock like this one can't reach
  // across tabs). That's accepted as a known gap for now: worth fixing
  // properly if it ever turns out to matter in practice, but a bigger
  // architectural change than this pass covers.
  let recordQueue = Promise.resolve();

  function recordObservation(product) {
    const result = recordQueue.then(() => recordObservationUnsafe(product));
    // Swallow rejections in the chain itself so one failed write doesn't
    // permanently wedge every future call behind a rejected promise —
    // each caller still sees its own real result or error via `result`.
    recordQueue = result.catch(() => {});
    return result;
  }

  async function recordObservationUnsafe(product) {
    const key = historyKey(product.productKey);
    const mKey = metaKey(product.productKey);
    const history = await loadHistory(product.productKey);

    // Snapshot the low BEFORE today's point is added, so "new low" means
    // "lower than everything previously observed," not "lower than itself."
    // Only compare within the same currency — a $65 USD reading isn't a
    // "new low" against a $100 AUD history, those numbers aren't
    // commensurable. A currency change effectively starts a fresh
    // comparison baseline rather than corrupting the existing one.
    const priorSameCurrency = filterSameCurrency(history, product.currency);
    const priorPrices = priorSameCurrency.map((h) => h.p);
    const priorLow = priorPrices.length ? Math.min(...priorPrices) : null;
    const isNewLow = priorLow !== null && product.price < priorLow - 0.001;

    const now = Date.now();
    const last = history[history.length - 1];
    const incomingClaim = product.claimedWasPrice ?? null;
    // Avoid spamming duplicate points on the same day at the exact same
    // reading — but a currency change OR a claim appearing/disappearing/
    // changing is a real change even if the price itself matches. A claim
    // is evidence in its own right (it's what the badge and history chart
    // check against future visits), so silently dropping or preserving a
    // stale one on the "no price change" fast path would let the ledger
    // lie about what the retailer actually displayed at that moment.
    const sameDay = last && new Date(last.t).toDateString() === new Date(now).toDateString();
    const sameReading =
      last && last.p === product.price && last.c === product.currency && (last.w ?? null) === incomingClaim;
    if (!last || !sameReading || !sameDay) {
      history.push({
        p: product.price,
        c: product.currency,
        t: now,
        // "w" = the retailer's own claimed was/RRP price at the time, if any.
        // Kept per-datapoint so a claim can be checked against your actual
        // observed history, not just today's number.
        w: incomingClaim,
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

    return { history: trimmed, isNewLow, priorLow };
  }

  // Content scripts run per-page, so a single in-memory guard is enough to
  // stop the poll/observer from firing duplicate notifications for the same
  // price within one page visit — storage-level dedup (above) handles the
  // rest across visits.
  const notifiedThisPageLoad = new Set();

  function notifyNewLow(product, priorLow) {
    const dedupeKey = `${product.productKey}::${product.price}`;
    if (notifiedThisPageLoad.has(dedupeKey)) return;
    notifiedThisPageLoad.add(dedupeKey);

    try {
      chrome.runtime.sendMessage({
        type: "PRICE_LEDGER_NEW_LOW",
        title: product.title,
        price: product.price,
        currency: product.currency,
        priorLow,
        url: location.href,
      });
    } catch (e) {
      console.error("[Price Ledger] failed to send new-low notification:", e);
    }
  }

  // ---------- 3. Badge UI ----------
  // (fmt() and escapeHtml() come from shared.js, loaded before this script.)

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
  // actually seen for the item — the whole point of the extension. The
  // actual evidence logic (currency filtering, day-span and observation-
  // count thresholds) lives in evaluateClaimAt() in shared.js, used
  // identically by the badge, history chart, and popup list. This is just
  // the badge's own wording built from that shared, structured result —
  // an earlier version had each surface re-implement the logic itself,
  // and they drifted out of sync when only some got updated.
  function evaluateClaim(product, history) {
    // By the time this runs, `history` already has product's current
    // observation as its last point (recordObservation pushed it before
    // renderBadge was called), with matching .w/.c/.p — so evaluating at
    // the last index reads today's actual claim, not a stale one.
    const result = evaluateClaimAt(history, history.length - 1);
    if (!result) return null;
    const { tone, was, currency, observedMax, pastCount, daysTracked } = result;

    if (tone === "neutral" && pastCount === 0) {
      return {
        tone,
        text: `Claims "was ${fmt(was, currency)}" — first time tracking this, can't verify yet.`,
      };
    }
    if (tone === "good") {
      return {
        tone,
        text: `Checks out — you've seen it at ${fmt(observedMax, currency)} before.`,
      };
    }
    if (tone === "neutral") {
      return {
        tone,
        text: `Only ${pastCount} check(s) over ${Math.max(1, Math.round(daysTracked))} day(s) so far — not enough history yet to confirm or challenge the "was ${fmt(was, currency)}" claim.`,
      };
    }
    return {
      tone,
      text: `${pastCount} checks over ${Math.round(daysTracked)} days, never above ${fmt(observedMax, currency)} — the "was ${fmt(was, currency)}" claim isn't corroborated by your observed history.`,
    };
  }

  // The badge lives inside a *closed* Shadow DOM. Content scripts share the
  // page's real DOM with the page's own scripts — that's the whole
  // mechanism that lets this badge render inline at all — which also means
  // a page script could previously do
  // document.querySelector("#price-ledger-badge")?.textContent and read
  // your private price history (low/high/check-count/claim verdict), or
  // rewrite the badge to display a fake "checks out" verdict for a claim
  // that doesn't. A closed shadow root means `host.shadowRoot` returns
  // null to every script except the one that created it, so the content
  // itself is no longer readable or rewritable via ordinary DOM queries.
  //
  // This does NOT make the badge fully tamper-proof: a page can still see
  // the host element exists, and can still remove, hide, or reposition it
  // (there's no DOM API that prevents an ancestor page from manipulating
  // any injected element's existence). That's an accepted, unavoidable
  // limit of content-script UI — which is exactly why the badge is a
  // convenience surface, not the authoritative one. The popup and history
  // page render entirely within extension-owned UI with no page DOM
  // involved at all, and are the surfaces to trust if you ever suspect a
  // page might be interfering with the inline badge.
  // Adapted from the old content.css — that file targeted the badge via a
  // page-level `#price-ledger-badge` selector, which no longer reaches
  // anything now that the badge lives inside a shadow root (external
  // stylesheets don't cross the shadow boundary). `:host` replaces the
  // old ID selector for styling the badge's own box; everything else is
  // unchanged, just no longer needing the ID prefix since shadow DOM
  // scoping already isolates these class names from the page.
  const BADGE_SHADOW_CSS = `
    :host {
      all: initial;
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 2147483647;
      width: 236px;
      background: #101814;
      border: 1px solid #2a362f;
      border-radius: 10px;
      padding: 10px 12px 11px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      color: #EDEAE0;
      animation: pl-rise 220ms ease-out;
      display: block;
      box-sizing: border-box;
    }
    :host(.pl-alert) { border-color: #6b3630; }
    @keyframes pl-rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .pl-row { display: flex; align-items: center; width: 100%; box-sizing: border-box; }
    .pl-head { gap: 6px; margin-bottom: 6px; }
    .pl-dot { width: 6px; height: 6px; border-radius: 50%; background: #E8A33D; flex: none; }
    :host(.pl-good) .pl-dot { background: #3FA796; }
    .pl-title {
      font-size: 10px; letter-spacing: 0.02em; color: #A8AFA6; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pl-close { all: unset; cursor: pointer; color: #6B756E; font-size: 13px; line-height: 1; padding: 0 2px; }
    .pl-close:hover { color: #EDEAE0; }
    .pl-price-row { justify-content: space-between; margin-bottom: 4px; }
    .pl-price { font-size: 18px; font-weight: 600; color: #EDEAE0; letter-spacing: -0.01em; }
    .pl-spark { width: 78px; height: 24px; color: #E8A33D; flex: none; }
    :host(.pl-good) .pl-spark { color: #3FA796; }
    .pl-verdict { font-size: 11px; color: #E8A33D; margin-bottom: 3px; }
    :host(.pl-good) .pl-verdict { color: #3FA796; }
    .pl-meta { font-size: 9.5px; color: #6B756E; line-height: 1.4; }
    .pl-claim {
      font-size: 9.5px; line-height: 1.4; margin-top: 6px; padding-top: 6px;
      border-top: 1px dashed #2a362f; white-space: normal;
    }
    .pl-claim-good { color: #3FA796; }
    .pl-claim-neutral { color: #6B756E; }
    .pl-claim-bad { color: #E2574C; font-weight: 600; }
  `;

  let badgeShadowRoot = null;

  function renderBadge(product, history) {
    document.getElementById("price-ledger-badge-host")?.remove();

    // Same-currency filtering matters here too — a badge showing "low
    // $65" against a $100 history that switched currency mid-stream would
    // be comparing numbers that aren't actually commensurable.
    const sameCurrencyHistory = filterSameCurrency(history, product.currency);
    const prices = sameCurrencyHistory.map((h) => h.p);
    const low = Math.min(...prices, product.price);
    const high = Math.max(...prices, product.price);
    const isAtLow = product.price <= low + 0.001;
    const diffFromLow = product.price - low;
    const claim = evaluateClaim(product, history);

    const host = document.createElement("div");
    host.id = "price-ledger-badge-host";
    let stateClass = isAtLow ? "pl-good" : "";
    if (claim?.tone === "bad") stateClass = "pl-alert";
    if (stateClass) host.classList.add(stateClass);

    const shadow = host.attachShadow({ mode: "closed" });
    badgeShadowRoot = shadow;

    const verdict = isAtLow
      ? sameCurrencyHistory.length > 1
        ? "Lowest you've seen"
        : "First time tracking this"
      : `${fmt(diffFromLow, product.currency)} above your low`;

    shadow.innerHTML = `
      <style>${BADGE_SHADOW_CSS}</style>
      <div class="pl-row pl-head">
        <span class="pl-dot"></span>
        <span class="pl-title">${escapeHtml(truncate(product.title, 34))}</span>
        <button class="pl-close" title="Dismiss">&times;</button>
      </div>
      <div class="pl-row pl-price-row">
        <span class="pl-price">${fmt(product.price, product.currency)}</span>
        ${buildSparkline(sameCurrencyHistory)}
      </div>
      <div class="pl-row pl-verdict">${verdict}</div>
      ${
        sameCurrencyHistory.length > 1
          ? `<div class="pl-row pl-meta">Low ${fmt(low, product.currency)} · High ${fmt(high, product.currency)} · ${sameCurrencyHistory.length} checks</div>`
          : `<div class="pl-row pl-meta">Come back later — history builds as you browse.</div>`
      }
      ${claim ? `<div class="pl-row pl-claim pl-claim-${claim.tone}">${escapeHtml(claim.text)}</div>` : ""}
    `;

    shadow.querySelector(".pl-close").addEventListener("click", () => host.remove());
    document.documentElement.appendChild(host);
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  // ---------- 4. Run ----------

  async function run() {
    document.getElementById("price-ledger-badge-host")?.remove();

    let product = detectFromJsonLd();
    if (!product) {
      product = detectFromMeta();
    }
    if (product) {
      stopDomPriceWatcher();
      const { history, isNewLow, priorLow } = await recordObservation(product);
      renderBadge(product, history);
      if (isNewLow) notifyNewLow(product, priorLow);
      return;
    }
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
    setTimeout(run, 400);
  }, 1000);

  // Give client-rendered pages (React/Vue product pages) a beat to hydrate.
  if (document.readyState === "complete") {
    setTimeout(run, 600);
  } else {
    window.addEventListener("load", () => setTimeout(run, 600));
  }
})();
