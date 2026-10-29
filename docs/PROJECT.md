# VROOM-based routing for farm-to-table deliveries

The farm-to-restaurant route planner is a VROOM-based app for decentralised farm-to-table logistics. Combine shop orders, compare farm sourcing, and calculate pickups, deliveries, capacity and costs on Barcelona’s roads.

Twenty farms around Barcelona said they could not deliver below their minimum order quantities. Twenty shops said they could not afford those quantities. Pooling orders creates a routing and sourcing problem: which farms, which stops and what delivery cost?

| Feature | What it does |
| --- | --- |
| Nine basket presets | Explore the original small-order, larger-basket, clustered-stop and dispersed-stop scenarios, or build your own. |
| Farm sourcing | Compare the products and quantities available across farms. |
| Real road routes | Use VROOM and a regional OSRM network to calculate Barcelona street routes. |
| Delivery economics | Read goods, van, driver, distance and time together. |
| Mobile order editing | Edit quantities and calculate above the map, with touch-sized controls and visible capacity feedback. |

## Workflow

Choose a basket or add orders → Compare farm supply → Calculate the route → Review capacity and costs → Open the road itinerary

## Design decisions

- Presets keep basket size and stop density visible as separate assumptions.
- Routing and cost assumptions stay editable, so the logistics service can test its actual operating model.

## Status and next steps

The native hosted app calculates routes with the same planner, VROOM service and local Barcelona OSRM network supplied by the source. Farm names, customers, prices and stock in the public example are illustrative. Connect your own stock, customers, delivery costs and regional road data.

Source: [docs/architecture.md](../docs/architecture.md), [docs/scenarios.md](../docs/scenarios.md), [docs/setup.md](../docs/setup.md).
