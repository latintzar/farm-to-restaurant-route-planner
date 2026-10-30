# Farm-to-restaurant route planner

VROOM-based routing for farm-to-table deliveries

Farm-to-restaurant route planner is a VROOM-based planning tool for decentralised farm-to-table logistics. Choose a basket or build an order, compare farm sourcing, and calculate pickup and delivery routes, vehicle capacity and costs on real roads.

[Website](https://atelierneyra.com/route-planner) · [Open app](https://atelierneyra.com/preview/route-planner/) · [Documentation](https://docs.atelierneyra.com/route-planner/overview/)

![Farm-to-restaurant route planner](https://atelierneyra.com/assets/product-shots-20261030/route-planner.jpg)

## Customer discovery

The design grew from conversations with 20 farms and 20 shops around Barcelona. Farms said they could not deliver below their minimum order quantities; shops said they could not afford those quantities. The planner tests whether pooled orders and shared pickups can make a delivery workable. The source separates product prices, van costs, driver time and delivery capacity so those assumptions can be changed.

## How it works

Twenty farms around Barcelona said they could not deliver below their minimum order quantities. Twenty shops said they could not afford those quantities. Pooling orders creates a routing and sourcing problem: which farms, which stops and what delivery cost?

| Feature | What it does |
| --- | --- |
| Nine basket presets | Explore the original small-order, larger-basket, clustered-stop and dispersed-stop scenarios, or build your own. |
| Farm sourcing | Compare the products and quantities available across farms. |
| Real road routes | Use VROOM and a regional OSRM network to calculate Barcelona street routes. |
| Delivery economics | Read goods, van, driver, distance and time together. |
| Mobile order editing | Edit quantities and calculate above the map, with touch-sized controls and visible capacity feedback. |

The native hosted app calculates routes with the same planner, VROOM service and local Barcelona OSRM network supplied by the source. Farm names, customers, prices and stock in the public example are illustrative. Connect your own stock, customers, delivery costs and regional road data. [Product guide](docs/PROJECT.md).

## Run locally

Requirements: Python 3 for static serving and an OSRM car-routing service covering Barcelona. Node 18+ runs the dependency-free offline tests. VROOM is optional: it attempts a complete pickup/delivery confirmation after the browser selects a sourcing bundle.

```sh
git clone https://github.com/latintzar/farm-to-restaurant-route-planner.git
cd farm-to-restaurant-route-planner
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080`. Local defaults are OSRM at `http://localhost:5000` and VROOM at `http://localhost:3000`. Set the services you operate or are authorized to use in [config.js](config.js); [examples/config.local-services.js](examples/config.local-services.js) is a complete local configuration. Cross-origin services need CORS support. Hosted pages default to same-origin `/osrm` and `/solve`, supplied by the host's reverse proxy.

OSRM must support `/table/v1/driving` with duration and distance annotations for all 22 catalogue locations, and `/route/v1/driving` with GeoJSON geometry. Follow the [upstream OSRM guide](https://project-osrm.org/docs/v5.24.0/api/) to prepare regional map data. [Routing service setup](server/README.md) includes the optional VROOM container. The verified [native Linux hosting guide](server/native/README.md) includes bounded services, persistent usage caps and a local OSRM road import.

Choose **scenarios → 3 chefs · 4 items · 250kg**, then **Calculate**. The nine original basket designs range from a 25 kg single-item order to clustered and dispersed deliveries, then a 1,257 kg basket that exceeds the example van’s 1,200 kg capacity. Counts and weights are calculated from the order lines. The main app uses live local OSRM and native VROOM; the separate demo.html preserves the dated recorded example and its older fixture.

The frontend caches one road matrix for the current catalogue, then requests geometry for the chosen route. Use the configured provider according to its service policy; operate your own service for repeated evaluations or shared hosting. The release supplies local endpoints. The basemap, map libraries and fonts need network access or locally hosted replacements.

For agent setup, use [the run skill](skills/run-route-planner/SKILL.md).

## How a proposal is calculated

1. OSRM supplies the road distance/time matrix for the depot, farms and restaurants.
2. The browser enumerates eligible sourcing choices, respecting stock and minimum order quantities (MOQs). When single suppliers cannot cover demand, a bounded split-sourcing fallback considers subsets of up to eight entered suppliers, reserving each supplier's MOQ before allocating the remainder.
3. All generated sourcing bundles are evaluated up to 1,500 bundles. Larger spaces use eight seeded local-search restarts with a 4,000-evaluation budget. Nearest-neighbour and 2-opt order the pickup-first route.
4. Candidates are ranked by goods + fuel + van rental + modeled driver time. The displayed costs use the same objective.
5. One VROOM request attempts to confirm the selected bundle. Every requested pickup/delivery, location, paired precedence, quantity and capacity bound is checked before a cheaper solver ordering can replace the browser result.
6. OSRM supplies road-following geometry for the final stop order.

This is a bounded heuristic search. Exhaustive sourcing enumeration still uses heuristic route ordering. The confirmation concerns the selected bundle, rather than re-ranking every bundle through an external solver.

## Example baskets and assumptions

| Scenario ID | Purpose |
|---|---|
| `small-basket` | One restaurant, two products, 50 kg |
| `barcelona-multi-stop` | Three restaurants, four products, 250 kg |
| `city-wide` | Five restaurants, eight products, 400 kg |
| `split-stock` | 140 kg tomato demand requires two farms |
| `capacity-boundary` | 650 kg, exactly the pickup-first capacity |
| `split-runs` | 651 kg, identified as requiring split runs |

The browser collects all pickups before delivering. The full basket must fit in the vehicle at once. Interleaved pickups/deliveries, multiple vehicles, time windows and cold-chain constraints are outside this search model.

The fictional vehicle assumptions are 650 kg capacity, €0.18/km fuel, €12/hour van rental capped at €72/day, and €24/hour driver time. Each hourly charge rounds `drive hours × 1.35` up to whole hours. [data/depot.json](data/depot.json) owns those editable assumptions. The values were authored on 28 October 2026 as examples; service responses supply travel data rather than commercial quotations.

The Modeling report estimates route shape for scenario comparison. Calculate produces the road-backed proposal and explicit route-check status. Gross profit deducts goods and run costs; add other business overhead to assess net earnings. Optional channel comparisons use illustrative 1.30 delivered-price and 0.79 farm-gate multipliers against the authored reference prices.

## Tests and verification

```sh
npm test
npm run check
```

With Playwright 1.58.0 and its Chromium installed, `python3 tests/browser_demo.py` exercises the recorded example at desktop/phone sizes and blocks every live road-service request.

**17 offline tests pass**: the 16 existing routing/label cases plus fixture validity, reference integrity, stock/MOQ feasibility and intended capacity boundaries. They exercise the application functions with synthetic matrices and solver responses, making zero real routing requests.

The fictional Barcelona fixture has successful live OSRM table and route responses, retained with exact request URLs and hashes. The real app and recorded example pass desktop/phone walkthroughs; the map has seven readable stop labels. The personal hosted preview additionally runs native VROOM1.15.0 and local OSRM5.27.1. A real browser scenario verified HTTP200, zero unassigned shipments and1,854road-geometry vertices; the full cost objective retained the slightly cheaper browser ordering after checking the solver alternative. Container compatibility is a separate path. [provenance/release-checks.json](provenance/release-checks.json) records these boundaries.

The six native-adapter checks run with `python3 server/native/test_gateway.py`; they cover request limits, confined road operations, restart-persistent quotas and preview asset resolution.

## Code and data

- [app.js](app.js): UI state, sourcing, route search, confirmation and modeled costs.
- [index.html](index.html), [style.css](style.css): responsive interface, map and breakdown.
- [data/README.md](data/README.md): fixture provenance, JSON schema and catalogue replacement.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): decisions and calculation boundaries.
- [provenance/](provenance/): clean-export provenance and checks.

Peter Neyra's code and newly authored example fixture use the [MIT licence](LICENSE). External software, map tiles and road data retain their terms; see [THIRD_PARTY.md](THIRD_PARTY.md). The historical sourced producer catalogue remains in its private case archive, with the [publisher's redistribution restriction](https://parcagrari.cat/info-legal) recorded in [data provenance](data/README.md).

[made by atelier neyra](https://atelierneyra.com)
