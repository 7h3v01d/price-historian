// Price Ledger — shared helpers
// Loaded before content.js (as an extra content script) and before
// popup.js/history.js (as a plain <script> tag) so all three can use these
// without three copy-pasted definitions drifting out of sync.

// ---------- Product identity (JSON-LD candidate selection) ----------
// Extracted from content.js so this logic — where three consecutive
// rounds of adversarial review found real bugs (scoring weight inversion,
// missing identity floor, tied-candidate ambiguity) — can be exercised
// directly with plain test data, rather than only checked by looking for
// the right regex pattern in content.js's source. content.js still owns
// everything that needs live DOM access (extracting offers from actual
// JSON-LD script tags, checking og:type, scanning for a visible
// corroborating price); this owns the pure decision once that data is
// already collected.

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// A rough, deliberately simple similarity check — not fuzzy-matching for
// its own sake, just enough to tell "this candidate's name is basically
// the page's title" from "this is some unrelated object that happened to
// be on the page."
function titleSimilarity(candidateName, pageTitle) {
  if (!candidateName || !pageTitle) return 0;
  const a = candidateName.toLowerCase().trim();
  const b = pageTitle.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  return a.includes(b) || b.includes(a) ? 0.5 : 0;
}

// Selects the best candidate from a list of { name, priceInfo: { price,
// currency, isExact }, gtin13?, gtin?, gtin12?, gtin8?, mpn?, sku? }
// objects, or returns null if none is trustworthy enough to accept.
//
// Identity correspondence dominates price-quality: a candidate whose name
// actually matches the page (weight ×10) always outranks one that merely
// has an exact price (+2) rather than a range floor (+0) — weighting
// these the other way around let an unrelated recommended-item's exact
// price outrank the actual product's own range-floor price.
//
// Multiple candidates with zero identity correspondence at all reject
// the whole detection — picking one is a coin flip, not a decision.
//
// Candidates that TIE on score are only resolved by picking one if they
// fully agree on identity: normalized name, currency, any available
// SKU/GTIN/MPN, and price to 6 decimal places (not 2 — rounding to 2
// decimals collapsed genuinely different three-decimal-currency prices,
// e.g. KWD 1.250 vs 1.251, into the same value). Two different variants
// that simply cost the same today are NOT the same product, and picking
// one arbitrarily would silently record the wrong SKU's identity.
//
// A single candidate with zero identity match is returned with
// bestTitleMatch: 0 in the result — content.js decides separately whether
// that's acceptable (it isn't, on its own; see the corroboration
// requirement there) since that decision needs live DOM access this
// function doesn't have.
function selectBestJsonLdCandidate(candidates, pageTitle) {
  let best = null;
  let bestScore = -Infinity;
  let bestTitleMatch = 0;
  let candidatesAtBestScore = [];

  for (const c of candidates) {
    const titleMatch = titleSimilarity(c.name, pageTitle);
    const score = titleMatch * 10 + (c.priceInfo.isExact ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestTitleMatch = titleMatch;
      best = c;
      candidatesAtBestScore = [c];
    } else if (score === bestScore) {
      candidatesAtBestScore.push(c);
    }
  }
  if (!best) return null;
  if (candidates.length > 1 && bestTitleMatch === 0) return null;

  if (candidatesAtBestScore.length > 1) {
    const identityKey = (c) => {
      const rawId = c.gtin13 || c.gtin || c.gtin12 || c.gtin8 || c.mpn || c.sku || "";
      return [normalize(c.name || ""), c.priceInfo.currency || "", rawId, c.priceInfo.price.toFixed(6)].join("|");
    };
    const distinctIdentities = new Set(candidatesAtBestScore.map(identityKey));
    if (distinctIdentities.size > 1) return null;
  }

  return { candidate: best, bestTitleMatch, viableCandidateCount: candidates.length };
}

// A Product with multiple offers that disagree on price, currency, or
// exact-vs-range type is ambiguous from JSON-LD alone — there's no
// reliable way to tell which offer corresponds to what's actually shown
// on this specific page. Confidently picking the first one risks silently
// tracking the wrong variant's price; rejecting is safer than guessing.
//
// `list` is an array of plain offer-like objects: { price?, lowPrice?,
// priceSpecification?: { price?, priceCurrency? }, priceCurrency? }.
// `currencyFallback` is used for offers with no explicit currency of
// their own (typically the page's own inferred domain currency).
//
// The identity key covers all three material dimensions, not price
// alone: comparing only toFixed(2)-rounded prices collapsed genuinely
// different three-decimal-currency values (KWD 1.250 vs 1.251) into "the
// same," and ignoring currency meant AUD 100 and USD 100 weren't treated
// as materially different just because the numbers match. lowPrice and
// priceSpecification.price are included alongside exact `price` too — an
// earlier version only fed exact price values into this check, so two
// conflicting non-exact offers could slip through undetected.
function offersAreAmbiguous(list, currencyFallback) {
  const offerIdentities = new Set();
  for (const offer of list) {
    const hasExactPrice = offer.price !== undefined && offer.price !== null && offer.price !== "";
    const rawPrice = offer.price ?? offer.lowPrice ?? offer?.priceSpecification?.price;
    if (rawPrice === undefined || rawPrice === null || rawPrice === "") continue;
    const num = parseStructuredPrice(String(rawPrice));
    if (num == null) continue;
    const rawCurrency = offer.priceCurrency ?? offer?.priceSpecification?.priceCurrency;
    const currency = sanitizeCurrency(rawCurrency, currencyFallback);
    offerIdentities.add([num.toFixed(6), currency || "", hasExactPrice ? "exact" : "range"].join("|"));
  }
  return offerIdentities.size > 1;
}

