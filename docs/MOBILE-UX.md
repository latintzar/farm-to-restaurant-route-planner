# Mobile route planning

On screens up to 880 px, the map fills the viewport below the Atelier navigation. Presets, Orders and Supply sit above it; Calculate and the actual basket/road summary stay at the bottom. Desktop keeps the original three columns.

The phone panels move the existing order, supply and calculation nodes into a full-screen native dialog. They share the same state, event handlers and computation with desktop. Editing a quantity invalidates the previous result. Calculate closes the panel and displays progress on the map. Resizing to desktop restores every node to its original position.

Presets, order entry, farm stock, economics and route details also use native dialogs. On phones they fill the available viewport, with a persistent close action, scrollable content and a reachable form submission action. Native dialog behavior contains keyboard focus, dismisses the foremost dialog with Escape and restores focus to its opener.

The map fits a calculated route around the overlaid controls. Callout placement reserves their actual rectangles while keeping each stop's original coordinates. Touch controls are at least 44 px high; form inputs use a 16 px font. Dynamic viewport units and safe-area insets keep the map and actions fitted as available space changes. Reduced motion suppresses the original route/glow animation loops.

## Verification

```sh
npm test
npm run check
python3 tests/browser_demo.py
python3 tests/browser_mobile.py
```

The default mobile suite uses a clearly synthetic startup matrix and makes zero live routing requests. It checks 320/390/desktop layout, all nine presets, real order editing, nested fullscreen forms, focus and Escape behavior, short-viewport submission, responsive restoration and reduced motion. The recorded example separately checks its unchanged recorded route/cost result.

An operator can additionally test one real calculation against their own native preview:

```sh
ROUTER_BASE_URL=http://127.0.0.1:8080 \
ROUTER_LIVE_CALCULATE=1 \
ROUTER_PROOF_DIR=/tmp/route-mobile-live \
python3 tests/browser_mobile.py
```

That origin must serve this source and its same-origin `/osrm` and `/solve` adapters. The live mode selects the 250 kg cluster preset, records the actual OSRM road geometry and visible result, and opens the result breakdown. It consumes the operator's normal service quotas. Physical iOS/Android keyboard and device performance remain device checks; the short-viewport browser check tests the layout's response to reduced available height.
