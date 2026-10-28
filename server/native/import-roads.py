from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess,time
BASE=Path(__file__).resolve().parents[1]
ROOT=BASE/'source/osrm-rootfs';DATA=BASE/'runtime/roads';LOG=BASE/'runtime/build-logs';LOG.mkdir(exist_ok=True)
LOADER=ROOT/'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
LIBS=':'.join(str(ROOT/p) for p in ['lib/x86_64-linux-gnu','usr/lib/x86_64-linux-gnu','usr/local/lib'])


def headroom():
 values=dict((x.split(':',1)[0],int(x.split()[1])*1024) for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
 disk=shutil.disk_usage(DATA).free
 used=sum(f.stat().st_size for f in BASE.rglob('*') if f.is_file() and not f.is_symlink())
 if disk<3*1024**3 or values['MemAvailable']<2*1024**3 or used>3*1024**3:
  raise RuntimeError('Preview import safety floor reached; stopped own build.')
 return {'free_disk_bytes':disk,'available_ram_bytes':values['MemAvailable'],'programme_bytes':used}

if any(DATA.glob('barcelona.osrm*')):
    raise RuntimeError('Use a fresh versioned directory; preserve the active road files.')
pbf=DATA/'barcelona.osm.pbf'
expected=next(x.split()[0] for x in (DATA/'CHECKSUM.txt').read_text().splitlines() if x.endswith('Barcelona.osm.pbf'))
assert hashlib.md5(pbf.read_bytes()).hexdigest()==expected,'Publisher checksum mismatch'
record={'source_url':'https://download.bbbike.org/osm/bbbike/Barcelona/Barcelona.osm.pbf','pbf_bytes':pbf.stat().st_size,'pbf_sha256':hashlib.sha256(pbf.read_bytes()).hexdigest(),'publisher_md5':expected,'osrm_version':'5.27.1','container_amd64_digest':'sha256:b1ca5d72da456e82f81b8732a095c2357b00710099efa844040d1eb40b4b5386','source_terms':'OpenStreetMap contributors; ODbL1.0','bounds':{'west':1.80,'east':2.48,'south':41.23,'north':41.62},'before':headroom(),'steps':[]}
for command,arguments in [('osrm-extract',['--threads','2','--profile',str(ROOT/'opt/car.lua'),str(pbf)]),('osrm-partition',['--threads','2',str(DATA/'barcelona.osrm')]),('osrm-customize',['--threads','2',str(DATA/'barcelona.osrm')])]:
 headroom();started=time.time();minimum_ram=10**20;minimum_disk=10**20
 argv=['/usr/bin/nice','-n','10','/usr/bin/prlimit','--as=2684354560:2684354560','--cpu=900:900','--',str(LOADER),'--inhibit-cache','--library-path',LIBS,str(ROOT/'usr/local/bin'/command),*arguments]
 with (LOG/(command+'.log')).open('w') as log:
  process=subprocess.Popen(argv,cwd=ROOT/'opt',stdout=log,stderr=log,start_new_session=True,env={'PATH':'/usr/bin:/bin','LANG':'C'})
  try:
   while process.poll() is None:
    h=headroom();minimum_ram=min(minimum_ram,h['available_ram_bytes']);minimum_disk=min(minimum_disk,h['free_disk_bytes']);time.sleep(1)
   if process.returncode!=0:raise RuntimeError(command+' failed; inspect own bounded build log')
  except BaseException:
   if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
   raise
 step={'command':command,'threads':2,'seconds':round(time.time()-started,3),'minimum_available_ram_bytes':minimum_ram,'minimum_free_disk_bytes':minimum_disk,'status':'passed'}
 record['steps'].append(step);(DATA/'import-proof.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(step),flush=True)
record['after']=headroom();record['files']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in DATA.glob('barcelona.osrm*') if f.is_file()}
(DATA/'import-proof.json').write_text(json.dumps(record,indent=2)+'\n')
print('Local Barcelona road import ready',flush=True)
