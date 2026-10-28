#!/usr/bin/env python3
"""Render source-faithful public route-planner presentation frames.

Uses actual source UI and calculations, plus capture.css. Only exact recorded
OSRM responses are replayed; this script makes no live road-solver requests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_receipt(path: Path) -> dict:
    content=path.read_bytes()
    assert content[:8] == b'\x89PNG\r\n\x1a\n'
    width,height=struct.unpack('>II',content[16:24])
    return {'file':path.name,'width':width,'height':height,'sha256':sha(path)}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


MEASURE = r"""() => {
  const box = el => {
    const r = el.getBoundingClientRect();
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,
      width:r.width,height:r.height};
  };
  const visible = el => {
    const s = getComputedStyle(el), r=el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const map=document.querySelector('#map'), bounds=box(map);
  const labels=[...map.querySelectorAll('.route-name,.route-stat')]
    .filter(visible).map(el=>({text:el.textContent.trim().replace(/\s+/g,' '),
      type:el.classList.contains('route-name')?'stop':'metric',
      fontSize:parseFloat(getComputedStyle(el).fontSize),...box(el)}));
  const controls=[...map.querySelectorAll('.leaflet-control')]
    .filter(visible).map(el=>({class:el.className,...box(el)}));
  const overlaps=(a,b,gap=0)=>a.left < b.right + gap && a.right + gap > b.left
    && a.top < b.bottom + gap && a.bottom + gap > b.top;
  const collisions=[];
  labels.forEach((a,i)=>labels.slice(i+1).forEach(b=>{
    if(overlaps(a,b))collisions.push([a.text,b.text]);
  }));
  const controlCollisions=[];
  labels.forEach(a=>controls.forEach(b=>{
    if(overlaps(a,b))controlCollisions.push([a.text,b.class]);
  }));
  const outside=labels.filter(r=>r.left < bounds.left - .5 || r.top < bounds.top - .5
    || r.right > bounds.right + .5 || r.bottom > bounds.bottom + .5).map(r=>r.text);
  const cost=document.querySelector('.card-runcost');
  const decision=__captureRouter.getDecision();
  const layer=Object.values(__captureMap._layers)
    .find(l=>typeof l.getMaplibreMap === 'function');
  const points=(decision.routeGeometry || []).map(p=>__captureMap.latLngToContainerPoint(p));
  return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    documentWidth:document.documentElement.scrollWidth,map:bounds,labels,controls,
    labelCollisions:collisions,controlCollisions,outsideLabels:outside,
    expectedStopLabels:__captureRouter.groupRouteStops(decision.route).length,
    cost:visible(cost)?{bounds:box(cost),text:cost.innerText}:null,
    mapState:{zoom:__captureMap.getZoom(),center:__captureMap.getCenter(),
      basemapReady:layer?layer.getMaplibreMap().loaded():null},
    attribution:map.querySelector('.leaflet-control-attribution')?.innerText,
    geometryScreenBounds:{left:Math.min(...points.map(p=>p.x)),
      right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),
      bottom:Math.max(...points.map(p=>p.y))},
    fonts:{archivo:document.fonts.check('900 34px Archivo'),
      jetbrainsMono:document.fonts.check('700 11px "JetBrains Mono"')},
    route:decision.route.map(({id,kind,name,lat,lng})=>({id,kind,name,lat,lng})),
    geometry:decision.routeGeometry,
    result:document.querySelector('#calculate').innerText};
}"""


def validate_measurement(measurement: dict, *, desktop: bool) -> None:
    assert measurement['documentWidth'] == measurement['viewport']['width'], 'horizontal page overflow'
    assert not measurement['labelCollisions'], 'route labels overlap'
    assert not measurement['controlCollisions'], 'route labels overlap map controls'
    assert not measurement['outsideLabels'], 'route labels leave map bounds'
    assert sum(label['type'] == 'stop' for label in measurement['labels']) == measurement['expectedStopLabels'], 'missing chosen-route stop labels'
    assert measurement['attribution'] and 'OpenFreeMap' in measurement['attribution'] and 'OpenStreetMap' in measurement['attribution'], 'missing map attribution'
    assert all(measurement['fonts'].values()), 'source fonts did not load'
    assert measurement['mapState']['basemapReady'] is True, 'basemap did not finish loading'
    assert measurement.get('geometry'), 'actual road geometry is absent'
    geometry=measurement['geometryScreenBounds']
    assert geometry['left'] >= 0 and geometry['right'] <= measurement['map']['width'], 'road geometry clipped horizontally'
    assert geometry['top'] >= 0 and geometry['bottom'] <= measurement['map']['height'], 'road geometry clipped vertically'
    if desktop:
        card = measurement['cost']['bounds']
        assert card['top'] >= 0 and card['bottom'] <= measurement['viewport']['height'], 'cost card is clipped'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--scenario', required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent / 'output')
    parser.add_argument('--chromium', default='/snap/bin/chromium')
    parser.add_argument('--variant',choices=['full','embedded'],default='full')
    parser.add_argument('--phone-height', type=int,
        help='Phone viewport height; the image captures the whole map below the 72px source title.')
    args = parser.parse_args()
    source=args.source.resolve()
    evidence=args.evidence.resolve()
    output=args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    css=Path(__file__).resolve().with_name('capture.css')
    manifest=json.loads((evidence/'capture.json').read_text())
    fixtures={}
    for entry in manifest['osrm']:
        path=(evidence/entry['file']).resolve()
        assert path.is_relative_to(evidence), 'road fixture must stay under evidence folder'
        assert sha(path) == entry['sha256'], f"road fixture hash mismatch: {entry['file']}"
        assert entry.get('status',200) == 200
        parsed=urlparse(entry['url'])
        assert parsed.scheme == 'https' and parsed.netloc == 'router.project-osrm.org'
        assert parsed.path.startswith(('/table/v1/driving/','/route/v1/driving/'))
        fixtures[entry['url']]=path.read_bytes()
    assert len(fixtures) == 2, 'expected one exact table and one exact geometry response'
    assert sum('/table/' in url for url in fixtures) == 1
    assert sum('/route/' in url for url in fixtures) == 1
    source_hashes={str(path.relative_to(source)):sha(path) for path in
        [source/'index.html',source/'style.css',source/'app.js',source/'config.js',*sorted((source/'data').glob('*.json'))]}
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(source)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_address[1]}'
    hits=[]
    blocked=[]
    external=[]
    failed=[]
    errors=[]
    # No data changes: expose the actual Leaflet map only for measured evidence.
    probe='L.Map.addInitHook(function(){window.__captureMap=this;});\n'
    app_source=(source/'app.js').read_text()
    export_marker="\nif (typeof module !== 'undefined' && module.exports) {"
    assert app_source.count(export_marker)==1, 'expected the exact source module-export boundary'
    closure_probe='''\nwindow.__captureRouter=Object.freeze({
      getDecision:()=>STATE.lastDecision,
      fitChosenRoute,layoutRouteLabels,groupRouteStops
    });\n'''
    instrumented_app=probe+app_source.replace(export_marker,closure_probe+export_marker,1)
    allowed_hosts={'unpkg.com','fonts.googleapis.com','fonts.gstatic.com','tiles.openfreemap.org'}
    try:
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(executable_path=args.chromium,headless=True,
                args=['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            desktop_viewport={'width':896,'height':640} if args.variant=='embedded' else {'width':1280,'height':760}
            context=browser.new_context(viewport=desktop_viewport,device_scale_factor=2,
                reduced_motion='reduce')
            def handle(route):
                request=route.request
                url=request.url
                parsed=urlparse(url)
                if url == origin+'/app.js':
                    route.fulfill(status=200,content_type='application/javascript',body=instrumented_app)
                elif url in fixtures:
                    assert request.method == 'GET'
                    hits.append(url)
                    route.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=fixtures[url])
                elif url.startswith(origin+'/'):
                    route.continue_()
                elif parsed.netloc in allowed_hosts and request.method == 'GET':
                    external.append({'url':url,'method':request.method})
                    route.continue_()
                else:
                    blocked.append({'url':url,'method':request.method})
                    route.abort()
            context.route('**/*',handle)
            context.add_init_script("localStorage.setItem('osrmEndpoint','https://router.project-osrm.org');")
            page=context.new_page()
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('requestfailed',lambda request:failed.append({'url':request.url,'failure':request.failure}))
            page.goto(origin+'/',wait_until='domcontentloaded',timeout=60000)
            page.wait_for_selector('#farm-cards .farm-card',timeout=60000)
            page.evaluate('document.fonts.ready')
            page.locator('#open-scenarios').click()
            page.locator(f'.scenario[data-id="{args.scenario}"]').click()
            page.locator('#calculate').click()
            page.wait_for_selector('.calc-result',timeout=45000)
            page.add_style_tag(path=str(css))
            page.evaluate("embedded => {document.documentElement.classList.add('capture-view'); if(embedded)document.documentElement.classList.add('capture-embedded'); __captureMap.invalidateSize({animate:false}); __captureRouter.fitChosenRoute(); __captureRouter.layoutRouteLabels();}",args.variant=='embedded')
            page.wait_for_function("Object.values(__captureMap._layers).some(l => typeof l.getMaplibreMap === 'function' && l.getMaplibreMap().loaded())",timeout=45000)
            page.wait_for_timeout(750)
            page.evaluate('document.fonts.ready')
            page.evaluate('__captureRouter.layoutRouteLabels()')
            page.wait_for_timeout(100)
            desktop=page.evaluate(MEASURE)
            desktop_path=output/('route-planner-embedded.png' if args.variant=='embedded' else 'route-planner-desktop.png')
            page.screenshot(path=str(desktop_path),animations='disabled')
            validate_measurement(desktop,desktop=True)
            phone_height=args.phone_height or (544 if args.variant=='embedded' else 616)
            page.set_viewport_size({'width':390,'height':phone_height})
            page.evaluate('__captureMap.invalidateSize({animate:false}); __captureRouter.fitChosenRoute(); __captureRouter.layoutRouteLabels();')
            page.wait_for_function("Object.values(__captureMap._layers).some(l => typeof l.getMaplibreMap === 'function' && l.getMaplibreMap().loaded())",timeout=45000)
            page.wait_for_timeout(750)
            page.evaluate('__captureRouter.layoutRouteLabels()')
            page.wait_for_timeout(100)
            phone=page.evaluate(MEASURE)
            phone_path=output/'route-planner-phone-map.png'
            page.locator('#map').screenshot(path=str(phone_path),animations='disabled')
            validate_measurement(phone,desktop=False)
            assert not errors, 'browser errors recorded'
            assert set(hits) == set(fixtures), 'both exact road fixtures must be used'
            unexpected_road=[item for item in blocked if 'router.project-osrm.org' in item['url']]
            assert not unexpected_road, 'actual calculation requested unmatched road data'
            assert source_hashes == {name:sha(source/name) for name in source_hashes}, 'source changed during capture'
            receipt={'title':page.title(),'scenario':args.scenario,'variant':args.variant,'source':'Project root; exact input bytes identified by source_sha256.','source_sha256':source_hashes,
                'capture_css_sha256':sha(css),'renderer_sha256':sha(Path(__file__)),
                'instrumentation':{'kind':'In-memory Leaflet-map hook and named closure probes only; original app bytes retained unchanged.',
                    'instrumented_app_sha256':hashlib.sha256(instrumented_app.encode()).hexdigest(),
                    'exposed_functions':['getDecision','fitChosenRoute','layoutRouteLabels','groupRouteStops']},
                'road_evidence_manifest_sha256':sha(evidence/'capture.json'),
                'road_requests_replayed':hits,'live_road_solver_requests':0,
                'data_rule':'Fictional public source fixture only; all displayed values from actual app calculation.',
                'desktop':desktop,'phone':phone,'browser_errors':errors,
                'external_requests':external,'blocked_requests':blocked,'failed_requests':failed,
                'outputs':[image_receipt(path) for path in [desktop_path,phone_path]]}
            (output/'capture-proof.json').write_text(json.dumps(receipt,indent=2,ensure_ascii=False)+'\n')
            browser.close()
            print(json.dumps({'title':receipt['title'],'scenario':args.scenario,
                'outputs':receipt['outputs'],'result':desktop['result'],
                'label_count':len(desktop['labels']),'phone_label_count':len(phone['labels']),
                'live_road_solver_requests':0,'browser_errors':errors},indent=2,ensure_ascii=False))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
