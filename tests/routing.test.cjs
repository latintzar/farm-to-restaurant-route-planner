const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../app.js');
const { STATE } = app;

// Importing the application skips boot in CommonJS. Every request in this
// suite is a fixture; an accidental real request fails immediately.
global.window = { location: { hostname: 'localhost', origin: 'http://localhost:8080' } };
global.localStorage = {};
const denyNetwork = async () => { throw new Error('Network disabled in deterministic tests'); };
test.beforeEach(() => { global.fetch = denyNetwork; });
test.after(() => { global.fetch = denyNetwork; });

function setup() {
  Object.assign(STATE, {
    depot: { id: 'depot', name: 'Depot', lat: 0, lng: 0 },
    farms: [
      { id: 'near', name: 'Near', lat: 1, lng: 0 },
      { id: 'quick', name: 'Quick', lat: 2, lng: 0 },
    ],
    restaurants: [{ id: 'chef', name: 'Chef', lat: 3, lng: 0 }],
    products: [{ id: 'tomato', label: 'Tomato', sale_price_eur_kg: 8 }],
    productById: { tomato: { label: 'Tomato', reference_price_eur_kg: 4, sale_price_eur_kg: 8 } },
    vehicle: { capacity_kg: 1200, cost_per_km_eur: 0.13,
      van_hourly_eur: 10, van_daily_cap_eur: 60, van_billing_buffer_pct: 50,
      driver_hourly_eur: 30, driver_billing_buffer_pct: 50 },
    fullMatrix: {
      distances: [[0, 100, 300, 100], [100, 0, 100, 100], [300, 100, 0, 300], [100, 100, 300, 0]],
      durations: [[0, 1200, 100, 100], [1200, 0, 100, 1200], [100, 100, 0, 100], [100, 1200, 100, 0]],
    },
    orderLines: [{ restaurant_id: 'chef', product_id: 'tomato', qty_kg: 10 }],
  });
}
function bundle(farmId = 'near', cost = 10, qty = 10) {
  return { goods_cost: cost, perProduct: { tomato: {
    goods_cost: cost, farms: [{ farm_id: farmId, qty, price: cost / qty }],
  } } };
}
function responseFor(request) {
  return { code: 0, unassigned: [], summary: { unassigned: 0, computing_times: { solving: 2 } },
    routes: [{ vehicle: 1, duration: 300, steps: [
      { type: 'start', location_index: 0 },
      ...request.shipments.map(s => ({ type: 'pickup', id: s.pickup.id, location_index: s.pickup.location_index })),
      ...request.shipments.map(s => ({ type: 'delivery', id: s.delivery.id, location_index: s.delivery.location_index })),
      { type: 'end', location_index: 0 },
    ] }] };
}
function useVroom(transform = x => x) {
  let captured;
  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => transform(responseFor(captured), captured) };
  };
  return () => captured;
}

test('scenario labels derive counts and weight from current fixture lines', () => {
  const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/scenarios.json'))).scenarios;
  const main = scenarios.find(s => s.id === 'barcelona-multi-stop');
  assert.deepEqual(app.scenarioSummary({ ...main, axes: { restaurants: 99, items: 99, kg: 99, spread: 'cluster' } }),
    { restaurants: 3, items: 4, kg: 250, spread: 'cluster' });
  assert.match(app.scenarioLabel(main), /3 chefs · 4 items · 250kg/);
  assert.deepEqual(app.scenarioSummary(scenarios.find(s => s.id === 'city-wide')),
    { restaurants: 5, items: 8, kg: 400, spread: 'spread' });
  setup();
  const products = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/products.json'))).products;
  STATE.productById = Object.fromEntries(products.map(p => [p.id, p]));
  STATE.vehicle.capacity_kg = 650;
  assert.equal(app.computeScenarioEconomics(scenarios.find(s => s.id === 'capacity-boundary')).capacityFeasible, true);
  assert.equal(app.computeScenarioEconomics(scenarios.find(s => s.id === 'split-runs')).capacityFeasible, false);
});

test('pickup-first fallback rejects a basket above capacity and accepts the exact boundary', async () => {
  setup();
  const lines = [{ ...STATE.orderLines[0], qty_kg: 1201 }];
  assert.throws(() => app.evaluateBundleFast(bundle('near', 10, 1201), lines), { code: 'capacity-exceeded' });
  await assert.rejects(app.evaluateBundle(bundle('near', 10, 1201), lines), { code: 'capacity-exceeded' });
  assert.equal(app.validateOrderCapacity([{ ...lines[0], qty_kg: 1200 }]), 1200000);
  assert.throws(() => app.validateOrderCapacity([{ ...lines[0], qty_kg: -2 }]), { code: 'invalid-quantity' });
});

test('candidate ranking includes driver time and matches displayed full route costs', () => {
  setup();
  const slow = app.evaluateBundleFast(bundle('near', 10), STATE.orderLines);
  const fast = app.evaluateBundleFast(bundle('quick', 25), STATE.orderLines);
  assert.ok(slow.cost.goods_eur + slow.cost.transport_eur < fast.cost.goods_eur + fast.cost.transport_eur);
  assert.ok(fast.cost.total_eur < slow.cost.total_eur);
  assert.equal([slow, fast].sort(app.compareCandidates)[0], fast);
  assert.equal(app.computeEconomics(fast).cogs, fast.cost.total_eur);
  assert.equal(slow.cost.total_eur, slow.cost.goods_eur + slow.cost.transport_eur + slow.cost.driver_eur);
});

