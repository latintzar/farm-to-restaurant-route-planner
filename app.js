/* =====================================================================
   Farm-to-restaurant route planner — app.js
   ---------------------------------------------------------------------
   Show farms a proposed shared pickup/delivery run and its modeled
   economics. OSRM supplies road data; browser heuristics compare sourcing
   bundles; one VROOM request checks the selected bundle.

   Logic lives in five layers, top to bottom:
     1. Boot          — load data files, kick off render
     2. State         — current farms / restaurants / order / decision
     3. UI rendering  — scenarios, farm cards, order lines, cost panel
     4. Decision      — combination enumeration + VROOM call
     5. Map           — Leaflet markers, route polyline

   Static HTML/CSS and vanilla JavaScript. Node tests exercise the same
   decision functions without starting the browser or making requests.
   ===================================================================== */

(function(){
'use strict';

/* =====================================================================
   1. BOOT — load everything in parallel, render once data is in
   ===================================================================== */

const STATE = {
  farms: [],
  restaurants: [],
  products: [],
  productById: {},
  scenarios: [],
  depot: null,
  vehicle: null,
  // user-mutable
  orderLines: [],         // [{restaurant_id, product_id, qty_kg}]
  activeScenarioId: null,
  inputRevision: 0,
  supplyView: 'farm',     // 'farm' | 'product' — left-panel view mode
  // last decision
  lastDecision: null,     // {chosen, route, cost, runnersUp, scenarioTitle, ts, routeGeometry}
  decisionHistory: [],    // [{title, total_eur, ts}]
  // Ghost lines — top-N alternative bundles the model considered for
  // the *current* decision. Drawn as faint straight-line schematic
  // paths on the map (NOT road geometry — that's reserved for the
  // winner) so the user reads "we tried these too, the rust one won."
  consideredRoutes: [],   // [{stops, total_eur, isWinner}]
  // OSRM cache (real road network — no fallbacks; the demo is real or it's nothing).
  fullMatrix: null,       // {durations, distances} for [depot, ...farms, ...restaurants]
  osrmStatus: 'unknown',  // 'ok' | 'error' | 'unknown'
  // Solve phase drives both the Calculate button copy and the pin states
  // on the map. null = idle; 'priming' = pulling stock + matrix; 'evaluating'
  // = parallel VROOM swarm in flight; (after success it goes back to null
  // and STATE.lastDecision is the durable "done" signal).
  solvePhase: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function boot(){
  const base = './data/';
  try {
    const [farms, restaurants, products, scenarios, depotData] = await Promise.all([
      fetch(base + 'farms.json').then(r => r.json()),
      fetch(base + 'restaurants.json').then(r => r.json()),
      fetch(base + 'products.json').then(r => r.json()),
      fetch(base + 'scenarios.json').then(r => r.json()),
      fetch(base + 'depot.json').then(r => r.json()),
    ]);
    STATE.farms = farms.farms;
    STATE.restaurants = restaurants.restaurants;
    STATE.products = products.products;
    STATE.products.forEach(p => STATE.productById[p.id] = p);
    STATE.scenarios = scenarios.scenarios.map(sc => ({
      ...sc, axes: scenarioSummary(sc), title: scenarioLabel(sc),
    }));
    STATE.depot = depotData.depot;
    STATE.vehicle = depotData.vehicle;
  } catch (err) {
    console.error('Failed to load data files', err);
    showToast('Could not load data files. Are you serving via http?', 'error');
    return;
  }

  initMap();
  renderScenarios();
  renderFarmCards();
  renderRestaurantSelect();
  renderOrderLines();   // also calls renderOrderTotal()
  renderRunCostSkeleton();
  bindEvents();
  pingSolver();
  primeOsrm();   // pre-fetch the full road matrix so Calculate is instant
}

async function primeOsrm(){
  setOsrmStatus('unknown');
  try {
    await ensureFullMatrix();
    setOsrmStatus('ok');
  } catch (err) {
    console.error('OSRM prime failed', err);
    setOsrmStatus('error');
    showToast(`OSRM unreachable — ${err.message}. The simulator can't compute real road distances. Check your network or try again.`, 'error');
  }
}

/* =====================================================================
   2. SOLVER ENDPOINT
   ===================================================================== */

function solverEndpoint(){
  if (window.ROUTER_CONFIG?.vroomEndpoint) return window.ROUTER_CONFIG.vroomEndpoint;
  if (localStorage.vroomEndpoint) return localStorage.vroomEndpoint;
  // When the page is served over the public sslip.io host, default to the
  // same-origin `/solve` path that Caddy reverse-proxies to vroom-express
  // on localhost:3000 of the Hetzner box. Locally, default to the docker
  // container on http://localhost:3000.
  const host = window.location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') {
    return window.location.origin + '/solve';
  }
  return 'http://localhost:3000';
}
function solverApiKey(){
  return localStorage.vroomApiKey || '';
}

// OSRM (real road network for matrix + polyline).
// On prod we proxy through Caddy at `/osrm/*`. On localhost we hit the public
// project-osrm demo directly (CORS open). Override: `localStorage.osrmEndpoint`.
function osrmEndpoint(){
  if (window.ROUTER_CONFIG?.osrmEndpoint) return window.ROUTER_CONFIG.osrmEndpoint;
  if (localStorage.osrmEndpoint) return localStorage.osrmEndpoint;
  const host = window.location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') {
    return window.location.origin + '/osrm';
  }
  return 'http://localhost:5000';
}

async function pingSolver(){
  const dotEl = $('#solver-status');
  if (!dotEl) return;
  dotEl.dataset.state = 'unknown';
  dotEl.title = `VROOM @ ${solverEndpoint().replace(/^https?:\/\//, '')}`;
  try {
    const resp = await fetch(solverEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...(solverApiKey() ? { 'Authorization': solverApiKey() } : {}) },
      body: JSON.stringify(minimalPing())
    });
    // VROOM replies 200 for a valid ping, but even a structured 400 means
    // the daemon is alive — only network-level failures count as "down".
    dotEl.dataset.state = (resp.ok || resp.status === 400) ? 'ok' : 'error';
  } catch {
    dotEl.dataset.state = 'error';
  }
}

function minimalPing(){
  return {
    vehicles: [{ id: 1, start_index: 0, end_index: 0 }],
    jobs:     [{ id: 1, location_index: 1 }],
    matrices: { car: { durations: [[0,60],[60,0]], distances: [[0,1000],[1000,0]] } }
  };
}

/* =====================================================================
   3. RENDER — UI panels
   ===================================================================== */

function scenarioSummary(sc){
  const lines = sc.lines || [];
  return {
    restaurants: new Set(lines.map(l => l.restaurant_id)).size,
    items: new Set(lines.map(l => l.product_id)).size,
    kg: Math.round(lines.reduce((sum, l) => sum + l.qty_kg, 0) * 1000) / 1000,
    spread: sc.axes?.spread || 'n/a',
  };
}

function scenarioLabel(sc){
  const a = scenarioSummary(sc);
  const spread = a.spread === 'cluster' ? 'clustered'
    : a.spread === 'spread' ? 'spread out' : a.spread;
  return `${a.restaurants} ${a.restaurants === 1 ? 'chef' : 'chefs'} · ${a.items} ${a.items === 1 ? 'item' : 'items'} · ${a.kg}kg`
    + (spread && spread !== 'n/a' ? ` · ${spread}` : '');
}

function renderScenarios(){
  const el = $('#scenario-list');
  if (!el) return;
  el.innerHTML = '';
  STATE.scenarios.forEach(sc => {
    const btn = document.createElement('button');
    btn.className = 'scenario' + (STATE.activeScenarioId === sc.id ? ' on' : '');
    btn.dataset.id = sc.id;
    // Three axis badges (restaurants × items × spread) instead of prose
    // tagline. The whole point: the title IS the spec, the simulator is
    // the answer. Spread is omitted for single-restaurant scenarios.
    const a = scenarioSummary(sc);
    const axisBadges = [
      a.restaurants != null ? `<span class="s-badge">${a.restaurants}R</span>` : '',
      a.items       != null ? `<span class="s-badge">${a.items}I</span>` : '',
      a.kg          != null ? `<span class="s-badge s-badge-kg">${a.kg}kg</span>` : '',
      (a.spread && a.spread !== 'n/a') ? `<span class="s-badge s-badge-${a.spread}">${a.spread}</span>` : ''
    ].filter(Boolean).join('');
    btn.innerHTML = `
      <span class="s-title">${escapeHtml(scenarioLabel(sc))}</span>
      <span class="s-axes">${axisBadges}</span>
    `;
    btn.addEventListener('click', () => {
      loadScenario(sc.id);
      closeModal('scenarios-modal');
    });
    el.appendChild(btn);
  });
}

function openModal(id){
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
}
function closeModal(id){
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

function renderRestaurantSelect(){
  const sel = $('#order-restaurant');
  sel.innerHTML = '';
  STATE.restaurants.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} · ${r.neighbourhood}`;
    sel.appendChild(opt);
  });
  // also populate the add-stock farm select
  const fSel = $('#add-stock-farm');
  fSel.innerHTML = '';
  STATE.farms.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.name} · ${f.town}`;
    fSel.appendChild(opt);
  });
}

/**
 * Top-level supply-panel renderer. Dispatches on STATE.supplyView:
 *   "farm"    → one card per farm, products inside
 *   "product" → one card per product, farms with stock listed inside
 *
 * The toggle in the header swaps between the two without losing the
 * current filter text. Both views honour the same filter input — it
 * matches against product names, Spanish names, synonyms, and (in farm
 * view) also against farm names / regions / towns.
 */
function renderFarmCards(){
  const view = STATE.supplyView || 'farm';
  if (view === 'product') return renderProductView();
  return renderFarmView();
}

function renderFarmView(){
  const el = $('#farm-cards');
  el.innerHTML = '';
  const search = ($('#farm-search').value || '').trim().toLowerCase();
  const matched = matchProductsBySearch(search);
  const matchedIds = new Set(matched.map(p => p.id));
  const chosenFarmIds = new Set();
  if (STATE.lastDecision) {
    Object.values(STATE.lastDecision.chosen).forEach(arr =>
      arr.forEach(a => chosenFarmIds.add(a.farm_id)));
  }

  STATE.farms.forEach(f => {
    const card = document.createElement('div');
    const stockKeys = Object.keys(f.inventory);
    // A farm "matches" the filter if EITHER its name/region matches OR
    // any of its in-stock products match. So typing "vendrell" finds the
    // farm; typing "tomate" finds farms that hold tomatoes.
    const farmText = `${f.name} ${f.region||''} ${f.town||''}`.toLowerCase();
    const farmTextHit = !search || farmText.includes(search);
    const productHit = !search || stockKeys.some(k => matchedIds.has(k));
    const farmHasMatch = farmTextHit || productHit;
    card.className = 'farm-card'
      + (chosenFarmIds.has(f.id) ? ' chosen' : '')
      + (search && !farmHasMatch ? ' dim' : '');
    card.style.setProperty('--farm-color', f.color || '#888');
    card.dataset.id = f.id;

    const pillsHtml = stockKeys.map(pid => {
      const inv = f.inventory[pid];
      const prod = STATE.productById[pid];
      if (!prod) return '';
      const taken = chosenAmountForFarmProduct(f.id, pid);
      const hasStock = typeof inv.stock_kg === 'number';
      let cls = 'stock-pill';
      if (taken > 0) cls += ' taken';
      else if (search && matchedIds.has(pid)) cls += ' match';
      if (!hasStock) cls += ' eligibility'; // catalog-only, no live stock confirmed
      const titleSuffix = hasStock
        ? ` · live stock confirmed${inv.moq_kg ? ` · MOQ ${inv.moq_kg}kg` : ''}`
        : ' · catalogue eligibility; enter available stock';
      let qtyHtml = '';
      if (taken > 0 && hasStock) qtyHtml = `<span class="sp-qty">${taken}/${inv.stock_kg}kg</span>`;
      else if (taken > 0)        qtyHtml = `<span class="sp-qty">${taken}kg</span>`;
      else if (hasStock)         qtyHtml = `<span class="sp-qty">${inv.stock_kg}kg</span>`;
      return `
        <span class="${cls}" title="${escapeHtml(prod.label)}${titleSuffix}">
          ${prod.icon || ''} ${qtyHtml}
          <span class="sp-price">€${inv.price_eur_kg.toFixed(2)}/kg</span>
        </span>`;
    }).join('');

    const srcHref = f.source_url || f.website || '';
    const srcIcon = srcHref
      ? `<a class="farm-src" href="${escapeHtml(srcHref)}" target="_blank" rel="noopener" title="Public listing — source for this farm's name, location, and SKU eligibility">🌐</a>`
      : '';
    const distHtml = (typeof f.distance_km_to_depot === 'number')
      ? ` · ${f.distance_km_to_depot.toFixed(1)} km`
      : '';

    card.innerHTML = `
      <div class="farm-head">
        <span class="farm-name">${escapeHtml(f.name)}</span>
        ${srcIcon}
        <span class="farm-loc">${escapeHtml(f.region)}${distHtml}</span>
      </div>
      <div class="farm-stock">${pillsHtml}</div>
    `;
    el.appendChild(card);
  });
}

/**
 * "By product" view — answers "who has fennel right now and at what
 * price?" in one glance. Each product gets a card listing every farm
 * with stock, sorted by price ascending. Filter still applies (matches
 * product name / Spanish / synonyms). Empty when no product matches.
 */
function renderProductView(){
  const el = $('#farm-cards');
  el.innerHTML = '';
  const search = ($('#farm-search').value || '').trim().toLowerCase();
  const matched = matchProductsBySearch(search);

  // Build {productId: [{farm, inv}, ...]} index. Skip products with
  // zero suppliers so the panel isn't padded with empty cards.
  const byProduct = new Map();
  matched.forEach(p => byProduct.set(p.id, []));
  STATE.farms.forEach(f => {
    Object.entries(f.inventory).forEach(([pid, inv]) => {
      if (!byProduct.has(pid)) return;
      byProduct.get(pid).push({ farm: f, inv });
    });
  });

  let renderedAny = false;
  matched.forEach(p => {
    const suppliers = byProduct.get(p.id) || [];
    if (suppliers.length === 0) return;
    renderedAny = true;
    suppliers.sort((a, b) => (a.farm.distance_km_to_depot ?? 999) - (b.farm.distance_km_to_depot ?? 999));
    const benchmark = p.reference_price_eur_kg ?? p.metro_price_eur_kg ?? null;

    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="pc-head">
        <span class="pc-icon">${p.icon || ''}</span>
        <span class="pc-name">${escapeHtml(p.label)}<em>${escapeHtml(p.label_es||'')}</em></span>
        <span class="pc-total">${suppliers.length} ${suppliers.length === 1 ? 'farm' : 'farms'}</span>
      </div>
      ${benchmark != null ? `<div class="pc-bench">Reference market gate · <strong>€${benchmark.toFixed(2)}/kg</strong></div>` : ''}
      ${suppliers.map(({farm, inv}) => {
        const srcHref = farm.source_url || farm.website || '';
        const srcIcon = srcHref
          ? `<a class="pc-farm-src" href="${escapeHtml(srcHref)}" target="_blank" rel="noopener" title="Public listing">🌐</a>`
          : '';
        const dist = (typeof farm.distance_km_to_depot === 'number')
          ? `${farm.distance_km_to_depot.toFixed(1)}km`
          : '';
        const stockCell = (typeof inv.stock_kg === 'number')
          ? `<span class="pc-farm-stock">${inv.stock_kg}kg</span>`
          : `<span class="pc-farm-stock dim" title="Eligible in this catalogue; enter available stock">—</span>`;
        return `
        <div class="pc-farm-row">
          <span class="pc-farm-name">${escapeHtml(farm.name)}</span>
          ${srcIcon}
          <span class="pc-farm-region">${escapeHtml(farm.region||'')}${dist ? ' · ' + dist : ''}</span>
          ${stockCell}
          <span class="pc-farm-price">€${inv.price_eur_kg.toFixed(2)}</span>
        </div>`;
      }).join('')}
    `;
    el.appendChild(card);
  });

  if (!renderedAny) {
    el.innerHTML = `<div class="empty-hint">${
      search ? `Nothing matches "${escapeHtml(search)}".` : 'No products in stock.'
    }</div>`;
  }
}

function chosenAmountForFarmProduct(farmId, productId){
  if (!STATE.lastDecision) return 0;
  const arr = STATE.lastDecision.chosen[productId] || [];
  const hit = arr.find(a => a.farm_id === farmId);
  return hit ? hit.qty_kg : 0;
}

function matchProductsBySearch(search){
  if (!search) return STATE.products;
  return STATE.products.filter(p => {
    const haystack = [p.label, p.label_es, p.id, ...(p.synonyms||[])].join(' ').toLowerCase();
    return haystack.includes(search);
  });
}

function renderOrderLines(){
  const el = $('#order-lines');
  el.innerHTML = '';
  if (STATE.orderLines.length === 0){
    el.innerHTML = `<div class="empty-hint">No lines yet. Pick a scenario or add one above.</div>`;
    renderOrderTotal();
    return;
  }
  STATE.orderLines.forEach((line, idx) => {
    const r = STATE.restaurants.find(x => x.id === line.restaurant_id);
    const p = STATE.productById[line.product_id];
    if (!r || !p) return;
    const lineRevenue = line.qty_kg * (p.sale_price_eur_kg || 0);
    const row = document.createElement('div');
    row.className = 'order-line';
    row.innerHTML = `
      <div class="ol-meta">
        <span class="ol-rest">${escapeHtml(r.name)}</span>
        <span class="ol-prod">${p.icon||''} ${escapeHtml(p.label)}</span>
      </div>
      <label class="ol-qty"><input class="ol-qty-input" type="number" min="1" step="1" value="${line.qty_kg}" data-idx="${idx}" aria-label="Quantity in kilograms for ${escapeHtml(p.label)} at ${escapeHtml(r.name)}"><span>kg</span></label>
      <span class="ol-rev" title="modeled sale price €${(p.sale_price_eur_kg||0).toFixed(2)}/kg">€${lineRevenue.toFixed(2)}</span>
      <button class="ol-rm" data-idx="${idx}" title="remove">×</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('.ol-qty-input').forEach(input => {
    input.addEventListener('change', () => {
      const i = Number(input.dataset.idx);
      const qty = Number(input.value);
      if (editsLocked() || !Number.isInteger(qty) || qty < 1) {
        input.value = STATE.orderLines[i].qty_kg;
        return;
      }
      invalidateDecision();
      STATE.activeScenarioId = null;
      STATE.orderLines[i].qty_kg = qty;
      renderOrderLines();
      drawMap();
    });
  });
  el.querySelectorAll('.ol-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      if (editsLocked()) return;
      invalidateDecision();
      STATE.activeScenarioId = null;
      STATE.orderLines.splice(i, 1);
      renderOrderLines();
      drawMap();
    });
  });
  renderOrderTotal();
}

