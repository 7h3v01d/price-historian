# Price Ledger — a local Universal Price Historian

A Chrome (Manifest V3) extension that watches product pages you visit,
remembers what price you actually saw, and tells you whether today's price
is a real deal or just a relabeled number. Everything is stored **locally**
via `chrome.storage.local` — no backend, no account, nothing leaves your
machine in this MVP.

## How it works

`shared.js` holds a few small helpers (`fmt()`, `escapeHtml()`, and the
claim-confidence constant) used by `content.js`, `popup.js`, and
`history.js` — loaded before each of them so there's one definition
instead of three copies quietly drifting apart.

1. **Detection** (`content.js`) — on every page load, it looks for
   `schema.org/Product` JSON-LD first (what most modern storefronts embed
   for SEO), then falls back to Open Graph / `itemprop="price"` meta tags.
2. **Identity** — it prefers a real product ID (GTIN/MPN/SKU) when the page
   provides one, otherwise falls back to a normalized slug of the product
   name, scoped per-domain.
3. **History** — each observation is appended to a small local time series
   (deduped per day) so a graph builds up the more you browse.
4. **The badge** — a small fixed card in the bottom-right shows the current
   price, a sparkline, and a verdict: *"lowest you've seen"* vs *"$X above
   your low."*
5. **The claim check** — when a page shows a struck-through "was $X", RRP,
   or "compare at" price, the badge checks that claim against what THIS
   browser has actually observed for the item. If you've genuinely seen it
   that high before, the claim checks out. If you've never seen it above a
   much lower price, it's flagged as likely inflated. First-time visits are
   marked "can't verify yet" rather than guessed at either way.
6. **Popup** (`popup.html`) — lists everything tracked across every site,
   most recent first, click through to revisit, with a flag on any item
   whose most recent "was" claim looks inflated.
7. **New-low alerts** — when a tracked item's price drops below anything
   you've seen before (not just matches your low — genuinely beats it), a
   background service worker fires an OS notification and puts a small
   count on the toolbar icon until you open the popup. First-time items
   never trigger this — there's nothing to have "beaten" yet.
8. **Full history view** (`history.html`) — opens in its own tab from the
   "Open full history & charts" button in the popup. A searchable sidebar
   lists every tracked product; selecting one draws a real line chart of
   its price over time (hand-rolled SVG, no external chart library — MV3
   blocks remote scripts anyway), with hover tooltips per data point,
   record-low points marked in green, and suspicious "was"-claim points
   ringed in red so you can see exactly when a dubious "sale" happened.
9. **Spend summary tab** (inside the history page) — this extension never
   sees actual purchases, so "spend" here specifically means: the trended
   value of everything you're tracking, priced at what you've actually
   observed, not what you paid. Shows your current basket total, what it'd
   cost if every item were at its own best price ever seen, the gap
   between the two, and a weekly/monthly bar chart of that basket value
   with new-low and flagged-claim counts per period.
10. **Cross-retailer comparisons** — "+ Compare across retailers" in the
    history sidebar lets you manually link 2+ tracked items you know are
    the same physical product (say, the same milk at Woolworths, Coles,
    and IGA). Linked items get their own entry showing who's cheapest
    right now, an overlaid price-history chart per retailer, and each
    retailer's own historical low. This is deliberately manual, not
    automatic — matching product identity across sites reliably (same
    item, different titles, no shared ID, different pack sizes) isn't
    something worth guessing at; you know it's the same product, the tool
    doesn't need to pretend to.

## Try it

Works the same way in any Chromium-based browser, including **Opera** —
same steps, just under `opera://extensions` instead of `chrome://extensions`.

