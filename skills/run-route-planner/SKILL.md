---
name: run-route-planner
description: Run the recorded Barcelona route-planner example or configure the real application with the developer's own road services and catalogue.
---

# Run the route planner

1. Read README.md and data/README.md. Establish whether the user wants the recorded example or their own data.
2. For the example, run `python3 -m http.server 8080 --bind 127.0.0.1` from the checkout. Open `/demo.html` at that origin. Choose an available loopback port if 8080 is occupied. Keep the server bound to loopback for local use.
3. Verify the completed seven-stop Barcelona route, the 250 kg basket and its Route costs. The road data is recorded; the real application calculates the sourcing choice and costs. The basemap and fonts still need connectivity. Read demo/README.md for provenance.
4. For the user's own catalogue, preserve the five JSON shapes in data/README.md and consistent IDs. Use their supplied/authorized business data. Configure OSRM and optional VROOM URLs in config.js; examples/config.local-services.js and server/README.md document the existing contract. Open `/index.html`.
5. Operate the user's own services for repeated route evaluation. Keep service credentials at a server proxy, outside browser source and chat. Preserve attribution for map/road data and providers.
6. After data/code changes, run `npm test` and `npm run check`. The fixture integrity test describes the included example and must be deliberately updated if the sample is replaced. The independent routing/cost/solver tests still apply.

Describe browser-checked and VROOM-confirmed proposals according to their actual status. Global route optimality, multiple vans and interleaved pickup/delivery search are outside this version's verified model.
