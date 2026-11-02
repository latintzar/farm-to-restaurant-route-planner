"""Native mobile layout/interaction regression; live routing is explicitly opt-in.

The default UI suite supplies a synthetic matrix only for startup, fences routing
network traffic, and never calculates a route. ROUTER_BASE_URL can select an owned
preview; ROUTER_LIVE_CALCULATE=1 additionally proves one real road/VROOM result.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from urllib.parse import urlparse
import json,os,threading,tempfile
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1];proof=Path(os.environ.get('ROUTER_PROOF_DIR',str(Path(tempfile.gettempdir())/'router-mobile-proof')));proof.mkdir(parents=True,exist_ok=True)
server=None
if os.environ.get('ROUTER_BASE_URL'):origin=os.environ['ROUTER_BASE_URL'].rstrip('/')
else:
 class Quiet(SimpleHTTPRequestHandler):
  def log_message(self,*args):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_address[1]}'
live=os.environ.get('ROUTER_LIVE_CALCULATE')=='1';result={'origin':origin,'live_calculation':live,'page_errors':[],'http_errors':[],'unconfigured_routing_requests':[],'checks':{}}
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('ROUTER_CHROMIUM'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 context=browser.new_context(viewport={'width':320,'height':568},has_touch=True,is_mobile=True)
 service=origin if live else 'https://routing-ui-fixture.invalid'
 context.add_init_script(f"localStorage.osrmEndpoint={json.dumps(service+'/osrm')};localStorage.vroomEndpoint={json.dumps(service+'/solve')}")
 def fence(route):
  u=route.request.url;host=urlparse(u).hostname or ''
  if host=='routing-ui-fixture.invalid':
   if '/table/v1/driving/' in u:
    n=len(urlparse(u).path.split('/driving/')[1].split(';'));matrix=[[abs(i-j)*60 for j in range(n)]for i in range(n)]
    route.fulfill(json={'code':'Ok','durations':matrix,'distances':[[v*10 for v in row]for row in matrix]})
   else:route.fulfill(json={'code':0})
  elif host in ['router.project-osrm.org','recorded-example.invalid'] or u.startswith(('http://localhost:5000','http://localhost:3000')):
   result['unconfigured_routing_requests'].append(u);route.abort()
  else:route.continue_()
 context.route('**/*',fence);page=context.new_page();page.on('pageerror',lambda e:result['page_errors'].append(str(e)));page.on('response',lambda r:result['http_errors'].append({'status':r.status,'path':r.url}) if r.url.startswith(origin) and r.status>=400 else None)
 page.goto(origin+'/',wait_until='domcontentloaded');page.wait_for_selector('#farm-cards .farm-card',state='attached',timeout=45000);page.wait_for_function("document.querySelector('#rc-slot').parentElement.id==='mobile-calc-host'")
 def check(name,value):
  result['checks'][name]=value
  (proof/'checks-partial.json').write_text(json.dumps(result,indent=2)+'\n');assert value,name
 def geometry(selector):return page.locator(selector).bounding_box()
 def full_dialog(selector,w,h):
  r=geometry(selector);return bool(r and abs(r['x'])<1 and abs(r['y'])<1 and abs(r['width']-w)<1 and abs(r['height']-h)<1)
 def layout(name,w,h):
  r=geometry('#map');footer=geometry('#mobile-routebar');result.setdefault('geometry',{})[name]={'map':r,'footer':footer};check(name+'_map_fills_viewport',abs(r['x'])<1 and abs(r['y']-56)<1 and abs(r['width']-w)<1 and abs(r['height']-(h-56))<1)
  check(name+'_no_page_overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight'))
  check(name+'_calculate_reachable',footer['y']>=56 and footer['y']+footer['height']<=h and geometry('#calculate')['height']>=44)
  for selector in ['#open-scenarios','#mobile-orders','#mobile-supply']:check(name+selector+'_touch44',geometry(selector)['height']>=44)
 layout('phone320',320,568);check('empty_calculate_disabled',page.locator('#calculate').is_disabled());page.wait_for_timeout(1600);page.screenshot(path=str(proof/'map-320.png'))
 page.locator('#open-scenarios').click();check('presets_fullscreen320',full_dialog('#scenarios-modal',320,568));check('all_nine_presets',page.locator('#scenario-list .scenario').count()==9);result['preset_ids']=page.locator('#scenario-list .scenario').evaluate_all('(els)=>els.map(e=>e.dataset.id)');page.screenshot(path=str(proof/'presets-320.png'))
 page.locator('.scenario[data-id="1r-1i-tiny"]').click();check('preset_25kg_loaded','25 kg' in page.locator('#mobile-summary-title').inner_text());check('preset_closes_dialog',not page.locator('#scenarios-modal').evaluate('(e)=>e.open'));check('loaded_calculate_enabled',page.locator('#calculate').is_enabled())
 page.locator('#mobile-orders').click();check('orders_fullscreen320',full_dialog('#mobile-panel',320,568));check('orders_one_original_line',page.locator('.ol-qty-input').count()==1);page.locator('.ol-qty-input').fill('30');page.locator('.ol-qty-input').dispatch_event('change');check('quantity_edit_updates_native_summary','30 kg' in page.locator('#mobile-summary-title').inner_text());page.screenshot(path=str(proof/'orders-320.png'))
 page.locator('#open-add-order').click();check('new_order_fullscreen320',full_dialog('#add-order-modal',320,568));page.locator('#order-product-search').fill('tom');page.locator('#order-product-autocomplete .autocomplete-row').first.click();page.locator('#order-qty').fill('5')
 page.set_viewport_size({'width':320,'height':400});page.locator('#order-qty').focus();page.locator('#order-add').scroll_into_view_if_needed();check('short_viewport_submit_reachable',geometry('#order-add')['y']+geometry('#order-add')['height']<=400.5);page.locator('#order-add').click();page.set_viewport_size({'width':320,'height':568});check('native_order_add_keeps_parent_panel',page.locator('#mobile-panel').evaluate('(e)=>e.open') and not page.locator('#add-order-modal').evaluate('(e)=>e.open'));check('native_order_added',page.locator('.ol-qty-input').count()==2);page.locator('#mobile-panel-close').click();page.wait_for_function("!document.querySelector('#mobile-panel').open")
 page.locator('#mobile-supply').click();check('supply_fullscreen320',full_dialog('#mobile-panel',320,568));check('supply_has_native_six_farms',page.locator('#farm-cards .farm-card').count()==6);page.locator('.svt-btn[data-view="product"]').click();check('native_product_view',page.locator('#farm-cards .product-card').count()>0);page.locator('#farms-add').click();check('stock_form_fullscreen320',full_dialog('#add-stock-modal',320,568));page.keyboard.press('Escape');check('stock_escape_preserves_parent',page.locator('#mobile-panel').evaluate('(e)=>e.open') and not page.locator('#add-stock-modal').evaluate('(e)=>e.open'))
 page.locator('#open-report').click();check('economics_fullscreen320',full_dialog('#report-modal',320,568));check('economics_nine_presets',page.locator('#rep-scenarios-table .rep-row').count()==9);page.locator('#report-close').focus();page.locator('#mobile-supply').evaluate('(e)=>e.focus()');check('native_background_focus_blocked',page.evaluate("document.querySelector('#report-modal').contains(document.activeElement)"));page.keyboard.press('Tab');check('native_keyboard_focus_inside_dialog',page.evaluate("document.querySelector('#report-modal').contains(document.activeElement)"));page.keyboard.press('Escape');page.keyboard.press('Escape');page.wait_for_function("!document.querySelector('#mobile-panel').open")
 check('focus_restored_to_supply',page.locator('#mobile-supply').evaluate('(e)=>e===document.activeElement'));check('footer_restored_after_panel',page.locator('#mobile-routebar').evaluate('(e)=>e.parentElement===document.body'))
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150);layout('phone390',390,844);page.locator('#open-scenarios').click();page.locator('.scenario[data-id="3r-cluster"]').click();check('cluster_250kg_loaded','250 kg' in page.locator('#mobile-summary-title').inner_text())
 if live:
  with page.expect_response(lambda r:'/osrm/route/v1/driving/' in r.url,timeout=90000) as road:page.locator('#calculate').click()
  road_response=road.value;road_data=road_response.json();(proof/'live-road-response.json').write_text(json.dumps({'url':road_response.url,'status':road_response.status,'response':road_data},indent=2)+'\n');page.wait_for_selector('#rc-slot[data-state="done"]',timeout=90000);check('actual_road_geometry',road_data['code']=='Ok' and len(road_data['routes'][0]['geometry']['coordinates'])>100)
  result['native_result']={s:page.locator('#'+s).text_content() for s in ['cs-distance','cs-time','cs-goods','cs-van','cs-driver','route-feasibility','mobile-summary-title','mobile-summary-detail']};page.screenshot(path=str(proof/'calculated-map-390.png'));check('mobile_result_details_enabled',page.locator('#mobile-details').is_visible());page.locator('#mobile-details').click();check('breakdown_fullscreen390',full_dialog('#breakdown-modal',390,844));page.screenshot(path=str(proof/'route-details-390.png'));page.keyboard.press('Escape')
 page.locator('#mobile-orders').click();page.set_viewport_size({'width':1600,'height':1000});page.wait_for_timeout(250);check('resize_closes_phone_panel',not page.locator('#mobile-panel').evaluate('(e)=>e.open'));check('desktop_presets_restored',page.locator('#open-scenarios').evaluate("e=>e.closest('.basket-head-actions')!==null"));check('desktop_calculate_restored',page.locator('#rc-slot').evaluate("e=>e.closest('.card-runcost')!==null"));check('desktop_three_columns_visible',all(page.locator(s).is_visible() for s in ['.col-left','.col-map','.col-right']));check('desktop_no_overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'));page.screenshot(path=str(proof/'desktop-1600.png'))
 page.set_viewport_size({'width':390,'height':844});page.emulate_media(reduced_motion='reduce');page.wait_for_timeout(150);layout('reduced390',390,844);check('reduced_motion_has_no_loop',page.locator('.route-glow-pane').evaluate("e=>parseFloat(getComputedStyle(e).animationDuration)<.01 && getComputedStyle(e).animationIterationCount==='1'"));check('zero_page_errors',not result['page_errors']);check('zero_local_http_errors',not result['http_errors']);check('zero_unconfigured_routing_requests',not result['unconfigured_routing_requests']);browser.close()
result['passed']=True;(proof/'checks.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
if server:server.shutdown()
