# Routing services

The frontend needs an OSRM road-data service and can use VROOM to confirm its selected bundle.

## VROOM

```sh
docker compose -f server/docker-compose.yml up -d
```

This preserves the inherited `ghcr.io/vroom-project/vroom-docker:v1.15.0` version. The container is bound to `127.0.0.1:3000`; the version and image availability need a real installation check before release. No image was pulled or container started during candidate preparation.

The browser sends an explicit `car` matrix, one vehicle and pickup/delivery shipments, with amounts/capacity in integer grams. A separate OSRM connection inside VROOM is unnecessary for this custom-matrix request. The browser calls the solver once after selecting a sourcing bundle, with an optional status probe when its status indicator is present.

The application accepts only a successful response with an empty unassigned list and a complete verified route for the expected vehicle. If the service is unavailable or its assignment is incomplete, the browser proposal remains identified as browser checked; the UI records the confirmation outcome.

## OSRM

Bring a regional OSRM car-routing service that covers the 12 supplied Barcelona-area locations. Configure table-size limits for the complete catalogue and provide both duration/distance table annotations plus GeoJSON route geometry. Follow [OSRM's upstream documentation](https://project-osrm.org/docs/v5.24.0/api/) for dataset preparation and serving.

Local default: `http://localhost:5000`. Change it in `config.js`. The frontend directly calls `/table/v1/driving` to cache costs, and `/route/v1/driving` to draw the final route. It uses no haversine substitution when the road service fails.

For a hosted frontend, configure same-origin `/solve` and `/osrm` reverse proxies or explicitly choose CORS-enabled endpoints. The former owner's host, account and deployment configuration are omitted.
