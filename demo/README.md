# Recorded Barcelona example

`demo.html` runs the actual application against the fictional public catalogue and two recorded OSRM responses. The browser calculates the selected suppliers, stop order and costs. The example keeps the basket fixed; map navigation, stock filtering and cost views remain available.

Road data was retrieved on 28 October 2026 for `barcelona-multi-stop`. The exact request URLs, SHA256 hashes and responses are in `evidence/`. Rendering the example makes zero live routing requests. The basemap, fonts and browser libraries retain their normal network requirements. VROOM is explicitly unconfigured; the result retains the browser proposal's capacity-check status.

The recorded road responses derive from OpenStreetMap and retain its [ODbL 1.0](https://www.openstreetmap.org/copyright) terms and attribution. They are separate from the MIT fictional business inputs. Map attribution remains visible in the application.

Run from the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080/demo.html`. Use `index.html` with your configured OSRM/VROOM services for other baskets and catalogues.

`python3 tools/build-demo.py` regenerates the example HTML from `index.html`. `replay.js` only supplies exact recorded road responses and selects the example through the application's own controls; it contains no route or cost implementation.