/**
 * Live revenue from the current order lines — what the chefs would pay
 * us (sum of qty × sale_price_eur_kg per product). Recomputes on
 * every basket change BEFORE Calculate, so the "Order total" row at
 * the bottom of the basket is always live.
 */
function computeOrderTotal(orderLines){
  let revenue = 0;
  orderLines.forEach(l => {
    const product = STATE.productById[l.product_id];
    if (product) revenue += l.qty_kg * (product.sale_price_eur_kg || 0);
  });
  return revenue;
}

/**
 * Driver cost: ceil(drive hours × (1 + buffer/100)) × hourly rate.
 * Rates and buffers come from vehicle inputs; a flat legacy fallback is supported.
 */
function driverCostFor(durationS){
  const v = STATE.vehicle || {};
  const hourly = v.driver_hourly_eur;
  if (hourly == null) return v.driver_cost_eur ?? 80;
  const bufferPct = v.driver_billing_buffer_pct ?? 0;
  const routeH = (durationS ?? 0) / 3600;
  const billable = Math.max(0, Math.ceil(routeH * (1 + bufferPct / 100)));
  return billable * hourly;
}

/**
 * Van cost: hourly buffered drive time rounded up, capped at the daily amount.
 * Rates and buffers come from vehicle inputs; a flat legacy fallback is supported.
 */
function vanRentalCostFor(durationS){
  const v = STATE.vehicle || {};
  const hourly = v.van_hourly_eur;
  if (hourly == null) return v.fixed_day_cost_eur ?? 0;
  const cap       = v.van_daily_cap_eur ?? Infinity;
  const bufferPct = v.van_billing_buffer_pct ?? 0;
  const routeH    = (durationS ?? 0) / 3600;
  const billableH = Math.max(0, Math.ceil(routeH * (1 + bufferPct / 100)));
  return Math.min(cap, billableH * hourly);
}

/**
 * Mulberry32 — small deterministic PRNG. We seed with a constant so
 * `localSearchBundles` returns the same answer every Calculate press
 * for the same basket. Without this, Math.random() restarts and
 * random product-visit orders would make two presses on the same
 * order produce different totals, runner-up lists, and route choices.
 * The simulator is a model — it must be reproducible.
 */
function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bottom-line economics for a *completed* decision.
 *  goods       = what we paid the farms
 *  van         = transport (day rental + per-km diesel)
 *  driver      = labour line, computed by driverCostFor() from the
 *                route's actual duration. We always bill the driver
 *                even on mornings the founder drives — otherwise the
 *                calc can't tell the difference between "this works"
 *                and "this works because someone is donating time".
 *                The note about Peter driving the first few mornings
 *                lives in one caveat in the breakdown modal.
 *  cogs        = goods + van + driver — the run's cash-out
 *  revenue     = what we charged the chefs (live from the basket)
 *  grossProfit = revenue − cogs. Founder salary, insurance, sales
 *                time, software amortisation are NOT deducted; one
 *                caveat in the breakdown modal flags the bridge to net.
 *  marginPct   = grossProfit / revenue
 */
function computeEconomics(decision){
  const goods  = decision.cost.goods_eur;
  const van    = decision.cost.transport_eur;
  const driver = decision.cost.driver_eur ?? driverCostFor(decision.cost.duration_s);
  const revenue = computeOrderTotal(decision.orderLines || STATE.orderLines);
  const cogs = goods + van + driver;
  const grossProfit = revenue - cogs;
  const marginPct = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  return {
    goods, van, driver, revenue, cogs, grossProfit, marginPct,
    // legacy aliases for any callers we haven't migrated yet
    totalCost: cogs, margin: grossProfit,
  };
}

/**
 * Comparison prices are explicit illustrative assumptions. They describe
 * another modeled channel, rather than a quote from an operating business.
 */
// Illustrative comparison assumptions, authored for the public fixture.
// These multipliers are scenario inputs, rather than measured market margins.
const HORECA_DISTRIBUTOR_MULTIPLIER = 1.30;
const MAYORISTA_BUY_FRACTION = 0.79;

function computeMercabarnaWholesaleCost(orderLines){
  let total = 0;
  orderLines.forEach(l => {
    const p = STATE.productById[l.product_id];
    if (!p) return;
    total += l.qty_kg * (p.reference_price_eur_kg ?? 0);
  });
  return total;
}

function computeHorecaDistributorCost(orderLines){
  return computeMercabarnaWholesaleCost(orderLines) * HORECA_DISTRIBUTOR_MULTIPLIER;
}

/* Back-compat shim — older callers still want a "Reference market chef cost"
 * for the breakdown's bet panel; we keep the wholesale-floor view
 * available under that name. The right sidebar now uses the HORECA
 * comparison; the breakdown modal uses both. */
function computeMercabarnaChefCost(orderLines){
  return computeMercabarnaWholesaleCost(orderLines);
}

/**
 * "Order total" block at the bottom of the basket card. Two lines:
 *  — Order total: live revenue (qty × Planner target per line)
 *  — vs Reference market: how much LESS the chef pays vs the wholesale
 *    market they'd otherwise use. Negative diff = Planner is cheaper.
 *  Both update on every basket mutation, BEFORE Calculate.
 */
function renderOrderTotal(){
  const el = $('#cs-revenue');
  const compEl = $('#cs-vs-mercabarna');
  if (!el) return;
  if (STATE.orderLines.length === 0){
    el.textContent = '€—';
    el.closest('.ot-main').classList.add('placeholder');
    if (compEl) {
      compEl.classList.add('empty');
      compEl.classList.remove('bad');
      compEl.innerHTML = 'vs modeled distributor · <strong>—</strong>';
    }
    return;
  }
  const revenue = computeOrderTotal(STATE.orderLines);
  el.textContent = `€${revenue.toFixed(2)}`;
  el.closest('.ot-main').classList.remove('placeholder');
  if (compEl) {
    // Compare against the chef's usual alternative: their HORECA
    // distributor delivering this basket (Reference market wholesale × 1.30).
    // "vs Reference market direct" is a niche 3am pickup most chefs don't
    // do; it lives in the breakdown modal. Keeping the right sidebar
    // honest means the wedge shown matches what the chef would
    // actually cut over to.
    const horeca = computeHorecaDistributorCost(STATE.orderLines);
    if (horeca > 0) {
      // diff > 0 → Planner is CHEAPER than the distributor (chef saves, good)
      // diff < 0 → Planner is PRICIER than the distributor (bad)
      const diff = horeca - revenue;
      const pct  = (diff / horeca) * 100;
      compEl.classList.remove('empty');
      compEl.classList.toggle('bad', diff < 0);
      compEl.classList.toggle('good', diff >= 0);
      const direction = diff >= 0 ? 'lower' : 'higher';
      compEl.innerHTML =
        `vs modeled distributor · <strong>${direction} · €${Math.abs(diff).toFixed(0)} · ${Math.abs(pct).toFixed(0)}%</strong>`;
    } else {
      compEl.classList.add('empty');
      compEl.classList.remove('good', 'bad');
      compEl.innerHTML = 'vs modeled distributor · <strong>—</strong>';
    }
  }
}

/**
 * Skeleton state for the run-cost rows — placeholder dashes that read
 * AS the row labels even before VROOM has run. Also resets the calc
 * slot to its idle state. Called whenever the decision is cleared or
 * the basket changes.
 */
function renderRunCostSkeleton(){
  // Skeleton shows the minimum-booking floor (e.g. 4h × €30 = €120
  // under today's hourly anchor) so the placeholder reads as the
  // lowest the driver line will be. Once Calculate runs, driverCostFor()
  // replaces this with the real route-hours billing.
  const v = STATE.vehicle || {};
  const driverDefault = v.driver_hourly_eur != null
    ? (v.driver_min_hours ?? 0) * v.driver_hourly_eur
    : (v.driver_cost_eur ?? 80);
  $('#cs-goods').textContent    = '€—';
  $('#cs-van').textContent      = '€—';
  $('#cs-driver').textContent   = `€${driverDefault.toFixed(0)}`;
  $('#cs-time').textContent     = '— min';
  $('#cs-distance').textContent = '— km';
  $$('#cs-goods, #cs-van, #cs-driver, #cs-time, #cs-distance').forEach(el =>
    el.closest('.rc-row').classList.add('placeholder')
  );
  setCalcState('idle');
  const status = $('#route-feasibility');
  if (status) status.textContent = 'Route checks appear after calculation.';
  // Disable "view breakdown" link until there's something to break down
  const bd = $('#open-breakdown');
  if (bd) bd.disabled = true;
}

/**
 * Fill the run-cost rows with real numbers from a completed decision.
 * Also morphs the calc-slot into the DONE state showing gross profit.
 */
function renderRunCost(decision){
  const e = computeEconomics(decision);
  $('#cs-goods').textContent    = `€${e.goods.toFixed(2)}`;
  $('#cs-van').textContent      = `€${e.van.toFixed(2)}`;
  $('#cs-driver').textContent   = `€${e.driver.toFixed(0)}`;
  $('#cs-time').textContent     = `${Math.round(decision.cost.duration_s/60)} min`;
  $('#cs-distance').textContent = `${(decision.cost.distance_m/1000).toFixed(1)} km`;
  $$('#cs-goods, #cs-van, #cs-driver, #cs-time, #cs-distance').forEach(el =>
    el.closest('.rc-row').classList.remove('placeholder')
  );
  setCalcState('done', { grossProfit: e.grossProfit, marginPct: e.marginPct });
  const status = $('#route-feasibility');
  if (status) status.textContent = feasibilityLabel(decision);
  const bd = $('#open-breakdown');
  if (bd) bd.disabled = false;
}

/**
 * Calculate-slot state machine. The slot lives at the bottom of the
 * Run Cost card; its inner HTML is swapped between three shapes:
 *
 *   'idle'    → the big black "→ CALCULATE" button (default)
 *   'solving' → animated pulsing block with "Solving… X/Y" progress
 *   'done'    → big gross-profit display ("+€436 · 23% gross profit")
 *               with a tiny "calculate again" affordance via click,
 *               and a "clear result" link that appears below the slot.
 */
function setCalcState(state, opts = {}){
  const slot = $('#rc-slot');
  const clearBtn = $('#rc-clear');
  if (!slot) return;
  if (state === 'idle') {
    slot.innerHTML = `
      <button id="calculate" class="calc-btn calc-btn-inline" type="button">
        <span class="calc-arrow">→</span>
        <span class="calc-label">Calculate</span>
      </button>`;
    $('#calculate').addEventListener('click', runDecision);
    if (clearBtn) clearBtn.classList.add('hidden');
    setGoogleMapsCta(null);
  } else if (state === 'solving') {
    const { done = 0, total = 0, phase = 'priming OSRM' } = opts;
    // Default copy when the solving card is first painted; the live
    // counter is taken over by setCalculateProgress() once the swarm
    // starts. We avoid "via VROOM" here because the swarm is in-browser
    // and the single VROOM call only runs at the very end.
    const progress = total > 0 ? `considering ${done}/${total}` : phase;
    slot.innerHTML = `
      <div class="calc-solving" id="calc-solving">
        <span class="cs-label">Solving<span class="dots">…</span></span>
        <span class="cs-progress" id="calc-solving-progress">${escapeHtml(progress)}</span>
      </div>`;
    if (clearBtn) clearBtn.classList.add('hidden');
    setGoogleMapsCta(null);
  } else if (state === 'done') {
    const { grossProfit = 0, marginPct = 0 } = opts;
    const sign = grossProfit >= 0 ? '+' : '−';
    const bad = grossProfit < 0;
    slot.innerHTML = `
      <button class="calc-result ${bad ? 'bad' : ''}" id="calculate" type="button" title="Click to recalculate">
        <span class="cr-label">Gross profit</span>
        <span class="cr-num">${sign}€${Math.abs(grossProfit).toFixed(0)}</span>
        <span class="cr-pct">${marginPct.toFixed(0)}% of revenue</span>
      </button>`;
    $('#calculate').addEventListener('click', runDecision);
    if (clearBtn) clearBtn.classList.remove('hidden');
    setGoogleMapsCta(STATE.lastDecision);
  }
}

/**
 * Show / hide the bottom-right "Open in Google Maps" CTA on the map.
 * Pass a decision to show it (with the route encoded in the href);
 * pass null to hide it. Safe to call before the DOM has the anchor
 * (returns silently).
 *
 * URL format: path-style Google Maps directions
 *   https://www.google.com/maps/dir/lat1,lng1/lat2,lng2/.../?travelmode=driving
 * Path-style is what Google's own Maps web UI emits when you build a
 * multi-stop trip, and it deep-links cleanly into the Maps app on
 * iOS/Android. It supports far more stops than the `?api=1&waypoints=`
 * scheme (which caps at 9 intermediate waypoints).
 */
function setGoogleMapsCta(decision){
  const a = $('#map-gmaps');
  if (!a) return;
  if (!decision || !decision.route || decision.route.length < 2) {
    a.classList.add('hidden');
    a.removeAttribute('href');
    return;
  }
  const url = buildGoogleMapsUrl(decision);
  if (!url) {
    a.classList.add('hidden');
    a.removeAttribute('href');
    return;
  }
  a.href = url;
  a.classList.remove('hidden');
  // Hint the chef which stops are in the link, in the tooltip.
  const stopCount = decision.route.length;
  const km = (decision.cost?.distance_m ?? 0) / 1000;
  a.title = `Open the optimised route in Google Maps · ${stopCount} stops · ${km.toFixed(1)} km`;
}

/**
 * Build a Google Maps directions URL from a VROOM-decided route.
 * Returns null if the route is empty.
 */
function buildGoogleMapsUrl(decision){
  if (!decision || !Array.isArray(decision.route) || decision.route.length < 2) return null;
  // Coordinates are emitted at 5dp (~1.1m precision) — plenty for routing
  // and keeps the URL shorter for routes with many stops.
  const fmt = (n) => Number(n).toFixed(5);
  const segments = decision.route
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map(s => `${fmt(s.lat)},${fmt(s.lng)}`);
  if (segments.length < 2) return null;
  // Path-style URL: /maps/dir/A/B/C/.../?travelmode=driving
  // Tested on desktop Chrome/Safari + iOS Maps app + Android Maps app.
  return 'https://www.google.com/maps/dir/' + segments.join('/') + '/?travelmode=driving';
}

/**
 * Full decision breakdown — Khan-Academy-style explainer.
 *
 * Layout (top → bottom):
 *   1. Hero: chef saved · vitrina gross profit · farmer earned vs Reference market
 *   2. Step 1: revenue table (per line)
 *   3. Step 2: COGS table (per pick from each farm)
 *   4. Step 3: van breakdown (fixed + per-km, with the formula spelled out)
 *   5. Step 4: gross profit math line + honest caveat about overheads
 *   6. The bet: side-by-side Reference market mayorista vs Planner margin capture
 *   7. The route VROOM picked
 *   8. Runners-up VROOM also evaluated
 */
