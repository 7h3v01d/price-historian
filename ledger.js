// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Leon Priest (GitHub: 7h3v01d)
//
// Price Ledger — the single writer for ledger storage.
//
// Every write to the ledger (price history, product metadata, comparison
// groups, and storage migrations) goes through one promise-chain queue
// owned by the background service worker. Content scripts and extension
// pages never write these keys themselves any more; they send a message
// and the worker applies the change.
//
// Why: each tab's content script is its own JS context, so an in-page lock
// can't stop two tabs doing a read-modify-write on the same history key at
// once — one tab's observation silently overwrote the other's (reproduced
// against 0.9.7 with two jsdom tabs on real content.js). The worker is a
// single shared instance, so one queue here is a complete fix rather than a
// mitigation. The same queue also orders migrations ahead of any writes,
// which closes two update-time races that existed in 0.9.7: the two
// migrations ran concurrently and clobbered each other, and a post-update
// content script could write to a migrated key mid-migration, splitting a
// product's history across two entries.
//
// Plain script (no modules): loaded via importScripts() in background.js
// after shared.js, and eval'd after shared.js by the test suite. Depends on
// shared.js for sanitizeCurrency(), filterSameCurrency(), and
// buildFallbackProductKey().

const LEDGER_HISTORY_CAP = 200;
const LEDGER_TITLE_MAX = 140;
const LEDGER_PRODUCT_KEY_MAX = 240;
const LEDGER_GROUP_NAME_MAX = 120;
const LEDGER_GROUP_MEMBERS_MAX = 50;
const LEDGER_MIGRATION_FLAG = "ledgerMigratedVersion";

