const test = require('node:test');
const assert = require('node:assert/strict');
const { groupRouteStops, placeMapLabels, rectanglesOverlap } = require('../app.js');

function clusteredLabels(viewport) {
  return [
    { id: 'depot', x: viewport.width * 0.65, y: viewport.height * 0.25, width: 270, height: 28 },
    { id: 'farm', x: viewport.width * 0.25, y: viewport.height * 0.8, width: 300, height: 32 },
    { id: 'restaurant-a', x: viewport.width * 0.73, y: viewport.height * 0.31, width: 120, height: 28 },
    { id: 'restaurant-b', x: viewport.width * 0.71, y: viewport.height * 0.32, width: 110, height: 28 },
    { id: 'restaurant-c', x: viewport.width * 0.7, y: viewport.height * 0.33, width: 120, height: 28 },
  ];
}
function verifyPlacement(items, viewport, obstacles) {
  const before = structuredClone(items);
  const placed = placeMapLabels(items, viewport, obstacles);
  assert.equal(placed.length, items.length);
  assert.deepEqual(items, before, 'Placement must leave exact stop anchor coordinates untouched');
  for (const [i, label] of placed.entries()) {
    assert.ok(label.left >= 12 && label.top >= 12);
    assert.ok(label.left + label.width <= viewport.width - 12);
    assert.ok(label.top + label.height <= viewport.height - 12);
    for (const other of placed.slice(i + 1)) assert.equal(rectanglesOverlap(label, other, 5), false);
    for (const obstacle of obstacles) assert.equal(rectanglesOverlap(label, obstacle, 5), false);
    const original = items.find(item => item.id === label.id);
    assert.deepEqual(label.anchor, { x: original.x, y: original.y });
    assert.ok(label.target.x >= label.left && label.target.x <= label.left + label.width);
    assert.ok(label.target.y >= label.top && label.target.y <= label.top + label.height);
  }
  return placed;
}

test('nearby restaurant callouts stay separate and in the desktop map viewport', () => {
  const viewport = { width: 780, height: 910 };
  const obstacles = [
    { left: 12, top: 12, width: 36, height: 66 },
    { left: 540, top: 826, width: 225, height: 52 },
  ];
  verifyPlacement(clusteredLabels(viewport), viewport, obstacles);
});

test('callouts reflow at phone width and avoid map controls without moving stops', () => {
  const viewport = { width: 366, height: 500 };
  const obstacles = [
    { left: 12, top: 12, width: 36, height: 66 },
    { left: 170, top: 436, width: 180, height: 40 },
  ];
  verifyPlacement(clusteredLabels(viewport), viewport, obstacles);
});

test('zoomed coincident anchors retain separate non-overlapping callouts', () => {
  const viewport = { width: 600, height: 480 };
  const items = [100, 120, 140].map((width, i) => ({ id: String(i), x: 300, y: 240, width, height: 28 }));
  verifyPlacement(items, viewport, []);
});

test('start and return at the same depot share one label with both route numbers', () => {
  const depot = Object.freeze({ kind: 'depot', id: 'depot', name: 'Depot', lat: 41.4, lng: 2.1 });
  const farm = Object.freeze({ kind: 'farm', id: 'farm', name: 'Farm', lat: 41.3, lng: 2.0 });
  const route = Object.freeze([depot, farm, depot]);
  const grouped = groupRouteStops(route);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].numbers, [1, 3]);
  assert.deepEqual(grouped[1].numbers, [2]);
  assert.equal(grouped[0].lat, depot.lat);
  assert.equal(grouped[0].lng, depot.lng);
  assert.equal(route.length, 3);
});
