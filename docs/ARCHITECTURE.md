# Routing architecture

The frontend is a static application. All mutable basket/stock/decision state lives in the browser; the shipped JSON supplies an illustrative starting world. The original interface remains: source catalogue left, map centre, order basket and economics right.

```text
JSON catalogues + entered orders/stock
                |
OSRM table -> cached road distance/time matrices
                |
Browser sourcing enumeration or seeded local search
                |
Nearest-neighbour + 2-opt pickup-first route proposals
                |
Compare goods + fuel + van rental + driver costs
                |
One complete-assignment VROOM confirmation attempt
                |
Validated VROOM ordering, or explicitly checked browser ordering
                |
OSRM road geometry -> Leaflet map + costs + evidence status
```

## Decisions and boundaries

**Browser evaluation keeps the interaction responsive.** Most candidate routes can be scored against one cached matrix, avoiding one external solver request per sourcing bundle. Search yields between batches, and seeded restarts make repeated runs reproducible. Small sourcing spaces are fully enumerated; routing within each assignment remains heuristic.

**Goods and time both affect the objective.** Every candidate includes goods, per-kilometre fuel, duration-dependent van rental and duration-dependent driver time. Confirmation costs are recomputed by walking the verified solver step order through the same matrix. The visible distance, time and cost therefore share one basis even if optional solver summary metrics differ.

**Capacity has an explicit model.** The browser proposes all pickups followed by all deliveries. The whole basket must fit at once; a larger basket is flagged for split runs. Interleaved pickup/delivery search, multiple vehicles, time windows, cold-chain constraints and operational availability are later capabilities.

**Shipment quantities are conserved.** Solver input uses integer grams. Each farm's product supply is assigned to destination demand in a deterministic order. Supply and demand totals must agree before confirmation. This avoids independently rounded proportional shares inventing or losing quantities.

**A solver response requires complete evidence.** The verifier checks success code, empty unassigned list, exactly one expected vehicle, correct depot endpoints and every requested pickup/delivery exactly once at its expected location. Deliveries follow their paired pickups; the reconstructed load stays within capacity and ends at zero. Missing/duplicate/foreign operations and partial assignments are rejected. The route status says whether the displayed proposal comes from that verified response or the browser's independent pickup-first check.

**A confirmation changes only the selected assignment.** A cheaper validated VROOM ordering can replace the browser ordering for that sourcing bundle. Other bundles retain their browser-route scores. The final proposal is the best evaluated candidate under this bounded procedure, rather than a proof of global optimality.

**Geometry is separate from scoring.** OSRM `/route` draws the final selected stop order. The cached `/table` supplied candidate costs. Geometry and table must use the same regional routing profile for a coherent deployment. Missing road pairs and geometry errors stop calculation.

**Reports identify assumptions.** The separate Modeling report estimates route shape using basket count, product count and spread. The public report displays scenario estimates and reference-run assumptions. Historical speculative market-scale charts were omitted from the public report and its source export. Capacity-violating baskets are marked for split runs and excluded from the report's feasible value-chain scenario aggregate.

## Configuration and data

`config.js` selects the public OSRM and VROOM URLs. Browser-local endpoint overrides remain available through `localStorage.osrmEndpoint` / `localStorage.vroomEndpoint`. API credentials for a shared public service belong at a server proxy; a browser-visible value is readable by its user. Historical private publication tooling is excluded from this release candidate.

Scenario restaurant/product/weight labels are derived from their order lines. Spread is an authored geographic classification. The supplied catalogue is independently authored and fictional. Its stock/MOQ/prices, restaurant baskets and vehicle assumptions are dated inputs. Calculated route costs use selected farm prices; the shape-based report uses product-level typical farm prices. Sale/reference price fields have provider-neutral names.

`provenance/code-source.json` records the owned-code origin and clean export. The historical sourced catalogue, its seeding/research files and earlier Git history are excluded. `data/README.md` records fresh fixture authorship, schema and the source-term evidence behind this packaging decision. Verification belongs in `provenance/release-checks.json`.

## Verification limits

Node tests use actual application functions, synthetic road matrices and explicit solver fixtures with real networking disabled. They establish internal calculation/admission behaviour. Live VROOM response compatibility and container installation remain unverified. The fictional release fixture has one successful live OSRM table and route response, with exact hashes and recorded replay. The real application and map were checked at 1600/390; the presentation frame was independently checked at 1280/390. The static recorded example makes zero live routing calls and preserves the browser proposal’s capacity-check status; VROOM is explicitly unconfigured there. See [recording provenance](../demo/README.md). No live service was deployed by preparing this export.

**Edits invalidate results.** Adding/removing orders, changing supply or loading a scenario clears the earlier route/economics. Input mutations are held during calculation; an input-revision check also rejects a stale asynchronous result before it can be committed. Each completed decision retains its own basket for revenue calculation.

**Split sourcing is bounded.** Single-source choices are generated first. If they cannot meet demand, subsets of up to eight stock-constrained farms are considered. Each selected MOQ is reserved before the remaining demand is allocated by price. This handles MOQ interactions while retaining a finite browser search; it is not complete optimization over arbitrary split allocations across every supplier.

## Basemap and route callouts

OpenFreeMap Positron supplies the configurable vector basemap through MapLibre GL and its official Leaflet binding. Existing Leaflet pins and OSRM route geometry retain their exact coordinates. An explicit raster URL and its attribution can select a different provider.

Selected stop labels are measured from the actual rendered DOM after fonts and layout are ready. A screen-space placer reserves map-control areas and exact-pin clearances, then puts label rectangles into the current viewport with no overlap. Short leader lines connect each callout back to its unchanged pin. Start/return at the same depot share one callout carrying both route numbers. Move, zoom and resize events remeasure/reflow; a label that cannot fit leaves its exact pin and popup available. The route list remains complete in the breakdown.
