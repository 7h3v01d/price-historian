# Price Ledger — a local Universal Price Historian

A Chrome (Manifest V3) extension that watches product pages you visit,
remembers what price you actually saw, and tells you whether today's price
is a real deal or just a relabeled number. Everything is stored **locally**
via `chrome.storage.local` — no backend, no account, nothing leaves your
machine in this MVP.

## How it works

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
- **Claim checks require ~14 days of tracking before flagging "inflated."**
  A "was $X" claim you've never personally seen corroborated could mean
  the claim is fake — or it could just mean you started tracking the item
  after a genuine discount had already begun. Fewer than 14 days of
  history reports "can't verify" either way rather than guessing; only a
  longer window that still never reaches the claimed price is treated as
  a real red flag. The threshold is a judgment call, not a precise
  science — tune `MIN_DAYS_FOR_INFLATED_VERDICT` in `content.js`,
  `history.js`, and `popup.js` together if you want it stricter or looser.
- **Spend summary assumes one currency across everything tracked.** It
  sums raw price numbers without currency conversion — fine if everything
  you track is in AUD (or whatever one currency), but would silently
  produce a meaningless total if you ever tracked items priced in
  genuinely different currencies. Worth fixing properly (group by
  currency, show separate totals) if that ever becomes a real scenario.
- **Comparisons are manual and don't auto-update membership.** Linking is
  a one-time action — if a retailer stops selling an item or you start
  tracking a better match, you'll need to delete the old comparison and
  create a new one; there's no "edit members" flow yet, just create and
  delete. Also, if a comparison somehow links two entries from the same
  domain, they'll render in the same series color on the chart — a minor
  cosmetic quirk, not a data problem.
