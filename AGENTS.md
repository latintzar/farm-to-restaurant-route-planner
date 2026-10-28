# Working on the route planner

Start with README.md, docs/ARCHITECTURE.md and data/README.md. The original project was Vitrina’s routing simulator; this independent release keeps its actual interface and route/cost implementation.

For the first result, follow skills/run-route-planner/SKILL.md. The fixed recorded example needs Python 3 and browser network access for map libraries, tiles and fonts. It makes zero live routing or solver calls. Other baskets require an explicitly configured OSRM service; VROOM confirmation is optional.

Keep the boundaries visible: authored commercial inputs are fictional and MIT; recorded road data retains ODbL attribution; computed browser proposals have a capacity check; VROOM confirmation requires a complete validated response. Missing road geometry must stop the calculation. A marketing image uses the actual application, its calculated values and unchanged stop coordinates.

Run `npm test` and `npm run check` for logic changes. `python3 tests/browser_demo.py` uses Playwright Chromium to exercise the actual recorded example at desktop/phone sizes, inspect costs and enforce zero live routing requests. `python3 tools/build-demo.py` regenerates demo.html after index.html changes.

The private historical producer catalogue and original Git history stay outside this repository. Replace the sample data with inputs you are entitled to use. Shared service credentials belong in a server proxy; avoid adding them to browser source, fixtures or chat.
