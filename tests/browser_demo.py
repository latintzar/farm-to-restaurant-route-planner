from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from functools import partial
from playwright.sync_api import sync_playwright
import threading,json,os,tempfile
base=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(base)))
threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_address[1]}'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('ROUTER_CHROMIUM'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 c=b.new_context(viewport={'width':1600,'height':1000});requests=[];errors=[];missing=[]
 def handle(route):
  u=route.request.url
  if 'router.project-osrm.org' in u or 'recorded-example.invalid' in u or u.startswith('http://localhost:3000'):
   requests.append(u);route.abort()
  else:route.continue_()
 c.route('**/*',handle)
 page=c.new_page();page.on('pageerror',lambda err:errors.append(str(err)))
 page.on('response',lambda r:missing.append(r.url) if r.url.startswith(origin) and r.status>=400 else None)
 page.goto(origin+'/demo.html',wait_until='domcontentloaded');page.wait_for_selector('.calc-result',timeout=45000);page.wait_for_timeout(1500)
 assert '+€227' in page.locator('.calc-result').inner_text()
 assert len(page.locator('.route-name').all())==7
 assert page.locator('#calculate').is_disabled()
 page.locator('#open-breakdown').click();page.wait_for_selector('#breakdown-modal:not(.hidden)');assert 'Browser proposal' in page.locator('#breakdown-modal').inner_text() or 'capacity' in page.locator('#breakdown-modal').inner_text().lower()
 page.locator('#breakdown-close').click()
 def measure():return page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,navBottom:document.querySelector(".nav").getBoundingClientRect().bottom,mapTop:document.querySelector("#map").getBoundingClientRect().top})')
 desktop=measure();page.screenshot(path=str(Path(tempfile.gettempdir())/'router-demo-desktop.png'))
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(1500);phone=measure();page.screenshot(path=str(Path(tempfile.gettempdir())/'router-demo-phone.png'),full_page=True)
 assert desktop['width']==desktop['scrollWidth'] and phone['width']==phone['scrollWidth']
 assert desktop['mapTop']>=desktop['navBottom'] and phone['mapTop']>=phone['navBottom']
 assert not requests and not errors and not missing
 result={'desktop':desktop,'phone':phone,'browser_errors':errors,'live_routing_requests':requests,'missing_local':missing,'calculated_result':page.locator('.calc-result').inner_text()}
 (Path(tempfile.gettempdir())/'router-demo-proof.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));b.close()
server.shutdown()
