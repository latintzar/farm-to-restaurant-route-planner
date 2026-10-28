# Attribution and external terms

Peter Neyra's original code and the newly authored fictional business fixture use the [MIT licence](LICENSE). Map, road-service and dependency material keeps its own licence and attribution.

| Material | Provenance and terms |
|---|---|
| Fictional commercial fixture | The five `data/*.json` files were independently authored on 28 October 2026 for this release. MIT covers these new names, manually selected test points, inventories, baskets, prices and vehicle assumptions. [Data provenance and schema](data/README.md). |
| Historical producer catalogue | Omitted from the public export. The [Parc Agrari notice](https://parcagrari.cat/info-legal) requires written authorization for redistribution of its content/information. [Benvinguts a Pagès](https://benvingutsapages.cat/) reserves rights. The bounded review established no affirmative redistribution grant for that catalogue. The private historical case remains preserved. |
| Leaflet 1.9.4 | Loaded unmodified from unpkg; [BSD-2-Clause licence](https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE). |
| MapLibre GL 5.7.1 | Loaded unmodified from unpkg; [upstream source/notices](https://github.com/maplibre/maplibre-gl-js/tree/v5.7.1). |
| MapLibre GL Leaflet binding 0.1.4 | Loaded unmodified from unpkg; [upstream source/notices](https://github.com/maplibre/maplibre-gl-leaflet). |
| OpenFreeMap Positron | Default vector basemap through its [official Leaflet integration](https://openfreemap.org/quick_start/#using-leaflet). Visible attribution retains OpenFreeMap, OpenMapTiles and OpenStreetMap. Follow the provider's current service terms. |
| OpenStreetMap | Visible map attribution remains; [copyright/data terms](https://www.openstreetmap.org/copyright) apply separately to OSM data. Configured OSRM services generally route regional OSM data and retain its relevant terms. |
| Recorded road responses | `demo/evidence/osrm-table.json` and `osrm-route.json` were returned by the public OSRM evaluation service on 28 October 2026. Their OSM-derived data retains [ODbL 1.0 and OSM attribution](https://www.openstreetmap.org/copyright), separately from MIT code/business inputs. Exact requests and hashes are in `demo/evidence/capture.json`. |
| OSRM | Operator-selected routing service; [upstream source/licence](https://github.com/Project-OSRM/osrm-backend). Routing profile, regional map-data terms and operator service policy remain applicable. The source export provides local URLs rather than an automatically selected public routing service. |
| VROOM | Optional solver, inherited container version v1.15.0; [upstream source/licence](https://github.com/VROOM-Project/vroom). The original upstream project and container keep their terms. |
| Archivo / JetBrains Mono | Loaded through Google Fonts; retain upstream notices if vendoring. [Archivo](https://github.com/Omnibus-Type/Archivo), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono). |
| Google Maps outbound link | Opens the selected coordinates in the external mapping product; that service retains its own terms. |

The public export excludes historical sourced records, research workbooks/exports, their derived catalogue/price-seeding scripts, owner deployment tooling, runtime state, credentials and previous Git history. A clean-export manifest records source hashes without including the omitted records. This packaging review is bounded; it is not a comprehensive legal or secret audit.
