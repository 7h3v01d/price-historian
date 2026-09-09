function fmt(price, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
  } catch {
    return `${currency} ${price.toFixed(2)}`;
  }
}

function formatShortDate(t) {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullDate(t) {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Mirrors the logic in content.js: was this point's claimed "was" price
// actually corroborated by anything observed before it? A short tracking
// window before this point reports "neutral" rather than "bad" — not
// having seen the higher price yet doesn't mean it's fake, it might just
// mean tracking started partway through an already-discounted period.
const MIN_DAYS_FOR_INFLATED_VERDICT = 14;

function evaluateClaimAt(history, i) {
  const point = history[i];
  if (point.w == null) return null;
  const past = history.slice(0, i);
  if (!past.length) return { tone: "neutral" };
  const observedMax = Math.max(...past.map((h) => h.p));
  const tolerance = point.w * 0.03;
  if (observedMax >= point.w - tolerance) return { tone: "good" };
  const daysTracked = (past[past.length - 1].t - past[0].t) / 86400000;
  return daysTracked < MIN_DAYS_FOR_INFLATED_VERDICT ? { tone: "neutral" } : { tone: "bad" };
}

async function loadAllProducts() {
  const all = await chrome.storage.local.get(null);
  const products = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith("meta:")) continue;
    const match = key.match(/^meta:([^:]+):(.+)$/);
    if (!match) continue;
    const [, domain, productKey] = match;
    const historyKey = `history:${domain}:${productKey}`;
    const meta = all[key];
    const history = (all[historyKey] || []).slice().sort((a, b) => a.t - b.t);
    if (!history.length) continue;
    products.push({ domain, productKey, meta, history, key: `${domain}:${productKey}` });
  }
  products.sort((a, b) => (b.meta.lastSeen || 0) - (a.meta.lastSeen || 0));
  return products;
}

// ---------- Cross-retailer groups ----------
// Manual, explicit linking only — matching product identity automatically
// across sites isn't reliable enough (no shared ID, pack-size/brand
// variants, differing titles), so the person links items they know are
// the same product themselves.

async function loadGroups() {
  const { groups } = await chrome.storage.local.get("groups");
  return groups || [];
}

async function saveGroups(groups) {
  await chrome.storage.local.set({ groups });
}

async function createGroup(name, memberKeys) {
  const groups = await loadGroups();
  const id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  groups.push({ id, name, members: memberKeys });
  await saveGroups(groups);
  return id;
}

async function deleteGroup(id) {
  const groups = await loadGroups();
  await saveGroups(groups.filter((g) => g.id !== id));
}

