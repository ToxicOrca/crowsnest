import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {userInfo,tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {testBucket} from './test-storage.mjs';

const source=await readFile('dist/server/index.js','utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const objects=new Map(), requests=[];
const env={SITE_ORIGIN:'https://board.example',AUTH_MODE:'standalone',DEFER_NOTIFICATIONS:true,NTFY_URL:'https://ntfy.example.com/fleet',BUCKET:testBucket(objects)};
const viewer={'oai-authenticated-user-id':'standalone-owner',Origin:env.SITE_ORIGIN};
const call=(path,method='GET',data,headers=viewer,environment=env)=>worker.fetch(new Request(env.SITE_ORIGIN+path,{method,headers,body:data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data)}),environment);
const read=key=>objects.has(key)?JSON.parse(objects.get(key)):null;
const set=(key,value)=>objects.set(key,JSON.stringify(value));
const clone=value=>JSON.parse(JSON.stringify(value));
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({id:'test-message',event:'message',topic:'fleet'}));};

// Reports come from the real agent over every fixture, so agent and server must agree.
const agentReports=JSON.parse(spawnSync('python3',['-I','-c',`
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('agent', 'storage-agent/crowsnest_storage.py')
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
version = Path('scripts/fixtures/zfs/captured/zpool-version.txt').read_bytes()
reports = {}
for status in sorted(Path('scripts/fixtures/zfs').rglob('*status.json')):
    listing = status.with_name(status.name.replace('status', 'list'))
    datasets = status.with_name('zfs-list.json')
    def run(program, arguments, status=status, listing=listing, datasets=datasets):
        if arguments == ('--version',): return version
        if program == 'zfs':
            if datasets.exists(): return datasets.read_bytes()
            raise agent.AgentError('command_failed')
        return (status if arguments == agent.ZPOOL_STATUS else listing).read_bytes()
    agent.run_command = run
    namer = agent.DeviceNamer('5a' * 32, dev_root='/nonexistent', sys_root='/nonexistent')
    storage, error = agent.collect({}, run=run, namer=namer)
    reports[status.parent.name + '/' + status.name.split('.')[0]] = json.loads(agent.encode_report(storage)[0])
print(json.dumps(reports))
`],{encoding:'utf8'}).stdout);
const fixture=name=>clone(agentReports[name]);
const scenario=name=>fixture('captured-scenarios/'+name);
assert.equal(Object.keys(agentReports).length,16);