test('local-search cached route costs retain driver time in every candidate', async () => {
  setup();
  const a = bundle('near', 10).perProduct.tomato;
  const b = bundle('quick', 25).perProduct.tomato;
  const result = await app.localSearchBundles({ tomato: [a, b] }, ['tomato'], STATE.orderLines,
    { restarts: 2, maxIterPerRestart: 3, evalBudget: 12 });
  assert.equal(result.explored[0].bundle.perProduct.tomato.farms[0].farm_id, 'quick');
  for (const entry of result.explored)
    assert.equal(entry.cost.total_eur, entry.cost.goods_eur + entry.cost.transport_eur + entry.cost.driver_eur);
});

test('split-farm fractional shipments conserve each product and destination to the gram', () => {
  setup();
  const lines = [
    { restaurant_id: 'r1', product_id: 'tomato', qty_kg: 0.667 },
    { restaurant_id: 'r2', product_id: 'tomato', qty_kg: 0.333 },
  ];
  const split = { perProduct: { tomato: { farms: [
    { farm_id: 'near', qty: 0.501 }, { farm_id: 'quick', qty: 0.499 },
  ] } } };
  const shipments = app.buildShipments(split, lines, ['near', 'quick'], ['r1', 'r2']);
  const sum = predicate => shipments.filter(predicate).reduce((n, s) => n + s.amount[0], 0);
  assert.equal(sum(() => true), 1000);
  assert.equal(sum(s => s.pickup.location_index === 1), 501);
  assert.equal(sum(s => s.pickup.location_index === 2), 499);
  assert.equal(sum(s => s.delivery.location_index === 3), 667);
  assert.equal(sum(s => s.delivery.location_index === 4), 333);
});

test('complete VROOM assignment is checked against exact requested IDs, locations and capacity', async () => {
  setup();
  const captured = useVroom();
  const result = await app.evaluateBundle(bundle(), STATE.orderLines);
  assert.equal(captured().vehicles[0].capacity[0], 1200000);
  assert.equal(captured().shipments[0].amount[0], 10000);
  assert.equal(result.feasibility.status, 'solver-confirmed');
  assert.equal(result.feasibility.peak_load_kg, 10);
  assert.equal(result.cost.total_eur, app.computeEconomics(result).cogs);
});

test('unassigned, omitted, duplicate and wrong-location solver results are rejected', async () => {
  setup();
  const bad = [
    r => ({ ...r, unassigned: [{ id: 1 }] }),
    r => { r.routes[0].steps.splice(1, 1); return r; },
    r => { r.routes[0].steps.splice(2, 0, { ...r.routes[0].steps[1] }); return r; },
    r => { r.routes[0].steps[1].location_index = 999; return r; },
    r => { delete r.unassigned; return r; },
    r => { r.routes[0].steps[1].type = 'delivery'; return r; },
  ];
  for (const transform of bad) {
    useVroom(transform);
    await assert.rejects(app.evaluateBundle(bundle(), STATE.orderLines), { code: 'solver-rejected' });
  }
});

test('partial or unavailable confirmation preserves a capacity-checked browser proposal with truthful status', async () => {
  setup();
  const winner = { ...app.evaluateBundleFast(bundle(), STATE.orderLines), bundle: bundle() };
  useVroom(r => { r.unassigned.push({ id: 1 }); return r; });
  const rejected = await app.confirmWinningBundle(winner, STATE.orderLines);
  assert.equal(rejected.winner, winner);
  assert.equal(rejected.solverConfirmation.status, 'rejected');
  assert.match(app.feasibilityLabel({ ...winner, solverConfirmation: rejected.solverConfirmation }), /response rejected/);
  global.fetch = denyNetwork;
  const unavailable = await app.confirmWinningBundle(winner, STATE.orderLines);
  assert.equal(unavailable.winner, winner);
  assert.equal(unavailable.solverConfirmation.status, 'unavailable');
});

test('quantity mismatch is rejected before a solver request', async () => {
  setup();
  await assert.rejects(app.evaluateBundle(bundle('near', 10, 9), STATE.orderLines), { code: 'supply-mismatch' });
});

test('MOQ fallback reserves minima so a valid split is retained', () => {
  setup();
  STATE.farms[0].inventory = { tomato: { stock_kg: 8, moq_kg: 6, price_eur_kg: 1 } };
  STATE.farms[1].inventory = { tomato: { stock_kg: 8, moq_kg: 4, price_eur_kg: 2 } };
  const choices = app.enumerateFarmCombos('tomato', 10);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].farms.map(f => [f.farm_id, f.qty]), [['near', 6], ['quick', 4]]);
  assert.equal(choices[0].goods_cost, 14);
});

test('changing inputs invalidates an old route and rejects an asynchronous stale result', () => {
  setup();
  STATE.inputRevision = 1;
  const revision = STATE.inputRevision;
  const old = { cost: { goods_eur: 10, transport_eur: 20, driver_eur: 30 },
    orderLines: STATE.orderLines.map(line => ({ ...line })) };
  assert.equal(app.commitDecision(old, revision), true);
  app.invalidateDecision();
  STATE.orderLines = [{ ...STATE.orderLines[0], qty_kg: 20 }];
  assert.equal(STATE.lastDecision, null);
  assert.equal(app.commitDecision(old, revision), false);
  assert.equal(STATE.lastDecision, null);
  assert.equal(app.computeEconomics(old).revenue, 80);
  assert.equal(app.commitDecision({ updated: true }, STATE.inputRevision), true);
});

test('basket total renders from the current basket before any decision exists', () => {
  setup();
  const classList = { add() {}, remove() {}, toggle() {} };
  const total = { textContent: '', closest: () => ({ classList }) };
  global.document = { querySelector: selector => selector === '#cs-revenue' ? total : null };
  try {
    app.renderOrderTotal();
    assert.equal(total.textContent, '€80.00');
  } finally { delete global.document; }
});