1. Open `chrome://extensions` (or `opera://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select this `price-historian` folder
4. Visit any product page with structured data (most Shopify stores, Best
   Buy, Etsy, Target, Wikipedia's "infobox" won't have one — try an actual
   retailer) — the badge should appear a moment after load
5. Revisit the same product later (or edit `content.js` to fake a different
   price) to see the sparkline and "lowest seen" verdict kick in
6. Click the toolbar icon to see everything tracked so far
7. If your OS notification permissions block extension alerts, the browser
   will usually prompt the first time one tries to fire — allow it, or the
   toolbar badge count will still work as a silent fallback

## Known limitations (this is an MVP, not the pitch-deck version)

- **No cross-device sync** — `chrome.storage.local` is per-browser-profile.
  Swapping to `chrome.storage.sync` would add sync but with a much smaller
  quota; a real product needs its own backend for durable, shared history.
- **JSON-LD coverage isn't universal** — sites without structured data or
  with heavily client-rendered pricing (price appears after your read) may
  not be detected. The `document_idle` + 600ms delay helps but isn't
  bulletproof for slow SPAs.
- **No product-identity merging across domains** — the same physical
  product on two different retailers is tracked as two separate entries by
  design (the "fake sale" detection is per-retailer, which is usually what
  you want, but a "cheapest anywhere" feature would need explicit matching).
- **Alerts are per-browser, not shared** — since history itself is
  per-browser-profile (see above), new-low notifications only fire in
  whichever browser actually recorded the drop. Two people tracking the
  same product in separate browsers get two independent alert streams,
  which is expected, not a bug — there's no shared state to notify from.
- **Claim checks require both ~14 days of tracking AND at least 4 distinct
  observations before flagging "inflated."** A "was $X" claim you've never
  personally seen corroborated could mean the claim is fake — or it could
  just mean you started tracking the item after a genuine discount had
  already begun, or that you simply haven't checked often enough yet for
  thin data to mean anything (two visits two weeks apart span 14 days but
  don't establish much about what happened in between). Short/thin
  history reports "can't verify" rather than guessing; wording is
  deliberately evidential ("not corroborated by your observed history")
  rather than accusatory, since ruling a claim uncorroborated and proving
  it's actually inflated are different strengths of evidence. Both
  thresholds are judgment calls — `MIN_DAYS_FOR_INFLATED_VERDICT` and
  `MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT` in `shared.js`, used by
  `content.js`, `history.js`, and `popup.js` — tune them there if needed.
- **Spend summary groups by currency rather than assuming one.** If
  tracked items span more than one currency, the summary now renders a
  separate total per currency instead of silently summing incompatible
  numbers into one meaningless figure.
- **Comparisons are manual and don't auto-update membership.** Linking is
  a one-time action — if a retailer stops selling an item or you start
  tracking a better match, you'll need to delete the old comparison and
  create a new one; there's no "edit members" flow yet, just create and
  delete. Also, if a comparison somehow links two entries from the same
  domain, they'll render in the same series color on the chart — a minor
  cosmetic quirk, not a data problem. If linked retailers turn out to use
  different currencies, ranking and the overlay chart are disabled with an
  explanation rather than pretending the numbers are comparable.
- **Cross-tab write races are only partially mitigated.** `recordObservation`
  is a read-modify-write against `chrome.storage.local`; this content
  script serializes its own concurrent calls (it deliberately runs a
  `MutationObserver` and a poll simultaneously, which could otherwise race
  against itself), but two separate *browser tabs* observing the same
  product at the same moment could still each read stale history and one
  write could clobber the other's. Properly closing that gap means
  centralizing ledger writes in the background service worker instead of
  each content script writing directly — a bigger architectural change
  than this pass covers, and a low-probability scenario for personal use,
  but a real one worth fixing before this handles anything higher-stakes.
- **Chrome Web Store packaging isn't done.** The zip here is structured
  for `chrome://extensions` → Load Unpacked (folder-based), not Store
  submission — a real submission needs `manifest.json` at the zip root
  rather than nested inside a folder. Not relevant unless you actually
  decide to publish this.

## Hardening pass (responding to an adversarial code review)

An external review of 0.8.1 found several real defects that specifically
undermined the thing this extension is supposed to be trustworthy about —
historical price accuracy. Every finding was independently reproduced
before fixing (not just taken on faith) and confirmed fixed after:

- **Price misparsing with thousands separators** — the old regex-based
  parsing truncated `$1,299.99` to `$1` and similar. Replaced with a
  canonical `parsePriceAmount()` in `shared.js` that correctly handles
  comma/dot/space thousands separators and comma/dot decimals, and
  rejects genuinely ambiguous input (e.g. `"1,2,3"`) instead of guessing.
  Every price-extraction site in `content.js` now routes through it.
- **Currency-blind price comparisons** — lows, highs, "new low" alerts,
  and claim checks used to compare raw numbers regardless of currency, so
  a currency change on a page could produce a fictional "new low."
  `filterSameCurrency()` now gates every comparison to matching currency
  only.
- **Stored HTML injection via page-controlled currency** — a malformed or
  malicious `priceCurrency` value from a page's own JSON-LD could reach
  `innerHTML` unescaped through `fmt()`'s fallback branch.
  `sanitizeCurrency()` now validates currency down to a plain 3-letter
  code at every point one is captured from page data, closing this at the
  source.
- **Notification click targets could silently vanish** — the
  notification→URL mapping lived in a plain in-memory object in the
  background service worker, which MV3 can terminate and respawn at any
  time, wiping it. Moved to `chrome.storage.session`, which survives
  worker restarts for the life of the browser session.
- **A watcher-lifecycle timer bug** — the DOM watcher's 45-minute safety
  cap wasn't tracked, so restarting the watcher could leave a stale timer
  that killed the new instance early. Now tracked and cancelled properly.
- **JSON-LD candidate selection took the first match blindly** — a page
  with multiple `Product` objects (variants, related items) could pick
  the wrong one, and an `AggregateOffer.lowPrice` (a range floor) was
  treated the same as an exact displayed price. Candidates are now scored:
  an exact price outranks a range floor, and a name matching the page
  outranks one that doesn't.

Not everything was fully closed — see the cross-tab write race and Store
packaging notes above for what's accepted as a known gap rather than
fixed, and why.

### Second hardening pass

A follow-up adversarial review of 0.9.0 found the first pass had
introduced a real regression and left one architectural gap unaddressed.
Both were independently reproduced before fixing, same as the first round:

- **`popup.js` had silently drifted out of sync.** The first hardening
  pass updated the currency-filtering and claim-threshold logic in
  `content.js` and `history.js` but missed `popup.js` entirely — it kept
  comparing prices across currencies and flagging claims off a bare
  14-day span with no observation-count floor, so the three surfaces
  could (and, when tested, did) disagree about the same underlying fact.
  Fixed properly this time, not just patched: `evaluateClaimAt()` moved
  into `shared.js` as the single canonical implementation, and
  `content.js`, `history.js`, and `popup.js` now all call it rather than
  each maintaining their own copy. There is structurally only one place
  this logic can live now, which is what actually prevents this class of
  bug — not "try to remember to update all three files."
- **The badge exposed private history data to the page it's tracking.**
  The badge was appended directly into the page's own DOM, which content
  scripts share with the page's own JavaScript — meaning a retailer's
  page script could read the badge's low/high/check-count/claim text via
  a plain `document.querySelector`, or rewrite it to show a fake "checks
  out" verdict. The badge now renders inside a **closed Shadow DOM**:
  verified with a real test that `host.shadowRoot` returns `null` to
  external scripts (even `host.textContent` returns empty), while the
  content script's own retained reference still works normally. This does
  **not** make the badge fully tamper-proof — a page can still see the
  host element exists and remove/hide/reposition it, which no DOM API
  can prevent. That's exactly why the popup and history page are the
  authoritative surfaces if you ever suspect a page is interfering with
  the inline badge — they're pure extension UI with no page DOM
  involvement at all.
- **JSON-LD candidate scoring had the weights inverted.** The scoring
  added in the first pass gave an exact price +2 and a title match at
  most +1, so an unrelated recommended-item with an exact price could
  outrank the actual product with a matching name but a range-floor
  price — precisely the failure mode the scoring was supposed to prevent.
  Rebalanced so title/identity correspondence (×10) dominates
  price-quality (+2): reproduced the review's exact scenario and
  confirmed the correct candidate now wins. Also added a check for
  variant-priced products (multiple exact offers at different prices on
  one `Product`) — rejects rather than confidently guessing which
  variant's price applies.
- **A claim appearing or disappearing without the price changing used to
  vanish.** Same-day deduplication only compared price and currency, not
  the claimed "was" price — so a claim that appeared in the afternoon
  with the morning's price unchanged was silently dropped, and vice
  versa. The claimed price is now part of observation identity in both
  `recordObservation`'s dedup check and the DOM watcher's own dedupe key.
- **`fmt()` is now intrinsically safe**, not just safe because every known
  caller sanitizes first — it validates currency internally and never
  echoes an unvalidated string, closing the gap for any future call site
  that forgets to sanitize, and for currency values already persisted by
  a pre-sanitization version. A migration in `background.js` also
  sanitizes any such legacy data on update (`chrome.storage.local`
  survives ordinary updates, so old poisoned values wouldn't otherwise
  self-heal).
- **Currency inference no longer silently assumes USD.** A `.com`
  retailer that localizes prices for AU/UK/etc visitors with no
  structured currency metadata used to get labeled USD by default.
  Genuinely unknown currency is now recorded as `null` and rendered
  honestly as "(currency unknown)" rather than a wrong label.
- **A real test suite now exists** (`test/run-tests.js`, run with
  `node test/run-tests.js`) — 38 checks covering the price parser,
  currency isolation, and claim-evidence thresholds, plus a structural
  check that would have specifically caught the `popup.js` drift bug
  above (verified: ran it against a reconstruction of the old broken
  file, and it fails as expected). This is a genuine start, not a
  finished suite — it doesn't yet cover JSON-LD scoring, the DOM
  watcher's dedupe key, or true end-to-end integration testing.

### Third hardening pass

A third adversarial review of 0.9.1 found two release-blocking correctness
bugs plus several secondary issues — all independently reproduced before
fixing, and this round's fixes surfaced two more latent crash bugs of
their own while being implemented, which are also documented below rather
than left for someone else to find.

- **Unknown currency was accidentally treated as A currency.** After the
  previous round stopped guessing "USD" for unlabeled prices, two
  genuinely different unknown-currency observations (e.g. a storefront
  silently switching region between visits) were still grouped together
  as if `null` were a real, consistent currency — reproducing the exact
  cross-currency corruption bug from two rounds ago, just relabeled.
  `filterSameCurrency()` now treats a `null` currency as never matching
  anything, including another `null` — "unknown" means "nothing is
  comparable," not "everything unknown belongs to one currency."
- **Three-decimal currencies (KWD, BHD, OMR, JOD, TND) were corrupted
  1000×.** The locale-guessing price parser's "exactly 3 digits after the
  separator means thousands-grouping" heuristic — built for human-typed
  page text — was also being applied to machine-readable JSON-LD/meta
  price fields, which are always plain decimals per spec and never
  locale-formatted. `"1.250"` (a legitimate 1.25 KWD) was misread as
  1250. Added `parseStructuredPrice()`, a separate, simpler parser with no
  grouping heuristic at all, for every JSON-LD/meta/itemprop call site;
  the locale-aware parser now only ever sees actual DOM display text.
- **"Was" claims could be attributed to the wrong product.** Claim
  detection searched the entire page for struck-through prices, so an
  unrelated "was $100" on a recommended-item widget elsewhere on the page
  could get attributed to the actual product being tracked.
  `findClaimedWasPrice()` now requires an anchor element (the real
  detected price node) and searches only a bounded local neighborhood
  around it — verified with a DOM test against both the exact
  cross-attribution scenario (now correctly ignored) and a genuinely
  co-located claim (still detected).
- **The closed Shadow DOM still leaked the verdict.** The private
  price/history text was already protected, but the badge's `pl-good`/
  `pl-alert` state class was applied to the externally-visible host
  element itself — readable via a plain `.className` check, revealing
  "your price is at its historical low" or "our claim check failed"
  without needing to breach the shadow root at all. The state class now
  lives on an element inside the closed shadow root; the host is
  state-neutral regardless of verdict, verified with a DOM test.
- **JSON-LD candidate scoring had no minimum identity floor.** The
  previous round's rebalanced weighting fixed the specific inversion it
  targeted, but a listing/category page with several unrelated `Product`
  objects (none matching the page's own title) could still all tie at
  the same price-only score, with the first one arbitrarily winning.
  Detection now rejects rather than guesses when multiple candidates
  exist and none shows real title correspondence — a single candidate is
  still accepted regardless of title match, since there's nothing to
  disambiguate and no reason to doubt the only option.
- **Evidence thresholds counted observation rows, not observation days.**
  Since claim changes are (correctly, per the previous round's fix)
  recorded as separate same-day rows, several rapid same-day edits could
  satisfy the "at least 4 observations" threshold while representing only
  one or two days of actual coverage. The threshold now requires distinct
  calendar days (`MIN_OBSERVATION_DAYS_FOR_INFLATED_VERDICT`), not raw
  row count.
- **Two crash bugs surfaced while fixing the currency bug above.**
  Correctly making `filterSameCurrency()` return an empty array for
  unknown currency exposed several places that assumed a non-empty
  result: `Math.min(...[])` silently returns `Infinity`, which would have
  shown a nonsensical "low: Infinity" or, in the spend summary, crashed
  outright reading `.p` off `undefined` in an empty history array. Fixed
  in the badge, the history chart, the popup list, the spend summary
  (which now excludes unknown-currency products with an honest count
  rather than crashing), and the cross-retailer comparison view (which
  also had its own related bug: two unknown-currency members were
  incorrectly treated as "not mixed" since they shared the same `null`
  value — fixed to treat any unknown currency as always non-comparable,
  consistent with the main fix).
- **The test suite grew to 56 checks**, adding coverage for all of the
  above: the null-currency-never-matches rule, the three-decimal
  structured-price parser, distinct-day evidence counting, and
  structural checks confirming the JSON-LD identity floor, the
  claim-scoping anchor requirement, the Shadow DOM host neutrality, and
  each of the five empty-array guards are actually present in source —
  the same style of regression test that caught the `popup.js` drift in
  the previous round, applied to this round's fixes.

### Fourth hardening pass

A fourth adversarial review found the previous round's JSON-LD identity
floor and claim-scoping fixes were both real improvements but not
complete — each still had a gap that could attribute a price or claim to
the wrong product. Also verified by reproduction before fixing.

- **A single JSON-LD candidate with zero title correspondence was still
  accepted unconditionally.** The identity floor from the previous round
  only rejected when *multiple* candidates existed with no identity
  match — a single unrelated `Product` object (a featured item on a
  homepage, a stale structured-data block, an editorial page) had nothing
  to compete against and sailed through. Now requires independent
  corroboration in that specific case: either the page declares itself a
  product page (`og:type=product`), or there's a visible price on the
  page that actually matches the JSON-LD price. Reproduced the exact
  homepage scenario and confirmed it's now rejected without
  corroboration.
- **Tied candidates with conflicting prices were resolved by document
  order.** Two JSON-LD `Product` objects that scored identically (e.g.
  two color/size variants, both named "Widget," each with its own exact
  price) picked whichever was scanned first — arbitrary, and capable of
  recording the wrong variant's price as a fictional new low. Detection
  now tracks every candidate tied for the top score and rejects the
  whole detection if they disagree on price, rather than guessing.
- **Claim scoping's fixed-depth ancestor walk could still reach an
  unrelated section.** A bounded climb of a fixed number of levels
  doesn't account for how shallow ordinary DOM structures often are — in
  one reproduced case, climbing just two real levels already reached
  `<main>`, which still contained an entire sibling recommendations
  section. Replaced the fixed depth with an ambiguity-aware walk: it
  stops before including a sibling subtree named like a distinctly
  different section (recommendations, related items, carousels — checked
  via common naming conventions) and, as a second independent check,
  stops if the total count of price-like signals in scope exceeds what
  one product's own current+was price pair should produce. Verified with
  a DOM test against both the exact failing scenario (now correctly
  excluded) and a genuinely co-located claim (still detected).
- **Price and claim detection didn't check element visibility.** A
  hidden responsive-layout price, an inactive carousel slide, or a stale
  variant panel under `display:none` could still be selected — a hidden
  32px desktop-layout price would outrank a visible 28px mobile one
  purely on font-size, since nothing checked whether either was actually
  shown. Both detectors now skip elements that are hidden via
  `display:none`, `visibility:hidden`, `opacity:0`, or have no client
  rects at all (a reliable catch-all for a hidden ancestor collapsing an
  element's rendered size to nothing). Worth noting honestly: the
  client-rects check can't be verified by this project's test suite,
  since it runs on plain Node rather than a real browser and Node has no
  layout engine to produce rects at all — it's verified correct by
  reasoning about how the DOM API actually behaves in Chrome, not by an
  automated test, which is a real gap the next round of testing
  infrastructure should close.
- **Page-controlled SKU/GTIN values had no length bound going into
  storage keys.** The name-based fallback key was already capped at 80
  characters; the identifier-based variant used a page-supplied value
  directly with no bound at all, so an unusually large SKU field could
  bloat storage keys for no real benefit. Now trimmed and capped at 100
  characters.
- **Documentation drift**: the README referenced the pre-rename constant
  name (missing the "DAYS" qualifier) after a previous round renamed it
  to reflect its actual distinct-days semantics. Fixed, and a new test
  now checks every constant name the README mentions actually exists in
  `shared.js`, so this specific class of drift can't recur silently.
- **Removed the `host_permissions: ["<all_urls>"]` grant.** It was
  redundant — content scripts are declared statically via
  `content_scripts.matches`, which already grants injection access to
  http/https pages on its own; `host_permissions` is separately needed
  only for things like cross-origin `fetch()` from extension pages or
  dynamic script injection, neither of which this extension does.
- **The test suite grew to 63 checks.**

### Fifth hardening pass

A fifth adversarial review found that the previous round's two JSON-LD
fixes and the claim-scoping fix were each real improvements but still
incomplete — and made a specific, repeated point worth taking seriously:
source-pattern tests (checking that certain code exists) can't actually
prove detection behaves correctly, only that it looks like it should.
This round's response includes an actual architectural change in
response to that, not just another patch.

- **`og:type=product` alone isn't corroboration.** The previous round
  required *either* the page declaring itself a product page *or* a
  visible matching price to accept a lone zero-identity JSON-LD
  candidate — but og:type=product only establishes "this page is about
  some product," not "this specific stale candidate is that product." A
  page showing a $99 Blue Widget with a stale, unrelated $29.95 Toaster
  in its JSON-LD would still accept the Toaster, since og:type=product
  was present. Changed to require both conditions together, and also
  narrowed the visible-price check itself to compare against the page's
  own primary displayed price specifically, not any incidental price
  match anywhere on the page (a coincidentally same-priced recommended
  item elsewhere could otherwise corroborate something unrelated).
- **Tied candidates were only compared on price, rounded to 2 decimals.**
  Two different variants (Red $10 / Blue $10) that simply cost the same
  today aren't the same product, but agreeing on price alone let one get
  picked arbitrarily — a corruption that stays invisible until the two
  variants' prices later diverge. Currency was also ignored entirely
  (AUD 100 and USD 100 counted as "the same"), and rounding to 2 decimals
  collapsed genuinely different three-decimal-currency prices (KWD 1.250
  vs 1.251) into equal. Tie-breaking now compares full identity —
  normalized name, currency, any available SKU/GTIN/MPN, and price to 6
  decimal places — rejecting the whole detection if tied candidates
  disagree on any of it.
- **Claim scoping still leaked through generically-named sections.** The
  previous round's container-boundary heuristics (named-sibling
  detection, price-signal counting) both failed on an ordinary
  `<aside class="promo">` — a real name a real site would plausibly use,
  matching neither the unrelated-section keyword list nor tripping the
  signal-count threshold. Replaced the core safety mechanism entirely:
  instead of trying to define the "right" container and search freely
  within it, claim detection now measures actual DOM hop-distance between
  the current-price element and any candidate claim, keeping only the
  closest one within a conservative threshold. This deliberately trades
  recall for precision, per the reviewer's own stated preference for this
  specific feature — an occasional missed claim from unusually deep
  markup nesting is a far smaller problem than attributing an unrelated
  claim to the wrong product and judging it against that product's
  history.
- **The JSON-LD candidate-selection logic was extracted into `shared.js`**
  as `selectBestJsonLdCandidate()` and `titleSimilarity()`, and the claim
  proximity calculation as `proximityHops()` — directly responding to the
  repeated critique that this logic, buried in content.js's closure,
  could only be checked by looking for the right code pattern rather than
  actually exercised. `content.js` still owns everything that needs live
  DOM access (parsing JSON-LD script tags, checking og:type, scanning for
  a visible corroborating price); the pure decision logic, once that data
  is collected, now lives somewhere genuinely testable with plain data
  and DOM fixtures.
- **The test suite now includes real behavioral tests**, not just source
  patterns: `selectBestJsonLdCandidate()` is exercised directly against
  every scenario from this round and the previous one (unrelated
  candidates, tied variants, cross-currency ties, three-decimal-currency
  ties, genuine duplicates), and `proximityHops()` is tested against real
  jsdom DOM fixtures reproducing the exact `<aside class="promo">` case
  alongside legitimate co-located and realistically-nested claims. This
  needed `jsdom` as an actual dev dependency — run `npm install` in this
  directory once before `node test/run-tests.js` (or `npm test`); it's
  dev-only and never shipped as part of the extension itself. A few
  things that still need live browser globals (the corroboration
  AND-logic, the Shadow DOM badge rendering) remain checked by weaker
  source-pattern tests for now, noted honestly in the test file itself.
- **Fixed a stale comment** in `inferCurrencyFromDomain()` that described
  the exact opposite of what the code actually does (a leftover from
  before the null-currency fix two rounds ago).
- **The test suite grew to 71 checks.**

### Sixth hardening pass

A sixth adversarial review found that three of the previous round's real
fixes each had the same underlying gap surviving one layer below or
beside where the fix was applied — plus one genuinely new finding about
unbounded page-controlled metadata. All reproduced before fixing.

- **The offers-array ambiguity check had the exact same rounding and
  currency-blindness bug the candidate-tie fix had already closed one
  layer up.** A single `Product`'s own `offers` array could contain two
  offers at `KWD 1.250` and `KWD 1.251` — genuinely different prices —
  and the ambiguity check's `toFixed(2)` rounding collapsed them into
  "the same," same failure mode as the candidate-tie bug from two rounds
  ago, just one level lower in the same JSON-LD object. Currency wasn't
  compared at all (`AUD 100` and `USD 100` counted as identical), and
  `lowPrice`/`priceSpecification.price` weren't included in the check at
  all, so two conflicting non-exact offers could slip through untested.
  Extracted into `offersAreAmbiguous()` in `shared.js` — a full identity
  key (price to 6 decimals, currency, exact-vs-range type), directly
  testable with plain data, mirroring the same fix already applied to
  candidate-tie detection.
- **The claim-proximity threshold still accepted a shallow unrelated
  promo.** The hop-distance threshold (≤3) was tuned against a fixture
  that happened to include an extra wrapper `<div>` around the price;
  removing that one wrapper reduced the combined distance to exactly 3,
  right at the threshold, and the unrelated `<aside class="promo">`'s
  claim was accepted again. Rather than retune the number (which trades
  one failure mode for another — too tight starts rejecting legitimately
  wrapped pairs), replaced the primary mechanism entirely with what the
  review specifically suggested: common-container semantics. Instead of
  measuring distance or counting signals, container expansion now stops
  the instant it would include a sibling that isn't itself part of the
  claim (a direct `<del>`, or a was/RRP-styled leaf) but wraps a
  price-like element nested somewhere inside it — which correctly
  distinguishes "the was-price itself, sitting right next to the current
  price" from "an unrelated section that happens to contain a price
  somewhere inside," regardless of naming, counting, or distance.
  `proximityHops()` remains as a secondary layer on top, not the primary
  gate anymore. Verified against the reviewer's exact minimal
  reproduction (no wrapper at all) plus the original wrapped fixture and
  two legitimate co-located cases.
- **Structured (JSON-LD/meta) prices could contradict the visible price
  and still win.** The zero-identity JSON-LD path got visible-price
  corroboration in the previous round, but every other structured path —
  a title-matching JSON-LD candidate, `og:price:amount`/
  `product:price:amount` meta tags, `itemprop="price"` — could return a
  price with no check against what's actually shown at all, plausible on
  variant pages where OG metadata reflects the default variant while a
  different one is selected. Added one general invariant applied in
  `run()` to every structured result, not just the zero-identity case: if
  a credible visible price exists and materially disagrees with the
  structured one, the structured result is discarded and detection falls
  through to the visibility-aware DOM watcher instead of silently
  trusting invisible metadata. Also closed a related gap: the
  `itemprop="price"` fallback didn't check whether the matched element
  was actually visible, so a hidden stale/inactive variant's microdata
  could beat the genuinely displayed price.
- **Page-controlled image metadata was unbounded and unused.** `image`
  (from JSON-LD or `og:image`) was persisted on every observation but
  never displayed anywhere in the popup or history UI — pure
  unnecessary attack surface. A hostile page could supply an enormous
  string or a large `data:` URL, and since history and metadata are
  written together in one `chrome.storage.local.set()` call, an
  oversized metadata value could push the whole write over quota and
  block the real observation from being recorded too. Removed entirely
  rather than bounded, since there's no actual use for it to preserve.
- **Extracted the container-scoping logic into `shared.js`** alongside
  the JSON-LD selection logic from the previous round —
  `looksLikeUnrelatedSection()`, `isClaimLeaf()`,
  `containsNestedPriceOrClaim()`, and `findLocalContainer()` are all now
  pure/DOM-fixture-testable functions rather than buried in content.js's
  closure, continuing the same response to the repeated critique that
  source-pattern tests can't prove detection behavior.
- **The test suite grew to 83 checks**, including real behavioral tests
  for every fixed scenario in this round — reproducing the reviewer's
  exact minimal claim-scoping case, the three-decimal-currency and
  cross-currency offer conflicts, and structural checks for the
  disagreement invariant, itemprop visibility, and image removal.
