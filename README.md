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
  `MIN_OBSERVATIONS_FOR_INFLATED_VERDICT` in `shared.js`, used by
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
