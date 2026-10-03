// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Leon Priest (GitHub: 7h3v01d)
//
// Price Ledger — real-browser test suite.
//
// The jsdom suite (run-tests.js) can't exercise anything that depends on
// layout or on the real extension runtime: getClientRects(), computed
// styles inherited through real CSS, the closed Shadow DOM as seen from a
// page's own main world, and the actual MV3 service worker handling
// messages from real content scripts. This suite loads the unpacked
// extension into Playwright's Chromium, serves fixture pages from a local
// HTTP server under real-looking *.test domains, and checks what actually
// lands in chrome.storage.local — read straight from the service worker.
//
// Setup: npm install (dev-only; installs playwright, pinned to match its
// Chromium build). If Playwright's browsers aren't installed on your
// machine yet: npx playwright install chromium
// Run: npm run test:browser   (or: node test/browser-tests.js)
// Set PL_HEADED=1 to watch it run in a visible window.

const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright isn't installed — run `npm install` in this directory first (dev-only).");
  process.exit(1);
}

const EXTENSION_DIR = path.join(__dirname, "..");

// shared.js is a plain script; load it here so fixtures can compute the
// exact storage keys the extension will use.
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(EXTENSION_DIR, "shared.js"), "utf8").replace(/^const /gm, "var "));
const BAD_KEY = buildFallbackProductKey("Bad", "/p/bad");

// ---------------------------------------------------------------------------
// Fixture server. Pages are registered per test as { host, path } -> html.
// Chromium maps every *.test hostname to this server, so each fixture gets
// its own real origin (and its own domain in the ledger).
// ---------------------------------------------------------------------------