try {
  // Sites (R2) keeps its existing behavior: storage hosts are standalone-only.
  const sites={...env,AUTH_MODE:undefined,COLLECTOR_SERVICE_TOKEN:'test-service-token',BUCKET:testBucket(new Map())};
  assert.equal((await call('/api/hosts','POST',{name:'nas',kind:'storage'},viewer,sites)).status,409);
  assert.equal((await call('/api/storage?host=00000000-0000-4000-8000-000000000000','GET',undefined,viewer,sites)).status,404);
  assert.equal((await (await call('/api/hosts','GET',undefined,viewer,sites)).json()).storageHosts,false);

  // Enrollment: a storage host gets its own token and a reviewable systemd setup.
  for(const body of [{name:'nas',kind:'nas'},{name:'nas',kind:'storage',format:'compose'},{name:'nas',kind:'storage',extra:1}])
    assert.equal((await call('/api/hosts','POST',body)).status,400,JSON.stringify(body));
  const registration=await call('/api/hosts','POST',{name:'nas',kind:'storage'});
  assert.equal(registration.status,200);
  const setup=await registration.json();
  assert.equal(setup.kind,'storage');
  assert.equal(setup.agentVersion,JSON.parse(await readFile('storage-agent/version.json','utf8')).version);
  assert.match(setup.setupCommand,/^sudo bash <<'CROWSNEST_STORAGE_SETUP'\nexport CROWSNEST_PREPARE_ONLY=1\n/);
  const heredoc=file=>setup.setupCommand.match(new RegExp('cat > '+file.replace('.','\\.')+" <<'CROWSNEST_FILE_EOF'\\n([\\s\\S]*?)\\nCROWSNEST_FILE_EOF"))[1];
  assert.equal(heredoc('crowsnest_storage.py'),await readFile('storage-agent/crowsnest_storage.py','utf8'),'embedded byte-for-byte');
  assert.equal(heredoc('crowsnest-storage.service'),await readFile('storage-agent/crowsnest-storage.service','utf8'),'embedded byte-for-byte');
  const config=JSON.parse(heredoc('storage.json'));
  assert.deepEqual(Object.keys(config),['url','hostId','hostToken'],'no service token, and no salt: the host generates it');
  assert.equal(config.hostId,setup.hostId);
  const inner=setup.setupCommand.split('\n').slice(1,-2).join('\n');
  assert.equal(spawnSync('bash',['-n'],{input:inner}).status,0,'rendered installer is valid Bash');
  const id=setup.hostId, auth={Authorization:'Bearer '+config.hostToken};
  const ingest=(report,token=config.hostToken,host=id)=>call('/api/ingest/'+host,'POST',report,{Authorization:'Bearer '+token});
  const docker=await (await call('/api/hosts','POST',{name:'docker-1',format:'setup'})).json();
  const dockerToken=JSON.parse(docker.setupCommand.match(/cat > collector.json <<'CROWSNEST_FILE_EOF'\n([\s\S]*?)\nCROWSNEST_FILE_EOF/)[1]).hostToken;
  const dockerReport={engineVersion:'29.0',containers:[]};

  // Every fixture, as the real agent reports it, is accepted and stored as a storage snapshot.
  for(const name of Object.keys(agentReports)) {
    const response=await ingest(fixture(name));
    assert.equal(response.status,200,name+' '+await response.clone().text());
    const snapshot=read('snapshots/'+id+'.json');
    assert.equal(snapshot.kind,'storage');assert.deepEqual(snapshot.containers,[]);
    assert.deepEqual(snapshot.storage,agentReports[name].storage,name+' is stored exactly as validated');
  }
  const hosts=Object.fromEntries((await (await call('/api/hosts')).json()).hosts.map(h=>[h.name,h]));
  assert.equal(hosts.nas.kind,'storage');assert.equal(hosts.nas.staleAfterSeconds,180);
  assert.equal(hosts['docker-1'].kind,'docker');assert.equal(hosts['docker-1'].staleAfterSeconds,120);

  // Strict validation: each invalid report is rejected and leaves the snapshot unchanged.
  const base=scenario('08-checksum-errors-after-scrub'), pool=r=>r.storage.pools[0], root=r=>pool(r).vdevs[0], leaf=r=>root(r).children[1].children[0];
  const leafNamed=(r,name)=>{const find=node=>node.name===name?node:(node.children||[]).map(find).find(Boolean);return find(root(r));};
  const invalid={
    'agent version':r=>{r.agentVersion='1.0';},'protocol':r=>{r.agentProtocol=0;},'missing storage':r=>{delete r.storage;},
    'state':r=>{r.storage.state='warning';},'ok with error code':r=>{r.storage.error='timeout';},
    'error with pools':r=>{r.storage.state='error';r.storage.error='timeout';},'unknown error code':r=>{r.storage={...r.storage,state:'error',error:'disk_on_fire',pools:[]};},
    'zfs version':r=>{r.storage.zfsVersion='2.4; rm -rf /';},'17 pools':r=>{r.storage.pools=Array.from({length:17},(_,i)=>({...clone(pool(r)),name:'p'+i,vdevs:[{...clone(root(r)),name:'p'+i}]}));},
    'duplicate pools':r=>{r.storage.pools.push(clone(pool(r)));},'pool name':r=>{pool(r).name='../x';root(r).name='../x';},'pool state':r=>{pool(r).state='GREAT';},
    'duplicate vdev names':r=>{leaf(r).name='mirror-0';},'vdev name':r=>{leaf(r).name='/dev/sda';},'vdev type':r=>{leaf(r).type='tape';},
    'vdev state':r=>{leaf(r).state='fine';},'children on a leaf':r=>{leaf(r).children=[];},'negative counter':r=>{leaf(r).read=-1;},
    'unsafe integer':r=>{leaf(r).write=2**53;pool(r).errors.write=2**53;},'too many vdevs':r=>{root(r).children[0].children=Array.from({length:130},(_,i)=>({name:'sd'+String.fromCharCode(97+i%26)+i,type:'disk',state:'ONLINE',read:0,write:0,checksum:0}));},
    'too deep':r=>{let node=root(r);for(let i=0;i<7;i++){const next={name:'mirror-'+(10+i),type:'mirror',state:'ONLINE',read:0,write:0,checksum:0,children:[]};node.children=[next];node=next;}},
    'root name':r=>{root(r).name='other';},'root type':r=>{root(r).type='mirror';},'two roots':r=>{pool(r).vdevs.push(clone(root(r)));},
    'totals mismatch':r=>{pool(r).errors.checksum=3;},'truncated shows more':r=>{pool(r).vdevsTruncated=true;pool(r).errors.checksum=1;},
    'capacity':r=>{pool(r).capacityPercent=101;},'size':r=>{pool(r).size=-5;},'scan type':r=>{pool(r).scan.type='defrag';},
    'scrub labelled resilvered':r=>{pool(r).scan.resilveredBytes=pool(r).scan.repairedBytes;delete pool(r).scan.repairedBytes;},
    'generic processed':r=>{pool(r).scan.processed=pool(r).scan.repairedBytes;delete pool(r).scan.repairedBytes;},
    'scanning with end time':r=>{pool(r).scan.state='scanning';},'scan time':r=>{pool(r).scan.endTime='yesterday';},
    'datasets without status':r=>{r.storage.datasets=[];},'dataset status':r=>{r.storage.datasetsStatus='partial';},
    'container report to a storage host':r=>{for(const key of Object.keys(r))delete r[key];Object.assign(r,dockerReport);},
  };
  const resilver=scenario('06-resilver-in-progress');
  const before=objects.get('snapshots/'+id+'.json');
  for(const [name,change] of Object.entries(invalid)) {
    const report=clone(base);change(report);
    assert.equal((await ingest(report)).status,400,name);
    assert.equal(objects.get('snapshots/'+id+'.json'),before,name+' must not change the snapshot');
  }
  const resilverAsScrub=clone(resilver);pool(resilverAsScrub).scan.repairedBytes=pool(resilverAsScrub).scan.resilveredBytes;delete pool(resilverAsScrub).scan.resilveredBytes;
  assert.equal((await ingest(resilverAsScrub)).status,400,'resilver labelled repaired');
  // Each byte label belongs to exactly one scan type: a second label is rejected, not dropped.
  const scrubBoth=clone(base);pool(scrubBoth).scan.resilveredBytes=0;
  const resilverBoth=clone(resilver);pool(resilverBoth).scan.repairedBytes=0;
  for(const [name,report] of [['scrub with both labels',scrubBoth],['resilver with both labels',resilverBoth]])assert.equal((await ingest(report)).status,400,name);
  const datasets=clone(fixture('captured/zpool-status'));datasets.storage.datasets=Array.from({length:65},(_,i)=>({...datasets.storage.datasets[0],name:'d'+i}));
  assert.equal((await ingest(datasets)).status,400,'65 datasets');
  // Unknown fields are dropped like the container validator does; known ones stay strict.
  const extra=clone(base);extra.extra='x';extra.storage.extra='x';pool(extra).guid=1;leaf(extra).path='/dev/disk/by-id/x';pool(extra).scan.processed=1;
  assert.equal((await ingest(extra)).status,200);
  assert.ok(!/extra|guid|by-id|"processed"/.test(objects.get('snapshots/'+id+'.json')));
  // Container reports keep their own validator: a storage section from a Docker host is dropped.
  assert.equal((await ingest({...dockerReport,storage:base.storage},dockerToken,docker.hostId)).status,200);
  assert.equal(read('snapshots/'+docker.hostId+'.json').storage,undefined);
  assert.equal((await ingest(base,dockerToken,docker.hostId)).status,400,'storage report to a Docker host');

  // Activity: state changes, new errors, resets and scan completion.
  const reset=()=>{for(const prefix of ['snapshots/','history/','storage/','storage-history/'])objects.delete(prefix+id+'.json');};
  const age=(seconds,host=id)=>{const s=read('snapshots/'+host+'.json');s.receivedAt=new Date(Date.now()-seconds*1000).toISOString();set('snapshots/'+host+'.json',s);};
  const texts=()=>(read('history/'+id+'.json')||[]).map(e=>e.text);
  const step=async(report,seconds=60)=>{if(objects.has('snapshots/'+id+'.json'))age(seconds);const n=texts().length;assert.equal((await ingest(report)).status,200);return texts().slice(0,texts().length-n).reverse();};
  reset();
  assert.deepEqual(await step(scenario('02-with-data-never-scrubbed')),['First storage agent report received']);
  assert.deepEqual(await step(scenario('03-scrub-in-progress')),['zfstest: scrub started']);
  assert.deepEqual(await step(scenario('04-scrub-finished')),['zfstest: scrub finished (repaired 0 B, 0 error(s))']);
  assert.deepEqual(await step(scenario('04-scrub-finished')),[],'an unchanged report records nothing');
  assert.deepEqual(await step(scenario('05-degraded-offline')),['zfstest: ONLINE → DEGRADED','zfstest/mirror-0: ONLINE → DEGRADED','zfstest/disk2: ONLINE → OFFLINE']);
  assert.deepEqual(await step(scenario('06-resilver-in-progress')),['zfstest/replacing-1: added (DEGRADED)','zfstest/disk5: added (ONLINE)','zfstest: resilver started']);
  assert.deepEqual(await step(scenario('07-resilver-finished')),['zfstest: DEGRADED → ONLINE','zfstest/mirror-0: DEGRADED → ONLINE','zfstest/replacing-1: removed','zfstest/disk2: removed','zfstest: resilver finished (resilvered 147 MiB, 0 error(s))']);
  // Silent corruption on an ONLINE pool with error_count 0 is visible through the vdev counter.
  const corrupted=scenario('08-checksum-errors-after-scrub');
  assert.deepEqual(await step(corrupted),['zfstest/disk3: errors increased (checksum 0 → 16)','zfstest: scrub finished (repaired 2.0 MiB, 0 error(s))']);
  // zpool clear or a reboot resets counters: a decrease is a reset, never a recovery or an error.
  const cleared=clone(corrupted);leafNamed(cleared,'disk3').checksum=0;pool(cleared).errors.checksum=0;
  assert.deepEqual(await step(cleared),['zfstest/disk3: error counters reset (zpool clear or reboot); now read 0, write 0, checksum 0']);
  assert.deepEqual(await step(corrupted),['zfstest/disk3: errors increased (checksum 0 → 16)'],'new errors after a reset count from the new baseline');
  const partial=clone(corrupted);leafNamed(partial,'disk3').checksum=2;pool(partial).errors.checksum=2;
  assert.deepEqual(await step(partial),['zfstest/disk3: error counters reset (zpool clear or reboot); now read 0, write 0, checksum 2'],'a decrease is a reset even if errors remain');
  // Agent error state and recovery; pools are not diffed across an error.
  const failed={agentVersion:base.agentVersion,agentProtocol:1,storage:{state:'error',error:'permission_denied',zfsVersion:'2.4.1-1',pools:[],datasetsStatus:'disabled'}};
  assert.deepEqual(await step(failed),['Storage agent error: permission_denied']);
  assert.deepEqual(await step(failed),[]);
  assert.deepEqual(await step(corrupted),['Storage agent recovered; pool status is available again']);
  // Data errors and a scrub that found errors.
  reset();
  await step(fixture('synthetic/scrub-in-progress'));
  assert.deepEqual(await step(fixture('synthetic/checksum-errors')),['tank: permanent data errors 0 → 2','tank/sdd: errors increased (checksum 0 → 17)','tank: scrub finished (repaired 1.0 MiB, 2 error(s))']);
  // A single report is bounded to 20 events plus a summary.
  const wide=clone(fixture('synthetic/scrub-in-progress')), widePool=pool(wide);
  widePool.vdevs[0].children[0].children=Array.from({length:30},(_,i)=>({name:'sd'+String.fromCharCode(97+i%26)+(i<26?'':'x'),type:'disk',state:'ONLINE',read:0,write:0,checksum:0}));
  reset();await step(wide);
  const faulted=clone(wide);for(const disk of pool(faulted).vdevs[0].children[0].children)disk.state='FAULTED';
  const capped=await step(faulted);
  assert.equal(capped.length,21);assert.equal(capped.at(-1),'10 more storage changes in this report');

  // The shared stale threshold: 180 s for storage agents, 120 s for Docker collectors.
  reset();await step(corrupted);
  assert.ok(!(await step(corrupted,150)).includes('Reporting resumed after a gap'),'storage: 150 s is not a gap');
  assert.ok((await step(corrupted,200)).includes('Reporting resumed after a gap'),'storage: 200 s is a gap');
  age(150,docker.hostId);assert.equal((await ingest(dockerReport,dockerToken,docker.hostId)).status,200);
  assert.ok(read('history/'+docker.hostId+'.json').some(e=>e.text==='Reporting resumed after a gap'),'docker: 150 s is a gap');
  assert.equal((await call('/api/notifications','PATCH',{enabled:true,recoveries:true})).status,200);
  const sweep=async()=>{objects.delete('notifications/sweep.json');let work;await worker.scheduled(null,env,{waitUntil:p=>{work=p;}});await work;};
  const alerts=()=>requests.map(r=>r.message);
  age(150);age(150,docker.hostId);requests.length=0;await sweep();
  assert.ok(alerts().some(m=>m.startsWith('docker-1\nAlert: No collector report for more than two minutes')),alerts().join('|'));
  assert.ok(!alerts().some(m=>m.startsWith('nas\n')),'storage agent is not stale at 150 s');
  age(200);requests.length=0;await sweep();
  assert.ok(alerts().some(m=>m==='nas\nAlert: No storage agent report for more than three minutes'),alerts().join('|'));
  // A storage host that never reports is described as awaiting its storage agent.
  const silent=await (await call('/api/hosts','POST',{name:'silent-nas',kind:'storage'})).json();
  const record=read('hosts/'+silent.hostId+'.json');record.createdAt=new Date(Date.now()-11*60000).toISOString();set('hosts/'+silent.hostId+'.json',record);
  requests.length=0;await sweep();
  assert.ok(alerts().includes('silent-nas\nAlert: Awaiting the first storage agent report'),alerts().join('|'));
  assert.equal((await call('/api/hosts/'+silent.hostId,'DELETE',{confirmName:'silent-nas'})).status,200);
  assert.equal((await call('/api/notifications','PATCH',{enabled:false,recoveries:true})).status,200);
  const board=await readFile('worker/board.js','utf8'), context=vm.createContext({Date});
  vm.runInContext(board.slice(board.indexOf('const age = '),board.indexOf('function duration('))+board.slice(board.indexOf('function staleAfterSeconds('),board.indexOf('function hostState(')+board.slice(board.indexOf('function hostState(')).indexOf('\n}')+2),context);
  const ago=seconds=>({receivedAt:new Date(Date.now()-seconds*1000).toISOString()});
  assert.equal(context.hostState({snapshot:ago(150),staleAfterSeconds:180}),'Reporting');
  assert.equal(context.hostState({snapshot:ago(200),staleAfterSeconds:180}),'Stale');
  assert.equal(context.hostState({snapshot:ago(150),staleAfterSeconds:120}),'Stale');
  assert.equal(context.hostState({snapshot:ago(150)}),'Stale','older servers without a threshold keep the 120 s default');

  // Capacity history: five-minute windows, 24 hours, 288 readings, bounded bytes.
  const history=()=>read('storage-history/'+id+'.json');
  reset();await step(corrupted);await step(corrupted);
  assert.equal(history().length,1,'one reading per five-minute window');
  assert.deepEqual(history()[0].pools,[['zfstest',61,307471872,503316480]]);
  await step(failed);assert.equal(history().length,1,'an error report adds no reading');
  const now=Date.now();
  set('storage-history/'+id+'.json',Array.from({length:310},(_,i)=>({at:new Date(now-(310-i)*300000).toISOString(),pools:[['zfstest',50,1,2]]})));
  await step(corrupted);
  assert.ok(history().length<=288 && history().every(s=>Date.parse(s.at)>now-86400000));
  set('storage-history/'+id+'.json',Array.from({length:200},(_,i)=>({at:new Date(now-(200-i)*300000).toISOString(),pools:Array.from({length:16},(_,j)=>['p'.repeat(100)+j,50,2**40,2**41])})));
  await step(corrupted);
  assert.ok(Buffer.byteLength(objects.get('storage-history/'+id+'.json'))<=262144,'bounded bytes per host');
  // Like resource history, a future-dated reading (clock skew) is discarded, not trusted.
  set('storage-history/'+id+'.json',[{at:new Date(Date.now()+3600000).toISOString(),pools:[['skewed',1,1,1]]}]);
  await step(corrupted);
  assert.deepEqual(history().map(s=>s.pools[0][0]),['zfstest']);
  // Overlapping reports use conditional writes: both succeed, one reading per window.
  objects.delete('storage-history/'+id+'.json');
  const overlapping=await Promise.all([ingest(corrupted),ingest(corrupted),ingest(corrupted)]);
  assert.deepEqual(overlapping.map(r=>r.status),[200,200,200]);
  assert.equal(history().length,1);

  // Last completed scrub is remembered across a resilver; never seen is "unknown", not "never".
  const scrubs=async()=>(await (await call('/api/storage?host='+id)).json()).scrubs;
  reset();await step(scenario('01-fresh-never-scrubbed'));
  assert.deepEqual(await scrubs(),{zfstest:{status:'never'}},'missing scan_stats means never scrubbed');
  reset();await step(scenario('06-resilver-in-progress'));
  assert.deepEqual(await scrubs(),{zfstest:{status:'unknown'}},'a resilver hides the last scrub');
  reset();await step(scenario('04-scrub-finished'));
  const known={zfstest:{status:'known',endTime:'2026-11-11T02:43:44Z',errors:0,repairedBytes:0}};
  assert.deepEqual(await scrubs(),known);
  await step(scenario('06-resilver-in-progress'));await step(scenario('07-resilver-finished'));
  assert.deepEqual(await scrubs(),known,'remembered across a resilver');
  await step(failed);assert.deepEqual(read('storage/'+id+'.json').pools.zfstest.lastScrub,known.zfstest&&{endTime:'2026-11-11T02:43:44Z',errors:0,repairedBytes:0},'an error report keeps the memory');
  const storageApi=await (await call('/api/storage?host='+id)).json();
  assert.equal(storageApi.windowSeconds,300);assert.equal(storageApi.retentionHours,24);assert.equal(storageApi.maxBytes,262144);assert.ok(Array.isArray(storageApi.history));
  assert.equal((await call('/api/storage?host='+docker.hostId)).status,404);
  assert.equal((await call('/api/storage?host=bad')).status,400);
  assert.equal((await call('/api/storage?host=00000000-0000-4000-8000-000000000000')).status,404);
  assert.equal((await call('/api/storage?host='+id,'GET',undefined,{})).status,401,'private like every viewer route');

  // Credential replacement keeps the host-local salt and therefore every vdev name.
  for(const format of ['compose','config','setup','update'])assert.equal((await call('/api/hosts/'+id+'/collector','POST',{format})).status,400,format);
  assert.equal((await call('/api/hosts/'+docker.hostId+'/collector','POST',{format:'storage-token'})).status,400);
  const replacement=await (await call('/api/hosts/'+id+'/collector','POST',{format:'storage-token'})).json();
  const newToken=replacement.tokenCommand.match(/config\["hostToken"\] = "([^"]+)"/)[1];
  assert.notEqual(newToken,config.hostToken);
  assert.ok(replacement.tokenCommand.split('\n').filter(line=>line.includes(newToken)).length===1,'the token appears only inside the Python program, never on a command line');
  const python=replacement.tokenCommand.match(/<<'CROWSNEST_STORAGE_PY'\n([\s\S]*?)\nCROWSNEST_STORAGE_PY/)[1].replace('getpwnam("crowsnest-storage")','getpwnam('+JSON.stringify(userInfo().username)+')');
  const directory=await mkdtemp(join(tmpdir(),'crowsnest-storage-token-')), file=join(directory,'storage.json');
  try {
    await writeFile(file,JSON.stringify({...config,nameSalt:'5a'.repeat(32)}),{mode:0o644});
    const result=spawnSync('python3',['-I','-',file],{input:python,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...config,hostToken:newToken,nameSalt:'5a'.repeat(32)});
    assert.equal((await stat(file)).mode&0o777,0o600);
    await writeFile(file,JSON.stringify(config));
    assert.notEqual(spawnSync('python3',['-I','-',file],{input:python,encoding:'utf8'}).status,0,'refuses a config without a salt');
  } finally {await rm(directory,{recursive:true,force:true});}
  assert.equal(spawnSync('bash',['-n'],{input:replacement.tokenCommand.split('\n').slice(1,-2).join('\n')}).status,0);
  assert.equal((await ingest(corrupted,newToken)).status,200,'the staged token activates on its first report');
  assert.equal((await ingest(corrupted)).status,403,'the previous token is retired');

  // Removal deletes every per-host key, including storage state and history.
  assert.ok(objects.has('storage/'+id+'.json') && objects.has('storage-history/'+id+'.json') && objects.has('history/'+id+'.json'));
  assert.equal((await call('/api/hosts/'+id,'DELETE',{confirmName:'nas'})).status,200);
  assert.deepEqual([...objects.keys()].filter(key=>key.includes(id)),[]);
  assert.equal((await ingest(corrupted,newToken)).status,404);
  console.log('Passed: standalone-only storage hosts, enrollment, every agent fixture accepted, strict validation with dropped unknown fields, state/error/reset/scan activity, 180 s vs 120 s stale threshold, bounded capacity history, remembered scrubs, salt-preserving token replacement, and complete removal.');
} finally {globalThis.fetch=originalFetch;}
