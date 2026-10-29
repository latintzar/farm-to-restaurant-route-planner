"""Personal route preview: bounded native VROOM, public source, recorded road cache.

The solver is upstream VROOM 1.15.0, compiled for custom matrices. This adapter
sets fixed execution bounds and never substitutes a local optimization algorithm.
No outbound routing/provider calls occur here. A self-hosted road backend remains
an explicit commissioning step; cache misses return a clear unavailable response.
"""
from __future__ import annotations
import argparse,hashlib,json,os,resource,sqlite3,subprocess,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,unquote,parse_qs
import re,urllib.request,urllib.error

MAX_BODY=65536
MAX_LOCATIONS=32
MAX_SHIPMENTS=32
MAX_CAPACITY=2000000
SOLVER_SLOTS=threading.BoundedSemaphore(1)


def integer(value,low,high):
    return type(value) is int and low <= value <= high


def validate_payload(body):
    if not isinstance(body,dict) or set(body)!={'vehicles','shipments','matrices'}:
        raise ValueError('Use vehicles, shipments and explicit car matrices.')
    vehicles=body['vehicles'];shipments=body['shipments'];matrices=body['matrices']
    if not isinstance(vehicles,list) or len(vehicles)!=1:
        raise ValueError('This preview accepts one vehicle.')
    if not isinstance(shipments,list) or not 1<=len(shipments)<=MAX_SHIPMENTS:
        raise ValueError('Use between 1 and 32 shipments.')
    if not isinstance(matrices,dict) or set(matrices)!={'car'} or not isinstance(matrices['car'],dict) or set(matrices['car'])!={'durations','distances'}:
        raise ValueError('Provide duration and distance matrices for car.')
    car=matrices['car'];n=len(car['durations']) if isinstance(car['durations'],list) else 0
    if not 2<=n<=MAX_LOCATIONS:
        raise ValueError('Use between 2 and 32 matrix locations.')
    for key,maximum in [('durations',86400),('distances',10000000)]:
        matrix=car[key]
        if not isinstance(matrix,list) or len(matrix)!=n or any(not isinstance(row,list) or len(row)!=n for row in matrix):
            raise ValueError('Matrices must be square and equal in size.')
        if any(not integer(value,0,maximum) for row in matrix for value in row):
            raise ValueError('Matrix entries must be bounded nonnegative integers.')
        if any(matrix[i][i]!=0 for i in range(n)):
            raise ValueError('Matrix diagonals must be zero.')
    vehicle=vehicles[0]
    if not isinstance(vehicle,dict) or set(vehicle)!={'id','start_index','end_index','capacity'} or vehicle['start_index']!=0 or vehicle['end_index']!=0 or not integer(vehicle['id'],1,2147483647):
        raise ValueError('Use one identified vehicle returning to depot index 0.')
    if not isinstance(vehicle['capacity'],list) or len(vehicle['capacity'])!=1 or not integer(vehicle['capacity'][0],1,MAX_CAPACITY):
        raise ValueError('Preview capacity is bounded at 2,000 kg, expressed in grams.')
    ids=set()
    for shipment in shipments:
        if not isinstance(shipment,dict) or set(shipment)!={'amount','pickup','delivery'} or not isinstance(shipment['amount'],list) or len(shipment['amount'])!=1 or not integer(shipment['amount'][0],1,MAX_CAPACITY):
            raise ValueError('Use positive bounded shipment amounts in grams.')
        for kind in ['pickup','delivery']:
            step=shipment[kind]
            if not isinstance(step,dict) or set(step)!={'id','location_index','service'} or not integer(step['id'],1,2147483647) or step['id'] in ids or not integer(step['location_index'],1,n-1) or not integer(step['service'],0,3600):
                raise ValueError('Use unique step IDs, valid locations and bounded service times.')
            ids.add(step['id'])
    return body


def validate_road_path(path):
    if len(path)>4096:raise ValueError('Bounded road request required.')
    parsed=urlsplit(path)
    match=re.fullmatch(r'/(table|route)/v1/driving/([0-9.,;+-]+)',parsed.path)
    if not match:raise ValueError('Use the table or route endpoint.')
    points=match[2].split(';')
    if not 2<=len(points)<=MAX_LOCATIONS:raise ValueError('Use between 2 and 32 locations.')
    for point in points:
        parts=point.split(',')
        if len(parts)!=2:raise ValueError('Use longitude and latitude pairs.')
        lon,lat=map(float,parts)
        if not 1.80<=lon<=2.48 or not 41.23<=lat<=41.62:raise ValueError('Choose points within the Barcelona extract.')
    query=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=True)
    allowed={'annotations':{'duration,distance','distance,duration'}} if match[1]=='table' else {'overview':{'full'},'geometries':{'geojson'},'steps':{'false'},'alternatives':{'false'}}
    if any(k not in allowed or len(values)!=1 or values[0] not in allowed[k] for k,values in query.items()):raise ValueError('Use the supported road response options.')
    if match[1]=='table' and query.get('annotations') not in [['duration,distance'],['distance,duration']]:raise ValueError('Request duration and distance annotations.')
    return path


