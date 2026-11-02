# Routing and operations

Service configuration, the calculation model, every basket and the release verification record are collected here. For the experience and source modules, start with the [product tour](product-tour.md).

## Run locally

Requirements: Python 3 for static serving and an OSRM car-routing service covering Barcelona. Node 18+ runs the dependency-free offline tests. VROOM is optional: it attempts a complete pickup/delivery confirmation after the browser selects a sourcing bundle.

```sh
git clone https://github.com/latintzar/farm-to-restaurant-route-planner.git
cd farm-to-restaurant-route-planner
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080`. Local defaults are OSRM at `http://localhost:5000` and VROOM at `http://localhost:3000`. Set the services you operate or are authorized to use in [config.js](../config.js); [examples/config.local-services.js](../examples/config.local-services.js) is a complete local configuration. Cross-origin services need CORS support. Hosted pages default to same-origin `/osrm` and `/solve`, supplied by the host's reverse proxy.

OSRM must support `/table/v1/driving` with duration and distance annotations for all 22 catalogue locations, and `/route/v1/driving` with GeoJSON geometry. Follow the [upstream OSRM guide](https://project-osrm.org/docs/v5.24.0/api/) to prepare regional map data. [Routing service setup](../server/README.md) includes the optional VROOM container. The verified [native Linux hosting guide](../server/native/README.md) includes bounded services, persistent usage caps and a local OSRM road import.

Choose **Presets → 3 chefs · 4 items · 250kg**, then **Calculate**. The nine original basket designs range from a 25 kg single-item order to clustered and dispersed deliveries, then a 1,257 kg basket that exceeds the example van’s 1,200 kg capacity. Counts and weights are calculated from the order lines. The main app uses live local OSRM and native VROOM; the separate demo.html preserves the dated recorded example and its older fixture.

The frontend caches one road matrix for the current catalogue, then requests geometry for the chosen route. Use the configured provider according to its service policy; operate your own service for repeated evaluations or shared hosting. The release supplies local endpoints. The basemap, map libraries and fonts need network access or locally hosted replacements.

For agent setup, use [the run skill](../skills/run-route-planner/SKILL.md).

## How a proposal is calculated

1. OSRM supplies the road distance/time matrix for the depot, farms and restaurants.
2. The browser enumerates eligible sourcing choices, respecting stock and minimum order quantities (MOQs). When single suppliers cannot cover demand, a bounded split-sourcing fallback considers subsets of up to eight entered suppliers, reserving each supplier's MOQ before allocating the remainder.
3. All generated sourcing bundles are evaluated up to 1,500 bundles. Larger spaces use eight seeded local-search restarts with a 4,000-evaluation budget. Nearest-neighbour and 2-opt order the pickup-first route.
4. Candidates are ranked by goods + fuel + van rental + modeled driver time. The displayed costs use the same objective.
5. One VROOM request attempts to confirm the selected bundle. Every requested pickup/delivery, location, paired precedence, quantity and capacity bound is checked before a cheaper solver ordering can replace the browser result.
6. OSRM supplies road-following geometry for the final stop order.

This is a bounded heuristic search. Exhaustive sourcing enumeration still uses heuristic route ordering. The confirmation concerns the selected bundle, rather than re-ranking every bundle through an external solver.

## Example baskets and assumptions

| Scenario ID | Chefs | Products | Weight | Drop locations |
|---|---:|---:|---:|---|
| `1r-1i-tiny` | 1 | 1 | 25 kg | Single drop |
| `1r-3i-mid` | 1 | 3 | 105 kg | Single drop |
| `1r-1i-big` | 1 | 1 | 350 kg | Single drop |
| `2r-cluster` | 2 | 3 | 100 kg | Clustered |
| `3r-cluster` | 3 | 4 | 250 kg | Clustered |
| `3r-spread` | 4 | 4 | 250 kg | Dispersed |
| `6r-cluster` | 7 | 9 | 600 kg | Clustered |
| `6r-spread` | 6 | 8 | 600 kg | Dispersed |
| `11r-fulltruck` | 12 | 17 | 1,257 kg | Mixed |

[data/scenarios.json](../data/scenarios.json) owns these nine presets. Counts and weights come from their order lines; `11r-fulltruck` exceeds the example van’s 1,200 kg capacity.

The browser collects all pickups before delivering. The full basket must fit in the vehicle at once. Interleaved pickups/deliveries, multiple vehicles, time windows and cold-chain constraints are outside this search model.

The fictional vehicle assumptions are 1,200 kg capacity, €0.18/km fuel, €12/hour van rental capped at €72/day, and €24/hour driver time. Each hourly charge rounds `drive hours × 1.35` up to whole hours. [data/depot.json](../data/depot.json) owns those editable assumptions. The values were authored on 28 October 2026 as examples; service responses supply travel data rather than commercial quotations.

The Modeling report estimates route shape for scenario comparison. Calculate produces the road-backed proposal and explicit route-check status. Gross profit deducts goods and run costs; add other business overhead to assess net earnings. Optional channel comparisons use illustrative 1.30 delivered-price and 0.79 farm-gate multipliers against the authored reference prices.

## Release verification record

The export checks and later native-host acceptance below were recorded while preparing this source release. Run the linked commands for your current checkout; the recorded replay and live service checks have separate scopes.

### Tests and verification

```sh
npm test
npm run check
```

With Playwright 1.58.0 and its Chromium installed, `python3 tests/browser_demo.py` exercises the recorded example at desktop/phone sizes and blocks every live road-service request.

**17 offline tests pass**: the 16 existing routing/label cases plus fixture validity, reference integrity, stock/MOQ feasibility and intended capacity boundaries. They exercise the application functions with synthetic matrices and solver responses, making zero real routing requests.

The fictional Barcelona fixture has successful live OSRM table and route responses, retained with exact request URLs and hashes. The real app and recorded example pass desktop/phone walkthroughs; the map has seven readable stop labels. The personal hosted preview additionally runs native VROOM1.15.0 and local OSRM5.27.1. A real browser scenario verified HTTP200, zero unassigned shipments and1,854road-geometry vertices; the full cost objective retained the slightly cheaper browser ordering after checking the solver alternative. Container compatibility is a separate path. [provenance/release-checks.json](../provenance/release-checks.json) records these boundaries.

The six native-adapter checks run with `python3 server/native/test_gateway.py`; they cover request limits, confined road operations, restart-persistent quotas and preview asset resolution.


## Source and rights

[Architecture and decisions](ARCHITECTURE.md) · [Data schema and provenance](../data/README.md) · [Code provenance](../provenance/README.md) · [Third-party terms](../THIRD_PARTY.md)