// ---------- Claim container scoping ----------
// Extracted from content.js for the same reason as the JSON-LD selection
// logic above: this is exactly where adversarial review kept finding real
// gaps (a generically-named `<aside class="promo">` sibling wasn't caught
// by naming conventions; a raw price-signal count of exactly 2 looked
// identical whether it was "one product's own current+was pair" or "one
// product's price plus an unrelated section's price"), and needs to be
// testable against real DOM fixtures to have any confidence in it.

// Common naming conventions for "a different section, not this product's
// own content" — recommendation widgets, related-item rails, upsell
// carousels. Not exhaustive (no fixed list of class names ever is, and a
// section can be named anything — "promo", "aside", "deal" — without
// matching any fixed keyword list), so this is one input signal among
// several below, never relied on alone.
const UNRELATED_SECTION_PATTERN = /recommend|related|similar|carousel|suggest|cross-?sell|upsell|also-?(bought|like)|you-?may-?also/;

function looksLikeUnrelatedSection(el) {
  const flag = `${el.className || ""} ${el.id || ""}`.toLowerCase();
  return UNRELATED_SECTION_PATTERN.test(flag);
}

// True if `el` itself IS a claim/comparison-price element — a direct
// <del>/<s>/<strike>, or something styled as a was/RRP price. This is the
// thing claim detection is actually looking for, so a sibling that
// matches this is exactly what should be included when expanding the
// search — it's the claim itself, not a separate block containing one.
function isClaimLeaf(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "del" || tag === "s" || tag === "strike") return true;
  const flag = `${el.className || ""} ${el.id || ""}`.toLowerCase();
  return /price/.test(flag) && /was|rrp|strike|compare-?at/.test(flag);
}

// True if `el` is NOT itself a claim (see isClaimLeaf) but CONTAINS one,
// or any other price-like element, somewhere nested inside it. This is
// the actual distinguishing signal a raw price-signal count couldn't
// provide: a direct <del> sibling sitting right next to the current price
// is exactly what we want (isClaimLeaf handles that case), but a sibling
// CONTAINER — regardless of what it's named — that merely happens to have
// a price or claim buried somewhere inside it is a structurally separate
// block (a recommendation card, a promo widget, a related-item tile), not
// this product's own content.
function containsNestedPriceOrClaim(el) {
  if (isClaimLeaf(el)) return false;
  return el.querySelectorAll('del, s, strike, [class*="price" i], [id*="price" i], [data-testid*="price" i]').length > 0;
}

// Walks up from a price element toward a container that plausibly
// represents "this product's own block," growing one level at a time and
// stopping the INSTANT expansion would sweep in a sibling that isn't
// itself part of the claim but wraps something price-like nested inside
// it. A prior version used a raw price-signal COUNT threshold (reject
// once a container held more than 2 total price-like elements) — that
// failed on the minimal case where a price and an unrelated promo's claim
// are both direct children of the same wrapper with nothing else around
// them: exactly 2 signals, under the old threshold, silently wrong. This
// version doesn't count at all; it asks, at each single step, "does this
// specific expansion introduce a new sibling that is itself a separate
// commerce block?" — which correctly distinguishes a direct <del>
// sibling (the claim itself, wanted) from a sibling container that
// merely has one nested inside (a different block, not wanted),
// regardless of what either is named or how many total signals end up in
// scope.
//
// `documentRef` is passed explicitly (rather than assumed to be the
// global `document`) specifically so this can be tested against a jsdom
// document without needing to swap browser globals — content.js's real
// call site just passes its own `document`.
function findLocalContainer(el, documentRef, maxLevels = 8) {
  let node = el;
  for (let i = 0; i < maxLevels; i++) {
    const parent = node.parentElement;
    if (!parent || parent === documentRef.body) break;

    const introducesAmbiguity = Array.from(parent.children).some(
      (sibling) => sibling !== node && (looksLikeUnrelatedSection(sibling) || containsNestedPriceOrClaim(sibling))
    );
    if (introducesAmbiguity) break;

    node = parent;
  }
  return node;
}