function renderSidebar(state) {
  const { products, groups, activeKey, activeGroupId, filterText, selectionMode, selectedKeys, callbacks } = state;
  const list = document.getElementById("product-list");
  const filtered = filterText
    ? products.filter((p) => (p.meta.title || "").toLowerCase().includes(filterText.toLowerCase()))
    : products;

  list.innerHTML = "";

  // --- Compare-mode toggle + create button ---
  const toggleRow = document.createElement("div");
  toggleRow.className = "pl-compare-row";
  toggleRow.innerHTML = `
    <button class="pl-compare-toggle">${selectionMode ? "Cancel" : "+ Compare across retailers"}</button>
    ${
      selectionMode
        ? `<button class="pl-compare-create" ${selectedKeys.size < 2 ? "disabled" : ""}>Create comparison (${selectedKeys.size})</button>`
        : ""
    }
  `;
  toggleRow.querySelector(".pl-compare-toggle").addEventListener("click", callbacks.onToggleSelectionMode);
  toggleRow.querySelector(".pl-compare-create")?.addEventListener("click", callbacks.onCreateGroup);
  list.appendChild(toggleRow);

  // --- Existing comparisons ---
  if (groups.length) {
    const section = document.createElement("div");
    section.className = "pl-sidebar-section-label";
    section.textContent = "Comparisons";
    list.appendChild(section);

    for (const group of groups) {
      const item = document.createElement("div");
      item.className = "pl-product-item pl-group-item" + (group.id === activeGroupId ? " pl-active" : "");
      item.innerHTML = `
        <div class="pl-product-item-title">⇄ ${escapeHtml(group.name)}</div>
        <div class="pl-product-item-meta">
          <span>${group.members.length} retailers</span>
          <button class="pl-group-delete" title="Delete comparison">&times;</button>
        </div>
      `;
      item.querySelector(".pl-product-item-title").addEventListener("click", () => callbacks.onSelectGroup(group));
      item.querySelector(".pl-group-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        callbacks.onDeleteGroup(group);
      });
      list.appendChild(item);
    }
  }

  // --- Products ---
  if (groups.length || selectionMode) {
    const section = document.createElement("div");
    section.className = "pl-sidebar-section-label";
    section.textContent = "All products";
    list.appendChild(section);
  }

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "pl-empty";
    empty.textContent = products.length ? "No matches." : "No products tracked yet. Browse a product page and check back here.";
    list.appendChild(empty);
    return;
  }

  for (const product of filtered) {
    const last = product.history[product.history.length - 1];
    const item = document.createElement("div");
    item.className = "pl-product-item" + (!selectionMode && product.key === activeKey ? " pl-active" : "");
    item.innerHTML = `
      <div class="pl-product-item-title">
        ${selectionMode ? `<input type="checkbox" class="pl-select-check" ${selectedKeys.has(product.key) ? "checked" : ""} />` : ""}
        ${escapeHtml(product.meta.title || "Untitled product")}
      </div>
      <div class="pl-product-item-meta">
        <span>${escapeHtml(product.domain)}</span>
        <span class="pl-product-item-price">${fmt(last.p, last.c)}</span>
      </div>
    `;
    if (selectionMode) {
      const checkbox = item.querySelector(".pl-select-check");
      const toggle = () => callbacks.onToggleSelect(product.key, checkbox.checked);
      checkbox.addEventListener("change", toggle);
      item.addEventListener("click", (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        toggle();
      });
    } else {
      item.addEventListener("click", () => callbacks.onSelectProduct(product));
    }
    list.appendChild(item);
  }
}

// ---------- Chart ----------

const CHART_W = 760;
const CHART_H = 280;
const PAD_LEFT = 58;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;

function buildChartSvg(history) {
  const plotW = CHART_W - PAD_LEFT - PAD_RIGHT;
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;

  const times = history.map((h) => h.t);
  const prices = history.map((h) => h.p);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const rawMinP = Math.min(...prices);
  const rawMaxP = Math.max(...prices);
  const priceSpan = rawMaxP - rawMinP || rawMaxP * 0.1 || 1;
  const minP = Math.max(0, rawMinP - priceSpan * 0.12);
  const maxP = rawMaxP + priceSpan * 0.12;

  const xScale = (t) => (times.length === 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + ((t - minT) / (maxT - minT)) * plotW);
  const yScale = (p) => PAD_TOP + (1 - (p - minP) / (maxP - minP)) * plotH;

  // Track running min so we can mark genuine record-low points.
  let runningMin = Infinity;
  const points = history.map((h, i) => {
    const isRecordLow = h.p <= runningMin + 0.001;
    runningMin = Math.min(runningMin, h.p);
    const claim = evaluateClaimAt(history, i);
    return { x: xScale(h.t), y: yScale(h.p), isRecordLow, claim, ...h };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${PAD_TOP + plotH} L${points[0].x.toFixed(1)},${PAD_TOP + plotH} Z`;

  // Y-axis ticks: 4 evenly spaced values across the padded price range.
  const yTicks = [0, 1, 2, 3].map((i) => minP + ((maxP - minP) * i) / 3);
  const yTickLines = yTicks
    .map(
      (val) => `
      <line x1="${PAD_LEFT}" y1="${yScale(val).toFixed(1)}" x2="${CHART_W - PAD_RIGHT}" y2="${yScale(val).toFixed(1)}" stroke="#1c2620" stroke-width="1" />
      <text x="${PAD_LEFT - 8}" y="${(yScale(val) + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#6B756E">${fmt(val, history[0].c).replace(/\.00$/, "")}</text>
    `
    )
    .join("");

  // X-axis ticks: up to 5 evenly spaced timestamps.
  const tickCount = Math.min(5, times.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) =>
    tickCount === 1 ? minT : minT + ((maxT - minT) * i) / (tickCount - 1)
  );
  const xTickLabels = xTicks
    .map(
      (t) => `
      <text x="${xScale(t).toFixed(1)}" y="${CHART_H - 10}" text-anchor="middle" font-size="9.5" fill="#6B756E">${formatShortDate(t)}</text>
    `
    )
    .join("");

  const circles = points
    .map((p, i) => {
      const fill = p.isRecordLow ? "#3FA796" : "#E8A33D";
      const ringColor = p.claim?.tone === "bad" ? "#E2574C" : p.claim?.tone === "good" ? "#3FA796" : null;
      const ring = ringColor
        ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6.5" fill="none" stroke="${ringColor}" stroke-width="1.8" />`
        : "";
      return `${ring}<circle class="pl-chart-point" data-index="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.4" fill="${fill}" stroke="#101814" stroke-width="1.2" />`;
    })
    .join("");

  return {
    svg: `
      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" height="${CHART_H}">
        <defs>
          <linearGradient id="pl-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3FA796" stop-opacity="0.18" />
            <stop offset="100%" stop-color="#3FA796" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${yTickLines}
        ${xTickLabels}
        <path d="${areaPath}" fill="url(#pl-area-fill)" />
        <path d="${linePath}" fill="none" stroke="#3FA796" stroke-width="1.8" />
        ${circles}
      </svg>
    `,
    points,
  };
}

