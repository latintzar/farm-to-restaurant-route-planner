# Example data

These five runtime JSON files are a new, fictional Barcelona-area fixture authored on 28 October 2026 for Peter Neyra's release, under his direction. The contribution uses the repository's MIT licence. Names, coordinates, product assignments, quantities, stock, MOQs, prices and vehicle rates were independently selected for the example. They describe an illustrative planning world; any resemblance between an invented business name and a real business is incidental.

The 12 manually chosen coordinate pairs are test points in the Barcelona area. A configured road service snaps/routes these points using its road network, and map/road data retain the relevant provider and OpenStreetMap terms. The commercial fixture's MIT release covers the newly authored inputs, rather than map tiles or returned road datasets.

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
