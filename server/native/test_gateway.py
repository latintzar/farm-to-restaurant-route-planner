import copy,importlib.util,json,tempfile,unittest,threading
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib.parse import urljoin
from pathlib import Path
spec=importlib.util.spec_from_file_location('gateway',Path(__file__).with_name('gateway.py'))
gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)

def payload():
 return {'vehicles':[{'id':1,'start_index':0,'end_index':0,'capacity':[10000]}], 'shipments':[{'amount':[10000],'pickup':{'id':1,'location_index':1,'service':180},'delivery':{'id':2,'location_index':2,'service':180}}], 'matrices':{'car':{'durations':[[0,10,20],[10,0,10],[20,10,0]],'distances':[[0,100,200],[100,0,100],[200,100,0]]}}}

class GatewayBounds(unittest.TestCase):
 def test_actual_app_shape_is_accepted(self):
  self.assertEqual(gateway.validate_payload(payload()),payload())
 def test_resource_and_command_shapes_are_bounded(self):
  examples=[]
  p=payload();p['options']={'g':True};examples.append(p)
  p=payload();p['vehicles'][0]['capacity']=[650001];examples.append(p)
  p=payload();p['shipments'][0]['delivery']['id']=1;examples.append(p)
  p=payload();p['shipments'][0]['pickup']['location_index']=99;examples.append(p)
  p=payload();p['matrices']['car']['durations'][0][1]=float('nan');examples.append(p)
  p=payload();p['matrices']['car']['distances'][0].append(2);examples.append(p)
  for example in examples:
   with self.assertRaises(ValueError):gateway.validate_payload(example)
 def test_road_proxy_accepts_only_bounded_local_region_operations(self):
  valid='/table/v1/driving/2.1408,41.3832;2.0712,41.3531?annotations=duration,distance'
  self.assertEqual(gateway.validate_road_path(valid),valid)
  for bad in ['/route/v1/driving/999,41;2.1,41.4?overview=full&geometries=geojson','/nearest/v1/driving/2.1,41.4','/table/v1/driving/2.1,41.4;2.2,41.4?annotations=duration,distance&fallback_speed=50','/route/v1/driving/2.1,41.4;2.2,41.4?geometries=polyline']:
   with self.assertRaises(ValueError):gateway.validate_road_path(bad)
 def test_hour_and_day_caps_survive_adapter_restart(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'rates.sqlite';store=gateway.RateStore(p,hour=2,day=3,client_minute=6)
   self.assertTrue(store.claim('client',now=100000));self.assertTrue(store.claim('client',now=100000))
   store=gateway.RateStore(p,hour=2,day=3,client_minute=6)
   self.assertFalse(store.claim('other-client',now=100000))
   self.assertTrue(store.claim('client',now=104000));self.assertFalse(store.claim('client',now=108000))
 def test_client_minute_limit_is_separate_from_global_pool(self):
  with tempfile.TemporaryDirectory() as d:
   store=gateway.RateStore(Path(d)/'rates.sqlite',hour=25,day=100,client_minute=1)
   self.assertTrue(store.claim('one',now=100000));self.assertFalse(store.claim('one',now=100000));self.assertTrue(store.claim('two',now=100000))


class PreviewAssetResolution(unittest.TestCase):
 def test_canonical_edge_url_keeps_assets_inside_preview(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'index.html').write_text('<html><head></head><body><script src="app.js"></script></body></html>');(root/'app.js').write_text('window.loaded=true;')
   server=ThreadingHTTPServer(('127.0.0.1',0),gateway.Gateway);server.root=root.resolve()
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   base='http://127.0.0.1:'+str(server.server_address[1])
   try:
    request=Request(base+'/',headers={'X-Route-Preview-Prefix':'/preview/route-planner'})
    with urlopen(request,timeout=3) as response:html=response.read().decode()
    self.assertIn('<base href="/preview/route-planner/">',html)
    self.assertEqual(urljoin('https://example.test/preview/route-planner/','app.js'),'https://example.test/preview/route-planner/app.js')
    with urlopen(base+'/app.js',timeout=3) as response:self.assertEqual(response.read(),b'window.loaded=true;')
    with self.assertRaises(HTTPError) as caught:urlopen(Request(base+'/',headers={'X-Route-Preview-Prefix':'https://example.test'}),timeout=3)
    self.assertEqual(caught.exception.code,400)
   finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