function renderChart(product) {
  const main = document.getElementById("main");
  const history = product.history;
  const last = history[history.length - 1];
  const prices = history.map((h) => h.p);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const isAtLow = last.p <= low + 0.001;
  const claim = evaluateClaimAt(history, history.length - 1);

  const { svg, points } = buildChartSvg(history);

  main.innerHTML = `
    <div class="pl-header-row">
      <div>
        <h2 class="pl-product-title">${escapeHtml(product.meta.title || "Untitled product")}</h2>
        <div class="pl-product-domain">${escapeHtml(product.domain)} · <a href="${escapeHtml(product.meta.url)}" target="_blank" rel="noopener">open product page ↗</a></div>
      </div>
    </div>
    <div class="pl-stat-row">
      <div class="pl-stat">
        <span class="pl-stat-label">Current</span>
        <span class="pl-stat-value">${fmt(last.p, last.c)}</span>
      </div>
      <div class="pl-stat">
        <span class="pl-stat-label">Low</span>
        <span class="pl-stat-value pl-good">${fmt(low, last.c)}</span>
      </div>
      <div class="pl-stat">
        <span class="pl-stat-label">High</span>
        <span class="pl-stat-value">${fmt(high, last.c)}</span>
      </div>
      <div class="pl-stat">
        <span class="pl-stat-label">Checks</span>
        <span class="pl-stat-value">${history.length}</span>
      </div>
      <div class="pl-stat">
        <span class="pl-stat-label">Status</span>
        <span class="pl-stat-value ${isAtLow ? "pl-good" : "pl-amber"}">${isAtLow ? "At low" : "Above low"}</span>
      </div>
    </div>
    <div class="pl-chart-wrap" id="chart-wrap">
      <div class="pl-chart-legend">
        <span><span class="pl-legend-swatch" style="background:#E8A33D"></span>Price checked</span>
        <span><span class="pl-legend-swatch" style="background:#3FA796"></span>New low at the time</span>
        <span><span class="pl-legend-swatch" style="background:transparent;border:1.5px solid #E2574C"></span>Suspicious "was" claim</span>
      </div>
      ${svg}
      <div class="pl-tooltip" id="tooltip"></div>
    </div>
    ${
      claim
        ? `<div class="pl-claim-note pl-${claim.tone === "bad" ? "bad" : claim.tone === "good" ? "good" : ""}">
            ${
              claim.tone === "bad"
                ? `Most recent visit claimed a "was" price never actually observed before — treat that discount with caution.`
                : claim.tone === "good"
                ? `Most recent visit's "was" claim checks out against your own price history.`
                : `Most recent visit included a "was" claim, but there isn't enough tracking history yet to confirm or challenge it.`
            }
          </div>`
        : ""
    }
  `;

  wireTooltip(points, history);
}