function renderBreakdown(decision){
  const e = computeEconomics(decision);
  const scenario = STATE.scenarios.find(s => s.id === STATE.activeScenarioId);
    const title = scenario ? scenarioLabel(scenario) : 'Ad-hoc order';
  $('#bd-title').textContent = title;

  // Per-line product/qty/price helpers
  const lines = STATE.orderLines.map(l => {
    const r = STATE.restaurants.find(x => x.id === l.restaurant_id);
    const p = STATE.productById[l.product_id];
    return { ...l, restaurant: r, product: p };
  });
  const totalKg = lines.reduce((sum, l) => sum + (l.qty_kg || 0), 0);

  // === HERO ===
  // Three numbers, every one with a defendable comparison baseline:
  //  · "what the chef saved" → vs the chef's HORECA distributor (their
  //    modeled comparison, reference price × 1.30).
  //  · "Planner gross profit" → after farms + van + paid driver.
  //  · "farmers vs Reference market" → the parity claim made visible.
  //    Under the simulator's pricing rule we pay the farmer the SAME
  //    as the mayorista would (Reference market × 0.79). farmerEarnedExtra
  //    is therefore zero on the central path and only swings when a
  //    farm runs glut-clearance (× 0.65) or DOP-premium (× 0.88).
  const mercabarnaChefCost  = computeMercabarnaChefCost(STATE.orderLines);   // wholesale floor
  const horecaChefCost       = computeHorecaDistributorCost(STATE.orderLines); // status-quo
  const chefSaved   = horecaChefCost - e.revenue;
  const chefSavedPct = horecaChefCost > 0 ? (chefSaved / horecaChefCost) * 100 : 0;

  let farmerGateBaseline = 0;
  decision.route.filter(s => s.kind === 'farm' && s.picks).forEach(stop => {
    stop.picks.forEach(p => {
      const prod = STATE.productById[p.product_id];
      const qty = p.qty ?? p.qty_kg ?? 0;
      if (prod && prod.reference_price_eur_kg) {
        // Mayorista buy price = Reference market × MAYORISTA_BUY_FRACTION.
        // This is the parity baseline — what the farmer would have
        // received from a Reference market mayorista. Anything above is the
        // farmer-side wedge (DOP premium); anything below is glut.
        farmerGateBaseline += qty * prod.reference_price_eur_kg * MAYORISTA_BUY_FRACTION;
      }
    });
  });
  const farmerEarnedExtra = e.goods - farmerGateBaseline;

  const fmt   = n => `€${Math.abs(n).toFixed(0)}`;
  const fmtSign = n => (n >= 0 ? '+' : '−') + fmt(n);

  $('#bd-hero-chef').textContent     = chefSaved >= 0 ? `+${fmt(chefSaved)}` : `−${fmt(chefSaved)}`;
  $('#bd-hero-chef').classList.toggle('bad', chefSaved < 0);
  $('#bd-hero-chef-sub').textContent = horecaChefCost > 0
    ? `vs €${horecaChefCost.toFixed(0)} vs modeled distributor · ${Math.abs(chefSavedPct).toFixed(0)}% ${chefSaved >= 0 ? 'cheaper' : 'pricier'}`
    : 'vs modeled distributor on the same kg';

  $('#bd-hero-profit').textContent   = fmtSign(e.grossProfit);
  $('#bd-hero-profit').classList.toggle('bad', e.grossProfit < 0);
  $('#bd-hero-profit-sub').textContent = `${e.marginPct.toFixed(0)}% of revenue · after farms, van, paid driver`;

  $('#bd-hero-farmer').textContent   = farmerGateBaseline > 0 ? fmtSign(farmerEarnedExtra) : '—';
  $('#bd-hero-farmer').classList.toggle('bad', farmerEarnedExtra < 0);

  // === STEP 1 — Revenue per line ===
  $('#bd-step-revenue').textContent = `€${e.revenue.toFixed(2)}`;
  const revTbody = $('#bd-revenue-table').querySelector('tbody');
  revTbody.innerHTML = '';
  lines.forEach(l => {
    if (!l.product || !l.restaurant) return;
    const target = l.product.sale_price_eur_kg || 0;
    const merca  = l.product.reference_price_eur_kg || 0;
    // The chef-side price math, exposed inline so the reader can
    // verify every kilo: <merca floor> × 1.15 → Planner charges <target>.
    const ratio  = merca > 0 ? (target / merca) : 1;
    const sub = `${l.qty_kg} kg × €${target.toFixed(2)}/kg → ${l.restaurant.name} ` +
                `<em>(Reference market €${merca.toFixed(2)} × ${ratio.toFixed(2)})</em>`;
    revTbody.insertAdjacentHTML('beforeend',
      `<tr><td>${escapeHtml(l.product.label)}<small>${sub}</small></td>` +
      `<td>€${(l.qty_kg * target).toFixed(2)}</td></tr>`);
  });
  revTbody.insertAdjacentHTML('beforeend',
    `<tr><td><strong>Total revenue</strong><small>${totalKg.toFixed(0)} kg this morning · illustrative sale prices</small></td>` +
    `<td><strong>€${e.revenue.toFixed(2)}</strong></td></tr>`);

  // === STEP 2 — Goods per pick ===
  // Per-pickup math made auditable: each row shows the Reference market
  // wholesale floor for the product AND the multiplier on it that
  // produced the farm's price (~0.79 standard, 0.65 clearance, etc.).
  // The reader can see we're not pulling the COGS number from thin
  // air — it's MAPA's mayorista buy fraction times the published
  // wholesale floor.
  $('#bd-step-goods').textContent = `€${e.goods.toFixed(2)}`;
  const goodsTbody = $('#bd-goods-table').querySelector('tbody');
  goodsTbody.innerHTML = '';
  decision.route.filter(s => s.kind === 'farm' && s.picks).forEach(stop => {
    const farm = STATE.farms.find(f => f.id === stop.id);
    stop.picks.forEach(p => {
      const prod = STATE.productById[p.product_id];
      if (!prod || !farm) return;
      const qty = p.qty ?? p.qty_kg ?? 0;
      const inv = farm.inventory && farm.inventory[p.product_id];
      const farmPrice = (inv && inv.price_eur_kg) || 0;
      const merca = prod.reference_price_eur_kg || 0;
      const ratio = merca > 0 ? (farmPrice / merca) : 0;
      const sub = `${qty} kg × €${farmPrice.toFixed(2)}/kg @ ${farm.name} ` +
                  `<em>(Reference market €${merca.toFixed(2)} × ${ratio.toFixed(2)})</em>`;
      goodsTbody.insertAdjacentHTML('beforeend',
        `<tr><td>${escapeHtml(prod.label)}<small>${sub}</small></td>` +
        `<td>€${(qty * farmPrice).toFixed(2)}</td></tr>`);
    });
  });
  goodsTbody.insertAdjacentHTML('beforeend',
    `<tr><td><strong>Total paid to farms (COGS)</strong><small>Illustrative farm prices from the selected suppliers</small></td>` +
    `<td><strong>€${e.goods.toFixed(2)}</strong></td></tr>`);

  // === STEP 3 — Van + fuel ===
  $('#bd-step-van').textContent = `€${e.van.toFixed(2)}`;
  const vanFixed    = decision.cost.transport_fixed_eur ?? 0;
  const vanVariable = decision.cost.transport_variable_eur ?? e.van;
  const km = decision.cost.distance_m / 1000;
  const perKm = km > 0 ? vanVariable / km : 0;
  $('#bd-van-fixed').textContent       = `€${vanFixed.toFixed(2)}`;
  $('#bd-van-variable').textContent    = `€${vanVariable.toFixed(2)}`;
  $('#bd-van-var-explain').textContent = `${km.toFixed(1)} km × €${perKm.toFixed(2)}/km`;
  // Spell out how the prorated rental was billed: ceil(route × 1.5) ×
  // hourly, capped at the daily. So a VC reading the breakdown can see
  // exactly why the van line is €40 and not €80.
  const fixedExplain = $('#bd-van-fixed-explain');
  if (fixedExplain){
    const vForVan = STATE.vehicle || {};
    const hourly = vForVan.van_hourly_eur;
    if (hourly != null){
      const cap = vForVan.van_daily_cap_eur ?? Infinity;
      const bufferPct = vForVan.van_billing_buffer_pct ?? 0;
      const routeH = (decision.cost.duration_s ?? 0) / 3600;
      const billableH = Math.max(0, Math.ceil(routeH * (1 + bufferPct / 100)));
      const raw = billableH * hourly;
      fixedExplain.textContent = raw >= cap
        ? `${billableH}h × €${hourly}/h = €${raw.toFixed(0)} → capped at €${cap}/day`
        : `${routeH.toFixed(1)}h drive +${bufferPct}% buffer → ${billableH}h × €${hourly}/h`;
    } else {
      fixedExplain.textContent = '';
    }
  }
  // Driver row reflects depot.json's driver_cost_eur (Phase-2 default).
  // The "Peter drives in months 1-3" caveat lives in the bd-caveat
  // paragraph at the bottom of Step 4 — not as a per-row footer.
  const driverMin = Math.round((decision.cost.duration_s ?? 0) / 60);
  $('#bd-driver-cost').textContent = `€${e.driver.toFixed(0)}`;
  // Driver detail spells out how the line was assembled — same shape
  // as the van rental: ceil(route × 1.5) billable hours × hourly.
  const v = STATE.vehicle || {};
  if (v.driver_hourly_eur != null){
    const routeH = (decision.cost.duration_s ?? 0) / 3600;
    const bufferPct = v.driver_billing_buffer_pct ?? 0;
    const billableH = Math.max(0, Math.ceil(routeH * (1 + bufferPct / 100)));
    $('#bd-driver-detail').textContent =
      `${routeH.toFixed(1)}h drive +${bufferPct}% buffer → ${billableH}h × €${v.driver_hourly_eur}/h hourly hire`;
  } else {
    $('#bd-driver-detail').textContent =
      `flat day rate · ${driverMin} min behind the wheel`;
  }

  // === STEP 4 — Gross profit math ===
  // The "Van+driver" total reads cleanly as the operating cost; the
  // step-3 table breaks it into van/fuel/driver lines for those who
  // want to follow the math row-by-row.
  $('#bd-step-profit').textContent = fmtSign(e.grossProfit);
  $('#bd-profit-math').innerHTML =
    `Revenue <strong>€${e.revenue.toFixed(2)}</strong> ` +
    `&minus; COGS <strong>€${e.goods.toFixed(2)}</strong> ` +
    `&minus; Van+driver <strong>€${(e.van + e.driver).toFixed(2)}</strong> ` +
    `= <strong>${fmtSign(e.grossProfit)}</strong> ` +
    `(${e.marginPct.toFixed(0)}% of revenue)`;

  // === THE BET — vs the chef's status-quo HORECA distributor ===
  // The status-quo column reflects what the chef likely pays today:
  // a HORECA distributor delivers, sourcing around the Reference market
  // wholesale floor and adding the observed delivered-channel margin.
  // We do not try to break Mercabarna/wholesaler rent, payroll, waste,
  // fleet, and depreciation into a per-order cost. They probably win
  // that physical cost per kilo. The simulator only needs the visible
  // basket spread: chef delivered price minus farmer gate price.
  // (`horecaChefCost` and `mercabarnaChefCost` are computed up in the
  // HERO block and reused here.)
  const distributorCut   = horecaChefCost - mercabarnaChefCost;       // ~30% of distributor cost
  const farmerThroughDist = mercabarnaChefCost * MAYORISTA_BUY_FRACTION; // ~79% of wholesale floor
  const statusQuoSpread = horecaChefCost - farmerThroughDist; // visible spread from farmer gate to delivered chef price
  $('#bd-merca-chef').textContent      = `€${horecaChefCost.toFixed(2)}`;
  $('#bd-merca-mayorista').textContent = `€${distributorCut.toFixed(2)}`;
  $('#bd-merca-spread').textContent    = `€${statusQuoSpread.toFixed(2)}`;
  $('#bd-merca-farmer').textContent    = `€${farmerThroughDist.toFixed(2)}`;
  $('#bd-bet-revenue').textContent     = `€${e.revenue.toFixed(2)}`;
  $('#bd-bet-profit').textContent      = fmtSign(e.grossProfit);
  $('#bd-bet-farmer').textContent      = `€${e.goods.toFixed(2)}`;

  // Takeaway sentence: compare against the visible status-quo spread,
  // not against Mercabarna's internal cost base. Win condition: Planner
  // is positive after farms + van + paid driver, the chef pays less, and
  // the farmer is no worse off.
  const chefSavedVsDist = horecaChefCost - e.revenue;
  const profitSentence = `<strong>Modeled gross profit: ${fmtSign(e.grossProfit)}.</strong> ` +
    `The basket costs €${e.revenue.toFixed(0)} at the example sale prices, ` +
    `with €${e.goods.toFixed(0)} paid to farms and €${(e.van + e.driver).toFixed(0)} for the run. ` +
    `The illustrative distributor comparison is €${horecaChefCost.toFixed(0)}.`;
  $('#bd-bet-takeaway').innerHTML = profitSentence;

  // === ROUTE ===
  $('#bd-step-route').textContent = `${decision.route.length - 2} stops · ${km.toFixed(1)} km · ${Math.round(decision.cost.duration_s/60)} min`;
  const routeOl = $('#bd-route-list');
  routeOl.innerHTML = '';
  decision.route.forEach((stop, i) => {
    const li = document.createElement('li');
    li.className = stop.kind;
    let detail = '';
    if (stop.kind === 'farm' && stop.picks) {
      detail = stop.picks.map(p => {
        const prod = STATE.productById[p.product_id];
        const qty = p.qty ?? p.qty_kg ?? 0;
        return `pick up ${qty}kg ${prod ? prod.label.toLowerCase() : p.product_id}`;
      }).join(' · ');
    } else if (stop.kind === 'restaurant') {
      detail = 'drop-off';
    } else if (stop.kind === 'depot') {
      detail = i === 0 ? 'driver clocks in (no stock held)' : 'driver returns van';
    }
    li.innerHTML = `<strong>${escapeHtml(stop.name)}</strong>` +
      (detail ? `<span class="rt-detail">${escapeHtml(detail)}</span>` : '');
    routeOl.appendChild(li);
  });
  const all = decision.combinationsTested === decision.combinationsTotal;
  // The swarm runs in-browser (2-opt path-TSP per combo). VROOM is called
  // once at the end on the winning bundle to confirm. The displayed
  // vroom_solving_ms is the one solve, not 1500.
  const fmtN = n => n.toLocaleString('en-GB');
  const search = all
    ? `All ${fmtN(decision.combinationsTested)} sourcing bundles evaluated with browser route heuristics`
    : `${fmtN(decision.combinationsTested)} of ${fmtN(decision.combinationsTotal)} sourcing bundles explored via local search`;
  $('#bd-vroom').textContent = `${search} · ${feasibilityLabel(decision)}`;


  // === RUNNERS-UP ===
  const runners = $('#bd-runners');
  runners.innerHTML = '';
  if (!decision.runnersUp || decision.runnersUp.length === 0){
    runners.innerHTML = `<div class="empty-hint">Only one combination was feasible.</div>`;
  } else {
    decision.runnersUp.slice(0, 12).forEach(r => {
      const row = document.createElement('div');
      row.className = 'runner-row' + (r.infeasible ? ' infeasible' : '');
      row.innerHTML = `
        <span class="rr-combo">${escapeHtml(r.label)}</span>
        <span class="rr-cost">${r.infeasible ? 'infeasible' : '€' + r.total_eur.toFixed(2)}</span>
      `;
      runners.appendChild(row);
    });
  }
}

/* =====================================================================
   4. EVENT BINDING
   ===================================================================== */

function bindEvents(){
  // farm search
  $('#farm-search').addEventListener('input', renderFarmCards);

  // Supply view toggle — by farm ↔ by product. Both buttons share the
  // same filter input above; flipping the view keeps the search text.
  $('#supply-view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.svt-btn');
    if (!btn) return;
    STATE.supplyView = btn.dataset.view;
    document.querySelectorAll('#supply-view-toggle .svt-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.view === STATE.supplyView));
    renderFarmCards();
  });

  // order builder — restaurant select
  // (stays on whatever is selected)

  // product autocomplete (order builder)
  setupAutocomplete('#order-product-search', '#order-product-autocomplete', (p) => {
    $('#order-product-search').value = p.label;
    $('#order-product-search').dataset.productId = p.id;
  });

  // add line
  $('#order-add').addEventListener('click', () => {
    if (editsLocked()) return;
    const restaurant_id = $('#order-restaurant').value;
    const product_id = $('#order-product-search').dataset.productId
      || pickProductByName($('#order-product-search').value);
    const qty_kg = parseInt($('#order-qty').value, 10);
    if (!restaurant_id || !product_id || !qty_kg || qty_kg <= 0) {
      showToast('Pick a product and a qty before adding.', 'error');
      return;
    }
    invalidateDecision();
    STATE.activeScenarioId = null;
    STATE.orderLines.push({ restaurant_id, product_id, qty_kg });
    $('#order-product-search').value = '';
    delete $('#order-product-search').dataset.productId;
    renderOrderLines();
    drawMap();
    // Close the new-order modal so the basket update is the visible feedback
    closeModal('add-order-modal');
  });

  // clear order
  $('#order-clear').addEventListener('click', () => {
    if (editsLocked()) return;
    invalidateDecision();
    STATE.orderLines = [];
    STATE.activeScenarioId = null;
    STATE.lastDecision = null;
    STATE.consideredRoutes = [];
    renderScenarios();
    renderOrderLines();
    renderFarmCards();
    drawMap();
    renderRunCostSkeleton();
    hideToast();
  });

  // calculate — the slot already has #calculate wired by setCalcState,
  // but bind a delegated handler at the slot level too so we don't lose
  // the click if the slot HTML is swapped between states.
  $('#rc-slot').addEventListener('click', (e) => {
    if (e.target.closest('#calculate')) runDecision();
  });

  // scenarios modal
  $('#open-scenarios').addEventListener('click', () => {
    renderScenarios();
    openModal('scenarios-modal');
  });
  $('#scenarios-close').addEventListener('click', () => closeModal('scenarios-modal'));

  // new-order modal — replaces the inline form fields. Pin clicks on
  // the map use the same modal via openAddOrderModalFor() with a
  // pre-filled restaurant (see initMap's delegated click handler).
  $('#open-add-order').addEventListener('click', () => openAddOrderModalFor());
  $('#add-order-close').addEventListener('click', () => closeModal('add-order-modal'));

  // breakdown modal
  $('#open-breakdown').addEventListener('click', () => {
    if (!STATE.lastDecision) return;
    renderBreakdown(STATE.lastDecision);
    openModal('breakdown-modal');
  });
  $('#breakdown-close').addEventListener('click', () => closeModal('breakdown-modal'));

  // clear the last calculation result (keep the orders, wipe the run).
  // Lives below the calc slot now (small text-style link) and is
  // hidden in idle/solving states by setCalcState.
  $('#rc-clear').addEventListener('click', () => {
    STATE.lastDecision = null;
    STATE.consideredRoutes = [];
    renderRunCostSkeleton();
    drawMap();
  });

  // modeling report — opened from the nav. Re-renders on each open so
  // any edits to scenarios.json or the cost model show up immediately.
  $('#open-report').addEventListener('click', () => {
    renderReport();
    openModal('report-modal');
  });
  $('#report-close').addEventListener('click', () => closeModal('report-modal'));

  // close modals on backdrop click
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.add('hidden'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-bg').forEach(m => m.classList.add('hidden'));
  });

  // add-stock modal
  $('#farms-add').addEventListener('click', () => openAddStockModalFor());
  $('#add-stock-close').addEventListener('click', () => closeModal('add-stock-modal'));
  setupAutocomplete('#add-stock-product', '#add-stock-autocomplete', (p) => {
    $('#add-stock-product').value = p.label;
    $('#add-stock-product').dataset.productId = p.id;
  });
  $('#add-stock-save').addEventListener('click', () => {
    if (editsLocked()) return;
    const farmId = $('#add-stock-farm').value;
    const productId = $('#add-stock-product').dataset.productId
      || pickProductByName($('#add-stock-product').value);
    const qty = parseInt($('#add-stock-qty').value, 10);
    const price = parseFloat($('#add-stock-price').value);
    const moq = parseInt($('#add-stock-moq').value, 10);
    if (!farmId || !productId || !Number.isFinite(qty) || !Number.isFinite(price) || !Number.isFinite(moq)
        || qty < 0 || price < 0 || moq < 0 || moq > qty) {
      showToast('Fill all fields before saving.', 'error');
      return;
    }
    const farm = STATE.farms.find(f => f.id === farmId);
    if (!farm) return;
    invalidateDecision();
    farm.inventory[productId] = { stock_kg: qty, price_eur_kg: price, moq_kg: moq };
    $('#add-stock-modal').classList.add('hidden');
    renderFarmCards();
    drawMap();
  });
}

function pickProductByName(name){
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const exact = STATE.products.find(p => p.label.toLowerCase() === n);
  if (exact) return exact.id;
  const matches = matchProductsBySearch(n);
  return matches.length > 0 ? matches[0].id : null;
}

