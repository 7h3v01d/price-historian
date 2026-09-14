// Price Ledger — regression test suite
//
// Setup: npm install (installs jsdom, a dev-only dependency used for
// real DOM-based behavioral tests — not part of the shipped extension).
// Run with: node test/run-tests.js (or npm test)
//
// Covers the canonical logic in shared.js: the price parser, currency
// sanitization/isolation, the claim evaluator, JSON-LD candidate
// selection, and claim-proximity scoring. This exists because an
// adversarial review found that content.js, history.js, and popup.js had
// drifted out of sync on claim logic that was supposed to be shared —
// exactly the kind of regression a small test suite catches immediately
// and a human reviewing three files by eye can miss. A later review round
// also found that source-pattern tests (checking that certain code exists
// in content.js, rather than exercising it) couldn't actually prove the
// detection behaved correctly — the JSON-LD selection and claim-proximity
// logic were extracted into shared.js specifically so real behavioral
// tests against plain data and DOM fixtures could replace those
// source-pattern checks where it mattered most.

const assert = require("assert");
const path = require("path");
const fs = require("fs");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error("jsdom isn't installed — run `npm install` in this directory first (dev-only, not part of the shipped extension).");
  process.exit(1);
}

// shared.js is a plain script (not a module) meant to run in a browser
// content-script/extension-page context. It only touches `document` in
// escapeHtml(), which nothing here calls — everything else is pure or
// (for proximityHops) operates on whatever DOM elements are passed to it
// regardless of the global `document`, so real jsdom elements can be used
// directly in tests without needing to swap this stub out.
global.document = {
  createElement: () => {
    throw new Error("escapeHtml() was called in a test that didn't expect DOM access");
  },
};

const sharedSrc = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
// eslint-disable-next-line no-eval
eval(sharedSrc);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

console.log("parsePriceAmount — value cases");
const valueCases = [
  ["19.99", 19.99],
  ["1,299.99", 1299.99],
  ["12,999.00", 12999.0],
  ["10000.00", 10000.0],
  ["12.5", 12.5],
  ["1.299,99", 1299.99],
  ["1 299,99", 1299.99],
  ["1,299", 1299],
  ["1.299", 1299],
  ["10000", 10000],
  ["3.00", 3],
  ["529.00", 529],
  ["12,999,000", 12999000],
  ["0.5", 0.5],
  ["1,234,567.89", 1234567.89],
];
for (const [input, expected] of valueCases) {
  test(`parses "${input}" as ${expected}`, () => {
    const got = parsePriceAmount(input);
    assert(got !== null, `expected ${expected}, got null`);
    assert(Math.abs(got - expected) < 0.001, `expected ${expected}, got ${got}`);
  });
}

console.log("\nparsePriceAmount — rejection cases (must return null, not a wrong guess)");
const rejectCases = ["", "abc", "1.23.45", "1,2,3", "$", ".", ",", "1,,2"];
for (const input of rejectCases) {
  test(`rejects "${input}"`, () => {
    assert.strictEqual(parsePriceAmount(input), null);
  });
}

console.log("\nsanitizeCurrency");
test("accepts a valid 3-letter code", () => {
  assert.strictEqual(sanitizeCurrency("aud", "FALLBACK"), "AUD");
});
test("rejects HTML-bearing input, uses fallback", () => {
  assert.strictEqual(sanitizeCurrency("<img src=x onerror=1>", "FALLBACK"), "FALLBACK");
});
test("rejects non-3-letter input, uses fallback", () => {
  assert.strictEqual(sanitizeCurrency("US", "FALLBACK"), "FALLBACK");
});

console.log("\nfmt() never echoes unvalidated currency text (stored-HTML-injection regression)");
test("malicious currency string never appears in fmt() output", () => {
  const malicious = "<img src=x onerror=alert(1)>";
  const output = fmt(19.99, malicious);
  assert(!output.includes("<img"), `fmt() leaked untrusted markup: ${output}`);
});
test("null currency renders honestly instead of a fake label", () => {
  assert.strictEqual(fmt(89.95, null), "89.95 (currency unknown)");
});

