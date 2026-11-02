# Product tour

Farm-to-restaurant route planner is a VROOM-based app for a logistics service pooling deliveries from small farms to food shops and restaurants. It brings the basket, farm sourcing, road itinerary and delivery economics into one decision.

[Open demo](https://atelierneyra.com/preview/route-planner/) · [Run locally](routing-and-operations.md#run-locally)

## A pooled delivery

1. Open **Presets** and choose **3 chefs · 4 items · 250kg**. Orders shows the customers, product lines, quantities and sale revenue. The nine presets let you change basket size and stop density independently.
2. Inspect **Supply**. Each farm has product availability, a price and a minimum order quantity. Edit those inputs or the basket to test a different sourcing situation.
3. Select **Calculate**. OSRM supplies road distances and durations. The browser compares sourcing bundles, checks capacity and attempts one VROOM confirmation for the selected bundle.
4. Read the completed route on Barcelona’s roads and open the breakdown. Follow the farm pickups and customer deliveries; compare goods, fuel, van rental, driver time and gross profit. The status identifies the route check used for the displayed result.
5. Open the route itinerary, or change an input and calculate a new proposal. Input edits clear the previous result so the visible economics belong to the current basket.

The phone view keeps the map behind compact controls. Orders and Supply are full-screen panels; the Calculate/results bar stays accessible. Desktop shows the same state in three columns.

## Product areas and source

| Area | Visible actions and results | Source |
| --- | --- | --- |
| Presets and order basket | Load a scenario, edit quantities, add demand and see basket weight/revenue. | [data/scenarios.json](../data/scenarios.json), [app.js](../app.js): `renderScenarios`, `loadScenario`, `invalidateDecision`. |
| Supplier catalogue | Edit stock, prices and MOQs; form eligible sourcing bundles. | [data guide](../data/README.md), [app.js](../app.js): `decide`, `localSearchBundles`, `evaluateBundle`. |
| Road calculation | Compare pickup-first candidates against the cached road matrix; draw the selected stop order. | [app.js](../app.js): `buildMatrix`, `fetchOsrmTable`, `fetchOsrmRoute`, `runDecision`. |
| VROOM confirmation | Validate every requested pickup/delivery, paired precedence, load and depot before adopting a cheaper ordering. | [app.js](../app.js): `confirmWinningBundle`, `validateVroomResponse`; [native adapter](../server/native/README.md). |
| Economics and itinerary | Read cost components, route status, stop list and map link. | [app.js](../app.js): `computeEconomics`, `renderBreakdown`, `buildGoogleMapsUrl`; [data/depot.json](../data/depot.json). |
| Modeling report | Compare basket economics using an explicitly shape-based route estimate. | [index.html](../index.html), [app.js](../app.js): `estimateRouteCost`, `computeScenarioEconomics`. |

## Calculation decisions

The objective combines goods and run costs. One cached OSRM matrix lets the browser evaluate many sourcing bundles, while the final OSRM geometry follows the chosen stops. VROOM checks the selected bundle; the result is a bounded heuristic proposal. The current vehicle model collects all pickups before deliveries and requires the whole basket to fit at once.

The original customer discovery involved 20 farms and 20 shops around Barcelona. The public catalogue supplies fictional businesses, commercial inputs and orders. The 1,257kg preset deliberately exceeds the example van’s 1,200kg capacity. The road-backed app, recorded replay and shape-based Modeling report each identify their calculation basis.

## Continue from here

- [Setup, nine presets, full assumptions and checks](routing-and-operations.md).
- [Architecture and design decisions](ARCHITECTURE.md), including solver-response admission and search limits.
- [Data schema and provenance](../data/README.md) for your stock, customers and commercial assumptions.
- [Routing services](../server/README.md) and [native Linux hosting](../server/native/README.md) for your region.
- [Agent run skill](../skills/run-route-planner/SKILL.md), [mobile interactions](MOBILE-UX.md) and [release evidence](../provenance/release-checks.json).

A useful next extension is to supply your own delivery region and operating costs, then test the existing capacity and complete-assignment checks against those inputs.