function wireTooltip(points, history) {
  const wrap = document.getElementById("chart-wrap");
  const svg = wrap.querySelector("svg");
  const tooltip = document.getElementById("tooltip");

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = CHART_W / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;

    let nearest = points[0];
    let nearestDist = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - mouseX);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }

    const scaleY = rect.height / CHART_H;
    const pxX = nearest.x / scaleX;
    const pxY = nearest.y * scaleY;
    // svg.offsetLeft/offsetTop give its position relative to the nearest
    // positioned ancestor (the wrap, which has position:relative) — needed
    // because the legend + wrap padding push the svg down from the wrap's
    // own top-left corner, and the tooltip is positioned against the wrap.
    const tooltipLeft = svg.offsetLeft + pxX;
    const tooltipTop = svg.offsetTop + pxY;

    let claimLine = "";
    if (nearest.w != null) {
      const verdict =
        nearest.claim?.tone === "bad"
          ? `⚠ claimed "was ${fmt(nearest.w, nearest.c)}" — never seen that high before`
          : nearest.claim?.tone === "good"
          ? `claimed "was ${fmt(nearest.w, nearest.c)}" — matches your history`
          : `claimed "was ${fmt(nearest.w, nearest.c)}" — not enough history yet to check`;
      claimLine = `<div class="pl-tt-flag">${escapeHtml(verdict)}</div>`;
    }

    tooltip.innerHTML = `
      <div class="pl-tt-date">${formatFullDate(nearest.t)}</div>
      <div>${fmt(nearest.p, nearest.c)}${nearest.isRecordLow ? " · new low" : ""}</div>
      ${claimLine}
    `;
    tooltip.style.left = `${tooltipLeft}px`;
    tooltip.style.top = `${tooltipTop - 10}px`;
    tooltip.classList.add("pl-visible");
  });

  svg.addEventListener("mouseleave", () => {
    tooltip.classList.remove("pl-visible");
  });
}

// ---------- Spend summary ----------
// Note: this extension never sees actual purchases (no checkout tracking),
// so "spend" here means something specific and honest: the trended value
// of everything you're tracking, at prices you've actually observed — not
// what you actually paid. The one genuinely purchase-independent number
// worth surfacing is the gap between your current basket and the
// cheapest each item has ever been, since that's fully computable from
// observation data alone.

const SUMMARY_CHART_W = 720;
const SUMMARY_CHART_H = 220;
const S_PAD_LEFT = 58;
const S_PAD_RIGHT = 16;
const S_PAD_TOP = 16;
const S_PAD_BOTTOM = 32;

function basketValueAsOf(products, atTime) {
  let total = 0;
  let itemCount = 0;
  for (const product of products) {
    const priorPoints = product.history.filter((h) => h.t <= atTime);
    if (!priorPoints.length) continue;
    total += priorPoints[priorPoints.length - 1].p;
    itemCount++;
  }
  return { total, itemCount };
}

function countNewLowsInRange(products, start, end) {
  let count = 0;
  for (const product of products) {
    let runningMin = Infinity;
    for (const h of product.history) {
      const isLow = h.p <= runningMin + 0.001;
      if (isLow && h.t >= start && h.t < end) count++;
      runningMin = Math.min(runningMin, h.p);
    }
  }
  return count;
}

function countFlaggedClaimsInRange(products, start, end) {
  let count = 0;
  for (const product of products) {
    for (let i = 0; i < product.history.length; i++) {
      const h = product.history[i];
      if (h.t < start || h.t >= end) continue;
      if (evaluateClaimAt(product.history, i)?.tone === "bad") count++;
    }
  }
  return count;
}

function buildPeriodBuckets(period, count) {
  const msPerDay = 86400000;
  const bucketMs = period === "weekly" ? 7 * msPerDay : 30 * msPerDay;
  const now = Date.now();
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = now - i * bucketMs;
    const start = end - bucketMs;
    buckets.push({ start, end });
  }
  return buckets;
}