console.log("\nfilterSameCurrency — currency-blind comparison regression");
test("does not mix AUD and USD in a filtered series", () => {
  const history = [
    { p: 100, c: "AUD", t: 0 },
    { p: 65, c: "USD", t: 1 },
  ];
  const filtered = filterSameCurrency(history, "USD");
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].p, 65);
});
test("a USD 65 reading is not a new low against an AUD 100 history", () => {
  const history = [{ p: 100, c: "AUD", t: 0 }];
  const priorSameCurrency = filterSameCurrency(history, "USD");
  const priorLow = priorSameCurrency.length ? Math.min(...priorSameCurrency.map((h) => h.p)) : null;
  assert.strictEqual(priorLow, null, "USD has no prior history, so there's nothing to compare against yet");
});

console.log("\nevaluateClaimAt — claim evidence thresholds");
const day = 86400000;
test("thin evidence (2 observations, 14-day span) is neutral, not inflated", () => {
  const history = [
    { p: 60, c: "AUD", t: 0, w: null },
    { p: 65, c: "AUD", t: 14 * day, w: null },
    { p: 64, c: "AUD", t: 15 * day, w: 100 },
  ];
  const result = evaluateClaimAt(history, history.length - 1);
  assert.strictEqual(result.tone, "neutral");
});
test("strong evidence (5 observations, 21-day span) is flagged", () => {
  const history = [
    { p: 10, c: "AUD", t: 0, w: null },
    { p: 10, c: "AUD", t: 5 * day, w: null },
    { p: 10, c: "AUD", t: 10 * day, w: null },
    { p: 10, c: "AUD", t: 15 * day, w: null },
    { p: 10, c: "AUD", t: 20 * day, w: null },
    { p: 6, c: "AUD", t: 21 * day, w: 12 },
  ];
  const result = evaluateClaimAt(history, history.length - 1);
  assert.strictEqual(result.tone, "bad");
});
test("a claim that matches observed history checks out", () => {
  const history = [
    { p: 12, c: "AUD", t: 0, w: null },
    { p: 6, c: "AUD", t: day, w: 12 },
  ];
  const result = evaluateClaimAt(history, history.length - 1);
  assert.strictEqual(result.tone, "good");
});
test("first-ever observation with a claim is neutral, never accusatory", () => {
  const history = [{ p: 6, c: "AUD", t: 0, w: 12 }];
  const result = evaluateClaimAt(history, 0);
  assert.strictEqual(result.tone, "neutral");
  assert.strictEqual(result.pastCount, 0);
});
test("claim evaluation ignores prior observations in a different currency", () => {
  const history = [
    { p: 100, c: "USD", t: 0, w: null },
    { p: 100, c: "USD", t: day, w: null },
    { p: 100, c: "USD", t: 2 * day, w: null },
    { p: 100, c: "USD", t: 20 * day, w: null },
    { p: 6, c: "AUD", t: 21 * day, w: 12 },
  ];
  // Only the single AUD point precedes this one in its own currency — not
  // enough evidence, regardless of how much USD history exists.
  const result = evaluateClaimAt(history, history.length - 1);
  assert.strictEqual(result.tone, "neutral");
});

console.log("\nfilterSameCurrency / evaluateClaimAt — unknown (null) currency must never match itself");
test("null currency never matches another null currency", () => {
  const history = [{ p: 100, c: null, t: 0 }];
  const filtered = filterSameCurrency(history, null);
  assert.strictEqual(filtered.length, 0, "two unknown-currency observations must not be treated as comparable");
});
test("a null-currency history never produces a fabricated new-low comparison", () => {
  // The exact scenario from the review: a storefront silently switches
  // region (A$100 -> currency unavailable -> US$65 -> currency
  // unavailable), and both unknown-currency readings must never be
  // compared against each other.
  const history = [{ p: 100, c: null, t: 0 }];
  const priorSameCurrency = filterSameCurrency(history, null);
  assert.strictEqual(priorSameCurrency.length, 0);
});
test("a claim on a null-currency observation is reported as unknown, not neutral-first-time", () => {
  const history = [{ p: 6, c: null, t: 0, w: 12 }];
  const result = evaluateClaimAt(history, 0);
  assert.strictEqual(result.tone, "neutral");
  assert.strictEqual(result.currencyUnknown, true);
});

