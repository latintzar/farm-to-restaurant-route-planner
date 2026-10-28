#!/usr/bin/env python3
"""Build the recorded example from the actual application HTML."""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'index.html').read_text()
marker = '<script src="config.js"></script>'
assert source.count(marker) == 1
source = source.replace(marker, marker + '\n<script src="demo/replay.js"></script>')
source = source.replace('</head>', '<link rel="stylesheet" href="demo/replay.css"/>\n</head>')
source = source.replace('<body>', '<body class="recorded-example">')
source = source.replace('</nav>', '<p class="recorded-notice">Recorded Barcelona example · fictional businesses · road data from 28 October 2026. <a href="https://github.com/latintzar/farm-to-restaurant-route-planner#run-locally">Run with your own data</a></p></nav>', 1)
(root / 'demo.html').write_text(source)
print('Built demo.html from index.html')
