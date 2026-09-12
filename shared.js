// Price Ledger — shared helpers
// Loaded before content.js (as an extra content script) and before
// popup.js/history.js (as a plain <script> tag) so all three can use these
// without three copy-pasted definitions drifting out of sync.

// fmt() is intrinsically safe against untrusted currency strings — it
// sanitizes internally rather than trusting callers to have done it
// already. This matters even though every known page-controlled ingestion
// point now sanitizes currency before storage: it closes the gap for (a)
// any future call site that forgets to sanitize first, and (b) currency
// values already persisted by an older version before this validation
// existed — chrome.storage.local survives ordinary extension updates, so
// stale unsanitized data can still reach fmt() after upgrading.
function fmt(price, currency) {
  const safeCurrency = sanitizeCurrency(currency, null);
  if (!safeCurrency) {
    // Never echo an unvalidated currency string, even in a fallback path.
    return `${price.toFixed(2)} (currency unknown)`;
  }
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: safeCurrency }).format(price);
  } catch {
    return `${safeCurrency} ${price.toFixed(2)}`;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Canonical price parsing ----------
// Every place that used to do its own `match(...).replace(/[^0-9.]/g,"")`
// regex parsing is now routed through here instead. That ad-hoc approach
// silently mangled anything with a thousands separator: "$1,299.99" parsed
// as $1, "€1.299,99" as €1.29, and so on — wrong enough to record a
// fictional "new low" and fire a false alert. This handles thousands
// separators (comma, dot, or space), decimal separators (comma or dot),
// and rejects genuinely ambiguous/malformed input rather than guessing.

function parsePriceAmount(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, "");
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma === -1 && lastDot === -1) {
    const num = parseFloat(s);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  const decimalSep = lastComma > lastDot ? "," : ".";
  const sepIndex = decimalSep === "," ? lastComma : lastDot;
  const fractionDigits = s.length - sepIndex - 1;

  // A trailing group of exactly 3 digits after the last separator is
  // ambiguous with thousands-grouping ("1.299" = 1299 in EU style, not
  // 1.299) — currency fractions are essentially never 3 digits, so treat
  // it as pure grouping: strip every separator, read as one integer.
  if (fractionDigits === 3) {
    const num = parseFloat(s.replace(/[.,]/g, ""));
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  if (fractionDigits < 1 || fractionDigits > 2) return null; // ambiguous/malformed — reject rather than guess

  // A genuine decimal separator appears exactly once in a well-formed
  // price. If the chosen separator repeats and the trailing group isn't a
  // 3-digit group (handled above), the string is malformed — e.g.
  // "1,2,3" or "1.23.45" — reject rather than silently mangling it.
  if (s.split(decimalSep).length - 1 > 1) return null;

  const integerPart = s.slice(0, sepIndex).split(decimalSep === "," ? "." : ",").join("");
  const fractionPart = s.slice(sepIndex + 1);
  if (!/^\d+$/.test(integerPart) || !/^\d+$/.test(fractionPart)) return null;

  const num = parseFloat(`${integerPart}.${fractionPart}`);
  return Number.isFinite(num) && num > 0 ? num : null;
}

// Finds a currency-symbol-prefixed amount in arbitrary page text and
// parses it through parsePriceAmount(). Returns a number, or null if no
// plausible/unambiguous price is found — callers should treat null as
// "no price here," not fall back to guessing.
function extractPriceFromText(text) {
  if (!text) return null;
  const match = text.match(/(?:\$|£|€)\s?(\d[\d.,\s]*\d|\d)/);
  if (!match) return null;
  return parsePriceAmount(match[1]);
}

// ---------- Currency handling ----------
// priceCurrency in JSON-LD (and og:price:currency / product:price:currency
// meta tags) comes straight from the page — i.e. it's attacker-controlled
// if the page is malicious or compromised. fmt()'s fallback branch (when
// Intl.NumberFormat rejects an invalid currency code) used to echo that
// raw string directly into a template literal that gets assigned via
// innerHTML in the badge/popup/history views — a stored-HTML-injection
// path from an untrusted web page into privileged extension UI. Validating
// the currency down to a plain 3-letter code before it's ever stored
// closes that off at the source, rather than trying to escape it at every
// render call site.
function sanitizeCurrency(code, fallback) {
  if (typeof code === "string" && /^[A-Za-z]{3}$/.test(code.trim())) {
    return code.trim().toUpperCase();
  }
  return fallback;
}

// Only compare/aggregate prices recorded in the same currency. Mixing
// currencies as if they were commensurable numbers (e.g. treating a $65
// USD price as a new low against a $100 AUD history) would be a silent
// correctness bug, not just a display quirk.
function filterSameCurrency(history, currency) {
  return history.filter((h) => h.c === currency);
}

// How many days of tracking — AND how many distinct prior observations —
// are required before a "was $X" claim that's never been corroborated
// gets flagged as inflated, rather than reported as "can't verify yet."
// Requiring both guards against thin evidence: two visits two weeks apart
// technically span 14 days but don't actually establish much about what
// happened in between.
const MIN_DAYS_FOR_INFLATED_VERDICT = 14;
const MIN_OBSERVATIONS_FOR_INFLATED_VERDICT = 4;

// ---------- Canonical claim evaluation ----------
// The single source of truth for "does this was-price claim check out
// against observed history." An earlier version had this logic
// re-implemented separately in content.js, history.js, and popup.js —
// when the evidence thresholds were tightened, only two of the three got
// updated, and the three surfaces started disagreeing about the same
// underlying fact. There is now exactly one implementation; every surface
// calls this and builds its own wording from the structured result rather
// than re-deriving the tone itself.
//
// `history` is the full array for one product (ascending by time,
// {p, c, t, w} per point). `index` is the point being evaluated — pass
// history.length - 1 to evaluate "as of the most recent observation."
// Returns null if that point made no claim at all.
function evaluateClaimAt(history, index) {
  const point = history[index];
  if (!point || point.w == null) return null;

  // Only compare within the same currency as this point — mixing
  // currency series would make "observed max" meaningless.
  const past = history.slice(0, index).filter((h) => h.c === point.c);
  const was = point.w;

  if (!past.length) {
    return { tone: "neutral", was, currency: point.c, observedMax: null, pastCount: 0, daysTracked: 0 };
  }

  const observedMax = Math.max(...past.map((h) => h.p));
  const tolerance = was * 0.03; // small wiggle room for rounding/cent differences
  if (observedMax >= was - tolerance) {
    return { tone: "good", was, currency: point.c, observedMax, pastCount: past.length, daysTracked: null };
  }

  const daysTracked = (past[past.length - 1].t - past[0].t) / 86400000;
  const hasEnoughEvidence =
    daysTracked >= MIN_DAYS_FOR_INFLATED_VERDICT && past.length >= MIN_OBSERVATIONS_FOR_INFLATED_VERDICT;

  return {
    tone: hasEnoughEvidence ? "bad" : "neutral",
    was,
    currency: point.c,
    observedMax,
    pastCount: past.length,
    daysTracked,
  };
}