console.log("\nparseStructuredPrice — three-decimal currencies (KWD/BHD/OMR/JOD/TND) must not be 1000x corrupted");
const structuredCases = [
  ["1.250", 1.25],
  ["0.750", 0.75],
  ["12.345", 12.345],
  ["19.99", 19.99],
  ["1299.99", 1299.99],
];
for (const [input, expected] of structuredCases) {
  test(`parseStructuredPrice("${input}") === ${expected}, not ${expected * 1000}`, () => {
    const got = parseStructuredPrice(input);
    assert(got !== null, `expected ${expected}, got null`);
    assert(Math.abs(got - expected) < 0.0001, `expected ${expected}, got ${got}`);
  });
}
test("parseStructuredPrice rejects locale-formatted input (that's parsePriceAmount's job, not this one's)", () => {
  // Structured data is never locale-formatted per spec — a comma here
  // means the source data is malformed, not that grouping should be
  // guessed at.
  assert.strictEqual(parseStructuredPrice("1,299.99"), null);
});

console.log("\nevaluateClaimAt — evidence requires distinct observation DAYS, not raw observation rows");
test("four same-day observation rows (e.g. claim edits) do not satisfy the observation-count threshold", () => {
  const history = [
    { p: 50, c: "AUD", t: 0, w: null },
    { p: 50, c: "AUD", t: 1000 * 60 * 20, w: 90 }, // 20 min later, claim appears
    { p: 50, c: "AUD", t: 1000 * 60 * 40, w: null }, // 40 min later, claim disappears
    { p: 48, c: "AUD", t: 1000 * 60 * 60, w: null }, // 1hr later, price changes
    { p: 45, c: "AUD", t: 15 * day, w: 90 }, // day 15, second visit — the point being evaluated
  ];
  const result = evaluateClaimAt(history, history.length - 1);
  // All 4 PRIOR rows fall on the same single calendar day (day 0) — the
  // point being evaluated (day 15) isn't itself "prior evidence," so
  // distinctDays counts only what came before it. 4 prior rows, 14-day
  // span — would have passed the old raw-count check — but only 1
  // distinct day of actual prior coverage.
  assert.strictEqual(result.distinctDays, 1);
  assert.strictEqual(result.tone, "neutral", "1 distinct day of prior coverage is thin evidence regardless of row count");
});


console.log("\nStructural checks — content.js safety patterns still bound to its closure (see note on why these remain source-pattern checks)");
// Most of the JSON-LD scoring/identity logic and the claim-proximity
// calculation were extracted into shared.js specifically so they could be
// exercised with real behavioral tests instead of these (see above) — but
// a few things still need live DOM/browser globals content.js owns
// (findClaimedWasPrice's anchor requirement, the Shadow DOM badge
// rendering) and remain checked this weaker way for now.
const contentSrc = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

test("findClaimedWasPrice requires an anchor element (no whole-document fallback)", () => {
  assert(
    /function findClaimedWasPrice\(anchorEl\)/.test(contentSrc) && /if \(!anchorEl\) return null;/.test(contentSrc),
    "findClaimedWasPrice appears to have lost its required-anchor guard"
  );
});
test("the badge host element never receives a verdict-dependent class (Shadow DOM privacy fix)", () => {
  assert(
    !/host\.classList\.add\(stateClass\)/.test(contentSrc),
    "host.classList.add(stateClass) reappeared — this leaks the verdict via the externally-visible host element"
  );
  assert(/host\.attachShadow\(\{\s*mode:\s*"closed"\s*\}\)/.test(contentSrc), "badge no longer uses a closed shadow root");
});