function buildBarChartSvg(buckets, currency) {
  const plotW = SUMMARY_CHART_W - S_PAD_LEFT - S_PAD_RIGHT;
  const plotH = SUMMARY_CHART_H - S_PAD_TOP - S_PAD_BOTTOM;
  const maxVal = Math.max(...buckets.map((b) => b.total), 1);
  const barSlot = plotW / buckets.length;
  const barWidth = Math.min(36, barSlot * 0.55);

  const yTicks = [0, 1, 2, 3].map((i) => (maxVal * i) / 3);
  const yTickLines = yTicks
    .map((val) => {
      const y = S_PAD_TOP + (1 - val / maxVal) * plotH;
      return `
        <line x1="${S_PAD_LEFT}" y1="${y.toFixed(1)}" x2="${SUMMARY_CHART_W - S_PAD_RIGHT}" y2="${y.toFixed(1)}" stroke="#1c2620" stroke-width="1" />
        <text x="${S_PAD_LEFT - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#6B756E">${fmt(val, currency).replace(/\.00$/, "")}</text>
      `;
    })
    .join("");

  const bars = buckets
    .map((b, i) => {
      const barH = maxVal > 0 ? (b.total / maxVal) * plotH : 0;
      const x = S_PAD_LEFT + barSlot * i + (barSlot - barWidth) / 2;
      const y = S_PAD_TOP + plotH - barH;
      const label = new Date(b.end - 1).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="#3FA796" fill-opacity="${b.itemCount ? 0.85 : 0.15}" />
        <text x="${(x + barWidth / 2).toFixed(1)}" y="${SUMMARY_CHART_H - 10}" text-anchor="middle" font-size="9" fill="#6B756E">${label}</text>
      `;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${SUMMARY_CHART_W} ${SUMMARY_CHART_H}" width="100%" height="${SUMMARY_CHART_H}">
      ${yTickLines}
      ${bars}
    </svg>
  `;
}

function renderSummary(products, period) {
  const main = document.getElementById("main");

  if (!products.length) {
    main.innerHTML = `<p class="pl-placeholder">Track a few products first — the summary builds up from there.</p>`;
    return;
  }

  const currency = products[0].history[0].c;
  const currentTotal = products.reduce((sum, p) => sum + p.history[p.history.length - 1].p, 0);
  const bestCaseTotal = products.reduce((sum, p) => sum + Math.min(...p.history.map((h) => h.p)), 0);
  const gap = currentTotal - bestCaseTotal;

  const bucketCount = period === "weekly" ? 8 : 6;
  const buckets = buildPeriodBuckets(period, bucketCount).map((b) => ({
    ...b,
    ...basketValueAsOf(products, b.end),
    newLows: countNewLowsInRange(products, b.start, b.end),
    flagged: countFlaggedClaimsInRange(products, b.start, b.end),
  }));

  const rows = buckets
    .slice()
    .reverse()
    .map((b) => {
      const label = `${new Date(b.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(b.end - 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      return `
        <tr>
          <td>${label}</td>
          <td>${b.itemCount ? fmt(b.total, currency) : "—"}</td>
          <td>${b.itemCount}</td>
          <td>${b.newLows || "—"}</td>
          <td>${b.flagged ? `⚠ ${b.flagged}` : "—"}</td>
        </tr>
      `;
    })
    .join("");

  main.innerHTML = `
    <div class="pl-header-row">
      <div>
        <h2 class="pl-product-title">Spend summary</h2>
        <div class="pl-product-domain">Based on prices you've actually observed — not purchase data.</div>
      </div>
    </div>
    <div class="pl-period-toggle">
      <button class="pl-period-btn${period === "weekly" ? " pl-period-active" : ""}" data-period="weekly">Weekly</button>
      <button class="pl-period-btn${period === "monthly" ? " pl-period-active" : ""}" data-period="monthly">Monthly</button>
    </div>
    <div class="pl-summary-cards">
      <div class="pl-summary-card">
        <div class="pl-summary-card-label">Current basket</div>
        <div class="pl-summary-card-value">${fmt(currentTotal, currency)}</div>
        <div class="pl-summary-card-sub">${products.length} items tracked, at last known price</div>
      </div>
      <div class="pl-summary-card">
        <div class="pl-summary-card-label">If every item were at its best price</div>
        <div class="pl-summary-card-value">${fmt(bestCaseTotal, currency)}</div>
        <div class="pl-summary-card-sub">Cheapest each item has ever been observed</div>
      </div>
      <div class="pl-summary-card">
        <div class="pl-summary-card-label">Gap to best-case</div>
        <div class="pl-summary-card-value ${gap > 0.01 ? "pl-amber" : "pl-good"}">${fmt(gap, currency)}</div>
        <div class="pl-summary-card-sub">${gap > 0.01 ? "More than buying everything at its lowest" : "Basket is basically at best prices"}</div>
      </div>
    </div>
    <div class="pl-chart-wrap">
      ${buildBarChartSvg(buckets, currency)}
    </div>
    <table class="pl-summary-table">
      <thead>
        <tr><th>Period</th><th>Basket total</th><th>Items priced</th><th>New lows</th><th>Flagged claims</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  main.querySelectorAll(".pl-period-btn").forEach((btn) => {
    btn.addEventListener("click", () => renderSummary(products, btn.dataset.period));
  });
}

// ---------- Cross-retailer comparison view ----------

const COMPARE_PALETTE = ["#3FA796", "#E8A33D", "#4C9FE2", "#B98CE8", "#E8A0C4"];

function buildComparisonChartSvg(members) {
  const plotW = CHART_W - PAD_LEFT - PAD_RIGHT;
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;

  const allPoints = members.flatMap((m) => m.history);
  const times = allPoints.map((h) => h.t);
  const prices = allPoints.map((h) => h.p);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const priceSpan = Math.max(...prices) - Math.min(...prices) || Math.max(...prices) * 0.1 || 1;
  const minP = Math.max(0, Math.min(...prices) - priceSpan * 0.12);
  const maxP = Math.max(...prices) + priceSpan * 0.12;

  const xScale = (t) => (minT === maxT ? PAD_LEFT + plotW / 2 : PAD_LEFT + ((t - minT) / (maxT - minT)) * plotW);
  const yScale = (p) => PAD_TOP + (1 - (p - minP) / (maxP - minP)) * plotH;

  const yTicks = [0, 1, 2, 3].map((i) => minP + ((maxP - minP) * i) / 3);
  const yTickLines = yTicks
    .map(
      (val) => `
      <line x1="${PAD_LEFT}" y1="${yScale(val).toFixed(1)}" x2="${CHART_W - PAD_RIGHT}" y2="${yScale(val).toFixed(1)}" stroke="#1c2620" stroke-width="1" />
      <text x="${PAD_LEFT - 8}" y="${(yScale(val) + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#6B756E">${fmt(val, allPoints[0].c).replace(/\.00$/, "")}</text>
    `
    )
    .join("");

  const tickCount = Math.min(5, times.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) =>
    tickCount === 1 ? minT : minT + ((maxT - minT) * i) / (tickCount - 1)
  );
  const xTickLabels = xTicks
    .map((t) => `<text x="${xScale(t).toFixed(1)}" y="${CHART_H - 10}" text-anchor="middle" font-size="9.5" fill="#6B756E">${formatShortDate(t)}</text>`)
    .join("");

  const series = members
    .map((m, i) => {
      const color = COMPARE_PALETTE[i % COMPARE_PALETTE.length];
      const pts = m.history.map((h) => ({ x: xScale(h.t), y: yScale(h.p) }));
      const path = pts.map((p, j) => `${j === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      const circles = pts
        .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}" stroke="#101814" stroke-width="1" />`)
        .join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" />${circles}`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" height="${CHART_H}">
      ${yTickLines}
      ${xTickLabels}
      ${series}
    </svg>
  `;
}

function renderComparison(group, products) {
  const main = document.getElementById("main");
  const members = group.members
    .map((key) => products.find((p) => p.key === key))
    .filter(Boolean);

  if (members.length < 2) {
    main.innerHTML = `<p class="pl-placeholder">This comparison needs at least 2 linked products with history — one or more may have been removed.</p>`;
    return;
  }

  const currentByMember = members.map((m) => ({
    domain: m.domain,
    title: m.meta.title,
    url: m.meta.url,
    price: m.history[m.history.length - 1].p,
    currency: m.history[m.history.length - 1].c,
    low: Math.min(...m.history.map((h) => h.p)),
  }));
  const cheapest = currentByMember.slice().sort((a, b) => a.price - b.price)[0];

  const rows = currentByMember
    .slice()
    .sort((a, b) => a.price - b.price)
    .map(
      (m, i) => `
      <tr>
        <td><span class="pl-legend-swatch" style="background:${COMPARE_PALETTE[members.findIndex((x) => x.domain === m.domain) % COMPARE_PALETTE.length]}"></span>${escapeHtml(m.domain)}</td>
        <td>${fmt(m.price, m.currency)}${i === 0 ? " · cheapest now" : ""}</td>
        <td>${fmt(m.low, m.currency)}</td>
        <td><a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">open ↗</a></td>
      </tr>
    `
    )
    .join("");

  main.innerHTML = `
    <div class="pl-header-row">
      <div>
        <h2 class="pl-product-title">⇄ ${escapeHtml(group.name)}</h2>
        <div class="pl-product-domain">Comparing ${members.length} retailers you've linked as the same product.</div>
      </div>
    </div>
    <div class="pl-summary-cards">
      <div class="pl-summary-card">
        <div class="pl-summary-card-label">Cheapest right now</div>
        <div class="pl-summary-card-value pl-good">${fmt(cheapest.price, cheapest.currency)}</div>
        <div class="pl-summary-card-sub">at ${escapeHtml(cheapest.domain)}</div>
      </div>
    </div>
    <div class="pl-chart-wrap">
      ${buildComparisonChartSvg(members)}
    </div>
    <table class="pl-summary-table">
      <thead><tr><th>Retailer</th><th>Current</th><th>Its own low</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------- Boot ----------

async function main() {
  const products = await loadAllProducts();
  let groups = await loadGroups();
  let activeKey = products[0]?.key || null;
  let activeGroupId = null;
  let filterText = "";
  let view = "products"; // "products" | "summary" | "compare"
  let selectionMode = false;
  let selectedKeys = new Set();

  function refreshSidebar() {
    renderSidebar({
      products,
      groups,
      activeKey,
      activeGroupId,
      filterText,
      selectionMode,
      selectedKeys,
      callbacks: {
        onSelectProduct: (product) => {
          activeKey = product.key;
          activeGroupId = null;
          view = "products";
          refreshSidebar();
          renderChart(product);
        },
        onSelectGroup: (group) => {
          activeGroupId = group.id;
          view = "compare";
          refreshSidebar();
          renderComparison(group, products);
        },
        onDeleteGroup: async (group) => {
          await deleteGroup(group.id);
          groups = await loadGroups();
          if (activeGroupId === group.id) {
            activeGroupId = null;
            view = "products";
            const fallback = products.find((p) => p.key === activeKey) || products[0];
            if (fallback) renderChart(fallback);
          }
          refreshSidebar();
        },
        onToggleSelectionMode: () => {
          selectionMode = !selectionMode;
          if (!selectionMode) selectedKeys = new Set();
          refreshSidebar();
        },
        onToggleSelect: (key, checked) => {
          if (checked) selectedKeys.add(key);
          else selectedKeys.delete(key);
          refreshSidebar();
        },
        onCreateGroup: async () => {
          if (selectedKeys.size < 2) return;
          const name = window.prompt("Name this product (shown across all linked retailers):", "");
          if (!name) return;
          await createGroup(name.trim(), Array.from(selectedKeys));
          groups = await loadGroups();
          selectionMode = false;
          selectedKeys = new Set();
          const newGroup = groups[groups.length - 1];
          activeGroupId = newGroup.id;
          view = "compare";
          refreshSidebar();
          renderComparison(newGroup, products);
        },
      },
    });
  }

  function showProductsView() {
    if (selectionMode) return; // don't yank the sidebar away mid-selection
    view = "products";
    document.getElementById("tab-products").classList.add("pl-tab-active");
    document.getElementById("tab-summary").classList.remove("pl-tab-active");
    document.querySelector(".pl-search").style.display = "";
    document.getElementById("product-list").style.display = "";
    const active = products.find((p) => p.key === activeKey) || products[0];
    if (active) {
      activeGroupId = null;
      refreshSidebar();
      renderChart(active);
    }
  }

  function showSummaryView() {
    view = "summary";
    document.getElementById("tab-summary").classList.add("pl-tab-active");
    document.getElementById("tab-products").classList.remove("pl-tab-active");
    document.querySelector(".pl-search").style.display = "none";
    document.getElementById("product-list").style.display = "none";
    renderSummary(products, "weekly");
  }

  refreshSidebar();
  if (products.length) {
    renderChart(products[0]);
  }

  document.getElementById("search").addEventListener("input", (e) => {
    filterText = e.target.value;
    refreshSidebar();
  });
  document.getElementById("tab-products").addEventListener("click", showProductsView);
  document.getElementById("tab-summary").addEventListener("click", showSummaryView);
}

main();
