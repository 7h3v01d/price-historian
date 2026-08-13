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

## Try it

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select this `price-historian` folder
4. Visit any product page with structured data (most Shopify stores, Best
   Buy, Etsy, Target, Wikipedia's "infobox" won't have one — try an actual
   retailer) — the badge should appear a moment after load
5. Revisit the same product later (or edit `content.js` to fake a different
   price) to see the sparkline and "lowest seen" verdict kick in
6. Click the toolbar icon to see everything tracked so far

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
- **No fake-discount label parsing** — resolved: see the claim check above.
  Note its honesty limits though — it only flags a claim as suspicious once
  you have at least one prior visit to compare against. A brand new item
  with no history yet is reported as "can't verify," never as "fake,"
  since there's no way to tell the difference between a genuine discount
  and a normal price from data this thin.