// ---------- Claim proximity ----------
// Combined hop-distance from `el` up to its nearest ancestor shared with
// `anchorEl`, plus the anchor's own hop-distance to that same ancestor.
// Elements that are siblings (or near-siblings) within the same small
// wrapper score low; elements that only share something as high up as
// <main> — e.g. a product's price and an unrelated promo section's price
// — score high, regardless of what either element or its container
// happens to be named. This is what actually distinguishes "this
// product's own was-price" from "some other content's price that happens
// to be nearby in the markup," which naming conventions and raw element
// counts both proved unable to do reliably on their own. Needs real DOM
// elements (walks .parentElement), but has no other dependency on
// content.js's closure, so it's kept here where it can be tested directly
// against DOM fixtures.
function proximityHops(anchorEl, el) {
  const anchorChain = [];
  for (let node = anchorEl; node; node = node.parentElement) anchorChain.push(node);

  let hopsUp = 0;
  for (let node = el; node; node = node.parentElement, hopsUp++) {
    const idx = anchorChain.indexOf(node);
    if (idx !== -1) return hopsUp + idx;
  }
  return Infinity;
}

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

// Parses a machine-readable structured price value — JSON-LD's
// Offer.price/lowPrice, Open Graph's price:amount meta content, or
// itemprop="price". These are specified (schema.org, Open Graph) as plain
// decimal numbers using '.' as the decimal point — never locale-formatted,
// never using a thousands separator. Routing them through the
// locale-guessing heuristic built for human-readable page text (see
// parsePriceAmount above) caused a real corruption: currencies that
// legitimately display three fractional digits (KWD, BHD, OMR, JOD, TND —
// e.g. "1.250" meaning 1.25) were misread as thousands-grouped integers,
// multiplying the value by 1000. A direct numeric parse is both simpler
// and more correct for this data source — no grouping heuristic needed or
// wanted, because none should ever apply here.
function parseStructuredPrice(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null; // not a clean plain decimal — reject rather than guess
  const num = parseFloat(s);
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
//
// Critically: a null/unknown currency must NEVER be treated as matching
// another null/unknown currency. "Unknown" means "we don't have enough
// information to establish comparability," not "these all belong to one
// currency named null" — two genuinely different currencies could both
// end up unlabeled (e.g. a storefront that silently switches region), and
// grouping them together would reproduce the exact cross-currency
// corruption this function exists to prevent, just with an extra step.
// A null target currency is therefore never comparable to anything,
// including other nulls — the caller gets an empty series and correctly
// treats that as "no historical comparison available" rather than a
// fabricated one.
function filterSameCurrency(history, currency) {
  if (currency == null) return [];
  return history.filter((h) => h.c === currency);
}

// How many days of tracking — AND how many distinct prior observations —
// are required before a "was $X" claim that's never been corroborated
// gets flagged as inflated, rather than reported as "can't verify yet."
// Requiring both guards against thin evidence: two visits two weeks apart
// technically span 14 days but don't actually establish much about what
// happened in between.
const MIN_DAYS_FOR_INFLATED_VERDICT = 14;
const MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT = 4;

// How many distinct calendar days a set of observations spans — not the
// same as how many observation rows exist. Same-day claim changes are
// intentionally recorded as separate rows (see recordObservation in
// content.js), so counting rows would let e.g. 4 same-day claim edits
// satisfy an evidence threshold meant to require broad time coverage.
function countDistinctDays(points) {
  return new Set(points.map((h) => new Date(h.t).toDateString())).size;
}

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
  const was = point.w;

  // An unknown currency for the point being evaluated means there is
  // nothing safe to compare it against, full stop — not "first time
  // tracking" (which implies more visits would resolve it) but "we
  // genuinely can't establish comparability here." Distinguished via
  // `currencyUnknown` so callers can word this differently from a
  // could-resolve-with-more-data neutral state.
  if (point.c == null) {
    return {
      tone: "neutral",
      currencyUnknown: true,
      was,
      currency: null,
      observedMax: null,
      pastCount: 0,
      distinctDays: 0,
      daysTracked: 0,
    };
  }

  // filterSameCurrency() is the single source of truth for currency
  // matching — including its rule that a null currency never matches
  // another null. Using it here (rather than a local `.filter(h => h.c
  // === point.c)`) means that rule can't drift out of sync between this
  // function and the rest of the codebase the way it briefly did between
  // files before evaluateClaimAt itself was centralized.
  const past = filterSameCurrency(history.slice(0, index), point.c);

  if (!past.length) {
    return { tone: "neutral", was, currency: point.c, observedMax: null, pastCount: 0, distinctDays: 0, daysTracked: 0 };
  }

  const observedMax = Math.max(...past.map((h) => h.p));
  const tolerance = was * 0.03; // small wiggle room for rounding/cent differences
  const distinctDays = countDistinctDays(past);
  if (observedMax >= was - tolerance) {
    return { tone: "good", was, currency: point.c, observedMax, pastCount: past.length, distinctDays, daysTracked: null };
  }

  const daysTracked = (past[past.length - 1].t - past[0].t) / 86400000;
  const hasEnoughEvidence =
    daysTracked >= MIN_DAYS_FOR_INFLATED_VERDICT && distinctDays >= MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT;

  return {
    tone: hasEnoughEvidence ? "bad" : "neutral",
    was,
    currency: point.c,
    observedMax,
    pastCount: past.length,
    distinctDays,
    daysTracked,
  };
}
