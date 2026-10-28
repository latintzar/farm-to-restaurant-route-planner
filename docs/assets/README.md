# Route planner presentation assets

These frames render the actual application with `capture.css`, using the
fictional `barcelona-multi-stop` scenario. The embedded frame combines the
existing map and Route costs card. Phone captures the whole actual map element.

All displayed stops, road geometry and costs come from the application. The
capture layout hides Farm supply, Orders, action buttons and the duplicated
on-map distance/time label. It enlarges the existing card and label typography.
The map retains exact pins, road geometry and all provider attribution. The
surrounding README or portfolio heading names the project, so the embedded
frame gives the source title bar's space to the map.

The example is 250 kg across three farms and three restaurants, with depot
return. Its economics are modeled. The card identifies the browser-capacity
check and VROOM availability.

## Reproduce

Install Python Playwright and Chromium, then run from the repository root:

```sh
python3 docs/assets/render.py --source . --evidence docs/assets/evidence \
  --scenario barcelona-multi-stop --variant embedded --output docs/assets
```

`--chromium` can select a local Chromium executable. The default is
`/snap/bin/chromium`. The capture driver serves source locally and adds named
read/reflow probes in memory within the app closure. Source on disk and its
calculation functions remain unchanged.

The driver replays one successful OSRM matrix and one route response recorded
for this exact fixture. It makes zero live road-solver requests. Map tiles,
source dependencies and source fonts use their declared public GET endpoints.
VROOM requests are blocked in this capture, and the card states that status.

- `route-planner-embedded.png`: 896 × 640 CSS pixels, DPR 2, 1792 × 1280 PNG.
- `route-planner-phone-map.png`: 390 × 544 CSS pixels, DPR 2, 780 × 1088 PNG.
- `capture-proof.json`: exact input, CSS, renderer and PNG hashes; seven stop
  labels in both frames; label/control collisions, map geometry bounds and
  attribution checks.
- `evidence/`: successful response URLs, raw road responses and their hashes.

The basemap uses OpenFreeMap/OpenMapTiles/OpenStreetMap data. Its original
on-map credits remain visible in both images. `asset-sha256.json` inventories
the prepared asset files.

The embedded frame uses 14px stop labels and 14–16px cost rows. At a 750–850px
display width, its stop labels read at 11.7–13.3px. Phone labels use 12px. The
application's actual placement algorithm measures and places all seven callouts
in both frames. `--variant full` also renders the full 1280 × 760 source view.
