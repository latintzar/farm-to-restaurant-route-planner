const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../app.js');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../data', `${name}.json`)));

test('public fixture resolves every reference and admits its intended stock/MOQ baskets', () => {
  const { farms } = read('farms');
  const { restaurants } = read('restaurants');
  const { products } = read('products');
  const { scenarios } = read('scenarios');
  const { depot, vehicle } = read('depot');
  for (const rows of [farms, restaurants, products, scenarios])
    assert.equal(new Set(rows.map(x => x.id)).size, rows.length);
  const productById = Object.fromEntries(products.map(p => [p.id, p]));
  const restaurantIds = new Set(restaurants.map(r => r.id));
  for (const entity of [depot, ...farms, ...restaurants]) {
    assert.equal(entity.synthetic, true);
    assert.ok(entity.lat > 41.2 && entity.lat < 41.5);
    assert.ok(entity.lng > 1.9 && entity.lng < 2.3);
    assert.equal(entity.source_url, undefined);
  }
  for (const p of products) {
    assert.ok(p.reference_price_eur_kg > 0);
    assert.ok(p.sale_price_eur_kg > p.farm_gate_typical_eur_kg);
  }
  for (const farm of farms) for (const [pid, inv] of Object.entries(farm.inventory)) {
    assert.ok(productById[pid], `${farm.id}: unknown product ${pid}`);
    assert.ok(inv.stock_kg >= inv.moq_kg && inv.moq_kg > 0);
    assert.ok(inv.price_eur_kg > 0);
  }
  Object.assign(app.STATE, { farms, restaurants, products, productById, depot, vehicle });
  for (const scenario of scenarios) {
    for (const line of scenario.lines) {
      assert.ok(restaurantIds.has(line.restaurant_id));
      assert.ok(productById[line.product_id]);
      assert.ok(line.qty_kg > 0 && Number.isInteger(line.qty_kg * 1000));
    }
    if (scenario.id === 'split-runs') {
      assert.throws(() => app.validateOrderCapacity(scenario.lines), { code: 'capacity-exceeded' });
      continue;
    }
    app.validateOrderCapacity(scenario.lines);
    const demand = {};
    for (const line of scenario.lines) demand[line.product_id] = (demand[line.product_id] || 0) + line.qty_kg;
    for (const [pid, qty] of Object.entries(demand)) {
      const combos = app.enumerateFarmCombos(pid, qty);
      assert.ok(combos.length > 0, `${scenario.id}: ${pid} has no stock/MOQ allocation`);
      for (const combo of combos) {
        assert.equal(Math.round(combo.farms.reduce((n, f) => n + f.qty, 0) * 1000), Math.round(qty * 1000));
        for (const f of combo.farms) {
          const inv = farms.find(x => x.id === f.farm_id).inventory[pid];
          assert.ok(f.qty >= inv.moq_kg && f.qty <= inv.stock_kg);
        }
      }
    }
  }
  const split = app.enumerateFarmCombos('tomato', 140);
  assert.ok(split.every(c => c.farms.length === 2), 'split-stock should require two farms');
});