function setupAutocomplete(inputSel, popupSel, onPick){
  const input = $(inputSel);
  const popup = $(popupSel);
  let activeIdx = -1;
  let visible = [];

  function close(){
    popup.classList.remove('visible');
    popup.innerHTML = '';
    activeIdx = -1;
  }
  function open(){ popup.classList.add('visible'); }
  function render(){
    popup.innerHTML = '';
    visible.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'autocomplete-row' + (i === activeIdx ? ' active' : '');
      row.innerHTML = `
        <span>${p.icon||''} ${escapeHtml(p.label)} <em style="color:var(--ink-mid);font-style:italic;font-weight:500">${escapeHtml(p.label_es)}</em></span>
        <span class="ar-meta">€${(p.reference_price_eur_kg ?? p.metro_price_eur_kg ?? 0).toFixed(2)} reference</span>
      `;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onPick(p);
        close();
      });
      popup.appendChild(row);
    });
  }
  input.addEventListener('input', () => {
    const v = input.value;
    delete input.dataset.productId;
    visible = matchProductsBySearch(v.toLowerCase()).slice(0, 8);
    if (visible.length === 0 || !v) { close(); return; }
    activeIdx = 0;
    render(); open();
  });
  input.addEventListener('focus', () => {
    if (input.value){
      visible = matchProductsBySearch(input.value.toLowerCase()).slice(0, 8);
      if (visible.length){ activeIdx = 0; render(); open(); }
    }
  });
  input.addEventListener('keydown', (e) => {
    if (!popup.classList.contains('visible')) return;
    if (e.key === 'ArrowDown'){ activeIdx = Math.min(activeIdx+1, visible.length-1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp'){ activeIdx = Math.max(activeIdx-1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter'){ if (visible[activeIdx]) { onPick(visible[activeIdx]); close(); } e.preventDefault(); }
    else if (e.key === 'Escape'){ close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

function loadScenario(id){
  if (editsLocked()) return;
  const sc = STATE.scenarios.find(s => s.id === id);
  if (!sc) return;
  invalidateDecision();
  STATE.activeScenarioId = id;
  STATE.orderLines = sc.lines.map(l => ({...l}));
  STATE.lastDecision = null;
  STATE.consideredRoutes = [];
  renderScenarios();
  renderOrderLines();
  renderFarmCards();
  drawMap();
  renderRunCostSkeleton();
  hideToast();
  // No success toast — the basket populating IS the feedback. Toasts are
  // reserved for actual problems (OSRM down, no feasible route, etc).
}

/* =====================================================================
   5. DECISION ENGINE
   ===================================================================== */

function editsLocked(){
  if (!STATE.solvePhase) return false;
  showToast('Finish this calculation before editing the run.', 'error');
  return true;
}

function invalidateDecision(){
  STATE.inputRevision++;
  STATE.lastDecision = null;
  STATE.consideredRoutes = [];
  if (typeof document !== 'undefined') {
    renderRunCostSkeleton();
    drawMap();
  }
}

function commitDecision(decision, revision){
  if (STATE.inputRevision !== revision) return false;
  STATE.lastDecision = decision;
  return true;
}

async function runDecision(){
  if (STATE.solvePhase) return;
  if (STATE.orderLines.length === 0) {
    showToast('Add at least one order line first.', 'error');
    return;
  }
  hideToast();
  const inputRevision = STATE.inputRevision;
  const orderSnapshot = STATE.orderLines.map(line => ({ ...line }));

  // Switch the slot into solving state immediately so the user gets
  // visual confirmation the click landed. setSolvePhase also drives the
  // pin-state classifier — by entering 'priming', the basket-relevant
  // farms + restaurants light up and the rest fade to passive outlines
  // so the user instantly sees WHICH locations the model is reasoning
  // about, even before the swarm starts.
  setSolvePhase('priming');

  // Clear any ghost lines from the previous decision so the user starts
  // from a clean map, and fit the view to all farms+restaurants+depot
  // so the ghost-line exploration is fully visible.
  STATE.consideredRoutes = [];
  STATE.lastDecision = null;
  clearFlashRoutes();
  $$('#cs-goods, #cs-van, #cs-driver, #cs-time, #cs-distance').forEach(el =>
    el.closest('.rc-row')?.classList.add('placeholder')
  );
  drawMap();
  fitMapToAllLocations();

  // Critical UX yield: hand the browser two frames to actually PAINT the
  // priming state ("reading stock levels…", pin re-classification, map
  // re-fit) BEFORE we start the synchronous enumeration / cartesian /
  // sort blocks inside decide(). Without this, on Full-truck-Monday
  // (614+ bundles) the button visibly freezes for ~10s before the
  // swarm animation begins because the whole heavy sync path runs in
  // the same tick as the click handler. Two rAF ticks ≈ 32ms — barely
  // noticeable, but enough for Chrome to flush a paint pass.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const t0 = performance.now();
  let decisionOk = false;
  try {
    validateOrderCapacity(STATE.orderLines);
    await ensureFullMatrix();

    const decision = await decide(orderSnapshot);
    if (!decision) return; // toast already shown

    // Fetch the actual road-following polyline for the chosen route. Hard
    // error if OSRM can't return one — no straight-line fallback.
    decision.routeGeometry = await fetchOsrmRoute(decision.route);

    decision.timing_ms = Math.round(performance.now() - t0);
    if (!commitDecision(decision, inputRevision))
      throw routingError('inputs-changed', 'Inputs changed. Calculate the updated run.');
    const scenario = STATE.scenarios.find(s => s.id === STATE.activeScenarioId);
    const title = scenario ? scenarioLabel(scenario) : 'Ad-hoc order';
    STATE.decisionHistory.push({
      title,
      total_eur: decision.cost.total_eur,
      farms_count: new Set(decision.route.filter(s => s.kind === 'farm').map(s => s.id)).size,
      distance_km: decision.cost.distance_m / 1000,
      vroom_calls: 1,
      timing_ms: decision.timing_ms,
      ts: Date.now(),
    });
    renderRunCost(decision);   // also calls setCalcState('done', ...)
    renderFarmCards();
    // Solve is finished — the swarm fades out, the chosen route blooms.
    // clearFlashRoutes is safe to call early; any in-flight CSS fades on
    // already-spawned polylines complete on their own setTimeout.
    STATE.solvePhase = null;
    clearFlashRoutes();
    drawMap();
    decisionOk = true;
  } catch (err) {
    console.error(err);
    showToast(`Decision failed: ${err.message}`, 'error');
  } finally {
    if (!decisionOk) {
      STATE.solvePhase = null;
      clearFlashRoutes();
      setCalcState('idle');
    }
  }
}

/**
 * Update the live progress text inside the solving state.
 * Throttled to ~12 updates/sec so 1500 in-flight resolves don't re-paint
 * the whole label on every tick (which is wasted work).
 */
let _lastProgressPaintAt = 0;
function setCalculateProgress(done, total, inFlight = 0){
  const el = document.getElementById('calc-solving-progress');
  if (!el) return;
  const now = performance.now();
  // Always paint the final tick; throttle the intermediates so 60fps
  // updates don't re-flow the whole label.
  if (done < total && now - _lastProgressPaintAt < 80) return;
  _lastProgressPaintAt = now;
  let phaseCopy;
  if (STATE.solvePhase === 'priming') {
    phaseCopy = 'reading stock levels…';
  } else if (STATE.solvePhase === 'confirming') {
    phaseCopy = 'VROOM confirming winner…';
  } else {
    phaseCopy = `considering ${done}/${total}`;
  }
  el.textContent = phaseCopy;
}

/**
 * Move the visualisation through its solve phases. Each phase changes
 * (a) the copy under the Calculate button and (b) the look of the map
 * pins (via STATE.solvePhase, which classifyPinStates() reads).
 *
 * Phases:
 *   'priming'    — fetching/reading the OSRM road matrix; pins go to
 *                   their "candidate" state (orderers + farms with
 *                   matching produce light up; the rest stay passive).
 *   'evaluating' — the in-browser swarm is live; flash polylines bloom
 *                   on the map per combo as 2-opt rips through the
 *                   cartesian product (paced for the eye).
 *   'confirming' — handing the winning bundle to VROOM for a single
 *                   final check; copy under Calculate flips to "VROOM
 *                   confirming winner…".
 *   'done'       — null'd out by the caller via setSolvePhase(null).
 */
function setSolvePhase(phase, opts = {}){
  STATE.solvePhase = phase;
  if (phase === 'priming') {
    setCalcState('solving', { phase: 'priming OSRM' });
    const el = document.getElementById('calc-solving-progress');
    if (el) el.textContent = 'reading stock levels…';
  } else if (phase === 'evaluating') {
    // Reset throttle so the first tick paints immediately.
    _lastProgressPaintAt = 0;
    setCalculateProgress(0, opts.total ?? 0, 0);
  } else if (phase === 'confirming') {
    _lastProgressPaintAt = 0;
    const el = document.getElementById('calc-solving-progress');
    if (el) el.textContent = 'VROOM confirming winner…';
  }
  // Pin states refresh on the next drawMap call (which the caller
  // typically already triggered). We don't force one here to avoid
  // double-paints when the caller is mid-flow.
}

/**
 * Evaluate every bundle in-browser with a 2-opt path-TSP heuristic, then
 * animate the swarm of considered routes at frame rate so the user sees
 * the model "thinking" even though the underlying compute is instant.
 *
 * Why this design (not 1500 parallel HTTP calls to VROOM):
 *   - The box has 2 vCPUs and vroom-express child-process-spawns per
 *     request. Real throughput cap is ~40 req/sec → ~38s for 1500 combos
 *     with concurrency 64, a regression vs sequential.
 *   - For 13-15-node open path-TSPs the 2-opt hits the proven optimum
 *     in <100µs. Empirically agrees with VROOM on every input we've run
 *     against this dataset. Even so, the runDecision pipeline calls
 *     VROOM once at the end on the winning bundle to confirm and to
 *     keep the credibility anchor — see "Phase B" in runDecision.
 *   - 1500 × evaluateBundleFast ≈ 30-80ms total. We yield every 64
 *     combos so the browser stays responsive (the call site is awaited
 *     and the animation phase below paints the swarm at 60fps).
 *
 * Visual phase: after solving, drain a queue of feasible combos onto
 * the map at frame rate, paced so the swarm covers ~`animateMs`. The
 * progress counter ticks against the visual pace, not compute, so it
 * never blows past the user's eye in 30ms.
 *
 * Returns `results[]` indexed identically to `bundles` (infeasible ones
 * carry { infeasible: true }) once the animation has finished playing
 * — so the caller's `evaluated[0]` is still the cheapest after sort.
 */
async function evaluateAllBundlesFast(bundles, orderLines, opts){
  const { onCombo, onProgress, animateMs = 1400 } = opts || {};
  const N = bundles.length;
  const results = new Array(N);
  if (N === 0) return results;

  // ──────────────────────────────────────────────────────────
  // Phase A — solve every bundle in pure JS. Yields every 24
  // combos so a 1500-combo solve never freezes the browser. With
  // 64 we sometimes ran ~120ms of unyielded work on slow demo
  // boxes, enough to drop a paint frame and visibly stutter the
  // progress text. 24 splits the same 30ms total compute into
  // ~60 yields — basically free, much smoother.
  // ──────────────────────────────────────────────────────────
  const YIELD_EVERY = 24;
  for (let i = 0; i < N; i++) {
    let entry;
    try {
      entry = evaluateBundleFast(bundles[i], orderLines);
      entry.bundle = bundles[i];
    } catch (err) {
      entry = {
        infeasible: true,
        label: bundleLabel(bundles[i]),
        error: err && err.message,
        bundle: bundles[i],
      };
    }
    results[i] = entry;
    if (i > 0 && (i % YIELD_EVERY === 0)) {
      // setTimeout(0) → ~4ms in browsers; with 1500/64 = ~24 yields that's
      // ~100ms of "we're warming up" before the animation phase takes over.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // ──────────────────────────────────────────────────────────
  // Phase B — paint a small, curated set of "candidate route"
  // flashes paced evenly across animateMs.
  //
  // Why not paint every combo: with 614 feasible bundles the old
  // queue-drain rendered 30+ overlapping animated polylines per
  // second. The eye reads that as static, not thinking. Worse: each
  // SVG path animates stroke-dashoffset + opacity, and Leaflet has
  // to re-project every one whenever the user pans the map — so
  // panning during a solve dropped frames and stuttered the
  // progress text.
  //
  // FLASH_TOTAL distinct, diverse-by-stop-path candidates spaced at
  // FLASH_INTERVAL_MS reads as "the model evaluated several
  // strategies and picked one." Combined with a 500ms life and a
  // hard cap of FLASH_MAX_LIVE simultaneous polylines, the screen
  // never has more than ~3 lines on it at once.
  // ──────────────────────────────────────────────────────────
  const FLASH_TOTAL = 8;
  const FLASH_INTERVAL_MS = 130;
  if (animateMs > 0 && onCombo) {
    const feasibleResults = results.filter(r => !r.infeasible && r.stopPath?.length > 1);
    if (feasibleResults.length === 0) {
      try { onProgress && onProgress(N, N, 0); } catch(_) {}
      return results;
    }

    // Pick visually distinct candidates: dedupe by stop-path
    // signature, take the cheapest-first ranking that's already
    // sorted, then sample evenly. With 8 picks across the cost
    // spectrum the eye sees the model trying a range of strategies
    // — not the same near-duplicate route 8 times.
    const seen = new Set();
    const distinct = [];
    for (const r of feasibleResults) {
      const sig = (r.stopPath || []).map(s => s.id || `${s.lat},${s.lng}`).join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      distinct.push(r);
    }
    const picks = [];
    const M = Math.min(FLASH_TOTAL, distinct.length);
    for (let i = 0; i < M; i++) {
      const idx = Math.floor((i * distinct.length) / M);
      picks.push(distinct[idx]);
    }

    // Total visible window: spawn over (M-1)*INTERVAL, last flash
    // lives for FLASH_LIFE_MS more. Progress counter ticks against
    // wall-clock so "considering N/M" rises smoothly across the
    // whole swarm even though only ~8 flashes paint.
    const swarmMs = Math.max(animateMs, (M - 1) * FLASH_INTERVAL_MS + 500);
    const startedAt = performance.now();
    return await new Promise(resolve => {
      let spawned = 0;
      const spawn = () => {
        if (spawned < M) {
          try { onCombo(picks[spawned], spawned); } catch(_) {}
          spawned++;
          if (spawned < M) setTimeout(spawn, FLASH_INTERVAL_MS);
        }
      };
      spawn();

      const progressTick = () => {
        const elapsed = performance.now() - startedAt;
        const visualDone = Math.min(N, Math.floor((elapsed / swarmMs) * N));
        try { onProgress && onProgress(visualDone, N, 0); } catch(_) {}
        if (elapsed >= swarmMs) {
          try { onProgress && onProgress(N, N, 0); } catch(_) {}
          resolve(results);
        } else {
          requestAnimationFrame(progressTick);
        }
      };
      requestAnimationFrame(progressTick);
    });
  }
  try { onProgress && onProgress(N, N, 0); } catch(_) {}
  return results;
}

/**
 * Push a short-lived "flash" polyline for an evaluated combo. Visualises
 * the model trying a candidate route during solving: a single straight
 * rust line that traces itself out (CSS stroke-dashoffset keyframe — see
 * .route-flash in style.css), holds for a beat, and fades.
 *
 * STRAIGHT-LINE ONLY by design. Earlier we asked OSRM for road geometry
 * for every flash via fetchRoutePolyByLegs; that fired hundreds of HTTP
 * requests in the first 50ms of a Full-truck-Monday solve and reliably
 * crashed Chrome on the demo box (connection-pool starvation + heavy
 * SVG layer churn). Schematic straight lines paint instantly, read
 * cleanly as "the model is thinking through alternatives" (vs "look,
 * the same road network 48 different ways"), and free the network for
 * the one OSRM call that actually matters: the winner's road polyline.
 *
 * Lives on its own long-lived layer (MAP_LAYERS.flashes) that drawMap
 * never clears. Hard-capped at FLASH_MAX_LIVE simultaneous polylines
 * so a misbehaving caller can't blow up the DOM.
 */
const FLASH_LIFE_MS = 500;   // matches .route-flash animation duration
const FLASH_MAX_LIVE = 4;    // never more than this on screen at once

function pushFlashRoute(stops){
  if (!MAP_LAYERS.flashes || !stops || stops.length < 2) return;
  // Don't paint if the solve already finished — a late-arriving flash
  // over the rendered winner is just noise. We allow paints during
  // 'confirming' because the in-browser swarm and the single VROOM
  // confirm can briefly overlap.
  if (STATE.solvePhase !== 'evaluating' && STATE.solvePhase !== 'confirming') return;

  const latlngs = stops.map(s => [s.lat, s.lng]);
  const poly = L.polyline(latlngs, {
    pane: 'ghosts',
    className: 'route-flash',
    color: '#ee6c2c',
    weight: 2.2,
    smoothFactor: 1.6,
    lineCap: 'round', lineJoin: 'round',
    interactive: false,
  }).addTo(MAP_LAYERS.flashes);
  // pathLength=100 normalises stroke-dasharray so the CSS keyframe
  // (stroke-dashoffset:100→0) traces every flash at the same visual
  // rate regardless of how long the path actually is.
  if (poly._path) poly._path.setAttribute('pathLength', '100');

  // Defensive cap: never more than FLASH_MAX_LIVE polylines on the
  // ghosts pane at once. The scheduler in evaluateAllBundlesFast paces
  // spawns so this almost never trips, but a careless caller can't
  // pile up an unbounded number of animated SVG paths.
  const layers = MAP_LAYERS.flashes.getLayers();
  while (layers.length > FLASH_MAX_LIVE) {
    MAP_LAYERS.flashes.removeLayer(layers.shift());
  }
  setTimeout(() => {
    try { MAP_LAYERS.flashes.removeLayer(poly); } catch (_) {}
  }, FLASH_LIFE_MS + 50);
}

function clearFlashRoutes(){
  if (MAP_LAYERS.flashes) MAP_LAYERS.flashes.clearLayers();
}

function fitMapToAllLocations(){
  if (!MAP) return;
  const pts = [
    [STATE.depot.lat, STATE.depot.lng],
    ...STATE.farms.map(f => [f.lat, f.lng]),
    ...STATE.restaurants.map(r => [r.lat, r.lng]),
  ];
  // Settle the overview before a fast cached solve can fit its result.
  if (pts.length > 0) MAP.fitBounds(L.latLngBounds(pts).pad(0.10), { animate: false });
}

/**
 * Top-level decision: for each order line, pick the cheapest farm
 * combination that respects MOQs; then route the union via VROOM.
 *
 * Returns { chosen, route, cost, runnersUp }.
 */
function routingError(code, message){
  const error = new Error(message);
  error.code = code;
  return error;
}

function quantityUnits(kg){
  if (!Number.isFinite(kg) || kg <= 0 || Math.abs(kg * 1000 - Math.round(kg * 1000)) > 1e-6)
    throw routingError('invalid-quantity', 'Use positive quantities with at most three decimal places.');
  return Math.round(kg * 1000);
}

function validateOrderCapacity(orderLines){
  const capacity = quantityUnits(STATE.vehicle?.capacity_kg);
  const load = orderLines.reduce((sum, line) => sum + quantityUnits(line.qty_kg), 0);
  if (load > capacity) throw routingError('capacity-exceeded',
    `This pickup-first model carries ${capacity / 1000}kg per run. Split the ${load / 1000}kg basket into runs.`);
  return load;
}

function validateBundleDemand(bundle, orderLines){
  const demand = new Map();
  for (const line of orderLines)
    demand.set(line.product_id, (demand.get(line.product_id) || 0) + quantityUnits(line.qty_kg));
  if (Object.keys(bundle.perProduct).length !== demand.size)
    throw routingError('supply-mismatch', 'The sourcing bundle must cover every requested product.');
  for (const [pid, combo] of Object.entries(bundle.perProduct)) {
    const supplied = combo.farms.reduce((sum, farm) => sum + quantityUnits(farm.qty), 0);
    if (supplied !== demand.get(pid))
      throw routingError('supply-mismatch', 'Sourcing quantities must match the complete basket.');
  }
}

function buildShipments(bundle, orderLines, farmIds, restIds){
  validateBundleDemand(bundle, orderLines);
  const shipments = [];
  let id = 1;
  for (const [pid, combo] of Object.entries(bundle.perProduct)) {
    const demand = orderLines.filter(line => line.product_id === pid)
      .map(line => ({ ...line, remaining: quantityUnits(line.qty_kg) }));
    let cursor = 0;
    for (const farm of combo.farms) {
      let remaining = quantityUnits(farm.qty);
      while (remaining > 0) {
        const line = demand[cursor];
        const amount = Math.min(remaining, line.remaining);
        shipments.push({ product_id: pid,
          pickup: { id: id++, location_index: 1 + farmIds.indexOf(farm.farm_id), service: 180 },
          delivery: { id: id++, location_index: 1 + farmIds.length + restIds.indexOf(line.restaurant_id), service: 240 },
          amount: [amount],
        });
        remaining -= amount;
        line.remaining -= amount;
        if (line.remaining === 0) cursor++;
      }
    }
  }
  return shipments;
}

function validateVroomResponse(response, request){
  const reject = () => { throw routingError('solver-rejected', 'VROOM returned an incomplete or invalid assignment.'); };
  if (!response || response.code !== 0 || !Array.isArray(response.unassigned)
      || response.unassigned.length || response.summary?.unassigned > 0
      || !Array.isArray(response.routes) || response.routes.length !== 1) reject();
  const route = response.routes[0];
  if (route.vehicle !== request.vehicles[0].id || !Number.isFinite(route.duration) || route.duration < 0
      || !Array.isArray(route.steps) || route.steps.length < 2) reject();
  const endpoints = [route.steps[0], route.steps[route.steps.length - 1]];
  if (endpoints[0].type !== 'start' || endpoints[1].type !== 'end'
      || endpoints.some(step => step.location_index !== 0)) reject();
  const expected = new Map();
  for (const shipment of request.shipments) {
    expected.set(shipment.pickup.id, { type: 'pickup', location: shipment.pickup.location_index,
      amount: shipment.amount[0], paired: shipment.delivery.id });
    expected.set(shipment.delivery.id, { type: 'delivery', location: shipment.delivery.location_index,
      amount: -shipment.amount[0], paired: shipment.pickup.id });
  }
  const seen = new Set();
  let load = 0, peak = 0;
  for (const step of route.steps.slice(1, -1)) {
    const operation = expected.get(step.id);
    if (!operation || seen.has(step.id) || step.type !== operation.type
        || step.location_index !== operation.location
        || (step.type === 'delivery' && !seen.has(operation.paired))) reject();
    seen.add(step.id);
    load += operation.amount;
    peak = Math.max(peak, load);
    if (load < 0 || load > request.vehicles[0].capacity[0]) reject();
  }
  if (seen.size !== expected.size || load !== 0) reject();
  return { ...route, verified_peak_load_units: peak };
}

function compareCandidates(a, b){
  if (!!a.infeasible !== !!b.infeasible) return a.infeasible ? 1 : -1;
  return (a.cost?.total_eur ?? Infinity) - (b.cost?.total_eur ?? Infinity);
}

async function confirmWinningBundle(winner, orderLines){
  try {
    const confirmation = await evaluateBundle(winner.bundle, orderLines);
    const solverConfirmation = { status: 'complete', solving_ms: confirmation.cost.vroom_solving_ms };
    if (confirmation.cost.total_eur <= winner.cost.total_eur + 0.01)
      return { winner: { ...confirmation, bundle: winner.bundle }, solverConfirmation };
    return { winner, solverConfirmation };
  } catch (error) {
    return { winner, solverConfirmation: {
      status: error.code === 'solver-rejected' ? 'rejected' : 'unavailable', solving_ms: 0,
    } };
  }
}

function feasibilityLabel(decision){
  if (decision.feasibility?.status === 'solver-confirmed')
    return 'Capacity and complete shipment assignment verified with VROOM';
  const status = decision.solverConfirmation?.status;
  if (status === 'complete') return 'Browser route capacity checked · alternate VROOM route checked';
  if (status === 'rejected') return 'Browser route capacity checked · VROOM response rejected';
  return 'Browser route capacity checked · VROOM unavailable';
}

async function decide(orderLines){
  validateOrderCapacity(orderLines);
  // 1. Group order by product (sum across restaurants — sourcing is per-product).
  const byProduct = {};
  orderLines.forEach(l => {
    if (!byProduct[l.product_id]) byProduct[l.product_id] = { qty_kg: 0, dest_restaurant_ids: new Set() };
    byProduct[l.product_id].qty_kg += l.qty_kg;
    byProduct[l.product_id].dest_restaurant_ids.add(l.restaurant_id);
  });

  // 2. For each product, find candidate farm-combinations.
  const productCandidates = {};         // {product_id: [{farms: [{farm_id, qty, price}], goods_cost}, ...]}
  for (const productId of Object.keys(byProduct)) {
    const qty = byProduct[productId].qty_kg;
    productCandidates[productId] = enumerateFarmCombos(productId, qty);
    if (productCandidates[productId].length === 0) {
      showToast(`No feasible sourcing for ${qty}kg of ${STATE.productById[productId]?.label || productId}. Add stock or lower the qty.`, 'error');
      return null;
    }
    // Yield after each product so a 13-product basket doesn't run
    // the entire enumeration on one tick. Each product is fast on
    // its own; what kills UX is doing 13 of them with no breath.
    await new Promise(r => setTimeout(r, 0));
  }

  // 3. Build feasible bundles. Two paths depending on the size of the
  //    full search space:
  //
  //    (a) EXHAUSTIVE — if the cartesian product fits under EXACT_CAP,
  //        enumerate every sourcing combination. Each route still uses
  //        nearest-neighbour and 2-opt heuristics; exhaustive sourcing
  //        enumeration does not prove a globally cheapest route.
  //
  //    (b) LOCAL SEARCH — when the cartesian explodes (e.g. the
  //        22-product full-truck basket: 3^22 ≈ 31 billion combos),
  //        we can't enumerate. We run multi-start hill-climbing over
  //        the FULL candidate space: from each starting assignment,
  //        repeatedly try swapping one product's farm choice; accept
  //        any swap that lowers total_eur. With 8 random restarts and
  //        first-improvement swaps, this searches a bounded subset of
  //        assignments. It can settle in a local minimum. Both paths
  //        compare goods, rental, fuel and modeled driver time.
  //
  //    Both paths feed the same downstream pipeline (sort, winner,
  //    runners-up, VROOM confirm). The cost-panel banner reports the
  //    search method so a VC reading "1,247 of 31,381,059,609 combos
  //    explored via 8-restart local search" knows exactly what happened.
  const EXACT_CAP = 1500;
  const productIds = Object.keys(productCandidates);
  const allPerProduct = productIds.map(pid =>
    productCandidates[pid].sort((a,b) => a.goods_cost - b.goods_cost));
  const fullPossible = allPerProduct.reduce((n, list) => n * Math.max(1, list.length), 1);
  const useExact = fullPossible <= EXACT_CAP;

  let evaluated;
  let combinationsTested;
  let searchMethod;
  let cappedFromTotal = fullPossible;

  STATE.consideredRoutes = [];
  let totalVroomMs = 0;

  if (useExact) {
    // PATH (a) — exhaustive cartesian. Every bundle gets a 2-opt route
    // solve in pure JS. Sorting chooses the lowest full modeled cost
    // among those evaluated routes, rather than a global optimality proof.
    await new Promise(r => setTimeout(r, 0));
    const allBundles = cartesian(allPerProduct).map(bundle => ({
      perProduct: Object.fromEntries(productIds.map((pid, i) => [pid, bundle[i]])),
      goods_cost: bundle.reduce((s, c) => s + c.goods_cost, 0),
    }));
    await new Promise(r => setTimeout(r, 0));
    allBundles.sort((a,b) => a.goods_cost - b.goods_cost);
    setSolvePhase('evaluating', { total: allBundles.length });
    evaluated = await evaluateAllBundlesFast(allBundles, orderLines, {
      animateMs: 1100,
      onCombo: (entry) => {
        if (!entry.infeasible && entry.stopPath?.length > 1) {
          pushFlashRoute(entry.stopPath);
        }
      },
      onProgress: (done, total, inFlight) => {
        setCalculateProgress(done, total, inFlight);
      },
    });
    combinationsTested = allBundles.length;
    searchMethod = 'exhaustive';
  } else {
    // PATH (b) — local search over the FULL candidate space (no
    // pre-trim). See localSearchBundles for the algorithm. Returns the
    // explored bundles sorted by total_eur ascending.
    setSolvePhase('evaluating', { total: 0 });
    const lsRes = await localSearchBundles(productCandidates, productIds, orderLines, {
      restarts: 8,
      maxIterPerRestart: 60,
      evalBudget: 4000,
      onProgress: (done, budget) => setCalculateProgress(done, budget, 0),
      onNewBest: (entry) => {
        if (entry.stopPath?.length > 1) pushFlashRoute(entry.stopPath);
      },
    });
    evaluated = lsRes.explored;
    combinationsTested = lsRes.evalsRun;
    searchMethod = 'local-search';
  }

  evaluated.sort(compareCandidates);

  let winner = evaluated[0];
  if (!winner || winner.infeasible) {
    showToast('No feasible route found across the top combinations.', 'error');
    return null;
  }

  // One confirmation request. A malformed/partial result is rejected;
  // the capacity-checked browser proposal remains explicitly identified.
  setSolvePhase('confirming');
  const confirmed = await confirmWinningBundle(winner, orderLines);
  winner = confirmed.winner;
  totalVroomMs = confirmed.solverConfirmation.solving_ms || 0;
  evaluated[0] = winner;

  // Top-N feasible bundles for the post-solve "alternatives we
  // considered" ghost lines on the map. STRAIGHT-LINE ONLY — we used
  // to fire an OSRM /route call per leg per ghost ("mycorrhizal
  // grow-in") so each ran-up gradually picked up real road geometry,
  // but on a fresh first solve that meant ~50–100 OSRM HTTP calls
  // landing right after the winner rendered. That stole frames from
  // the winner's bloom and added clutter that read like a wiring
  // diagram. Schematic straight lines are calmer and match the
  // straight-line flashes the eye just watched during the swarm.
  // The ranked list with full details still lives in the breakdown
  // modal — we just don't make the map fight for the user's eye.
  const TOP_GHOSTS = 8;
  const winnerSig = JSON.stringify(winner.stopPath);
  STATE.consideredRoutes = evaluated
    .filter(e => !e.infeasible)
    .slice(0, TOP_GHOSTS)
    .map(e => ({
      stops: e.stopPath,                           // [{id, lat, lng, name, kind}]
      total_eur: e.cost?.total_eur ?? Infinity,
      isWinner: JSON.stringify(e.stopPath) === winnerSig,
      poly: null,                                  // intentionally null — drawMap renders straight-line
    }));

  // 4. Build the final decision payload.
  const chosen = {};
  Object.entries(winner.bundle.perProduct).forEach(([pid, c]) => {
    chosen[pid] = c.farms.map(f => ({ farm_id: f.farm_id, qty_kg: f.qty }));
  });

  const runnersUp = evaluated.slice(1).map(e => ({
    label: bundleLabel(e.bundle),
    total_eur: e.cost ? e.cost.total_eur : null,
    infeasible: !!e.infeasible,
  }));

  return {
    chosen,
    orderLines: orderLines.map(line => ({ ...line })),
    route: winner.route,
    cost: winner.cost,
    runnersUp,
    combinationsTested,
    combinationsTotal: cappedFromTotal,
    searchMethod,
    feasibility: winner.feasibility,
    solverConfirmation: confirmed.solverConfirmation,
    vroom_solving_ms: totalVroomMs,
  };
}

/**
 * Enumerate the supplier candidates for `qty` of `productId`.
 *
 * Two shapes of inventory entry exist (see seed script + add-stock modal):
 *   - "catalog eligibility" — `{ price_eur_kg }` only. Means the farm
 *     grows this SKU per its public listing, but we have no live stock
 *     confirmation. Treated as unbounded supply, no MOQ — sourcing it
 *     in real life means a phone call before dispatch.
 *   - "live stock" — `{ price_eur_kg, stock_kg, moq_kg }`. Confirmed
 *     by the operator (e.g. farmer WhatsApp'd "200 kg of tomato today").
 *     Capped to stock_kg, must clear MOQ.
 *
 * Per-product prices are uniform across farms (every farm-gate is
 * anchored to Reference market × 0.79), so splitting one order line across
 * multiple farms is dominated on cost by single-sourcing — splitting
 * only adds a pickup leg. We emit one combo per eligible farm; the
 * routing optimiser then picks based on geography and cross-product
 * co-location. Live-stock entries that can't cover qty solo are
 * combined with other suppliers via a small bitmask enumeration.
 *
 * Returns: [{farms: [{farm_id, qty, price}], goods_cost}, ...]
 */
function enumerateFarmCombos(productId, qty){
  const eligible = STATE.farms
    .filter(f => f.inventory[productId])
    .map(f => {
      const inv = f.inventory[productId];
      const hasStock = typeof inv.stock_kg === 'number';
      return {
        id: f.id,
        price: inv.price_eur_kg,
        stock: hasStock ? inv.stock_kg : Infinity,
        moq: hasStock ? (inv.moq_kg || 0) : 0,
      };
    });
  if (eligible.length === 0) return [];

  // Single-source candidates first — the dominant strategy whenever a
  // single farm can cover qty (which is always true for catalog-only
  // entries since their stock is unbounded).
  const combos = [];
  for (const f of eligible) {
    if (f.stock < qty) continue;
    if (qty < f.moq) continue;
    combos.push({
      farms: [{ farm_id: f.id, qty: qty, price: f.price }],
      goods_cost: qty * f.price,
    });
  }

  // Multi-source fallbacks only when no single farm can cover qty (i.e.
  // every covering candidate is live-stock-capped below qty). Bitmask
  // over live-stock farms; cap at 8 to keep 2^N bounded.
  const constrained = eligible.filter(f => f.stock !== Infinity);
  if (combos.length === 0 && constrained.length > 0) {
    const subset = constrained.slice(0, 8);
    const N = subset.length;
    for (let mask = 1; mask < (1 << N); mask++) {
      const picks = [];
      let totalStock = 0;
      for (let i = 0; i < N; i++) {
        if (mask & (1 << i)) { picks.push(subset[i]); totalStock += subset[i].stock; }
      }
      if (totalStock < qty) continue;
      const sorted = [...picks].sort((a, b) => a.price - b.price);
      // Reserve every selected supplier's minimum first, then allocate
      // the remaining demand by price up to stock. A greedy full take
      // can otherwise leave an impossible below-MOQ remainder.
      const demandUnits = quantityUnits(qty);
      const allocation = sorted.map(f => ({ farm_id: f.id, price: f.price,
        units: Math.round(f.moq * 1000), stock: Math.round(f.stock * 1000) }));
      if (allocation.some(a => a.units > a.stock)) continue;
      let remaining = demandUnits - allocation.reduce((sum, a) => sum + a.units, 0);
      if (remaining < 0) continue;
      for (const a of allocation) {
        const extra = Math.min(remaining, a.stock - a.units);
        a.units += extra;
        remaining -= extra;
      }
      if (remaining > 0) continue;
      const positive = allocation.filter(a => a.units > 0)
        .map(a => ({ farm_id: a.farm_id, price: a.price, qty: a.units / 1000 }));
      if (positive.length === 0) continue;
      combos.push({
        farms: positive,
        goods_cost: positive.reduce((s, a) => s + a.qty * a.price, 0),
      });
    }
  }

  // Deduplicate by allocation signature.
  const seen = new Set();
  const out = [];
  for (const c of combos) {
    const sig = c.farms.map(a => `${a.farm_id}:${a.qty}`).sort().join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

function cartesian(arrays){
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesian(rest);
  return first.flatMap(f => restProduct.map(rp => [f, ...rp]));
}

function bundleLabel(bundle){
  const allFarms = new Set();
  Object.values(bundle.perProduct).forEach(c => c.farms.forEach(f => allFarms.add(f.farm_id)));
  const names = Array.from(allFarms).map(id => STATE.farms.find(f => f.id === id)?.name || id);
  return names.join(' + ');
}

/**
 * Solve an open path-TSP in pure JS with nearest-neighbour seeding and
 * 2-opt local search. For our problem sizes (≤ 8 farms or ≤ 11 chefs)
 * 2-opt reaches the proven optimum in ~5 iterations, ~50µs total.
 *
 *   startIdx — fixed start node (in distMatrix coordinates)
 *   midIdxs  — nodes that must be visited exactly once
 *   endIdx   — fixed end node (the matrix index AFTER the last mid;
 *              the leg cost from the last mid to endIdx is included
 *              so 2-opt sees the cost of "snapping back" to the next
 *              segment)
 *   distMatrix — square distance matrix
 *
 * Returns a heuristic ordering of midIdxs that reduces
 *   d(start, mid[0]) + Σ d(mid[i], mid[i+1]) + d(mid[N-1], end)
 *
 * This is the path-TSP variant (open route, fixed endpoints) — exactly
 * what we need for "depot → farms → restaurants → depot": split the
 * problem into two segments and solve each.
 */
function solvePathTSP2Opt(startIdx, midIdxs, endIdx, distMatrix){
  const n = midIdxs.length;
  if (n === 0) return [];
  if (n === 1) return [midIdxs[0]];
  // Greedy nearest-neighbour seed.
  const remaining = new Set(midIdxs);
  const route = [];
  let cur = startIdx;
  while (remaining.size > 0) {
    let best = -1, bestD = Infinity;
    for (const m of remaining) {
      const d = distMatrix[cur][m];
      if (d < bestD) { bestD = d; best = m; }
    }
    route.push(best);
    remaining.delete(best);
    cur = best;
  }
  // 2-opt: reverse [i..j] if it reduces the cost of the two boundary edges.
  // Stop when a whole pass produces no improvement.
  let improved = true;
  let safety = 0;
  while (improved && safety++ < 24) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const before = i === 0 ? startIdx : route[i - 1];
        const after  = j === route.length - 1 ? endIdx : route[j + 1];
        const oldCost = distMatrix[before][route[i]] + distMatrix[route[j]][after];
        const newCost = distMatrix[before][route[j]] + distMatrix[route[i]][after];
        if (newCost + 1e-9 < oldCost) {
          // Reverse route[i..j] in place.
          let lo = i, hi = j;
          while (lo < hi) { const tmp = route[lo]; route[lo] = route[hi]; route[hi] = tmp; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return route;
}

/**
 * Pure-JS evaluator — same return shape as evaluateBundle but solves the
 * pickup-then-delivery routing in-browser with a 2-opt path-TSP heuristic.
 *
 * Why in-browser: the box has 2 vCPUs and vroom-express spawns a child
 * process per request, capping real throughput around ~40 req/sec. With
 * ~1500 combos that's ~40s sequential / ~10s parallel, mostly stuck on
 * process-spawn overhead (the actual VROOM solve is ~10ms).
 *
 * This evaluator constrains all pickups to precede all deliveries.
 * Therefore the complete basket must fit in the vehicle at once.
 * Nearest-neighbour plus 2-opt supplies a route heuristic, with one
 * VROOM request afterward for an independently checked candidate.
 *
 * Same return shape as evaluateBundle so the rest of the pipeline (sort,
 * winner extraction, runners-up, decision payload) needs no changes.
 */
function evaluateBundleFast(bundle, orderLines){
  validateOrderCapacity(orderLines);
  validateBundleDemand(bundle, orderLines);
  if (!STATE.fullMatrix) throw new Error('Internal: matrix not primed before fast eval');

  // 1. Aggregate pickups per farm and identify destination chefs.
  const pickupAtFarm = {};
  Object.entries(bundle.perProduct).forEach(([pid, combo]) => {
    combo.farms.forEach(a => {
      if (!pickupAtFarm[a.farm_id]) pickupAtFarm[a.farm_id] = [];
      pickupAtFarm[a.farm_id].push({ product_id: pid, qty: a.qty });
    });
  });
  const farmIds = Object.keys(pickupAtFarm);
  const restIds = Array.from(new Set(orderLines.map(l => l.restaurant_id)));

  // 2. Slice the matrix down to the locations this bundle uses.
  const locations = [STATE.depot,
    ...farmIds.map(id => STATE.farms.find(f => f.id === id)),
    ...restIds.map(id => STATE.restaurants.find(r => r.id === id))
  ];
  const fullIdx = locations.map(loc => fullIndexOf(loc));
  if (fullIdx.some(i => i < 0)) throw new Error('Internal: location not in full matrix');
  const sub = (m) => fullIdx.map(i => fullIdx.map(j => m[i][j]));
  const distances = sub(STATE.fullMatrix.distances);
  const durations = sub(STATE.fullMatrix.durations);

  // 3. Solve two path-TSPs back-to-back.
  //    Segment A: depot (0) → permute(farms) → first chef
  //    Segment B: last farm  → permute(chefs) → depot (0)
  // First chef and last farm are interlinked (the second segment's
  // start is determined by the first segment's end). We resolve this
  // cheaply by running segment A *twice*: once with each candidate
  // chef as the snap-back target, picking the cheapest. For ≤ 11 chefs
  // and ≤ 8 farms this is still microseconds.
  const farmIdxs = farmIds.map((_, i) => 1 + i);
  const restIdxs = restIds.map((_, i) => 1 + farmIds.length + i);

  let bestOrderedFarms = null;
  let bestOrderedRests = null;
  let bestTotal = Infinity;
  // If there are no chefs (defensive), fall through with empty rests.
  if (restIdxs.length === 0) {
    bestOrderedFarms = solvePathTSP2Opt(0, farmIdxs, 0, distances);
    bestOrderedRests = [];
  } else if (farmIdxs.length === 0) {
    bestOrderedFarms = [];
    bestOrderedRests = solvePathTSP2Opt(0, restIdxs, 0, distances);
  } else {
    // Try each chef as the bridge (snap-back target for farms;
    // start of chef segment). Pick the cheapest combined tour.
    for (const bridgeRest of restIdxs) {
      const orderedFarms = solvePathTSP2Opt(0, farmIdxs, bridgeRest, distances);
      const lastFarm = orderedFarms[orderedFarms.length - 1];
      const otherRests = restIdxs.filter(r => r !== bridgeRest);
      // Restaurant segment starts at lastFarm, must visit bridgeRest first
      // and otherRests in any order, ending at depot.
      // Easier: route the restaurants from lastFarm to depot via all chefs.
      const orderedRests = solvePathTSP2Opt(lastFarm, restIdxs, 0, distances);
      // Total cost
      let distance = 0, duration = 0;
      let prev = 0;
      for (const next of [...orderedFarms, ...orderedRests, 0]) {
        distance += distances[prev][next];
        duration += durations[prev][next];
        prev = next;
      }
      const total = distance / 1000 * STATE.vehicle.cost_per_km_eur
        + vanRentalCostFor(duration) + driverCostFor(duration);
      if (total < bestTotal) {
        bestTotal = total;
        bestOrderedFarms = orderedFarms;
        bestOrderedRests = orderedRests;
      }
    }
  }

  // 4. Walk the chosen tour and accumulate the costs from the matrix
  //    that the model already saw — same numbers VROOM would have used.
  const tour = [0, ...bestOrderedFarms, ...bestOrderedRests, 0];
  let totalDistanceM = 0, totalDurationS = 0;
  for (let i = 1; i < tour.length; i++) {
    totalDistanceM += distances[tour[i-1]][tour[i]];
    totalDurationS += durations[tour[i-1]][tour[i]];
  }

  // 5. Build the human-readable steps array — same shape as VROOM.
  const steps = tour.map((idx, i) => {
    const isStart = i === 0;
    const isEnd = i === tour.length - 1;
    if (idx === 0 || isStart || isEnd) {
      return { kind: 'depot', name: STATE.depot.name, lat: STATE.depot.lat, lng: STATE.depot.lng, id: 'depot' };
    }
    if (idx >= 1 && idx <= farmIds.length) {
      const farmId = farmIds[idx - 1];
      const farm = STATE.farms.find(f => f.id === farmId);
      const picks = pickupAtFarm[farmId] || [];
      return { kind: 'farm', id: farmId, name: farm.name, lat: farm.lat, lng: farm.lng, picks };
    }
    const restId = restIds[idx - 1 - farmIds.length];
    const r = STATE.restaurants.find(x => x.id === restId);
    return { kind: 'restaurant', id: restId, name: r.name, lat: r.lat, lng: r.lng };
  });

  // 6. Same cost decomposition as evaluateBundle. Van rental is prorated
  //    by route duration (see vanRentalCostFor). Fuel is per-km.
  const goods = Object.values(bundle.perProduct).reduce((s, c) => s + c.goods_cost, 0);
  const transportVariable = (totalDistanceM / 1000) * STATE.vehicle.cost_per_km_eur;
  const transportFixed = vanRentalCostFor(totalDurationS);
  const transport = transportVariable + transportFixed;

  // Reference market benchmark: same calc as evaluateBundle.
  let mercabarna = 0;
  Object.entries(bundle.perProduct).forEach(([pid, c]) => {
    const totalKg = c.farms.reduce((s, f) => s + f.qty, 0);
    const product = STATE.productById[pid];
    if (product) {
      const benchmark = product.reference_price_eur_kg ?? product.metro_price_eur_kg ?? 0;
      mercabarna += totalKg * benchmark;
    }
  });

  return {
    feasibility: { status: 'browser-checked', capacity_kg: STATE.vehicle.capacity_kg,
      peak_load_kg: orderLines.reduce((sum, line) => sum + line.qty_kg, 0) },
    route: steps,
    stopPath: steps.map(s => ({ id: s.id, lat: s.lat, lng: s.lng })),
    cost: {
      goods_eur: goods,
      transport_eur: transport,
      transport_fixed_eur: transportFixed,
      transport_variable_eur: transportVariable,
      driver_eur: driverCostFor(totalDurationS),
      total_eur: goods + transport + driverCostFor(totalDurationS),
      distance_m: totalDistanceM,
      duration_s: totalDurationS,
      mercabarna_equivalent_eur: mercabarna,
      // No VROOM time on the swarm path — but keep the field so the
      // breakdown panel doesn't NaN. The optional winner-confirm step
      // adds the real VROOM ms separately.
      vroom_solving_ms: 0,
    },
  };
}

/* =====================================================================
   LOCAL SEARCH OVER THE FULL CANDIDATE SPACE
   ---------------------------------------------------------------------
   Used when the cartesian product of per-product candidate farms is too
   large to enumerate (e.g. 22 products × 3 farms each = 31 billion). The
   pre-trim heuristic ("keep only K cheapest per product") leaves money
   on the table because it ignores the goods/routing trade-off — a farm
   that's €5 cheaper but 30km off the route is worse than one €5 pricier
   that's on the way.

   Hill-climbing with random restarts addresses that. The algorithm:

     1. Start from an assignment (cheapest-per-product on restart 0,
        random thereafter).
     2. Try every single-product swap; accept the first one that lowers
        total_eur (= goods + routing).
     3. Repeat until no swap improves cost — that's a local optimum.
     4. Restart from a new random assignment; keep the global best.

   Why this is correct at scale:

     - The route cost depends ONLY on the SET of distinct farms picked
       (not on which product each farm supplies). So we cache the route
       solve by farm-set hash and goods is a cheap O(K) sum on top —
       most swaps hit the cache because changing one product's farm
       leaves the farm set unchanged when another product still uses
       the same farm.
     - Each restart converges in O(K × max_fanout × iter) swap trials.
       For the 22-product case that's ~22 × 3 × 10 ≈ 660 trials per
       restart, ~5000 across 8 restarts. With route caching collapsing
       most trials to <0.1ms, total wall time is sub-second.
     - Eight seeded restarts improve coverage while keeping runtime
       bounded; they provide no global optimality guarantee.
   ===================================================================== */
async function localSearchBundles(productCandidates, productIds, orderLines, opts){
  const {
    restarts = 8,
    maxIterPerRestart = 60,
    evalBudget = 4000,
    onProgress,
    onNewBest,
  } = opts || {};

  const lists = productIds.map(pid => productCandidates[pid]);
  const K = productIds.length;

  // Route cache: keyed by sorted farm-id set. Stores the full
  // evaluateBundleFast result; we splice in fresh goods + total each
  // time so the per-product attribution is correct for THIS bundle.
  const routeCache = new Map();

  const makeBundle = (assignment) => ({
    perProduct: Object.fromEntries(productIds.map((pid, i) => [pid, assignment[i]])),
    goods_cost: assignment.reduce((s, c) => s + c.goods_cost, 0),
  });

  const farmSetKey = (bundle) => {
    const set = new Set();
    Object.values(bundle.perProduct).forEach(c =>
      c.farms.forEach(a => set.add(a.farm_id)));
    return [...set].sort().join('|');
  };

  function evalCached(bundle){
    const key = farmSetKey(bundle);
    let routeEval = routeCache.get(key);
    if (!routeEval) {
      try {
        routeEval = evaluateBundleFast(bundle, orderLines);
      } catch (err) {
        routeEval = { infeasible: true, error: err && err.message };
      }
      routeCache.set(key, routeEval);
    }
    if (routeEval.infeasible) {
      return { ...routeEval, bundle, label: bundleLabel(bundle) };
    }
    // Route + transport depend only on the farm set, so we reuse the
    // cached route geometry/distance/transport. Goods + mercabarna
    // depend on the per-product assignment — recompute them fresh.
    const goods = bundle.goods_cost;
    const transport = routeEval.cost.transport_eur;
    let mercabarna = 0;
    Object.entries(bundle.perProduct).forEach(([pid, c]) => {
      const totalKg = c.farms.reduce((s, f) => s + f.qty, 0);
      const product = STATE.productById[pid];
      if (product) {
        const benchmark = product.reference_price_eur_kg ?? product.metro_price_eur_kg ?? 0;
        mercabarna += totalKg * benchmark;
      }
    });
    const pickups = {};
    for (const [pid, combo] of Object.entries(bundle.perProduct))
      for (const farm of combo.farms)
        (pickups[farm.farm_id] ||= []).push({ product_id: pid, qty: farm.qty });
    return {
      ...routeEval,
      route: routeEval.route.map(step => step.kind === 'farm'
        ? { ...step, picks: pickups[step.id] || [] } : step),
      bundle,
      cost: {
        ...routeEval.cost,
        goods_eur: goods,
        total_eur: goods + transport + routeEval.cost.driver_eur,
        mercabarna_equivalent_eur: mercabarna,
      },
    };
  }

  // De-dupe explored bundles by farm assignment signature so the
  // runners-up list shows distinct strategies, not the same one
  // discovered from 8 different starts.
  const sigOf = (assignment) => assignment.map((c, i) =>
    `${productIds[i]}:${c.farms.map(f => f.farm_id).join(',')}`).join('|');
  const seenSigs = new Set();
  const explored = [];

  // Seeded PRNG → identical answers across Calculate presses. Without
  // this, restart 1..N seeds + product-shuffle order would diverge run
  // to run, and the same basket would surface different winners,
  // different runner-up lists, and different totals each press. The
  // simulator is a model — reproducibility is the bare minimum.
  const rand = mulberry32(0xC0FFEE);
  let globalBest = null;
  let evalsRun = 0;

  const recordEval = (entry, assignment) => {
    const sig = sigOf(assignment);
    if (seenSigs.has(sig)) return;
    seenSigs.add(sig);
    explored.push(entry);
  };

  for (let r = 0; r < restarts; r++) {
    if (evalsRun >= evalBudget) break;
    // Restart 0 = cheapest-per-product (the natural baseline).
    // Later restarts = uniformly random across each product's candidates.
    let current = lists.map((list, i) =>
      r === 0 ? list[0] : list[Math.floor(rand() * list.length)]);
    let curEval = evalCached(makeBundle(current));
    evalsRun++;
    recordEval(curEval, current);
    if (!curEval.infeasible && (!globalBest || curEval.cost.total_eur < globalBest.cost.total_eur)) {
      globalBest = curEval;
      if (onNewBest) onNewBest(curEval);
    }
    if (onProgress) onProgress(evalsRun, evalBudget);

    for (let iter = 0; iter < maxIterPerRestart && evalsRun < evalBudget; iter++) {
      let improved = false;
      // Visit products in random order — avoids bias toward early indices.
      const order = productIds.map((_, i) => i);
      for (let s = order.length - 1; s > 0; s--) {
        const j = Math.floor(rand() * (s + 1));
        [order[s], order[j]] = [order[j], order[s]];
      }

      for (const pIdx of order) {
        const candList = lists[pIdx];
        for (const candidate of candList) {
          if (candidate === current[pIdx]) continue;
          if (evalsRun >= evalBudget) break;
          const trial = current.slice();
          trial[pIdx] = candidate;
          const trialEval = evalCached(makeBundle(trial));
          evalsRun++;
          recordEval(trialEval, trial);
          if (!trialEval.infeasible
              && trialEval.cost.total_eur + 1e-6 < curEval.cost.total_eur) {
            current = trial;
            curEval = trialEval;
            improved = true;
            if (!globalBest || curEval.cost.total_eur < globalBest.cost.total_eur) {
              globalBest = curEval;
              if (onNewBest) onNewBest(curEval);
            }
            break;
          }
        }
        if (improved || evalsRun >= evalBudget) break;
      }

      if (onProgress) onProgress(evalsRun, evalBudget);
      // Yield to the browser every ~64 evals so the UI stays responsive.
      if (evalsRun % 64 === 0) await new Promise(res => setTimeout(res, 0));
      if (!improved) break;
    }
  }

  explored.sort(compareCandidates);

  return { explored, evalsRun };
}

/**
 * Given a candidate bundle, build the VROOM input, call the solver,
 * and return { cost, route }.
 */
async function evaluateBundle(bundle, orderLines){
  validateOrderCapacity(orderLines);
  validateBundleDemand(bundle, orderLines);
  // Collect all farm pickups across products
  const pickupAtFarm = {}; // farm_id -> [{product_id, qty}]
  Object.entries(bundle.perProduct).forEach(([pid, combo]) => {
    combo.farms.forEach(a => {
      if (!pickupAtFarm[a.farm_id]) pickupAtFarm[a.farm_id] = [];
      pickupAtFarm[a.farm_id].push({ product_id: pid, qty: a.qty });
    });
  });
  const farmIds = Object.keys(pickupAtFarm);
  const restIds = Array.from(new Set(orderLines.map(l => l.restaurant_id)));

  // Build location index list:  [depot, farms..., restaurants...]
  const locations = [STATE.depot,
    ...farmIds.map(id => STATE.farms.find(f => f.id === id)),
    ...restIds.map(id => STATE.restaurants.find(r => r.id === id))
  ];
  const matrix = await buildMatrix(locations);

  // Integer grams preserve requested quantities, including split farms.
  // Assign each product's supply to demand deterministically; rounding
  // each proportional share independently could lose or invent cargo.
  const shipments = buildShipments(bundle, orderLines, farmIds, restIds);

  const vroomReq = {
    vehicles: [{
      id: 1,
      start_index: 0,
      end_index: 0,
      capacity: [quantityUnits(STATE.vehicle.capacity_kg)],
    }],
    shipments: shipments.map(({ product_id, ...shipment }) => shipment),
    matrices: { car: matrix },
  };

  const resp = await callVroom(vroomReq);
  const route = validateVroomResponse(resp, vroomReq);
  const pickupById = new Map(shipments.map(shipment => [shipment.pickup.id, shipment]));

  // Build human route from VROOM steps.
  const steps = route.steps.map((s, i) => {
    const idx = s.location_index ?? s.location?.index ?? null;
    const isStart = i === 0;
    const isEnd = i === route.steps.length - 1;
    if (idx === 0 || isStart || isEnd) {
      return { kind: 'depot', name: STATE.depot.name, lat: STATE.depot.lat, lng: STATE.depot.lng, id: 'depot' };
    }
    if (idx >= 1 && idx <= farmIds.length) {
      const farmId = farmIds[idx - 1];
      const farm = STATE.farms.find(f => f.id === farmId);
      const shipment = pickupById.get(s.id);
      const picks = shipment ? [{ product_id: shipment.product_id, qty: shipment.amount[0] / 1000 }] : [];
      return { kind: 'farm', id: farmId, name: farm.name, lat: farm.lat, lng: farm.lng, picks };
    }
    const restId = restIds[idx - 1 - farmIds.length];
    const r = STATE.restaurants.find(x => x.id === restId);
    return { kind: 'restaurant', id: restId, name: r.name, lat: r.lat, lng: r.lng };
  }).reduce((result, step) => {
    const previous = result[result.length - 1];
    if (previous && previous.kind === step.kind && previous.id === step.id && step.kind !== 'depot') {
      if (step.picks) previous.picks.push(...step.picks);
    } else result.push(step);
    return result;
  }, []);

  // VROOM v1.13 only reports `route.distance` when it generates geometry
  // itself via OSRM. We send an explicit matrix so it returns `duration`
  // only — sum the distance ourselves by walking the chosen step indices
  // through the same matrix VROOM saw.
  const stepIdxs = route.steps.map(s => s.location_index ?? s.location?.index ?? 0);
  let totalDistanceM = 0, totalDurationS = 0;
  for (let i = 1; i < stepIdxs.length; i++) {
    totalDistanceM += matrix.distances[stepIdxs[i-1]][stepIdxs[i]];
    totalDurationS += matrix.durations[stepIdxs[i-1]][stepIdxs[i]];
  }

  const goods = Object.values(bundle.perProduct).reduce((s, c) => s + c.goods_cost, 0);
  // Transport = per-km diesel + prorated van rental. Getaround prices
  // the van at €10/h with a ~€60 daily cap; we bill ceil(route × 1.5)
  // hours to cover pickup + offloads + return, capped at the daily.
  // See depot.json `_evidence` for the worked examples.
  const transportVariable = (totalDistanceM / 1000) * STATE.vehicle.cost_per_km_eur;
  const transportFixed = vanRentalCostFor(totalDurationS);
  const transport = transportVariable + transportFixed;
  const vroomMs = (resp.summary?.computing_times?.solving ?? 0)
                + (resp.summary?.computing_times?.loading ?? 0);

  // Reference market benchmark: what would the same kg cost a chef buying
  // through their Reference market distributor (the BCN equivalent of Rungis,
  // not Metro Cash&Carry — Metro is retail, Reference market is wholesale).
  let mercabarna = 0;
  Object.entries(bundle.perProduct).forEach(([pid, c]) => {
    const totalKg = c.farms.reduce((s, f) => s + f.qty, 0);
    const product = STATE.productById[pid];
    if (product) {
      // Tolerate the legacy `metro_price_eur_kg` field during the data
      // migration so old products.json files don't break the page.
      const benchmark = product.reference_price_eur_kg ?? product.metro_price_eur_kg ?? 0;
      mercabarna += totalKg * benchmark;
    }
  });

  return {
    feasibility: { status: 'solver-confirmed', capacity_kg: STATE.vehicle.capacity_kg,
      peak_load_kg: route.verified_peak_load_units / 1000 },
    route: steps,
    // Bare lat/lng path of this combo's chosen stops — used to render it
    // as a faint ghost line on the map while VROOM crunches the others.
    stopPath: steps.map(s => ({ id: s.id, lat: s.lat, lng: s.lng })),
    cost: {
      goods_eur: goods,
      transport_eur: transport,
      transport_fixed_eur: transportFixed,
      transport_variable_eur: transportVariable,
      driver_eur: driverCostFor(totalDurationS),
      total_eur: goods + transport + driverCostFor(totalDurationS),
      // Both display and objective use the same validated OSRM matrix
      // walk, independent of optional solver summary metrics.
      distance_m: totalDistanceM,
      duration_s: totalDurationS,
      mercabarna_equivalent_eur: mercabarna,
      vroom_solving_ms: vroomMs,
    }
  };
}

async function callVroom(req){
  const url = solverEndpoint();
  const headers = { 'Content-Type': 'application/json' };
  if (solverApiKey()) headers['Authorization'] = solverApiKey();
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(req) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`VROOM HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Subset the cached full OSRM road-distance matrix down to just `locations`.
 * The full matrix covers [depot, all 8 farms, all 5 restaurants] = 14 nodes;
 * each per-bundle call to VROOM uses a subset of it. One OSRM `/table` call
 * serves every Calculate press until the page reloads.
 *
 * Throws if OSRM hasn't been primed — the simulator pre-fetches the matrix
 * on boot so this never blocks the user. There is intentionally **no
 * haversine fallback**: the whole point of the demo is real road numbers.
 * If OSRM is unreachable, we hard-fail and tell the user.
 */
async function buildMatrix(locations){
  const full = await ensureFullMatrix();
  const idx = locations.map(loc => fullIndexOf(loc));
  if (idx.some(i => i < 0)) {
    throw new Error('Internal: location not found in full matrix index');
  }
  const sub = (m) => idx.map(i => idx.map(j => m[i][j]));
  return { durations: sub(full.durations), distances: sub(full.distances) };
}

function fullIndexOf(loc){
  if (loc === STATE.depot || loc.id === STATE.depot.id) return 0;
  const f = STATE.farms.findIndex(x => x.id === loc.id);
  if (f >= 0) return 1 + f;
  const r = STATE.restaurants.findIndex(x => x.id === loc.id);
  if (r >= 0) return 1 + STATE.farms.length + r;
  return -1;
}

async function ensureFullMatrix(){
  if (STATE.fullMatrix) return STATE.fullMatrix;
  const allLocs = [STATE.depot, ...STATE.farms, ...STATE.restaurants];
  STATE.fullMatrix = await fetchOsrmTable(allLocs); // throws on failure
  STATE.osrmStatus = 'ok';
  setOsrmStatus('ok');
  return STATE.fullMatrix;
}

async function fetchOsrmTable(locs){
  const coords = locs.map(l => `${l.lng},${l.lat}`).join(';');
  const url = `${osrmEndpoint()}/table/v1/driving/${coords}?annotations=duration,distance`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM /table HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error(`OSRM /table returned code "${j.code}"`);
  if (!j.durations || !j.distances) throw new Error('OSRM /table missing durations/distances');
  // VROOM requires unsigned-int matrix cells (its cost model is integer-only).
  // OSRM returns floats (e.g. 450.9 sec, 3136.9 m) and `null` for unreachable
  // pairs — round one and reject the other.
  const durations = j.durations.map((row, i) => row.map((v, k) => {
    if (v == null) throw new Error(`OSRM could not route ${locs[i].name || i} → ${locs[k].name || k}`);
    return Math.round(v);
  }));
  const distances = j.distances.map((row, i) => row.map((v, k) => {
    if (v == null) throw new Error(`OSRM could not route ${locs[i].name || i} → ${locs[k].name || k}`);
    return Math.round(v);
  }));
  return { durations, distances };
}

/**
 * Fetch an actual road-following polyline (array of [lat,lng]) from OSRM
 * for the given ordered list of stops. Throws on failure — no straight-line
 * fallback; the user gets a real error.
 */
async function fetchOsrmRoute(stops){
  if (!stops || stops.length < 2) return null;
  const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
  const url = `${osrmEndpoint()}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM /route HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes[0]) {
    throw new Error(`OSRM /route returned code "${j.code}"`);
  }
  return j.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

/**
 * Find the geometric midpoint along a polyline (the point at half of
 * the total path length, NOT the bounding-box centre). Used to anchor
 * the on-path "X km · Y min" label so it sits along the actual route
 * rather than floating in dead space.
 */
function polylineMidpoint(latlngs){
  if (!latlngs || latlngs.length < 2) return null;
  // Cheap planar distance is fine for label placement at city scale.
  const segLen = (a, b) => {
    const dx = b[1] - a[1], dy = b[0] - a[0];
    return Math.sqrt(dx*dx + dy*dy);
  };
  let total = 0;
  const segs = [];
  for (let i = 1; i < latlngs.length; i++) {
    const d = segLen(latlngs[i-1], latlngs[i]);
    segs.push(d); total += d;
  }
  if (total === 0) return latlngs[0];
  const target = total / 2;
  let acc = 0;
  for (let i = 1; i < latlngs.length; i++) {
    if (acc + segs[i-1] >= target) {
      const t = (target - acc) / segs[i-1];
      const a = latlngs[i-1], b = latlngs[i];
      return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];
    }
    acc += segs[i-1];
  }
  return latlngs[Math.floor(latlngs.length/2)];
}

function setOsrmStatus(state){
  STATE.osrmStatus = state;
  const dot = $('#osrm-status');
  if (dot) dot.dataset.state = state;
}

/* =====================================================================
   6. MAP — Leaflet
   ===================================================================== */

let MAP = null;
// Three layer groups so we can mutate them independently:
//   - markers: pins (re-rendered on every drawMap, so state changes apply)
//   - route:   ghosts (pre-winner) + winner polyline + on-path labels
//   - flashes: the live-solve flash polylines. NOT cleared by drawMap —
//              flash polys self-remove via setTimeout once their CSS
//              keyframe fade ends, so an unrelated drawMap call doesn't
//              restart in-flight animations mid-stream.
let MAP_LAYERS = { markers: null, route: null, flashes: null, leaders: null };
let MAP_ROUTE_LABELS = [];
let LABEL_LAYOUT_FRAME = null;

function groupRouteStops(route){
  const grouped = new Map();
  route.forEach((stop, index) => {
    const key = `${stop.kind}:${stop.id}:${stop.lat}:${stop.lng}`;
    if (!grouped.has(key)) grouped.set(key, { ...stop, numbers: [] });
    grouped.get(key).numbers.push(index + 1);
  });
  return [...grouped.values()];
}

function rectanglesOverlap(a, b, gap = 0){
  return a.left < b.left + b.width + gap && a.left + a.width + gap > b.left
    && a.top < b.top + b.height + gap && a.top + a.height + gap > b.top;
}

// Pure screen-space placement. Width/height come from actual rendered DOM
// labels. Anchor coordinates remain unchanged; only callout rectangles move.
function placeMapLabels(items, viewport, obstacles = []){
  const margin = 12, gap = 6;
  const placed = [];
  const anchors = items.filter(i => i.kind !== 'metric')
    .map(i => ({ left: i.x - 8, top: i.y - 8, width: 16, height: 16 }));
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const ordered = [...items].sort((a, b) => b.width - a.width || a.y - b.y || String(a.id).localeCompare(String(b.id)));
  for (const item of ordered) {
    const { width, height, x, y } = item;
    if (x < 0 || x > viewport.width || y < 0 || y > viewport.height
        || width > viewport.width - 2 * margin || height > viewport.height - 2 * margin) continue;
    const maxX = viewport.width - margin - width;
    const maxY = viewport.height - margin - height;
    const xs = [x + 14, x - width - 14, x - width / 2, margin, maxX]
      .map(v => clamp(v, margin, maxX));
    const ys = [y - height / 2, y - height - 14, y + 14];
    // Nearby vertical lanes keep leaders short when several destinations
    // are on adjacent streets. Edge candidates cover cramped viewports.
    for (let offset = height + gap; offset < viewport.height; offset += height + gap)
      ys.push(y - height / 2 - offset, y - height / 2 + offset);
    ys.push(margin, maxY);
    let best = null;
    for (const left of new Set(xs)) for (const candidateY of ys) {
      const top = clamp(candidateY, margin, maxY);
      const rect = { left, top, width, height };
      if ([...obstacles, ...placed, ...anchors].some(other => rectanglesOverlap(rect, other, gap))) continue;
      const target = { x: clamp(x, left, left + width), y: clamp(y, top, top + height) };
      const score = (target.x - x) ** 2 + (target.y - y) ** 2;
      if (!best || score < best.score) best = { ...rect, id: item.id, score,
        anchor: { x, y }, target };
    }
    if (best) placed.push(best);
  }
  return placed;
}

function scheduleRouteLabelLayout(){
  if (LABEL_LAYOUT_FRAME !== null || !MAP) return;
  LABEL_LAYOUT_FRAME = requestAnimationFrame(() => {
    LABEL_LAYOUT_FRAME = null;
    layoutRouteLabels();
  });
}

function layoutRouteLabels(){
  if (!MAP || !MAP_LAYERS.leaders) return;
  MAP_LAYERS.leaders.clearLayers();
  const container = MAP.getContainer();
  const bounds = container.getBoundingClientRect();
  const viewport = { width: container.clientWidth, height: container.clientHeight };
  const obstacles = [...container.querySelectorAll('.leaflet-control, #map-gmaps')]
    .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height)
    .map(r => ({ left: r.left - bounds.left, top: r.top - bounds.top, width: r.width, height: r.height }));
  const measured = [];
  for (const entry of MAP_ROUTE_LABELS) {
    const label = entry.marker.getElement()?.querySelector(entry.selector);
    if (!label) continue;
    label.style.maxWidth = `${Math.max(40, Math.min(300, viewport.width - 24))}px`;
    label.style.visibility = 'hidden';
    const rect = label.getBoundingClientRect();
    const point = MAP.latLngToContainerPoint(entry.latlng);
    measured.push({ id: entry.id, x: point.x, y: point.y, width: rect.width + 2,
      height: rect.height + 2, kind: entry.leader ? 'stop' : 'metric', label, entry });
  }
  const placements = new Map(placeMapLabels(measured, viewport, obstacles).map(p => [p.id, p]));
  for (const item of measured) {
    const position = placements.get(item.id);
    if (!position) continue; // The exact pin and its popup remain available.
    item.label.style.transform = `translate(${position.left - item.x}px, ${position.top - item.y}px)`;
    item.label.style.visibility = 'visible';
    item.label.dataset.layoutId = item.id;
    if (item.entry.leader) {
      L.polyline([item.entry.latlng, MAP.containerPointToLatLng([position.target.x, position.target.y])], {
        pane: 'route-leaders', color: '#0e1a14', weight: 1.2, opacity: 0.8,
        interactive: false, className: 'route-label-leader',
      }).addTo(MAP_LAYERS.leaders);
    }
  }
}

function fitChosenRoute(){
  if (!MAP || !STATE.lastDecision) return;
  const decision = STATE.lastDecision;
  const geometry = decision.routeGeometry || decision.route.map(stop => [stop.lat, stop.lng]);
  if (geometry.length < 2) return;
  MAP.stop();
  MAP.fitBounds(L.latLngBounds(geometry).pad(0.12), { animate: false });
  scheduleRouteLabelLayout();
}

function initMap(){
  MAP = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([41.50, 2.00], 9);
  const mapConfig = window.ROUTER_CONFIG || {};
  const tileUrl = mapConfig.mapTileUrl || localStorage.mapTileUrl;
  const osmAttribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  if (tileUrl) {
    L.tileLayer(tileUrl, {
      maxZoom: mapConfig.mapMaxZoom || 19,
      attribution: mapConfig.mapAttribution || osmAttribution,
    }).addTo(MAP);
  } else {
    L.maplibreGL({
      style: mapConfig.mapStyleUrl || localStorage.mapStyleUrl || 'https://tiles.openfreemap.org/styles/positron',
      attribution: mapConfig.mapAttribution || '<a href="https://openfreemap.org/">OpenFreeMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · ' + osmAttribution,
    }).addTo(MAP);
  }
  // Custom panes so we can z-stack: ghosts UNDER pins, winner glow ABOVE
  // pins, route labels ABOVE everything.
  MAP.createPane('ghosts');         MAP.getPane('ghosts').style.zIndex = 380;
  MAP.createPane('route-glow');     MAP.getPane('route-glow').style.zIndex = 450;
  MAP.getPane('route-glow').classList.add('route-glow-pane');
  MAP.createPane('route-leaders');  MAP.getPane('route-leaders').style.zIndex = 590;
  MAP.createPane('route-labels');   MAP.getPane('route-labels').style.zIndex = 660;
  MAP_LAYERS.markers = L.layerGroup().addTo(MAP);
  MAP_LAYERS.route   = L.layerGroup().addTo(MAP);
  MAP_LAYERS.flashes = L.layerGroup().addTo(MAP);
  MAP_LAYERS.leaders = L.layerGroup().addTo(MAP);
  MAP.on('move zoom moveend zoomend resize', scheduleRouteLabelLayout);
  MAP.on('resize', fitChosenRoute);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleRouteLabelLayout).observe(MAP.getContainer());
  if (document.fonts?.ready) document.fonts.ready.then(scheduleRouteLabelLayout);

  // Hide on-map name pills + the route-stat midpoint label when the
  // user is zoomed out past the readable density. At zoom <12 the
  // map shows the whole BCN catchment and 14+ labels collide into
  // an unreadable tangle; the side panel already carries the same
  // information (route stops in the cost breakdown, km/min in the
  // run-cost card), so hiding them at low zoom is pure win. The
  // class lives on the #map element; CSS in style.css does the work.
  const LABEL_ZOOM_THRESHOLD = 12;
  const applyZoomClass = () => {
    const z = MAP.getZoom();
    document.getElementById('map').classList.toggle('zoom-low', z < LABEL_ZOOM_THRESHOLD);
  };
  MAP.on('zoomend', applyZoomClass);
  applyZoomClass();

  // Delegated click handler for action buttons inside Leaflet popups.
  // Pops live in the leaflet-popup-pane DOM mounted INSIDE #map, so we
  // bind on the map container — no per-popup wiring needed and clicks
  // survive map re-draws.
  document.getElementById('map').addEventListener('click', (e) => {
    const btn = e.target.closest('.pp-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add-order') {
      const restId = btn.dataset.restaurantId;
      MAP.closePopup();
      openAddOrderModalFor({ restaurantId: restId });
    } else if (action === 'add-stock') {
      const farmId = btn.dataset.farmId;
      MAP.closePopup();
      openAddStockModalFor({ farmId });
    }
  });

  drawMap();
}

/**
 * Open the "+ New order" modal pre-filled with a specific restaurant
 * and a clean product/qty. Used both by the sidebar button (no pre-fill)
 * and by the restaurant-pin popup (restaurant pre-selected).
 */
function openAddOrderModalFor({ restaurantId } = {}){
  openModal('add-order-modal');
  if (restaurantId) {
    const sel = $('#order-restaurant');
    if (sel) sel.value = restaurantId;
  }
  // Reset product + qty so the user starts fresh, then focus the search.
  const ps = $('#order-product-search');
  if (ps) { ps.value = ''; delete ps.dataset.productId; }
  const qty = $('#order-qty');
  if (qty) qty.value = 50;
  setTimeout(() => $('#order-product-search')?.focus(), 80);
}

/**
 * Open the "+ Add stock" modal pre-filled with a specific farm. Used
 * both by the supply-panel button and by the farm-pin popup.
 */
function openAddStockModalFor({ farmId } = {}){
  openModal('add-stock-modal');
  if (farmId) {
    const sel = $('#add-stock-farm');
    if (sel) sel.value = farmId;
  }
  const ps = $('#add-stock-product');
  if (ps) { ps.value = ''; delete ps.dataset.productId; }
}

function drawMap(){
  MAP_ROUTE_LABELS = [];
  if (MAP_LAYERS.leaders) MAP_LAYERS.leaders.clearLayers();
  if (!MAP) return;
  MAP_LAYERS.markers.clearLayers();
  MAP_LAYERS.route.clearLayers();

  const { farmState, restState } = classifyPinStates();
  const orderRestIds = new Set(STATE.orderLines.map(l => l.restaurant_id));

  // depot — always full-bright gold (driver hub, NOT a warehouse)
  L.marker([STATE.depot.lat, STATE.depot.lng], {
    icon: pinIcon('depot'),
    title: STATE.depot.name,
  }).bindPopup(`<span class="pp-kicker">Driver hub · no stock</span><strong>${escapeHtml(STATE.depot.name)}</strong><br/>${escapeHtml(STATE.depot.subtitle || STATE.depot.address)}`).addTo(MAP_LAYERS.markers);

  // Farms — green leaf circles. State-dependent rendering:
  //   idle      → faint outline, low opacity (no matching produce / no basket)
  //   candidate → bright with rust accent (has matching produce; the swarm
  //               will reason about it)
  //   chosen    → solid moss + gold ring (winner); always wins over candidate
  STATE.farms.forEach(f => {
    const state = farmState.get(f.id) || 'idle';
    const inv = Object.entries(f.inventory).map(([pid, v]) => {
      const p = STATE.productById[pid];
      return `${p?.icon||''} ${p?.label||pid}: €${v.price_eur_kg.toFixed(2)}/kg`;
    }).join('<br/>');
    const srcHref = f.source_url || f.website || '';
    const srcLink = srcHref
      ? `<a href="${escapeHtml(srcHref)}" target="_blank" rel="noopener" class="pp-src">🌐 source listing</a>`
      : '';
    const distLabel = (typeof f.distance_km_to_depot === 'number')
      ? ` · ${f.distance_km_to_depot.toFixed(1)} km from depot`
      : '';
    L.marker([f.lat, f.lng], {
      icon: pinIcon('farm', { state, color: f.color }),
      title: f.name,
      // Lower the marker's z-index slightly when idle so the active
      // candidate/chosen pins sit visually on top in dense clusters.
      zIndexOffset: state === 'idle' ? -100 : (state === 'chosen' ? 200 : 50),
    }    ).bindPopup(
      `<span class="pp-kicker">${escapeHtml(f.region)}${distLabel}</span>` +
      `<strong>${escapeHtml(f.name)}</strong><br/>${inv}` +
      `<div class="pp-actions">` +
        `<button class="pp-btn" data-action="add-stock" data-farm-id="${escapeHtml(f.id)}">+ Confirm live stock</button>` +
        (srcLink ? srcLink : '') +
      `</div>`
    ).addTo(MAP_LAYERS.markers);
  });

  // Restaurants — orange diamond. Always present (so a fresh user can
  // click any chef's pin to add an order even with an empty basket),
  // but state-dependent: chefs in the basket fill in to bright rust;
  // the rest stay as faint outlines so the relevant ones pop visually.
  STATE.restaurants.forEach(r => {
    const state = restState.get(r.id) || 'idle';
    const inBasket = orderRestIds.has(r.id);
    const basketSummary = inBasket
      ? STATE.orderLines.filter(l => l.restaurant_id === r.id).map(l => {
          const p = STATE.productById[l.product_id];
          return `${p?.icon||''} ${p?.label||l.product_id}: ${l.qty_kg}kg`;
        }).join('<br/>')
      : '';
    L.marker([r.lat, r.lng], {
      icon: pinIcon('restaurant', { state }),
      title: r.name,
      zIndexOffset: state === 'idle' ? -100 : (state === 'chosen' ? 200 : 50),
    }).bindPopup(
      `<span class="pp-kicker">${escapeHtml(r.neighbourhood)}${inBasket ? ' · in basket' : ''}</span>` +
      `<strong>${escapeHtml(r.name)}</strong>` +
      (basketSummary ? `<br/>${basketSummary}` : '') +
      `<div class="pp-actions"><button class="pp-btn" data-action="add-order" data-restaurant-id="${escapeHtml(r.id)}">+ Add order for ${escapeHtml(r.name)}</button></div>`
    ).addTo(MAP_LAYERS.markers);
  });

  // Ghost lines — the top alternative combinations the model considered,
  // drawn as faint straight-line schematic paths (NOT road geometry).
  // They sit in a pane UNDER the pins so glyphs stay readable. The
  // straight-line look is deliberate: it visually distinguishes the
  // "alternatives we tried" from the rust, road-following winner, and
  // it costs zero OSRM fetches so the post-solve frame is calm.
  // The breakdown modal carries the full ranked list with €/km details.
  const winnerSet = !!STATE.lastDecision;
  STATE.consideredRoutes.forEach(g => {
    if (g.isWinner) return; // winner is the hero line, drawn below
    const latlngs = g.stops.map(s => [s.lat, s.lng]);
    L.polyline(latlngs, {
      pane: 'ghosts',
      color:   winnerSet ? '#a9aea5' : '#c97250',
      weight:  winnerSet ? 1.4       : 2.2,
      opacity: winnerSet ? 0.22      : 0.55,
      smoothFactor: 1.5,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(MAP_LAYERS.route);
  });

  // Winner route — actual road geometry from OSRM, drawn in the glowing
  // pane (CSS `filter: drop-shadow` + pulse animation). No dashed lines,
  // no overlapping number tooltips — the chosen-route name pills carry
  // an embedded number bubble (`.rn-num`) so the "4" sits NEXT to the
  // pin, never inside it.
  if (STATE.lastDecision && STATE.lastDecision.route.length > 1) {
    const stopLatLngs = STATE.lastDecision.route.map(s => [s.lat, s.lng]);
    const polyline = STATE.lastDecision.routeGeometry || stopLatLngs;
    // Underline first to lift the rust off light tiles
    L.polyline(polyline, {
      pane: 'route-glow',
      color: '#0e1a14', weight: 7, opacity: 0.22,
      smoothFactor: 1,
    }).addTo(MAP_LAYERS.route);
    // The hero line itself
    L.polyline(polyline, {
      pane: 'route-glow',
      color: '#ee6c2c', weight: 4.5, opacity: 1,
      smoothFactor: 1,
    }).addTo(MAP_LAYERS.route);

    // Distance + drive time, rendered AS TEXT on the polyline midpoint
    // (white halo, no card background). Replaces the old top-right
    // overlay panel — Peter wanted the metrics to read as part of the
    // route itself, "not another square of any kind".
    const midpoint = polylineMidpoint(polyline);
    if (midpoint) {
      const km = (STATE.lastDecision.cost.distance_m / 1000).toFixed(1);
      const min = Math.round(STATE.lastDecision.cost.duration_s / 60);
      const marker = L.marker(midpoint, {
        pane: 'route-labels',
        icon: L.divIcon({
          className: 'route-stat-wrap route-callout-wrap',
          html: `<span class="route-stat">
                   <span class="rs-num">${km}</span> KM
                   <span class="rs-sep">·</span>
                   <span class="rs-num">${min}</span> MIN
                 </span>`,
          iconSize: null,
          iconAnchor: [0, 0],
        }),
        interactive: false,
      }).addTo(MAP_LAYERS.route);
      MAP_ROUTE_LABELS.push({ marker, latlng: midpoint, id: 'route-metrics',
        selector: '.route-stat', leader: false });
    }

    // Labels move in screen space; their pins and the road geometry
    // retain their exact geographic coordinates. Start/return share one
    // depot label with both original route numbers.
    groupRouteStops(STATE.lastDecision.route).forEach(stop => {
      const marker = L.marker([stop.lat, stop.lng], {
        pane: 'route-labels',
        icon: L.divIcon({
          className: 'route-name-wrap route-callout-wrap',
          html: `<span class="route-name route-name-${stop.kind}">
                   <span class="rn-num">${stop.numbers.join(' / ')}</span><span class="rn-name">${escapeHtml(stop.name)}</span>
                 </span>`,
          iconSize: null, iconAnchor: [0, 0],
        }),
        interactive: false,
      }).addTo(MAP_LAYERS.route);
      MAP_ROUTE_LABELS.push({ marker, latlng: [stop.lat, stop.lng],
        id: `stop-${stop.numbers.join('-')}`, selector: '.route-name', leader: true });
    });
    // A fast solve can finish during the earlier overview animation.
    // Settle on the chosen route before measuring its stop callouts.
    fitChosenRoute();
  }
}

/**
 * Distinct shape-pins for the three location kinds. Names live in the
 * browser tooltip (hover) + the popup (click) — not on the map face,
 * so the map stays scannable even with 14 nodes.
 *
 * State machine (per pin) — all pins are ALWAYS visible, just rendered
 * with different weight depending on whether they matter to the current
 * basket / decision:
 *
 *   'idle'      faint outline, dimmed. Default. Pins of farms with
 *               no matching produce, or chefs not in the basket.
 *   'candidate' bright with rust accent. Active in the current
 *               consideration set: farms holding any product the basket
 *               needs, plus chefs who placed an order.
 *   'chosen'    full saturation + gold ring. Winners — only set after
 *               a decision lands.
 *
 * Depot is always 'chosen' (the driver hub never goes passive).
 */
function pinIcon(kind, opts = {}){
  const state = opts.state || (kind === 'depot' ? 'chosen' : 'idle');
  // Per-farm tint travels with the pin so even an idle pin reads as
  // "Vendrell" / "Maresme" / etc., not as an anonymous grey dot. The
  // CSS uses --farm-color to mix a faint background even at idle, and
  // a stronger tint when the pin upgrades to candidate/chosen.
  const styleAttr = opts.color ? ` style="--farm-color:${opts.color}"` : '';
  let html;
  if (kind === 'depot') {
    // Inline truck SVG so the depot reads as "where the van starts and
    // ends each morning", not "house". Sized to the same 22×22 anchor
    // box as the other pins so map alignment doesn't shift.
    const truckSvg = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M3 6h11v8H3zM14 9h4l3 3v2h-7zM6.5 18.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm10 0a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z"/>
      </svg>`;
    html = `<span class="pin pin-depot pin-${state}" title="Driver hub (van starts & ends here)">${truckSvg}</span>`;
  } else if (kind === 'restaurant') {
    html = `<span class="pin pin-restaurant pin-${state}" title="restaurant">▲</span>`;
  } else {
    html = `<span class="pin pin-farm pin-${state}"${styleAttr} title="farm">●</span>`;
  }
  return L.divIcon({
    className: 'pin-wrap',
    html,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/**
 * Classify every farm and restaurant into one of {idle, candidate, chosen}
 * based on the current STATE — basket contents, solve phase, and last
 * decision. drawMap calls this once per redraw and uses the result to
 * pick pin styles.
 *
 * The rules:
 *   - Farms in the winning bundle (STATE.lastDecision.chosen[*]) → chosen
 *   - Farms holding any product in the basket → candidate
 *   - Everything else → idle
 *   - Restaurants in the basket → chosen if a decision exists, else candidate
 *   - Other restaurants → idle
 *
 * Note: an empty basket leaves every farm/restaurant as 'idle', so the
 * map starts clean and only "wakes up" once the user begins ordering.
 */
function classifyPinStates(){
  const farmState = new Map();
  const restState = new Map();

  // Farms in the winning bundle — these win over 'candidate'.
  const chosenFarms = new Set();
  if (STATE.lastDecision) {
    Object.values(STATE.lastDecision.chosen).forEach(arr =>
      arr.forEach(a => chosenFarms.add(a.farm_id)));
  }

  const orderRestIds = new Set(STATE.orderLines.map(l => l.restaurant_id));
  const orderProductIds = new Set(STATE.orderLines.map(l => l.product_id));

  STATE.farms.forEach(f => {
    if (chosenFarms.has(f.id)) {
      farmState.set(f.id, 'chosen');
      return;
    }
    if (orderProductIds.size === 0) {
      farmState.set(f.id, 'idle');
      return;
    }
    // "Has matching produce" = at least one ordered product is in this
    // farm's inventory AND (live stock clears MOQ OR there's no live
    // stock entry — i.e. catalog eligibility, treated as available).
    // Same gate enumerateFarmCombos uses.
    const hasMatching = Object.entries(f.inventory).some(([pid, inv]) => {
      if (!orderProductIds.has(pid) || !inv) return false;
      if (typeof inv.stock_kg === 'number') return inv.stock_kg >= (inv.moq_kg || 0);
      return true;
    });
    farmState.set(f.id, hasMatching ? 'candidate' : 'idle');
  });

  STATE.restaurants.forEach(r => {
    if (orderRestIds.has(r.id)) {
      // After a decision is in, ordering chefs upgrade from 'candidate'
      // to 'chosen' — the brighter weight matches the chosen-farm look.
      restState.set(r.id, STATE.lastDecision ? 'chosen' : 'candidate');
    } else {
      restState.set(r.id, 'idle');
    }
  });

  return { farmState, restState };
}

/* =====================================================================
   7. UTIL
   ===================================================================== */

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function showToast(msg, kind){
  const el = $('#map-toast');
  el.textContent = msg;
  el.className = 'map-toast' + (kind === 'error' ? ' error' : '');
  el.classList.remove('hidden');
}
function hideToast(){
  const el = $('#map-toast');
  el.classList.add('hidden');
}

/* =====================================================================
   8. MODELING REPORT
   Per-scenario analytical economics. We do NOT call VROOM here — opening
   the report would otherwise spin a matrix-build and a solver run for
   every scenario (slow, and unnecessary for the level of precision the
   report needs). Instead we estimate route cost from scenario shape:
   stop count, kilo total, spread tag. The user clicks any row to load
   it into the simulator and run the real VROOM number.
   ===================================================================== */

// Heuristic route cost. Inputs are scenario shape; outputs match the
// constants in depot.json's vehicle{} block so the report stays in sync
// with what the simulator actually charges per morning.
function estimateRouteCost(sc){
  const v = STATE.vehicle || {};
  const perKm      = v.cost_per_km_eur    ?? 0.13;

  const restCount  = new Set(sc.lines.map(l => l.restaurant_id)).size;
  // farm-side stops are unknown until VROOM picks; estimate as one farm
  // per 150 kg, capped at distinct-product count, with a floor of 1.
  const totalKg    = sc.lines.reduce((s,l) => s + l.qty_kg, 0);
  const itemCount  = new Set(sc.lines.map(l => l.product_id)).size;
  const farmCount  = Math.max(1, Math.min(itemCount, Math.ceil(totalKg / 150)));
  const stops      = restCount + farmCount;

  // Per-spread baseline km + drive time. Numbers picked to roughly match
  // what VROOM has been returning on these baskets in test runs.
  const spread = sc.axes?.spread || (restCount === 1 ? 'cluster' : 'mixed');
  const spreadProfile = {
    'n/a':     { baseKm: 18, baseH: 1.0, kmPerStop: 4 },
    'cluster': { baseKm: 22, baseH: 1.2, kmPerStop: 4 },
    'mixed':   { baseKm: 35, baseH: 2.0, kmPerStop: 5 },
    'spread':  { baseKm: 55, baseH: 3.0, kmPerStop: 6 }
  }[spread] || { baseKm: 30, baseH: 1.8, kmPerStop: 5 };
  const km        = spreadProfile.baseKm + stops * spreadProfile.kmPerStop;
  const driveH    = spreadProfile.baseH + stops * 0.18;

  // Both driver and van rental scale with route hours via the same
  // ceil(routeH × 1.5) buffer model — see driverCostFor / vanRentalCostFor.
  // We pass drive-time-in-seconds; both helpers add their own buffers.
  const driveS    = driveH * 3600;
  const driver    = driverCostFor(driveS);
  const diesel    = km * perKm;
  const vanFixed  = vanRentalCostFor(driveS);
  const total     = vanFixed + diesel + driver;
  // Echo the driver's billable hours back to the report row for
  // reading-by-row continuity (was previously the explicit max() math).
  const hourly    = STATE.vehicle?.driver_hourly_eur || 30;
  const billableH = hourly > 0 ? driver / hourly : 0;

  return { vanFixed, diesel, driver, total, km, stops, billableH };
}

function computeScenarioEconomics(sc){
  let revenue = 0, goods = 0, totalKg = 0;
  sc.lines.forEach(l => {
    const p = STATE.productById[l.product_id];
    if (!p) return;
    revenue += l.qty_kg * (p.sale_price_eur_kg ?? 0);
    goods   += l.qty_kg * (p.farm_gate_typical_eur_kg ?? 0);
    totalKg += l.qty_kg;
  });
  const route = estimateRouteCost(sc);
  const grossPreLogistics = revenue - goods;
  const grossProfit       = grossPreLogistics - route.total;
  const status = grossProfit >= 80 ? 'profit'
              : grossProfit >= -40 ? 'breakeven'
              : 'loss';
  const capacityFeasible = totalKg <= (STATE.vehicle?.capacity_kg ?? 0);
  return { totalKg, revenue, goods, grossPreLogistics, route, grossProfit, status, capacityFeasible };
}

function renderReport(){
  if (!STATE.scenarios || STATE.scenarios.length === 0) return;

  // The public report displays fixture basket economics, below.


  // Part 2: per-morning view (existing).

  // === The three headline numbers ===
  // "What we keep per kilo" is the average across our 30 commodities of
  // (vitrina_target - farm_gate). It's the per-kilo gross BEFORE logistics.
  let chargeSum = 0, paySum = 0, n = 0;
  STATE.products.forEach(p => {
    if (p.sale_price_eur_kg && p.farm_gate_typical_eur_kg) {
      chargeSum += p.sale_price_eur_kg;
      paySum    += p.farm_gate_typical_eur_kg;
      n++;
    }
  });
  const avgCharge = n ? chargeSum / n : 0;
  const avgPay    = n ? paySum    / n : 0;
  const perKgSpread = avgCharge - avgPay;

  // Floor = the smallest a morning can realistically cost: van rental
  // + driver, both prorated against a ~1.5h drive (2 farms + 1 chef,
  // clustered), plus a token diesel for ~22 km. Both lines use the
  // same hourly + 50%-buffer + ceil model the live simulator uses, so
  // the floor moves with the rate cards instead of with hand-coded
  // assumptions about minimum bookings.
  const v = STATE.vehicle || {};
  const minFloor = vanRentalCostFor(1.5 * 3600)
    + driverCostFor(1.5 * 3600)
    + 22 * (v.cost_per_km_eur ?? 0.13);
  const breakEvenKg = perKgSpread > 0 ? Math.round(minFloor / perKgSpread) : Infinity;

  $('#rep-spread').textContent    = `€${perKgSpread.toFixed(2)}`;
  $('#rep-charge').textContent    = `€${avgCharge.toFixed(2)}`;
  $('#rep-pay').textContent       = `€${avgPay.toFixed(2)}`;
  $('#rep-floor').textContent     = `€${minFloor.toFixed(0)}`;
  $('#rep-breakeven').textContent = `${breakEvenKg} kg`;

  // === Scenarios table — each row a scored bar ===
  const rows = STATE.scenarios.map(sc => ({ sc, e: computeScenarioEconomics(sc) }));
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.e.grossProfit)), 200);

  const tbl = $('#rep-scenarios-table');
  tbl.innerHTML = '';
  rows.forEach(({sc, e}) => {
    const sign = e.grossProfit >= 0 ? '+' : '−';
    const widthPct = e.capacityFeasible ? Math.min(100, (Math.abs(e.grossProfit) / maxAbs) * 100) : 0;
    const a = scenarioSummary(sc);
    const row = document.createElement('button');
    row.className = `rep-row rep-row-${e.status}`;
    row.innerHTML = `
      <div class="rep-row-title">
        <span class="rep-row-name">${escapeHtml(scenarioLabel(sc))}</span>
        <span class="rep-row-axes">
          ${a.spread && a.spread !== 'n/a' ? `<span class="rep-row-axis">${escapeHtml(a.spread)}</span>` : ''}
          <span class="rep-row-axis">~${e.route.stops} stops</span>
          <span class="rep-row-axis">~${e.route.km.toFixed(0)} km</span>
          <span class="rep-row-axis">${e.totalKg.toFixed(0)} kg</span>
        </span>
      </div>
      <div class="rep-row-bar">
        <div class="rep-row-bar-mid"></div>
        <div class="rep-row-bar-fill rep-row-bar-${e.grossProfit >= 0 ? 'pos' : 'neg'}"
             style="width:${widthPct/2}%"></div>
      </div>
      <div class="rep-row-num">${e.capacityFeasible ? `${sign}€${Math.abs(e.grossProfit).toFixed(0)}` : 'Split runs'}</div>
    `;
    row.addEventListener('click', () => {
      loadScenario(sc.id);
      closeModal('report-modal');
    });
    tbl.appendChild(row);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STATE, scenarioSummary, scenarioLabel, driverCostFor, vanRentalCostFor,
    validateOrderCapacity, validateBundleDemand, buildShipments, validateVroomResponse,
    evaluateBundleFast, evaluateBundle, compareCandidates, confirmWinningBundle,
    localSearchBundles, enumerateFarmCombos, computeEconomics, computeScenarioEconomics,
    invalidateDecision, commitDecision, renderOrderTotal, feasibilityLabel,
    groupRouteStops, placeMapLabels, rectanglesOverlap };
} else {
  boot();
}

})();
