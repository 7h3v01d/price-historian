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

console.log(`\n${passed} passed, ${failed} failed`);

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
  /MIN_OBSERVATIONS_FOR_INFLATED_VERDICT\s*=\s*\d/,
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

console.log(`\n${passed} passed, ${failed} failed (total)`);
if (failed > 0) process.exit(1);
