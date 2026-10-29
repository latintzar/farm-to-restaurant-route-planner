# Example data

The main application restores the original nine basket designs: small and large orders, clustered and dispersed drops, and a capacity-exceeding full-truck case. Their product combinations and quantities come from the original Vitrina routing simulator. Labels derive from actual lines, correcting historical counts and weights.

The public data contains six fictional farms, fifteen fictional restaurant customers and thirty-two products. Stock, MOQs, prices and vehicle rates are illustrative, editable assumptions. Customer points preserve the original scenarios’ Barcelona neighbourhood structure. The original restricted-source producer directory remains privately preserved.

The separate recorded demo.html loads demo/data/, retaining its earlier fixture and exact recorded road requests. The live index.html loads data/ and calculates new routes.

## Why this is a fresh fixture

The original private case used a public-directory-derived catalogue of 37 producers: 17 from Parc Agrari and 20 from Benvinguts a Pagès. The [Parc Agrari legal notice](https://parcagrari.cat/info-legal), checked 28 October 2026, requires written authorization for distributing/copying/modifying/transmitting its page content and supplied information. The [Benvinguts site](https://benvingutsapages.cat/) reserves rights; the bounded source review located no affirmative redistribution grant for its 2019 workbook.

Those sourced records, workbook, derived seeding tools, research exports, original coordinates/eligibility assignments and their Git history are omitted from this clean release. The historical case and actual route evidence remain privately preserved with provenance. This records the observed source terms and release packaging decision; it makes no legal claim about individual facts or enforceability.

## Files and required fields

Each JSON object may include an ignored `_note`. IDs are unique within their entity type. Scenario and inventory references must resolve to existing IDs. Quantities are kilograms with at most three decimal places; routing requests convert them to integer grams.

| File | Shape and fields |
|---|---|
| `farms.json` | `{ farms: [...] }`. Each farm: `id`, `name`, `lat`, `lng`, `inventory`. Optional `region`, `town`, `color`. `inventory[product_id]` contains `price_eur_kg`, optional `stock_kg` and `moq_kg`. Provided stock is finite and positive; MOQ ≤ stock. A price-only entry is catalogue eligibility awaiting modeled stock confirmation. |
| `restaurants.json` | `{ restaurants: [...] }`. Each restaurant: `id`, `name`, `lat`, `lng`; optional `neighbourhood`. |
| `products.json` | `{ products: [...] }`. Each product: `id`, `label`, `sale_price_eur_kg`, `reference_price_eur_kg`, `farm_gate_typical_eur_kg`; optional `label_es`, `icon`, `synonyms`, `category`. Sale prices drive revenue. Reference prices drive the explicitly illustrative channel comparison. Farm-gate typical values supply the shape-based report, while calculated routes use selected farms' actual input prices. |
| `scenarios.json` | `{ scenarios: [...] }`. Each scenario: `id`, optional `title`, `axes.spread` (`cluster`, `mixed` or `spread`), `lines`. Each line: `restaurant_id`, `product_id`, positive `qty_kg`. Displayed counts/weight are calculated from lines. |
| `depot.json` | `{ depot: {...}, vehicle: {...} }`. Depot: `id`, `name`, `lat`, `lng`. Vehicle: positive `capacity_kg`, `cost_per_km_eur`, `van_hourly_eur`, `van_daily_cap_eur`, `van_billing_buffer_pct`, `driver_hourly_eur`, `driver_billing_buffer_pct`. |

The optional `synthetic: true` entity flag identifies this authored fixture. It is metadata; the route logic uses coordinates and inventory.

## Load your own catalogue

1. Replace the five files with data you are entitled to use, retaining the shapes above and preserving relevant source notices.
2. Update supplier/product/restaurant IDs consistently and choose a vehicle model.
3. Configure an OSRM service covering all locations, with duration/distance table annotations; each catalogue contributes one matrix location per entity plus the depot.
4. Reload the page to reset the catalogue matrix and scenario list. In-page stock/order edits invalidate the displayed decision.
5. Run `npm test` after adjusting the fixture-specific assertions to your catalogue. The independent solver/cost/label regression cases remain applicable.

The example stocks, orders and rates are dated assumptions. Availability, trading permissions, delivery schedules, tax, food handling and operating constraints belong to the operator's actual workflow.