console.log("\nselectBestJsonLdCandidate — behavioral tests (real function calls, not source patterns)");
test("a single unrelated Product on a homepage is not auto-accepted by identity alone (still flags zero title match)", () => {
  // selectBestJsonLdCandidate() only owns the identity/scoring decision —
  // it correctly returns a result here (nothing else to compare against),
  // but flags bestTitleMatch: 0 so the caller (content.js) knows this
  // needs independent corroboration before trusting it. That corroboration
  // step itself needs live DOM access (og:type, visible price scanning)
  // and is checked structurally below, since it can't be exercised without
  // a full browser-like page.
  const result = selectBestJsonLdCandidate(
    [{ name: "Unrelated Featured Toaster", priceInfo: { price: 29.95, currency: "AUD", isExact: true }, sku: "TOASTER-1" }],
    "Blue Widget"
  );
  assert(result !== null, "a lone candidate should still be returned with its match quality flagged");
  assert.strictEqual(result.bestTitleMatch, 0, "zero title correspondence should be reported, not silently ignored");
});
test("multiple candidates with zero identity correspondence are rejected outright", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Beach Towel", priceInfo: { price: 15, currency: "AUD", isExact: true } },
      { name: "Sunscreen SPF50", priceInfo: { price: 22, currency: "AUD", isExact: true } },
      { name: "Flip Flops", priceInfo: { price: 18, currency: "AUD", isExact: true } },
    ],
    "Summer Sale"
  );
  assert.strictEqual(result, null, "a listing page with several unrelated products and no title match should reject detection entirely");
});
test("identity correspondence outranks an unrelated exact price (scoring inversion regression)", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Sony WH-1000XM5 Headphones", priceInfo: { price: 349, currency: "AUD", isExact: false } },
      { name: "Random USB Cable", priceInfo: { price: 12, currency: "AUD", isExact: true } },
    ],
    "Sony WH-1000XM5 Headphones"
  );
  assert(result !== null && result.candidate.name === "Sony WH-1000XM5 Headphones", "the matching-title candidate should win despite the unrelated item having an exact price");
});
test("tied candidates that disagree on price are rejected (Red $10 / Blue $20)", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Widget", priceInfo: { price: 10, currency: "AUD", isExact: true }, sku: "RED" },
      { name: "Widget", priceInfo: { price: 20, currency: "AUD", isExact: true }, sku: "BLUE" },
    ],
    "Widget"
  );
  assert.strictEqual(result, null, "two equally-scoring variants with different prices must not be arbitrarily resolved");
});
test("tied candidates with the SAME price but different SKUs are still rejected (5th round: equal price != equal product)", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Widget", priceInfo: { price: 10, currency: "AUD", isExact: true }, sku: "RED" },
      { name: "Widget", priceInfo: { price: 10, currency: "AUD", isExact: true }, sku: "BLUE" },
    ],
    "Widget"
  );
  assert.strictEqual(result, null, "matching price alone doesn't mean matching identity — different SKUs at the same price are still a real conflict, not a safe duplicate");
});
test("tied candidates in different currencies at the same numeric price are rejected (AUD 100 vs USD 100)", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Item", priceInfo: { price: 100, currency: "AUD", isExact: true } },
      { name: "Item", priceInfo: { price: 100, currency: "USD", isExact: true } },
    ],
    "Item"
  );
  assert.strictEqual(result, null, "100 AUD and 100 USD are not equivalent evidence just because the numbers match");
});
test("three-decimal currency prices are NOT collapsed by the tie-identity check (KWD 1.250 vs 1.251)", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Item", priceInfo: { price: 1.25, currency: "KWD", isExact: true } },
      { name: "Item", priceInfo: { price: 1.251, currency: "KWD", isExact: true } },
    ],
    "Item"
  );
  assert.strictEqual(result, null, "1.250 and 1.251 KWD are genuinely different prices and must be treated as a real conflict, not rounded together");
});
test("genuine duplicate candidates (identical in every way) are still accepted — no real ambiguity", () => {
  const result = selectBestJsonLdCandidate(
    [
      { name: "Widget", priceInfo: { price: 19.99, currency: "AUD", isExact: true } },
      { name: "Widget", priceInfo: { price: 19.99, currency: "AUD", isExact: true } },
    ],
    "Widget"
  );
  assert(result !== null, "identical duplicate JSON-LD entries (same name, price, currency) should still be accepted");
});