// Validates a RECORD message against what the worker itself knows about
// the sender. The domain and URL come from the sender's frame URL (which
// Chrome supplies, not the message), so a content script can only ever
// write under the domain it's actually running on. Returns a clean
// observation, or null if anything is off — the worker writes nothing
// rather than guessing.
function validateObservation(product, senderUrl) {
  if (!product || typeof product !== "object") return null;

  let url;
  try {
    url = new URL(senderUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const domain = url.hostname.replace(/^www\./, "");
  if (!domain || domain.includes(":")) return null;

  const { productKey, price, title } = product;
  if (typeof productKey !== "string") return null;
  if (!/^(id|name):./.test(productKey) || productKey.length > LEDGER_PRODUCT_KEY_MAX) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;

  const claimed = product.claimedWasPrice;
  const claimedWasPrice = typeof claimed === "number" && Number.isFinite(claimed) && claimed >= 0 ? claimed : null;

  const cleanTitle = (typeof title === "string" ? title : "").trim().slice(0, LEDGER_TITLE_MAX);

  // Name-based identity is derived HERE, from exactly the title and URL
  // path that get stored as this product's meta — never taken from the
  // message. The identity migration recomputes keys from stored meta, so
  // the two must agree by construction. Before 0.10.1 the content script
  // hashed the raw title while the stored title was trimmed and cut to 140
  // characters: any long or whitespace-padded title had its current entry
  // moved to a key nothing writes to on every update, restarting its
  // history (live since 0.9.7). ID-based keys are unaffected.
  const resolvedKey = productKey.startsWith("name:") ? buildFallbackProductKey(cleanTitle, url.pathname) : productKey;

  return {
    domain,
    url: url.href,
    productKey: resolvedKey,
    price,
    currency: sanitizeCurrency(product.currency, null),
    claimedWasPrice,
    title: cleanTitle,
  };
}

// Union of two histories for the same product: time-ordered, exact
// duplicate readings dropped, capped like any other history. Never
// invents or alters a reading.
function mergeHistories(a, b) {
  const seen = new Set();
  const merged = [];
  for (const h of [...a, ...b]) {
    if (!h || typeof h !== "object" || !Number.isFinite(h.t)) continue;
    const id = JSON.stringify([h.t, h.p, h.c ?? null, h.w ?? null]);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(h);
  }
  merged.sort((x, y) => x.t - y.t);
  return merged.slice(-LEDGER_HISTORY_CAP);
}

// The most recently seen entry's title/URL win; lastSeen is the later one.
function mergeMeta(dest, incoming) {
  if (!dest || typeof dest !== "object") return incoming;
  const newer = (incoming.lastSeen || 0) > (dest.lastSeen || 0) ? incoming : dest;
  return { title: newer.title, url: newer.url, lastSeen: Math.max(dest.lastSeen || 0, incoming.lastSeen || 0) };
}

function createLedger(storage, options = {}) {
  const now = options.now || (() => Date.now());
  let queue = Promise.resolve();

  // Runs fn after every previously enqueued operation has settled. A failed
  // operation doesn't wedge the queue — its caller still sees the real
  // error through the returned promise.
  function enqueue(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  async function recordUnsafe(obs) {
    const hKey = `history:${obs.domain}:${obs.productKey}`;
    const mKey = `meta:${obs.domain}:${obs.productKey}`;
    const stored = await storage.get(hKey);
    const history = Array.isArray(stored[hKey]) ? stored[hKey] : [];

    // Snapshot the low BEFORE today's point is added, so "new low" means
    // "lower than everything previously observed," not "lower than itself."
    // Same-currency only — an unknown or different currency never counts.
    const priorPrices = filterSameCurrency(history, obs.currency).map((h) => h.p);
    const priorLow = priorPrices.length ? Math.min(...priorPrices) : null;
    const isNewLow = priorLow !== null && obs.price < priorLow - 0.001;

    const t = now();
    const last = history[history.length - 1];
    // Same-day dedupe: a currency change or a claim appearing/disappearing/
    // changing is a real change even when the price matches, so all three
    // are part of the reading's identity.
    const sameDay = last && new Date(last.t).toDateString() === new Date(t).toDateString();
    const sameReading =
      last && last.p === obs.price && last.c === obs.currency && (last.w ?? null) === obs.claimedWasPrice;
    if (!last || !sameReading || !sameDay) {
      history.push({ p: obs.price, c: obs.currency, t, w: obs.claimedWasPrice });
    }
    const trimmed = history.slice(-LEDGER_HISTORY_CAP);

    // Deliberately no image field — page-controlled, unbounded, and never
    // displayed (see README, sixth hardening pass).
    await storage.set({
      [hKey]: trimmed,
      [mKey]: { title: obs.title, url: obs.url, lastSeen: t },
    });

    return { history: trimmed, isNewLow, priorLow };
  }

  function record(obs) {
    return enqueue(() => recordUnsafe(obs));
  }

  // ---------- Comparison groups ----------

  async function loadGroupsUnsafe() {
    const { groups } = await storage.get("groups");
    return Array.isArray(groups) ? groups : [];
  }

  function createGroup(name, members) {
    return enqueue(async () => {
      if (typeof name !== "string" || !name.trim()) throw new Error("group name required");
      if (!Array.isArray(members) || members.length < 2 || members.length > LEDGER_GROUP_MEMBERS_MAX) {
        throw new Error("a comparison needs 2 or more members");
      }
      if (!members.every((m) => typeof m === "string" && m.length <= 400)) throw new Error("invalid member key");
      const groups = await loadGroupsUnsafe();
      const id = `g_${now()}_${Math.random().toString(36).slice(2, 8)}`;
      groups.push({ id, name: name.trim().slice(0, LEDGER_GROUP_NAME_MAX), members: [...new Set(members)] });
      await storage.set({ groups });
      return id;
    });
  }

  function deleteGroup(id) {
    return enqueue(async () => {
      const groups = await loadGroupsUnsafe();
      await storage.set({ groups: groups.filter((g) => g.id !== id) });
    });
  }

  // ---------- Migrations ----------
  // Each migration re-reads storage itself and they run strictly one after
  // the other inside the queue, so neither can act on a snapshot the other
  // has already changed. Order matters: currency is sanitized first, then
  // keys are moved, so the moved data is the sanitized data.

  async function migrateLegacyCurrencyData() {
    const all = await storage.get(null);
    const updates = {};
    for (const key of Object.keys(all)) {
      if (!key.startsWith("history:")) continue;
      const entries = all[key];
      if (!Array.isArray(entries)) continue;
      let changed = false;
      const cleaned = entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        if (sanitizeCurrency(entry.c, null) === entry.c) return entry;
        changed = true;
        return { ...entry, c: sanitizeCurrency(entry.c, null) };
      });
      if (changed) updates[key] = cleaned;
    }
    if (Object.keys(updates).length > 0) await storage.set(updates);
  }

  async function migrateNameBasedIdentityKeys() {
    const all = await storage.get(null);
    const updates = {};
    const removals = [];
    const renamed = new Map(); // "domain:oldProductKey" -> "domain:newProductKey"

    for (const key of Object.keys(all)) {
      const match = key.match(/^meta:([^:]+):name:(.+)$/);
      if (!match) continue;
      const [, domain, oldSlug] = match;
      const meta = all[key];
      if (!meta || typeof meta.title !== "string") continue;

      let pathname = "";
      try {
        pathname = meta.url ? new URL(meta.url).pathname : "";
      } catch {
        // malformed/missing URL — title-only identity, as buildFallbackProductKey does
      }

      const newProductKey = buildFallbackProductKey(meta.title, pathname);
      const oldProductKey = `name:${oldSlug}`;
      if (newProductKey === oldProductKey) continue;

      const newMetaKey = `meta:${domain}:${newProductKey}`;
      const oldHistoryKey = `history:${domain}:${oldProductKey}`;
      const newHistoryKey = `history:${domain}:${newProductKey}`;
      const current = (k) => (k in updates ? updates[k] : all[k]);
      const oldHistory = all[oldHistoryKey];
      const destHistory = current(newHistoryKey);
      if (oldHistory !== undefined && !Array.isArray(oldHistory)) continue; // unrecognised shape — leave it alone
      if (destHistory !== undefined && !Array.isArray(destHistory)) continue;

      // If the destination already exists — 0.9.7 could create it when a
      // tab recorded mid-migration, leaving this old entry orphaned as a
      // second copy of the same product — merge rather than skip. Both keys
      // resolve from the same stored title and URL, so they're the same
      // product by construction; the merge only ever unions observations.
      if (oldHistory || destHistory) updates[newHistoryKey] = mergeHistories(destHistory || [], oldHistory || []);
      updates[newMetaKey] = mergeMeta(current(newMetaKey), meta);
      removals.push(key, oldHistoryKey);
      renamed.set(`${domain}:${oldProductKey}`, `${domain}:${newProductKey}`);
    }

    // Comparison groups store members as "domain:productKey", so a moved
    // product has to be renamed in them too — otherwise the comparison
    // silently loses that member (live since the 0.9.7 identity migration).
    // Written in the same set() as the move, so they can't disagree.
    if (renamed.size > 0 && Array.isArray(all.groups)) {
      let changed = false;
      const groups = all.groups.map((g) => {
        if (!g || !Array.isArray(g.members)) return g;
        const members = [...new Set(g.members.map((m) => renamed.get(m) || m))];
        if (members.length === g.members.length && members.every((m, i) => m === g.members[i])) return g;
        changed = true;
        return { ...g, members };
      });
      if (changed) updates.groups = groups;
    }

    if (Object.keys(updates).length > 0) await storage.set(updates);
    // Never remove a key this same pass just wrote.
    const toRemove = removals.filter((k) => !(k in updates));
    if (toRemove.length > 0) await storage.remove(toRemove);
  }

  // Runs the migrations once per extension version. Checked on every worker
  // start (not only onInstalled), so a missed or interrupted onInstalled
  // event can't leave storage half-migrated with writes landing on top. The
  // flag is only set after both succeed, so a failure retries next start.
  function ensureMigrated(version) {
    return enqueue(async () => {
      const { [LEDGER_MIGRATION_FLAG]: done } = await storage.get(LEDGER_MIGRATION_FLAG);
      if (done === version) return false;
      await migrateLegacyCurrencyData();
      await migrateNameBasedIdentityKeys();
      await storage.set({ [LEDGER_MIGRATION_FLAG]: version });
      return true;
    });
  }

  return { enqueue, record, createGroup, deleteGroup, ensureMigrated };
}
