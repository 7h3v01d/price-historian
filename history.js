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

function renderSidebar(products, activeKey, onSelect, filterText) {
  const list = document.getElementById("product-list");
  const filtered = filterText
    ? products.filter((p) => (p.meta.title || "").toLowerCase().includes(filterText.toLowerCase()))
    : products;

  if (!filtered.length) {
    list.innerHTML = `<p class="pl-empty">${
      products.length ? "No matches." : "No products tracked yet. Browse a product page and check back here."
    }</p>`;
    return;
  }

  list.innerHTML = "";
  for (const product of filtered) {
    const last = product.history[product.history.length - 1];
    const item = document.createElement("div");
    item.className = "pl-product-item" + (product.key === activeKey ? " pl-active" : "");
    item.innerHTML = `
      <div class="pl-product-item-title">${escapeHtml(product.meta.title || "Untitled product")}</div>
      <div class="pl-product-item-meta">
        <span>${escapeHtml(product.domain)}</span>
        <span class="pl-product-item-price">${fmt(last.p, last.c)}</span>
      </div>
    `;
    item.addEventListener("click", () => onSelect(product));
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

// ---------- Boot ----------

async function main() {
  const products = await loadAllProducts();
  let activeKey = products[0]?.key || null;
  let filterText = "";

  function refreshSidebar() {
    renderSidebar(products, activeKey, (product) => {
      activeKey = product.key;
      refreshSidebar();
      renderChart(product);
    }, filterText);
  }

  refreshSidebar();
  if (products.length) {
    renderChart(products[0]);
  }

  document.getElementById("search").addEventListener("input", (e) => {
    filterText = e.target.value;
    refreshSidebar();
  });
}

main();