console.log("\noffersAreAmbiguous — behavioral tests (6th adversarial review round: ambiguity survived one layer below the candidate-tie fix)");
test("two offers within ONE Product at 1.250 vs 1.251 KWD are ambiguous (rounding-collapse regression)", () => {
  const ambiguous = offersAreAmbiguous([{ price: "1.250", priceCurrency: "KWD" }, { price: "1.251", priceCurrency: "KWD" }], "USD");
  assert.strictEqual(ambiguous, true, "1.250 and 1.251 KWD must not be collapsed into 'the same offer' by 2-decimal rounding");
});
test("two offers within ONE Product at the same number but different currencies are ambiguous", () => {
  const ambiguous = offersAreAmbiguous([{ price: "100", priceCurrency: "AUD" }, { price: "100", priceCurrency: "USD" }], "USD");
  assert.strictEqual(ambiguous, true, "AUD 100 and USD 100 are not the same offer just because the numbers match");
});
test("two conflicting lowPrice offers (non-exact) are ambiguous — not just exact-price offers", () => {
  const ambiguous = offersAreAmbiguous([{ lowPrice: "50", priceCurrency: "AUD" }, { lowPrice: "80", priceCurrency: "AUD" }], "AUD");
  assert.strictEqual(ambiguous, true, "conflicting non-exact offers must be caught too, not just conflicting exact prices");
});
test("a single genuine offer is not ambiguous", () => {
  const ambiguous = offersAreAmbiguous([{ price: "19.99", priceCurrency: "AUD" }], "AUD");
  assert.strictEqual(ambiguous, false);
});
test("identical duplicate offers within one Product are not ambiguous", () => {
  const ambiguous = offersAreAmbiguous([{ price: "19.99", priceCurrency: "AUD" }, { price: "19.99", priceCurrency: "AUD" }], "AUD");
  assert.strictEqual(ambiguous, false, "genuinely identical duplicate offers shouldn't be flagged as a conflict");
});

console.log("\nfindLocalContainer — behavioral tests against real DOM fixtures (jsdom)");
// This replaces reliance on proximityHops' distance threshold as the
// PRIMARY defense — a 6th adversarial review round found that threshold
// (<=3 hops) still accepted an unrelated <aside class="promo"> claim when
// the price had no wrapper div around it (price and aside both direct
// children of <main> — combined distance exactly 3, right at the
// boundary). findLocalContainer's ambiguity-based scoping is the real
// fix; proximityHops remains as a secondary layer below.
test("an unrelated sibling section's claim is rejected in the EXACT minimal reproduction (no wrapper div — 6th round regression)", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main><span class="price">$50</span><aside class="promo"><del>$100</del></aside></main></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const container = findLocalContainer(anchor, doc);
  assert(!container.querySelector("del"), "the unrelated aside's claim must not be reachable from the resolved container");
});
test("an unrelated sibling section's claim is still rejected with an extra wrapper div (the original 5th-round fixture)", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main><div id="product"><span class="price">$50</span></div><aside class="promo"><del>$100</del></aside></main></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const container = findLocalContainer(anchor, doc);
  assert(!container.querySelector("del"), "the unrelated aside's claim must not be reachable from the resolved container");
});
test("a genuinely co-located claim (direct sibling) is still found", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="main-product"><span class="price">$50</span><del>$100</del></div></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const container = findLocalContainer(anchor, doc);
  assert(container.querySelector("del"), "a claim that's a direct sibling of the price should still be found");
});
test("a realistic nested price-container pattern (price and was-price each in their own wrapper) still passes", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="product-details"><div class="price-container"><div class="price">$50</div><div class="was-price">$100</div></div></div></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const container = findLocalContainer(anchor, doc);
  assert(container.querySelector(".was-price"), "a legitimately nested was-price should still be found");
});