class RateStore:
    def __init__(self,path,hour=25,day=100,client_minute=6):
        self.path=Path(path);self.hour=hour;self.day=day;self.client_minute=client_minute
        with sqlite3.connect(self.path) as db:db.execute('CREATE TABLE IF NOT EXISTS buckets(k TEXT PRIMARY KEY,used INTEGER NOT NULL)')
        self.path.chmod(0o600)
    def claim(self,client,now=None):
        now=time.time() if now is None else now
        keys=[('day:'+str(int(now//86400)),self.day),('hour:'+str(int(now//3600)),self.hour),('client:'+hashlib.sha256(client.encode()).hexdigest()[:24]+':'+str(int(now//60)),self.client_minute)]
        with sqlite3.connect(self.path,timeout=3) as db:
            db.execute('BEGIN IMMEDIATE')
            for key,limit in keys:
                row=db.execute('SELECT used FROM buckets WHERE k=?',(key,)).fetchone()
                if row and row[0]>=limit:return False
            for key,_ in keys:db.execute('INSERT INTO buckets VALUES(?,1) ON CONFLICT(k) DO UPDATE SET used=used+1',(key,))
        return True


def child_limits():
    resource.setrlimit(resource.RLIMIT_CPU,(4,4))
    resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
    resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))


def solve(binary,payload):
    result=subprocess.run(['/usr/bin/prlimit','--cpu=4:4','--as=268435456:268435456','--nofile=32:32','--',str(binary),'-t','1','-x','2','-l','3'],input=json.dumps(payload,separators=(',',':')).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,env={'PATH':'/usr/bin:/bin','LANG':'C'})
    if len(result.stdout)>2*1024*1024:raise RuntimeError('Solver output exceeded its bound.')
    if result.returncode!=0:raise RuntimeError('Native VROOM returned an error.')
    response=json.loads(result.stdout)
    if not isinstance(response,dict):raise RuntimeError('Native VROOM returned invalid JSON.')
    return response


class Gateway(BaseHTTPRequestHandler):
    server_version='RoutePreview/1'
    def log_message(self,*args):pass
    def setup(self):
        super().setup();self.connection.settimeout(5)
    def reply(self,status,value,headers=None):
        raw=json.dumps(value,separators=(',',':')).encode() if not isinstance(value,bytes) else value
        self.send_response(status)
        self.send_header('Content-Type',(headers or {}).get('Content-Type', 'application/json' if not isinstance(value,bytes) else 'application/octet-stream'))
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','no-store')
        for k,v in (headers or {}).items():
            if k.lower()!='content-type':self.send_header(k,v)
        self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        if urlsplit(self.path).path!='/solve':return self.reply(404,{'error':'Unknown endpoint.'})
        if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply(415,{'error':'Send a bounded JSON request.'})
        try:size=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.reply(400,{'error':'Supply a valid content length.'})
        if not 1<=size<=MAX_BODY:return self.reply(413,{'error':'Request limit is 64 KiB.'})
        # Only the reviewed loopback ingress may supply forwarded client identity.
        client=(self.headers.get('X-Route-Preview-Client') or self.client_address[0])[:128]
        if not self.server.rates.claim(client):return self.reply(429,{'error':'Preview usage limit reached.'},{'Retry-After':'60'})
        try:payload=validate_payload(json.loads(self.rfile.read(size)))
        except (ValueError,TypeError,KeyError,RecursionError):return self.reply(400,{'error':'Use the supported bounded vehicle/shipment/matrix request.'})
        if not SOLVER_SLOTS.acquire(blocking=False):return self.reply(429,{'error':'The preview solver is busy.'},{'Retry-After':'3'})
        try:
            response=solve(self.server.binary,payload)
            return self.reply(200,response,{'X-Solver':'VROOM/1.15.0','X-Solver-Mode':'custom-matrix'})
        except subprocess.TimeoutExpired:return self.reply(503,{'error':'The preview solver reached its time limit.'})
        except (RuntimeError,ValueError,OSError):return self.reply(503,{'error':'Native solver execution needs attention.'})
        finally:SOLVER_SLOTS.release()
    def do_GET(self):
        parsed=urlsplit(self.path)
        if parsed.path in ['/healthz','/solve']:
            return self.reply(200,{'status':'ok','source_repository':'https://github.com/latintzar/farm-to-restaurant-route-planner','solver':'VROOM 1.15.0','road_data':'local OSRM 5.27.1 / BBBike Barcelona / OpenStreetMap ODbL' if self.server.osrm_upstream else 'recorded real OSRM for 12 fictional locations; cache misses need local road service','limits':{'hour':self.server.rates.hour,'day':self.server.rates.day,'per_client_minute':self.server.rates.client_minute,'concurrent_solves':1,'solver_soft_seconds':3,'solver_wall_timeout_seconds':5,'solver_cpu_limit_seconds':4,'body_bytes':MAX_BODY,'locations':MAX_LOCATIONS,'shipments':MAX_SHIPMENTS}})
        if parsed.path=='/config.js':
            prefix=self.headers.get('X-Route-Preview-Prefix','')
            if prefix and not re.fullmatch(r'/[a-z0-9/_-]{1,120}',prefix):return self.reply(400,{'error':'Invalid preview prefix.'})
            config={'osrmEndpoint':prefix+'/osrm','vroomEndpoint':prefix+'/solve','mapStyleUrl':'','mapTileUrl':'','mapAttribution':'','mapMaxZoom':19}
            raw=('window.ROUTER_CONFIG='+json.dumps(config,separators=(',',':'))+';\n').encode()
            return self.reply(200,raw,{'Content-Type':'application/javascript'})
        if parsed.path.startswith('/osrm/'):
            road_path=parsed.path.removeprefix('/osrm')+('?' + parsed.query if parsed.query else '')
            try:validate_road_path(road_path)
            except (ValueError,TypeError):return self.reply(400,{'error':'Use a bounded Barcelona table or route request.'})
            client=(self.headers.get('X-Route-Preview-Client') or self.client_address[0])[:128]
            if not self.server.road_rates.claim(client):return self.reply(429,{'error':'Preview road-request limit reached.'},{'Retry-After':'60'})
            if self.server.osrm_upstream:
                try:
                    with urllib.request.urlopen(self.server.osrm_upstream+road_path,timeout=5) as response:
                        raw=response.read(2*1024*1024+1)
                        if len(raw)>2*1024*1024:raise ValueError('Road response too large.')
                        return self.reply(200,raw,{'Content-Type':'application/json','X-Road-Data':'local-osrm-5.27.1-bbbike-barcelona','X-Map-Data-Licence':'OpenStreetMap contributors / ODbL1.0'})
                except (OSError,ValueError):return self.reply(503,{'error':'The local road service needs attention.'})
            key=hashlib.sha256(road_path.encode()).hexdigest()
            index=self.server.cache/'index.json'
            entries=json.loads(index.read_text()) if index.is_file() else {}
            entry=entries.get(key)
            if not entry:return self.reply(503,{'code':'RoadCacheMiss','message':'This route requires the commissioned local road service.'})
            return self.reply(200,(self.server.cache/entry['file']).read_bytes(),{'Content-Type':'application/json','X-Road-Data':'recorded-osrm-2026-10-28','X-Road-Data-SHA256':entry['sha256']})
        name=unquote(parsed.path).lstrip('/') or 'index.html'
        path=(self.server.root/name).resolve()
        if not path.is_relative_to(self.server.root) or not path.is_file() or any(part.startswith('.') for part in Path(name).parts):return self.reply(404,{'error':'File unavailable.'})
        import mimetypes
        raw=path.read_bytes()
        # Vercel canonical URLs omit the final slash. Keep relative assets/data
        # inside this preview without changing the released application code.
        if path.name in {'index.html','demo.html'}:
            prefix=self.headers.get('X-Route-Preview-Prefix','')
            if prefix and not re.fullmatch(r'/[a-z0-9/_-]{1,120}',prefix):return self.reply(400,{'error':'Invalid preview prefix.'})
            if prefix:raw=raw.replace(b'<head>',b'<head>\n<base href="'+prefix.rstrip('/').encode()+b'/">',1)
        return self.reply(200,raw,{'Content-Type':mimetypes.guess_type(path.name)[0] or 'application/octet-stream'})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--osrm-upstream',default='');parser.add_argument('--port',type=int,default=18170);parser.add_argument('--hour-limit',type=int,default=25);parser.add_argument('--day-limit',type=int,default=100)
    args=parser.parse_args()
    if args.osrm_upstream not in {'','http://127.0.0.1:18172'}:raise ValueError('Use the commissioned loopback road service.')
    args.runtime.mkdir(parents=True,mode=0o700,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Gateway)
    server.daemon_threads=True;server.root=args.root.resolve();server.binary=args.binary.resolve();server.cache=args.cache.resolve()
    server.rates=RateStore(args.runtime/'rates.sqlite',hour=args.hour_limit,day=args.day_limit)
    server.road_rates=RateStore(args.runtime/'road-rates.sqlite',hour=200,day=1000,client_minute=30)
    server.osrm_upstream=args.osrm_upstream
    print('Loopback route preview ready; bounded native VROOM and explicit road-cache status.',flush=True)
    server.serve_forever()


if __name__=='__main__':main()
