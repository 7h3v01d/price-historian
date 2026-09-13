// Price Ledger — regression test suite
//
// Run with: node test/run-tests.js
//
// Covers the canonical logic in shared.js: the price parser, currency
// sanitization/isolation, and the claim evaluator. This exists because an
// adversarial review found that content.js, history.js, and popup.js had
// drifted out of sync on claim logic that was supposed to be shared —
// exactly the kind of regression a small test suite catches immediately
// and a human reviewing three files by eye can miss.
//
// What this does NOT cover yet, and should before this is called
// comprehensive: JSON-LD candidate scoring, the DOM watcher's dedupe key,
// and the popup/history/content.js integration points themselves (this
// suite tests shared.js directly, not whether each consumer actually
// calls it correctly — that still requires reading the calling code).

const assert = require("assert");
const path = require("path");
const fs = require("fs");

// shared.js is a plain script (not a module) meant to run in a browser
// content-script/extension-page context. It only touches `document` in
// escapeHtml(), which nothing here calls — everything else is pure.
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


console.log("\nStructural checks — content.js safety patterns (see note below on why these are structural, not unit tests)");
// titleSimilarity/JSON-LD scoring and findClaimedWasPrice's scoping live
// inside content.js's IIFE closure, tied to `document`/`location` browser
// globals — not independently callable from a plain Node test the way
// shared.js's exported-by-convention functions are. Extracting them to
// shared.js so they could be unit tested properly is the right long-term
// fix; for now these check that the safety pattern is actually present in
// the source, which is weaker than a real unit test but still catches an
// accidental revert of either fix.
const contentSrc = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

test("JSON-LD detection rejects multi-candidate pages with zero identity match", () => {
  assert(
    /viableCandidateCount > 1 && bestTitleMatch === 0/.test(contentSrc),
    "the identity-floor guard appears to have been removed from detectFromJsonLd()"
  );
});
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

console.log("\nStructural checks — JSON-LD candidate confidence (4th adversarial review round)");
test("JSON-LD detection rejects tied candidates that disagree on price", () => {
  assert(
    /candidatesAtBestScore\.length > 1/.test(contentSrc) && /distinctPrices\.size > 1/.test(contentSrc),
    "the tied-candidate ambiguity guard appears to have been removed — two equal-scoring variants with different prices could be arbitrarily resolved to whichever was scanned first"
  );
});
test("a single zero-identity JSON-LD candidate requires independent corroboration", () => {
  assert(
    /pageDeclaresProductType\(\)/.test(contentSrc) && /hasVisiblePriceCorroboration\(/.test(contentSrc),
    "single-candidate corroboration requirement appears to have been removed — an unrelated Product on a non-product page could be accepted with no supporting evidence at all"
  );
});

console.log("\nStructural checks — ambiguity-aware claim scoping (4th adversarial review round)");
test("findLocalContainer stops at unrelated sibling sections rather than climbing a fixed depth", () => {
  assert(
    /looksLikeUnrelatedSection/.test(contentSrc) && /countPriceSignals/.test(contentSrc),
    "the ambiguity-aware container scoping appears to have reverted to a fixed-depth walk, which the 4th review round showed could still sweep in an unrelated recommendations section"
  );
});
test("price and claim detection both check element visibility", () => {
  assert(/function isVisible\(/.test(contentSrc), "isVisible() appears to have been removed");
  const findPriceElementsBlock = contentSrc.slice(contentSrc.indexOf("function findPriceElements"), contentSrc.indexOf("function findPriceElements") + 800);
  assert(/isVisible\(el\)/.test(findPriceElementsBlock), "findPriceElements no longer filters out hidden candidates");
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
