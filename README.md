# Farm-to-restaurant route planner

VROOM-based routing for farm-to-table deliveries

Farm-to-restaurant route planner is a VROOM-based planning tool for decentralised farm-to-table logistics. Choose a basket or build an order, compare farm sourcing, and calculate pickup and delivery routes, vehicle capacity and costs on real roads.

[Open demo](https://atelierneyra.com/preview/route-planner/) · [Website](https://atelierneyra.com/route-planner) · [Product tour](docs/product-tour.md) · [Documentation](https://docs.atelierneyra.com/route-planner/overview/)

![Farm-to-restaurant route planner](https://atelierneyra.com/assets/product-motion-v4/route-planner.jpg)

## The problem

The design grew from conversations with 20 farms and 20 shops around Barcelona. Farms said they could not deliver below their minimum order quantities; shops said they could not afford those quantities. The planner tests whether pooled orders and shared pickups can make a delivery workable.

## Product areas

| Area | What you can do |
| --- | --- |
| Basket presets and orders | Compare nine small, large, clustered and dispersed baskets, or edit customers, products and quantities. |
| Farm supply | Compare stock, supplier prices and minimum order quantities when sourcing the basket. |
| Road routing | Calculate Barcelona pickups and deliveries with OSRM road data and optional VROOM confirmation. |
| Delivery economics | Inspect goods, fuel, van rental, driver time, capacity and gross profit together. |
| Route and modeling reports | Follow the stop itinerary or compare the baskets’ modeled economics. |

## Explore the app

Open **Presets**, choose **3 chefs · 4 items · 250kg**, then **Calculate**. Inspect the pickup and delivery stops, route-check status and cost breakdown. Change an order or the available supply and calculate again. The [product tour](docs/product-tour.md) follows that complete journey and links each area to its implementation.

On phones, the map fills the available viewport; Orders and Supply open full-screen panels, with Calculate and its result kept within reach. Desktop keeps the supply, map and order columns.

The hosted app runs the actual planner with native VROOM and a local Barcelona OSRM network. Its businesses, stock, prices and orders are fictional examples. The separate `demo.html` replays a dated recorded route. [All nine baskets, assumptions and verification](docs/routing-and-operations.md).

## Run locally

Python 3 serves the frontend. Calculating routes requires your OSRM service covering Barcelona; VROOM provides optional confirmation of the selected sourcing bundle.

```sh
git clone https://github.com/latintzar/farm-to-restaurant-route-planner.git
cd farm-to-restaurant-route-planner
python3 -m http.server 8080 --bind 127.0.0.1
```

Open **http://127.0.0.1:8080**. Configure the services you operate or are authorized to use in [config.js](config.js); local defaults are OSRM on port 5000 and VROOM on port 3000. Follow [routing and operations](docs/routing-and-operations.md#run-locally) for endpoint requirements, road import, CORS and hosted configuration, or [set up with your agent](skills/run-route-planner/SKILL.md).

## Build with it

- [Product tour](docs/product-tour.md): user journey, product areas and source map.
- [Architecture and decisions](docs/ARCHITECTURE.md): sourcing, route search, capacity and solver admission.
- [Routing and operations](docs/routing-and-operations.md): complete calculation sequence, assumptions, presets and checks.
- [Data guide](data/README.md): replace the fictional catalogue with stock and customer data you can use.
- [Native hosting](server/native/README.md): bounded OSRM/VROOM services and persistent usage caps.
- [Mobile interactions](docs/MOBILE-UX.md): shared state, panels and responsive checks.

Peter Neyra’s code and newly authored example fixture use the [MIT licence](LICENSE). External software, map tiles and road data retain their terms; see [THIRD_PARTY.md](THIRD_PARTY.md). The historical producer catalogue stays in its private case archive, with the publisher’s redistribution restriction recorded in the [data guide](data/README.md).

[made by atelier neyra](https://atelierneyra.com)