const pages = new Map();
function servePage(url, html) {
  const u = new URL(url);
  pages.set(`${u.hostname}${u.pathname}`, html);
}
const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const html = pages.get(`${host}${req.url.split("?")[0]}`);
  if (html == null) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function launch() {
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pl-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // full Chromium in new headless mode; the headless shell can't load extensions
    headless: !process.env.PL_HEADED,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP *.test 127.0.0.1:${port}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  // Playwright can attach to the worker before Chromium has installed its
  // chrome.* bindings; an evaluate() in that window sees chrome.storage as
  // undefined. Wait until the worker is genuinely ready.
  for (let i = 0; ; i++) {
    const ready = await worker.evaluate(() => typeof chrome?.storage?.local?.get === "function").catch(() => false);
    if (ready) break;
    if (i > 100) throw new Error("service worker never exposed chrome.storage");
    await new Promise((r) => setTimeout(r, 50));
  }
  const extensionId = new URL(worker.url()).host;
  return {
    context,
    worker,
    extensionId,
    async storage() {
      return worker.evaluate(() => chrome.storage.local.get(null));
    },
    async seed(data) {
      await worker.evaluate((d) => chrome.storage.local.set(d), data);
    },
    async close() {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

// Polls the real extension storage until predicate(store) is truthy.
async function waitForStorage(b, predicate, { timeout = 10000, label = "storage condition" } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await b.storage();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}; storage was ${JSON.stringify(last)}`);
}

const histories = (store) =>
  Object.entries(store).filter(([k]) => k.startsWith("history:")).map(([k, v]) => ({ key: k, prices: v.map((h) => h.p) }));

// After detection has had ample time to run (content.js waits 600ms after
// load, the DOM watcher polls every 1.2s), assert nothing was recorded.
async function expectNothingRecorded(b, ms = 4000) {
  await new Promise((r) => setTimeout(r, ms));
  const h = histories(await b.storage());
  assert.deepStrictEqual(h, [], `expected no observation, got ${JSON.stringify(h)}`);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function productPage({ title = "Widget", head = "", body = "", jsonLd = null, ogProduct = true } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:title" content="${title}">
${ogProduct ? '<meta property="og:type" content="product">' : ""}
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
${head}</head><body><h1>${title}</h1>${body}</body></html>`;
}

const jsonLdProduct = (price, extra = {}) => ({
  "@type": "Product",
  name: "Widget",
  sku: "SKU-1",
  offers: { "@type": "Offer", price: String(price), priceCurrency: "AUD" },
  ...extra,
});

// ---------------------------------------------------------------------------
// Runner: one fresh browser profile per test, so no state leaks between them.
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ===========================================================================
// Baseline: the real extension, end to end
// ===========================================================================

test("records a JSON-LD product's exact price through the real service worker", async (b) => {
  servePage("http://shop-a.test/p/widget", productPage({ jsonLd: jsonLdProduct(129.95) }));
  const page = await b.context.newPage();
  await page.goto("http://shop-a.test/p/widget");
  const store = await waitForStorage(b, (s) => s["history:shop-a.test:id:SKU-1"], { label: "the observation" });
  assert.deepStrictEqual(store["history:shop-a.test:id:SKU-1"].map((h) => [h.p, h.c]), [[129.95, "AUD"]]);
  assert.strictEqual(store["meta:shop-a.test:id:SKU-1"].url, "http://shop-a.test/p/widget");
});

test("the startup migration check completes and sets its per-version flag", async (b) => {
  const version = await b.worker.evaluate(() => chrome.runtime.getManifest().version);
  await waitForStorage(b, (s) => s.ledgerMigratedVersion === version, { label: "ledgerMigratedVersion" });
});

test("two real tabs recording the same product at once both land (the 0.10.0 race fix, in a real browser)", async (b) => {
  const yesterday = Date.now() - 86400000;
  await b.seed({
    "history:shop-a.test:id:SKU-1": [{ p: 120, c: "AUD", t: yesterday, w: null }],
    "meta:shop-a.test:id:SKU-1": { title: "Widget", url: "http://shop-a.test/p/widget", lastSeen: yesterday },
  });
  servePage("http://shop-a.test/p/widget", productPage({ jsonLd: jsonLdProduct(110) }));
  servePage("http://shop-a.test/p/widget-b", productPage({ jsonLd: jsonLdProduct(100) }));
  const [p1, p2] = await Promise.all([b.context.newPage(), b.context.newPage()]);
  await Promise.all([p1.goto("http://shop-a.test/p/widget"), p2.goto("http://shop-a.test/p/widget-b")]);
  const store = await waitForStorage(b, (s) => (s["history:shop-a.test:id:SKU-1"] || []).length >= 3, {
    label: "both observations",
  });
  const prices = store["history:shop-a.test:id:SKU-1"].map((h) => h.p);
  assert(prices.includes(110) && prices.includes(100), `history: [${prices}]`);
});

test("an in-place price change on a single-page app is picked up by the DOM watcher", async (b) => {
  servePage(
    "http://spa.test/p/milk",
    productPage({
      title: "Full Cream Milk 2L",
      body: `<span class="product-price">$3.10</span>
      <script>setTimeout(() => { document.querySelector(".product-price").textContent = "$2.85"; }, 3000);</script>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://spa.test/p/milk");
  const store = await waitForStorage(b, (s) => histories(s).some((h) => h.prices.includes(2.85)), {
    timeout: 12000,
    label: "the updated price",
  });
  assert.deepStrictEqual(histories(store)[0].prices, [3.1, 2.85]);
});

// ===========================================================================
// JSON-LD identity corroboration — needs live og:type and a real visible
// price, so the jsdom suite could only check these by source pattern.
// ===========================================================================

const toaster = { "@type": "Product", name: "Chrome 2-Slice Toaster", offers: { "@type": "Offer", price: "29.95", priceCurrency: "AUD" } };

test("a lone unrelated JSON-LD Product on a non-product page (a homepage feature) isn't recorded", async (b) => {
  servePage("http://shop-e.test/", productPage({ title: "Shop E — Home", ogProduct: false, jsonLd: toaster }));
  const page = await b.context.newPage();
  await page.goto("http://shop-e.test/");
  await expectNothingRecorded(b);
});

test("a stale unrelated JSON-LD Product on a product page loses to the visible price (two layers: corroboration + disagreement)", async (b) => {
  servePage(
    "http://shop-e.test/p/blue-widget",
    productPage({ title: "Blue Widget", jsonLd: toaster, body: `<span class="price" style="font-size:30px">$99.00</span>` })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-e.test/p/blue-widget");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  const all = histories(store);
  assert(!all.some((h) => h.prices.includes(29.95)), `the unrelated toaster price was recorded: ${JSON.stringify(all)}`);
  assert.deepStrictEqual(all.map((h) => h.prices), [[99]]);
});

test("og:type=product alone isn't corroboration: with no visible price to match, a stale unrelated Product isn't recorded", async (b) => {
  // No visible price, so the structured-vs-visible disagreement check has
  // nothing to compare against — only the AND in the corroboration gate
  // stands between this toaster and the ledger.
  servePage("http://shop-e.test/p/red-widget", productPage({ title: "Red Widget", jsonLd: toaster }));
  const page = await b.context.newPage();
  await page.goto("http://shop-e.test/p/red-widget");
  await expectNothingRecorded(b);
});

test("a listing page with several unrelated JSON-LD Products (none matching the title) records nothing", async (b) => {
  // One exact-price candidate outscores two range-floor ones, so there's a
  // unique best and no tie — only the identity floor (no candidate matches
  // the page title) rejects this. With all three tied, the tie-ambiguity
  // check would reject it too and the test couldn't isolate the floor.
  const items = [
    { "@type": "Product", name: "Kettle", sku: "L0", offers: { "@type": "Offer", price: "20", priceCurrency: "AUD" } },
    ...["Toaster", "Blender"].map((name, i) => ({
      "@type": "Product", name, sku: `L${i + 1}`,
      offers: { "@type": "AggregateOffer", lowPrice: String(30 + i), priceCurrency: "AUD" },
    })),
  ];
  servePage(
    "http://shop-e.test/c/kitchen",
    `<!doctype html><html><head><title>Kitchen appliances</title>
     <script type="application/ld+json">${JSON.stringify(items)}</script></head><body><h1>Kitchen</h1></body></html>`
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-e.test/c/kitchen");
  await expectNothingRecorded(b);
});

// ===========================================================================
// Visibility — getClientRects() and computed style need a real layout engine.
// These are the checks the jsdom suite documents it cannot make.
// ===========================================================================

test("a hidden responsive-layout price (display:none via media query, bigger font) loses to the visible one", async (b) => {
  servePage(
    "http://shop-b.test/p/lamp",
    productPage({
      title: "Desk Lamp",
      head: `<style>@media (min-width: 1px) { .desktop-only { display: none; } }</style>`,
      body: `<div class="desktop-only"><span class="price" style="font-size:32px">$59.00</span></div>
             <span class="price" style="font-size:28px">$49.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/lamp");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [49]);
});

test("a price under a display:none ancestor has no client rects and is skipped", async (b) => {
  servePage(
    "http://shop-b.test/p/kettle",
    productPage({
      title: "Kettle",
      body: `<div style="display:none"><div><span class="price" style="font-size:40px">$99.00</span></div></div>
             <span class="price" style="font-size:20px">$79.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/kettle");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [79]);
});

test("a price in an inactive, visibility:hidden carousel slide is skipped", async (b) => {
  servePage(
    "http://shop-b.test/p/toaster",
    productPage({
      title: "Toaster",
      body: `<div class="slide" style="visibility:hidden"><span class="price" style="font-size:40px">$15.00</span></div>
             <div class="slide"><span class="price" style="font-size:24px">$35.00</span></div>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/toaster");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [35]);
});

test("a hidden itemprop=price is never trusted", async (b) => {
  // The displayed price sits in an element the DOM watcher doesn't treat as
  // a price candidate, so neither the watcher nor the structured-vs-visible
  // check can rescue a wrong itemprop read — only itemprop's own visibility
  // check decides. Recording nothing is the correct outcome here.
  servePage(
    "http://shop-b.test/p/fan",
    productPage({
      title: "Desk Fan",
      body: `<div style="display:none"><span itemprop="price" content="10.00">$10.00</span></div>
             <p>Now only <b>$45.00</b></p>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/fan");
  await expectNothingRecorded(b);
});

test("a price struck through by an ANCESTOR's CSS line-through isn't recorded as the current price", async (b) => {
  servePage(
    "http://shop-b.test/p/blender",
    productPage({
      title: "Blender",
      body: `<span style="text-decoration-line:line-through"><span class="price" style="font-size:36px">$200.00</span></span>
             <span class="price" style="font-size:28px">$150.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/blender");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [150]);
});

test("structured data that contradicts the visible price is discarded in favour of what's shown", async (b) => {
  servePage(
    "http://shop-b.test/p/chair",
    productPage({
      title: "Widget",
      jsonLd: jsonLdProduct(100),
      body: `<span class="price" style="font-size:30px">$90.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/chair");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  const all = histories(store);
  assert.strictEqual(all.length, 1, JSON.stringify(all));
  assert.deepStrictEqual(all[0].prices, [90]);
});

test("a price whose ANCESTOR is opacity:0 is treated as hidden", async (b) => {
  servePage(
    "http://shop-b.test/p/mixer",
    productPage({
      title: "Mixer",
      body: `<div style="opacity:0"><span class="price" style="font-size:40px">$20.00</span></div>
             <span class="price" style="font-size:24px">$65.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/mixer");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [65]);
});

test("a price in an inactive carousel slide moved off-screen inside an overflow:hidden track is skipped", async (b) => {
  servePage(
    "http://shop-b.test/p/grill",
    productPage({
      title: "Grill",
      body: `<div class="carousel" style="overflow:hidden;width:400px">
               <div class="track" style="display:flex;transform:translateX(0)">
                 <div class="slide" style="flex:0 0 400px"><span class="price" style="font-size:24px">$300.00</span></div>
                 <div class="slide" style="flex:0 0 400px"><span class="price" style="font-size:40px">$120.00</span></div>
               </div>
             </div>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/grill");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [300]);
});

test("a genuine price far below the fold still counts as visible", async (b) => {
  servePage(
    "http://shop-b.test/p/rug",
    productPage({
      title: "Rug",
      body: `<div style="height:3000px">Gallery</div><span class="price" style="font-size:28px">$240.00</span>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/rug");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [240]);
});

test("a genuine price inside a scrollable (overflow:auto) panel still counts, even scrolled out of view", async (b) => {
  servePage(
    "http://shop-b.test/p/desk",
    productPage({
      title: "Desk",
      body: `<div style="overflow:auto;height:100px"><div style="height:600px">Specs</div>
             <span class="price" style="font-size:28px">$410.00</span></div>`,
    })
  );
  const page = await b.context.newPage();
  await page.goto("http://shop-b.test/p/desk");
  const store = await waitForStorage(b, (s) => histories(s).length, { label: "an observation" });
  assert.deepStrictEqual(histories(store)[0].prices, [410]);
});

// ===========================================================================
// Badge isolation — seen from the PAGE's own main world, which jsdom can't
// separate from the content script's isolated world.
// ===========================================================================

async function badgeFromPageWorld(page) {
  await page.waitForSelector("#price-ledger-badge-host", { state: "attached", timeout: 10000 });
  // page.evaluate runs in the page's main world — exactly what a
  // retailer's own scripts can see.
  return page.evaluate(() => {
    const host = document.getElementById("price-ledger-badge-host");
    return {
      shadowRoot: host.shadowRoot,
      text: host.textContent,
      className: host.className,
      attrs: host.getAttributeNames().sort(),
      innerHTML: host.innerHTML,
    };
  });
}

test("the badge's closed shadow root hides its contents from the page's own scripts", async (b) => {
  servePage("http://shop-c.test/p/widget", productPage({ jsonLd: jsonLdProduct(55) }));
  const page = await b.context.newPage();
  await page.goto("http://shop-c.test/p/widget");
  const seen = await badgeFromPageWorld(page);
  assert.strictEqual(seen.shadowRoot, null, "page script can reach the shadow root");
  assert.strictEqual(seen.text, "", `page script can read badge text: ${seen.text}`);
  assert.strictEqual(seen.innerHTML, "");
});

test("the badge host looks identical to the page whether the verdict is good or an alert", async (b) => {
  const now = Date.now();
  const old = now - 30 * 86400000;
  // "good": today's price is the lowest seen. "alert": a "was" claim that
  // weeks of observed history don't corroborate.
  await b.seed({
    "history:shop-c.test:id:GOOD": [{ p: 80, c: "AUD", t: old, w: null }],
    "meta:shop-c.test:id:GOOD": { title: "Good", url: "http://shop-c.test/p/good", lastSeen: old },
    [`history:shop-c.test:${BAD_KEY}`]: [0, 1, 2, 3, 4].map((i) => ({ p: 50, c: null, t: old + i * 5 * 86400000, w: null })),
    [`meta:shop-c.test:${BAD_KEY}`]: { title: "Bad", url: "http://shop-c.test/p/bad", lastSeen: old },
  });
  servePage("http://shop-c.test/p/good", productPage({ title: "Good", jsonLd: jsonLdProduct(60, { name: "Good", sku: "GOOD" }) }));
  // Deliberately the DOM-watcher path (no JSON-LD): claims are only detected
  // there — see the JSON-LD claim note in the README.
  servePage(
    "http://shop-c.test/p/bad",
    productPage({
      title: "Bad",
      body: `<div class="buy-box"><span class="price" style="font-size:30px">$50.00</span> <del class="was-price">$120.00</del></div>`,
    })
  );
  const good = await b.context.newPage();
  await good.goto("http://shop-c.test/p/good");
  const bad = await b.context.newPage();
  await bad.goto("http://shop-c.test/p/bad");
  const g = await badgeFromPageWorld(good);
  const a = await badgeFromPageWorld(bad);
  // Sanity: the two pages really did get different verdicts, or this test proves nothing.
  const store = await waitForStorage(b, (s) => (s[`history:shop-c.test:${BAD_KEY}`] || []).some((h) => h.w === 120), {
    label: "the bad page's claim",
  });
  assert(store["history:shop-c.test:id:GOOD"].length === 2, "good page didn't record");
  assert.deepStrictEqual({ className: g.className, attrs: g.attrs }, { className: a.className, attrs: a.attrs });
});

// ===========================================================================
// Extension pages render stored data safely
// ===========================================================================

test("the popup and history page render a hostile stored title as text, not markup", async (b) => {
  const hostile = `<img src=x onerror="window.__plPwned=1">Widget`;
  await b.seed({
    "history:shop-d.test:id:X": [{ p: 10, c: "AUD", t: Date.now(), w: null }],
    "meta:shop-d.test:id:X": { title: hostile, url: "http://shop-d.test/p/x", lastSeen: Date.now() },
  });
  for (const file of ["popup.html", "history.html"]) {
    const page = await b.context.newPage();
    await page.goto(`chrome-extension://${b.extensionId}/${file}`);
    await page.waitForFunction((t) => document.body.innerText.includes(t), hostile, { timeout: 5000 });
    const result = await page.evaluate(() => ({ pwned: window.__plPwned === 1, imgs: document.querySelectorAll("img[src='x']").length }));
    assert.deepStrictEqual(result, { pwned: false, imgs: 0 }, `${file} rendered the title as markup`);
    await page.close();
  }
});

// ---------------------------------------------------------------------------

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const only = process.env.PL_ONLY;
  let passed = 0;
  let failed = 0;
  console.log("Real-browser tests — unpacked extension in Playwright Chromium");
  for (const { name, fn } of tests) {
    if (only && !name.includes(only)) continue;
    pages.clear();
    let b;
    try {
      b = await launch();
      await fn(b);
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL  ${name}`);
      const lines = String(err.message).split("\n").filter((l) => l.trim()).slice(0, 8);
      console.log(lines.map((l) => `        ${l}`).join("\n"));
      failed++;
    } finally {
      if (b) await b.close().catch(() => {});
    }
  }
  server.close();
  console.log(`\n${passed} passed, ${failed} failed (browser)`);
  process.exit(failed > 0 ? 1 : 0);
})();