console.log("\nproximityHops — secondary defense-in-depth layer (behavioral tests)");
test("an unrelated sibling section's claim is far by hop-distance too, once a wrapper is present", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main><div id="product"><span class="price">$50</span></div><aside class="promo"><del>$100</del></aside></main></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const del = doc.querySelector("del");
  const dist = proximityHops(anchor, del);
  assert(dist > 3, `expected the unrelated aside's claim to be far (>3 hops), got ${dist}`);
});
test("a genuinely co-located claim (direct sibling) is close enough to accept", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="main-product"><span class="price">$50</span><del>$100</del></div></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const del = doc.querySelector("del");
  const dist = proximityHops(anchor, del);
  assert(dist <= 3, `expected the co-located claim to be close (<=3 hops), got ${dist}`);
});
test("a realistic nested price-container pattern (price and was-price each in their own wrapper) still passes", () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="product-details"><div class="price-container"><div class="price">$50</div><div class="was-price">$100</div></div></div></body></html>`
  );
  const doc = dom.window.document;
  const anchor = doc.querySelector(".price");
  const wasEl = doc.querySelector(".was-price");
  const dist = proximityHops(anchor, wasEl);
  assert(dist <= 3, `expected the nested-wrapper claim to still be close enough (<=3 hops), got ${dist}`);
});

console.log("\nStructural checks — content.js-specific corroboration logic (needs live DOM access, can't be exercised with plain data)");
test("single zero-identity JSON-LD candidates require BOTH og:type=product AND a matching visible price, not either alone", () => {
  assert(
    /pageDeclaresProductType\(\)\s*&&\s*hasVisiblePriceCorroboration\(/.test(contentSrc),
    "the corroboration check should use && (both required) — an earlier version used || (either alone was accepted), which let og:type=product alone rescue a completely unrelated stale candidate"
  );
});
test("price and claim detection both check element visibility", () => {
  assert(/function isVisible\(/.test(contentSrc), "isVisible() appears to have been removed");
  const findPriceElementsBlock = contentSrc.slice(contentSrc.indexOf("function findPriceElements"), contentSrc.indexOf("function findPriceElements") + 800);
  assert(/isVisible\(el\)/.test(findPriceElementsBlock), "findPriceElements no longer filters out hidden candidates");
});
test("structured (JSON-LD/meta) prices are checked against the visible price before being trusted (6th round: OG/microdata bypassed corroboration entirely)", () => {
  assert(
    /function disagreesWithVisiblePrice/.test(contentSrc),
    "disagreesWithVisiblePrice appears to have been removed — structured data could again silently override a materially different visible price"
  );
  assert(
    /disagreesWithVisiblePrice\(product\.price\)/.test(contentSrc),
    "run() should check every structured detection result against the visible price, not just the zero-identity JSON-LD case"
  );
});
test("the itemprop=\"price\" fallback requires the matched element to be visible", () => {
  const anchorIdx = contentSrc.indexOf('querySelectorAll(\'[itemprop="price"]\')');
  assert(anchorIdx !== -1, "couldn't locate the itemprop querySelectorAll call at all");
  const itemPropBlock = contentSrc.slice(anchorIdx, anchorIdx + 400);
  assert(/isVisible\(itemPropEls\[0\]\)/.test(itemPropBlock), "a hidden stale/inactive itemprop price could again beat the visible current price");
});

console.log("\nStructural check — unused page-controlled image metadata no longer persisted");
test("product.image is never written to storage", () => {
  assert(!/image: product\.image/.test(contentSrc), "product.image is being persisted again — it was removed because it's unused in the UI and was unbounded page-controlled data (a hostile page could supply a huge data: URL)");
});

console.log("\nStructural check — storage key length bounding");
test("page-controlled SKU/GTIN identifiers are bounded before use in a storage key", () => {
  assert(/function sanitizeIdForKey/.test(contentSrc), "sanitizeIdForKey appears to have been removed — a page could again supply an unbounded identifier into a storage key");
});

console.log("\nEmpty-array guards — filterSameCurrency([], ...) correctly returning [] must not silently become Infinity/NaN downstream");
// Fixing the null-currency matching bug (above) means filterSameCurrency
// can now legitimately return an empty array for a product whose currency
// is unknown. Math.min()/Math.max() on an empty array silently produces
// Infinity/-Infinity rather than throwing — several call sites across
// content.js, history.js, and popup.js assumed a non-empty result and
// would have shown "Infinity" or crashed on the very first genuinely
// unknown-currency product. These are structural checks (the actual
// guards live inside DOM-rendering functions not independently
// callable here) confirming each site was updated with an explicit
// length check rather than relying on the old, no-longer-true assumption.
const historySrc = fs.readFileSync(path.join(__dirname, "..", "history.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

test("content.js's badge handles unknown currency before computing low/high", () => {
  assert(/isCurrencyUnknown/.test(contentSrc), "renderBadge should explicitly branch on unknown currency");
});
test("history.js's per-product chart handles unknown currency before Math.min/max", () => {
  assert(/last\.c == null/.test(historySrc), "renderChart should explicitly branch on unknown currency before building chart stats");
});
test("history.js's spend summary excludes unknown-currency products rather than crashing on an empty history", () => {
  assert(/unknownCurrencyCount/.test(historySrc), "groupProductsByCurrency should track and exclude unknown-currency products");
});
test("history.js's comparison view guards its own per-member 'low' against an empty same-currency history", () => {
  assert(
    /ownHistorySameCurrency\.length \? Math\.min/.test(historySrc),
    "the comparison view's per-member low calculation should guard against an empty array before calling Math.min"
  );
});
test("popup.js's list handles unknown currency before computing low", () => {
  assert(/isCurrencyUnknown/.test(popupSrc), "the popup list should explicitly branch on unknown currency");
});

// ---------- Structural consistency check ----------
// This is the test that would have actually caught the real regression:
// popup.js had its own re-implementation of the claim-threshold logic
// that fell out of sync with content.js and history.js after the
// thresholds were tightened. A unit test on shared.js alone can't catch
// "a consumer stopped calling the shared function" — this checks the
// consuming files' source directly for exactly that failure mode.
console.log("\nSource consistency — consuming files must call the shared evaluator, not reimplement it");

const consumerFiles = ["content.js", "history.js", "popup.js"];
const suspiciousPatterns = [
  /observedMax\s*=\s*Math\.max/, // re-deriving the claim's "observed max" locally
  /MIN_DAYS_FOR_INFLATED_VERDICT\s*=\s*\d/, // redeclaring the shared constant instead of importing it
  /MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT\s*=\s*\d/,
];

for (const file of consumerFiles) {
  test(`${file} calls evaluateClaimAt() rather than reimplementing claim logic`, () => {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert(src.includes("evaluateClaimAt("), `${file} never calls the shared evaluateClaimAt()`);
    for (const pattern of suspiciousPatterns) {
      assert(!pattern.test(src), `${file} appears to reimplement claim logic locally (matched ${pattern})`);
    }
  });
}

console.log("\nREADME consistency — documented constant names must match what's actually in shared.js");
// A prior round renamed MIN_OBSERVATIONS_FOR_INFLATED_VERDICT to
// MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT to reflect its real semantics
// (distinct days, not raw observation count) but missed updating the
// README's mention of it — someone tuning the documented name wouldn't
// find it. This checks the README only ever references constant names
// that actually exist in shared.js.
test("README doesn't reference the old, renamed constant name", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert(!readme.includes("MIN_OBSERVATIONS_FOR_INFLATED_VERDICT"), "README still references the pre-rename constant name");
});
test("every ALL_CAPS constant name the README mentions actually exists in shared.js", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const mentioned = new Set((readme.match(/`(MIN_[A-Z_]+)`/g) || []).map((m) => m.slice(1, -1)));
  for (const name of mentioned) {
    assert(sharedSrc.includes(`const ${name}`), `README mentions \`${name}\`, which doesn't exist in shared.js`);
  }
});

console.log(`\n${passed} passed, ${failed} failed (total)`);
if (failed > 0) process.exit(1);
