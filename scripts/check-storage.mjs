import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {userInfo,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
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
assert.equal(Object.keys(agentReports).length,22);

try {
  // Sites (R2) keeps its existing behavior: storage hosts are standalone-only.
  const sites={...env,AUTH_MODE:undefined,COLLECTOR_SERVICE_TOKEN:'test-service-token',BUCKET:testBucket(new Map())};
  assert.equal((await call('/api/hosts','POST',{name:'nas',kind:'storage'},viewer,sites)).status,409);
  const sitesObjects=new Map(), sitesHost='11111111-2222-4333-8444-555555555555';
  const sitesIngest={...sites,BUCKET:testBucket(sitesObjects)};
  sitesObjects.set('hosts/'+sitesHost+'.json',JSON.stringify({id:sitesHost,name:'nas',kind:'storage',tokenHash:createHash('sha256').update('test-host-token').digest('hex'),createdAt:new Date().toISOString()}));
  const sitesResponse=await call('/api/ingest/'+sitesHost,'POST',fixture('captured-scenarios/04-scrub-finished'),{Authorization:'Bearer test-host-token'},sitesIngest);
  assert.equal(sitesResponse.status,409,'a storage record on Sites is refused at ingest');
  assert.deepEqual([...sitesObjects.keys()],['hosts/'+sitesHost+'.json'],'nothing is written to R2');
  // The other gates, for a storage record that exists on R2: each must refuse for the gate's own reason.
  const sitesRecord=sitesObjects.get('hosts/'+sitesHost+'.json');
  const sitesStorage=await call('/api/storage?host='+sitesHost,'GET',undefined,viewer,sitesIngest);
  assert.deepEqual([sitesStorage.status,(await sitesStorage.json()).error],[404,'Storage hosts require a standalone dashboard'],'/api/storage is refused by the Sites gate, not as an unknown host');
  const sitesToken=await call('/api/hosts/'+sitesHost+'/collector','POST',{format:'storage-token'},viewer,sitesIngest);
  assert.deepEqual([sitesToken.status,(await sitesToken.json()).error],[409,'Storage hosts require a standalone dashboard'],'storage token replacement is refused on Sites');
  assert.equal(sitesObjects.get('hosts/'+sitesHost+'.json'),sitesRecord,'no pending token is written to R2');
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
  // Every rejection must fail for its own rule: the validator from worker/storage.js
  // runs in a sandbox so each case can assert its exact reason, not just a 400.
  const sandbox=vm.createContext({});
  vm.runInContext((await readFile('worker/versions.js','utf8'))+'\n'+(await readFile('worker/storage.js','utf8'))+'\nthis.validate=validatedStorageReport;this.nameAllowed=storageVdevNameAllowed;this.storageNodes=storageNodes;',sandbox);
  const storageNodes=node=>sandbox.storageNodes(node);
  const reason=report=>{try{sandbox.validate(report);return null;}catch(error){return error.message.replace('Invalid storage report: ','');}};
  const withDatasets=fixture('captured/zpool-status');
  assert.equal(reason(clone(base)),null);assert.equal(reason(clone(withDatasets)),null);
  const chain=r=>{const mirror=root(r).children[0], bottom=mirror.children[0];let node=mirror;
    for(let i=0;i<6;i++){const next={name:'mirror-'+(10+i),type:'mirror',class:'normal',state:'ONLINE',read:0,write:0,checksum:0,children:[]};if(node===mirror)mirror.children[0]=next;else node.children=[next];node=next;}
    node.children=[bottom];};
  const invalid=[
    ['agent version',r=>{r.agentVersion='1.0';},'agent version'],['protocol',r=>{r.agentProtocol=0;},'agent protocol'],['missing storage',r=>{delete r.storage;},'storage section'],
    ['state',r=>{r.storage.state='warning';},'state'],['ok with error code',r=>{r.storage.error='timeout';},'error code'],
    ['error with pools',r=>{r.storage.state='error';r.storage.error='timeout';},'pools'],['unknown error code',r=>{r.storage={...r.storage,state:'error',error:'disk_on_fire',pools:[]};},'error code'],
    ['zfs version',r=>{r.storage.zfsVersion='2.4; rm -rf /';},'zfs version'],['ok without zfs version',r=>{r.storage.zfsVersion=null;},'missing zfs version'],
    ['17 pools',r=>{r.storage.pools=Array.from({length:17},(_,i)=>({...clone(pool(r)),name:'p'+i,vdevs:[{...clone(root(r)),name:'p'+i}]}));},'pools'],
    ['duplicate pools',r=>{r.storage.pools.push(clone(pool(r)));},'pool name'],['pool name',r=>{pool(r).name='../x';root(r).name='../x';},'pool name'],['pool state',r=>{pool(r).state='GREAT';},'pool state'],
    ['duplicate vdev names',r=>{leaf(r).name='disk4';},'duplicate vdev name'],['vdev name',r=>{leaf(r).name='/dev/sda';},'vdev name'],['vdev type',r=>{leaf(r).type='tape';},'vdev type or state'],
    ['vdev state',r=>{leaf(r).state='fine';},'vdev type or state'],['children on a leaf',r=>{leaf(r).children=[];},'vdev children'],['negative counter',r=>{leaf(r).read=-1;},'read errors'],
    ['unsafe integer',r=>{leaf(r).write=2**53;pool(r).errors.write=2**53;},'write errors'],
    ['too many vdevs',r=>{root(r).children[0].children=Array.from({length:130},(_,i)=>({name:'sd'+String.fromCharCode(97+i%26)+String.fromCharCode(97+Math.floor(i/26)),type:'disk',class:'normal',state:'ONLINE',read:0,write:0,checksum:0}));},'too many vdevs'],
    ['too deep',chain,'vdev tree too deep'],
    ['root name',r=>{root(r).name='other';},'pool root vdev'],['root type',r=>{root(r).type='mirror';},'pool root vdev'],['two roots',r=>{pool(r).vdevs.push(clone(root(r)));},'pool vdevs'],
    ['nested root',r=>{root(r).children[0].type='root';},'pool root vdev'],
    ['vdev class',r=>{leaf(r).class='tape-library';},'vdev class'],['root class',r=>{root(r).class='special';},'vdev class'],
    // Pool totals equal the root vdev's own counters exactly, in both directions.
    ['totals above the root',r=>{pool(r).errors.checksum=root(r).checksum+1;},'pool error totals'],
    ['totals summed over the tree',r=>{pool(r).errors.checksum=16;},'pool error totals'],
    ['totals below the root',r=>{root(r).checksum=5;pool(r).errors.checksum=4;},'pool error totals'],
    ['truncated totals still match the root',r=>{pool(r).vdevsTruncated=true;pool(r).errors.checksum=1;},'pool error totals'],
    ['capacity',r=>{pool(r).capacityPercent=101;},'pool capacity'],['size',r=>{pool(r).size=-5;},'pool size'],
    ['allocated above size',r=>{pool(r).allocated=pool(r).size+1;},'pool sizes'],['allocated plus free above size',r=>{pool(r).free=pool(r).free+4096;},'pool sizes'],
    ['capacity does not match sizes',r=>{pool(r).capacityPercent=5;},'pool capacity does not match its sizes'],['scan type',r=>{pool(r).scan.type='defrag';},'scan type or state'],
    ['scrub labelled resilvered',r=>{pool(r).scan.resilveredBytes=pool(r).scan.repairedBytes;delete pool(r).scan.repairedBytes;},'scan byte label'],
    ['generic processed',r=>{pool(r).scan.processed=pool(r).scan.repairedBytes;delete pool(r).scan.repairedBytes;},'scan byte label'],
    ['scrub with both labels',r=>{pool(r).scan.resilveredBytes=0;},'scan byte label'],
    ['scanning with end time',r=>{pool(r).scan.state='scanning';},'a running scan has no end time'],['scan time',r=>{pool(r).scan.endTime='yesterday';},'scan end'],
    ['datasets without status',r=>{r.storage.datasets=[];},'datasets'],['dataset status',r=>{r.storage.datasetsStatus='partial';},'dataset status'],
    ['datasets in an error report',r=>{r.storage={...r.storage,state:'error',error:'timeout',pools:[],datasetsStatus:'complete',datasets:[]};},'datasets in an error report'],
    ['container report to a storage host',r=>{for(const key of Object.keys(r))delete r[key];Object.assign(r,dockerReport);},'agent version'],
    // Dataset rules use the captured fixture, which lists datasets.
    ['65 datasets',r=>{r.storage.datasets=Array.from({length:65},(_,i)=>({...r.storage.datasets[0],name:'bulk/d'+i}));},'datasets',withDatasets],
    ['dataset of an unreported pool',r=>{r.storage.datasets[1].name='elsewhere/library';},'dataset pool or depth',withDatasets],
    ['dataset deeper than one level',r=>{r.storage.datasets[1].name='bulk/library/nested';},'dataset pool or depth',withDatasets],
    ['mountpoint over 256 UTF-16 units',r=>{r.storage.datasets[1].mountpoint='/'+'\u{1D11E}'.repeat(128);},'dataset mountpoint',withDatasets],
    ['bidi control in a dataset name',r=>{r.storage.datasets[1].name='bulk/lib\u202Eyrar';},'dataset name',withDatasets],
    ['C1 control in a mountpoint',r=>{r.storage.datasets[1].mountpoint='/bulk/\x85library';},'dataset mountpoint',withDatasets],
    ['zero-width space in a dataset name',r=>{r.storage.datasets[1].name='bulk/lib\u200Brary';},'dataset name',withDatasets],
    ['pool name over 255 characters',r=>{const name='p'.repeat(256);pool(r).name=name;root(r).name=name;},'pool name'],
  ];
  const resilver=scenario('06-resilver-in-progress');
  invalid.push(['resilver labelled repaired',r=>{pool(r).scan.repairedBytes=pool(r).scan.resilveredBytes;delete pool(r).scan.resilveredBytes;},'scan byte label',resilver],
    ['resilver with both labels',r=>{pool(r).scan.repairedBytes=0;},'scan byte label',resilver]);
  const before=objects.get('snapshots/'+id+'.json');
  for(const [name,change,expected,from=base] of invalid) {
    const report=clone(from);change(report);
    assert.equal(reason(report),expected,name+' must fail for its own rule');
    assert.equal((await ingest(report)).status,400,name);
    assert.equal(objects.get('snapshots/'+id+'.json'),before,name+' must not change the snapshot');
  }
  // ZFS allows spaces in pool names and up to 255 characters: such a pool must not drop the report.
  for(const name of ['my pool','p'.repeat(255),'tank.2:x-y_z']) {
    const report=clone(base);pool(report).name=name;root(report).name=name;
    assert.equal(reason(report),null,'pool name '+name.slice(0,20));
  }
  const spaced=clone(withDatasets), spacedPool=spaced.storage.pools[0], oldName=spacedPool.name;
  spacedPool.name=spacedPool.vdevs[0].name='bulk store';
  spaced.storage.datasets=spaced.storage.datasets.map(d=>d.name.split('/')[0]===oldName?{...d,name:d.name.replace(oldName,'bulk store')}:d);
  assert.equal(reason(spaced),null,'datasets of a pool whose name has a space');
  assert.equal(reason({...clone(withDatasets),storage:{...clone(withDatasets).storage,datasets:clone(withDatasets).storage.datasets.map(d=>({...d,mountpoint:d.mountpoint&&d.mountpoint.slice(0,1)+'\u{1D11E}'.repeat(127)}))}}),null,'254 UTF-16 units is within the limit');

  // Limits at their exact boundaries: the real agent's largest reports are accepted,
  // and one more of anything is rejected for its own rule.
  const atLimits=JSON.parse(spawnSync('python3',['-I','-c',`
import importlib.util, json
spec = importlib.util.spec_from_file_location('agent', 'storage-agent/crowsnest_storage.py')
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
namer = agent.DeviceNamer('5a' * 32, dev_root='/nonexistent', sys_root='/nonexistent')
guid = iter(range(1, 100000))
leaf = lambda name: {'name': '/srv/v/' + name, 'vdev_type': 'file', 'guid': next(guid), 'state': 'ONLINE', 'class': 'normal'}
group = lambda name, children: {'name': name, 'vdev_type': 'mirror', 'guid': next(guid), 'state': 'ONLINE', 'class': 'normal', 'vdevs': {c['name']: c for c in children}}
def pool(name, children):
    return {'name': name, 'state': 'ONLINE', 'vdevs': {name: {'name': name, 'vdev_type': 'root', 'guid': next(guid), 'state': 'ONLINE', 'class': 'normal', 'vdevs': {c['name']: c for c in children}}}, 'error_count': 0}
def listing(names):
    return {'pools': {n: {'properties': {'size': {'value': 1000}, 'allocated': {'value': 400}, 'free': {'value': 600}, 'capacity': {'value': 40}, 'fragmentation': {'value': 1}}} for n in names}}
def report(status, names, datasets=None):
    storage = {'state': 'ok', 'error': None, 'zfsVersion': '2.4.1-1', 'pools': agent.pools_summary({'pools': status}, listing(names), namer), 'datasetsStatus': 'disabled'}
    if datasets is not None:
        result, truncated = agent.datasets_summary(datasets, set(names))
        storage['datasets'], storage['datasetsStatus'] = result, 'truncated' if truncated else 'complete'
    return json.loads(agent.encode_report(storage)[0])
chain = leaf('bottom')
for level in range(5):                     # root (0) > 5 nested mirrors (1-5) > leaf at depth 6
    chain = group('mirror-' + str(level), [chain])
wide = group('mirror-0', [leaf('d%03d' % i) for i in range(126)])   # root + mirror + 126 leaves = 128 vdevs
properties = {'used': {'value': 1}, 'available': {'value': 1}, 'referenced': {'value': 1}, 'quota': {'value': 0}, 'mountpoint': {'value': '-'}}
print(json.dumps({
    'depth 6': report({'tank': pool('tank', [chain])}, ['tank']),
    '128 vdevs': report({'tank': pool('tank', [wide])}, ['tank']),
    '16 pools': report({'p%02d' % i: pool('p%02d' % i, [leaf('x%02d' % i)]) for i in range(16)}, ['p%02d' % i for i in range(16)]),
    '64 datasets': report({'tank': pool('tank', [leaf('x')])}, ['tank'], {'datasets': {'tank/d%02d' % i: {'properties': properties} for i in range(70)}}),
}))`],{encoding:'utf8'}).stdout);
  const maxDepth=node=>1+Math.max(-1,...(node.children||[]).map(maxDepth));
  assert.equal(maxDepth(atLimits['depth 6'].storage.pools[0].vdevs[0]),6,'the deepest vdev is at depth 6');
  assert.equal(storageNodes(atLimits['128 vdevs'].storage.pools[0].vdevs[0]).length,128);
  assert.equal(atLimits['128 vdevs'].storage.pools[0].vdevsTruncated,false);
  assert.equal(atLimits['16 pools'].storage.pools.length,16);
  assert.deepEqual([atLimits['64 datasets'].storage.datasets.length,atLimits['64 datasets'].storage.datasetsStatus],[64,'truncated']);
  for(const [name,report] of Object.entries(atLimits))assert.equal(reason(report),null,'the agent\'s largest report at the limit ('+name+') is accepted');
  const plusOne=[
    ['depth 7',r=>{const leafNode=storageNodes(r.storage.pools[0].vdevs[0]).find(n=>n.name==='bottom');Object.assign(leafNode,{name:'mirror-9',type:'mirror',children:[{name:'deeper',type:'file',class:'normal',state:'ONLINE',read:0,write:0,checksum:0}]});},'vdev tree too deep','depth 6'],
    ['129 vdevs',r=>{r.storage.pools[0].vdevs[0].children[0].children.push({name:'d126',type:'file',class:'normal',state:'ONLINE',read:0,write:0,checksum:0});},'too many vdevs','128 vdevs'],
    ['17 pools',r=>{r.storage.pools.push({...clone(r.storage.pools[0]),name:'p16',vdevs:[{...clone(r.storage.pools[0].vdevs[0]),name:'p16'}]});},'pools','16 pools'],
    ['65 datasets',r=>{r.storage.datasets.push({...r.storage.datasets[0],name:'tank/d64'});},'datasets','64 datasets'],
  ];
  for(const [name,change,expected,from] of plusOne){const report=clone(atLimits[from]);change(report);assert.equal(reason(report),expected,name+' (one past the limit) must fail for its own rule');}

  // Names: the server independently allows only shapes the agent emits, per vdev type.
  const accepted=[['disk','sda'],['disk','sdab'],['disk','nvme0n1'],['disk','vdb'],['disk','xvdf'],['disk','mmcblk0'],['disk','md127'],['disk','zd16'],
    ['disk','mpatha'],['disk','mpathbz'],['disk','disk-3f9a2c11'],['dspare','dspare-0a1b2c3d'],['unknown','device-0a1b2c3d'],['unknown','sdc'],
    ['file','vdev.img'],['file','disk1'],['file','file-0a1b2c3d'],['mirror','mirror-0'],['raidz','raidz2-1'],['draid','draid1:4d:6c:1s-0'],['replacing','replacing-1'],['spare','spare-3'],['mirror','mirror-0a1b2c3d']];
  const rejected=[
    // Real-world by-id and identifier formats (fictional serials).
    ['disk','ata-WDC_WD80EFZZ-68BTXN0_WD-CA1FAKE7'],['disk','ata-ST8000VN004-2M2101_ZA1FAKE9'],['disk','scsi-35000cca2b3c4d5e6'],['disk','scsi-SATA_ST4000DM004-2CV1_ZFN0FAKE'],
    ['disk','wwn-0x5000cca2b3c4d5e6'],['disk','nvme-eui.002538b8a1b2c3d4'],['disk','nvme-INTEL_SSDPE2KX040T8_PHLJ0FAKE01'],['disk','nvme-Micron_7450_MTFDKCC3T8TFR_22F0FAKE'],
    ['disk','dm-uuid-mpath-36001405abcdef012'],['disk','dm-name-mpatha'],['disk','usb-SanDisk_Ultra_4C530001-0:0'],['disk','virtio-QM00001'],['disk','0x5000cca2b3c4d5e6'],
    ['disk','6001405abcdef0123456'],['disk','WD-WCC7K0FAKE12'],['disk','ZA1B2C3D'],['disk','dm-3'],['file','ata-image-copy'],['file','S6PTNM0R912345X.img'],
    // Identifiers dressed as hashes, split serials, models and custom aliases.
    ['disk','disk-5000cca2b3c4d5e6'],['disk','disk-002538b8a1b2c3d4'],['disk','disk-'+'ab'.repeat(32)],['disk','S3Z9-NB0K-123456X'],['disk','WD-WX12-D3456'],
    ['disk','18071234567'],['disk','Acme_SSD_990'],['disk','KINGSTON_SA400'],['disk','shelf2-bay07'],['file','KINGSTON_SA400.img'],['file','backup-20240101.img'],
    // File basenames shaped like kernel names or another type's hash (would drop a report if sent).
    ['file','sdb'],['file','loop0'],['file','md0'],['file','zd0'],['file','disk-20240101'],
    // A name of the wrong shape for its type.
    // Group types only take ZFS group names or their own hash label; local names
    // (aliases, basenames) are free-form but bounded and identifier-free.
    ['mirror','sda'],['mirror','mirror'],['raidz','file-0a1b2c3d'],['disk','/dev/sda'],['disk','x'.repeat(65)]];
  for(const [type,name] of accepted)assert.ok(sandbox.nameAllowed(type,name),'accept '+type+' '+name);
  for(const [type,name] of rejected)assert.ok(!sandbox.nameAllowed(type,name),'reject '+type+' '+name);
  // Parity: the agent's name_allowed() and the server's rule give identical verdicts.
  const table=[...accepted,...rejected,...['disk','file','mirror','raidz','unknown','dspare','spare'].flatMap(type=>['mirror-0','raidz1-0','spare-1','sda','nvme0n1','mpatha','vdev.img','disk1','x','file-0a1b2c3d','disk-0a1b2c3d','mirror-0a1b2c3d','device-0a1b2c3d','spare-0a1b2c3d','a b','',null].map(name=>[type,name]))];
  const agentVerdicts=JSON.parse(spawnSync('python3',['-I','-c',`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('agent', 'storage-agent/crowsnest_storage.py')
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
print(json.dumps([agent.name_allowed(t, n) for t, n in json.loads(sys.argv[1])]))`,JSON.stringify(table)],{encoding:'utf8'}).stdout);
  table.forEach(([type,name],i)=>assert.equal(agentVerdicts[i],sandbox.nameAllowed(type,name),'agent and server agree on '+type+' '+JSON.stringify(name)));
  // ...and every name the agent produces for those inputs is one the server accepts.
  const agentNames=JSON.parse(spawnSync('python3',['-I','-c',`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('agent', 'storage-agent/crowsnest_storage.py')
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
namer = agent.DeviceNamer('5a' * 32, dev_root='/nonexistent', sys_root='/nonexistent')
out = []
for vtype, name in json.loads(sys.argv[1]):
    node = {'vdev_type': vtype, 'name': name, 'devid': name, 'guid': len(out) + 1}
    out.append([vtype if vtype in ('disk', 'file', 'mirror', 'raidz', 'draid', 'replacing', 'spare', 'dspare') else 'unknown', name, namer.name(node, 'tank', {})])
print(json.dumps(out))`,JSON.stringify([...accepted,...rejected])],{encoding:'utf8'}).stdout);
  for(const [type,input,emitted] of agentNames) {
    assert.ok(sandbox.nameAllowed(type,emitted),'agent output for '+input+' ('+emitted+') must be accepted');
    if(rejected.some(([t,n])=>t===type && n===input))assert.notEqual(emitted,input,'identifier '+input+' is never sent as-is');
  }
  assert.equal(objects.get('snapshots/'+id+'.json'),before);
  // Unknown fields are dropped like the container validator does; known ones stay strict.
  const extra=clone(base);extra.extra='x';extra.storage.extra='x';pool(extra).guid=1;leaf(extra).path='/dev/disk/by-id/x';pool(extra).scan.processed=1;
  assert.equal((await ingest(extra)).status,200);
  assert.ok(!/extra|guid|by-id|"processed"/.test(objects.get('snapshots/'+id+'.json')));
  // Container reports keep their own validator: a storage section from a Docker host is dropped.
  assert.equal((await ingest({...dockerReport,storage:base.storage},dockerToken,docker.hostId)).status,200);
  assert.equal(read('snapshots/'+docker.hostId+'.json').storage,undefined);
  assert.equal((await ingest(base,dockerToken,docker.hostId)).status,400,'storage report to a Docker host');
  // As on main: an unreadable previous snapshot skips only the history write; the report is accepted.
  for(const [hostId,token,report] of [[docker.hostId,dockerToken,dockerReport],[id,config.hostToken,base]]) {
    const historyBefore=objects.get('history/'+hostId+'.json');
    objects.set('snapshots/'+hostId+'.json','{not json');
    assert.equal((await ingest(report,token,hostId)).status,200,'an unreadable previous snapshot does not fail ingest');
    assert.doesNotThrow(()=>JSON.parse(objects.get('snapshots/'+hostId+'.json')),'the new snapshot replaces it');
    assert.equal(objects.get('history/'+hostId+'.json'),historyBefore,'only the history write is skipped');
  }

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
  const cleared=clone(corrupted);leafNamed(cleared,'disk3').checksum=0;
  assert.deepEqual(await step(cleared),['zfstest/disk3: error counters reset (zpool clear or reboot); now read 0, write 0, checksum 0']);
  assert.deepEqual(await step(corrupted),['zfstest/disk3: errors increased (checksum 0 → 16)'],'new errors after a reset count from the new baseline');
  const partial=clone(corrupted);leafNamed(partial,'disk3').checksum=2;
  assert.deepEqual(await step(partial),['zfstest/disk3: error counters reset (zpool clear or reboot); now read 0, write 0, checksum 2'],'a decrease is a reset even if errors remain');
  // Agent error state and recovery: changes are measured against the last successful report.
  const failed={agentVersion:base.agentVersion,agentProtocol:1,storage:{state:'error',error:'permission_denied',zfsVersion:'2.4.1-1',pools:[],datasetsStatus:'disabled'}};
  assert.deepEqual(await step(failed),['Storage agent error: permission_denied']);
  assert.deepEqual(await step(failed),[]);
  assert.deepEqual(await step(corrupted),['Storage agent recovered; pool status is available again','zfstest/disk3: errors increased (checksum 2 → 16)'],'the last successful report (checksum 2) is the baseline');
  // A pool that degrades while the agent is failing (e.g. zpool status hangs) is still recorded.
  reset();await step(scenario('04-scrub-finished'));await step(failed);
  assert.deepEqual(await step(scenario('05-degraded-offline')),['Storage agent recovered; pool status is available again','zfstest: ONLINE → DEGRADED','zfstest/mirror-0: ONLINE → DEGRADED','zfstest/disk2: ONLINE → OFFLINE']);
  // Special, log, cache and spare vdevs (zpool status lists them beside the main tree).
  const classes=name=>fixture('captured-classes/'+name);
  reset();await step(classes('01-all-healthy'));
  assert.deepEqual(await step(classes('03-cache-offline')),['zfstest2/cache1: ONLINE → OFFLINE'],'a cache device going offline is recorded while the pool stays ONLINE');
  reset();await step(classes('01-all-healthy'));
  assert.deepEqual(await step(classes('04-spare-inuse-resilvering')),['zfstest2: ONLINE → DEGRADED','zfstest2/mirror-0: ONLINE → DEGRADED','zfstest2/spare-1: added (DEGRADED)','zfstest2/d2: ONLINE → OFFLINE','zfstest2/spare1: AVAIL → ONLINE','zfstest2: resilver started'],'the hot spare moves into the tree; it is not reported as removed');
  // Data errors and a scrub that found errors.
  reset();
  await step(fixture('synthetic/scrub-in-progress'));
  assert.deepEqual(await step(fixture('synthetic/checksum-errors')),['tank: permanent data errors 0 → 2','tank/sdd: errors increased (checksum 0 → 17)','tank: scrub finished (repaired 1.0 MiB, 2 error(s))']);
  // A single report is bounded to 20 events plus a summary.
  const wide=clone(fixture('synthetic/scrub-in-progress')), widePool=pool(wide);
  widePool.vdevs[0].children[0].children=Array.from({length:30},(_,i)=>({name:'sd'+String.fromCharCode(97+i%26)+(i<26?'':'x'),type:'disk',class:'normal',state:'ONLINE',read:0,write:0,checksum:0}));
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
  // At 150 s a storage agent is fresh again, so the recovery is announced, not suppressed as stale.
  const backoff=read('notifications/hosts/'+id+'.json');backoff.nextAttemptAt=0;set('notifications/hosts/'+id+'.json',backoff);
  age(150);requests.length=0;await sweep();
  assert.ok(alerts().some(m=>m.startsWith('nas\nCleared:')),'recovery at 150 s: '+alerts().join('|'));
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
  // Conditional writes: another writer lands between this writer's read and its put.
  // An unconditional put would silently discard that writer's data.
  const realBucket=env.BUCKET;
  const intercept=hooks=>{env.BUCKET={...realBucket,
    get:async key=>{if(hooks.get)await hooks.get(key);return realBucket.get(key);},
    put:async(key,value,options)=>{if(hooks.put)await hooks.put(key,value,options);return realBucket.put(key,value,options);}};};
  const historyKey='storage-history/'+id+'.json', stateKey='storage/'+id+'.json';
  // Worst case for the retry tests: both reports in the same millisecond (a fast machine).
  const RealDate=Date, frozen=RealDate.now();
  globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[frozen]));}static now(){return frozen;}};
  try {
    objects.delete(historyKey);
    let injected=false;
    const concurrent={at:new Date(Date.now()-3600000).toISOString(),pools:[['concurrent',1,1,1]]};
    intercept({put:async key=>{if(key===historyKey && !injected){injected=true;set(historyKey,[concurrent]);}}});
    assert.equal((await ingest(corrupted)).status,200);
    assert.deepEqual(history().map(s=>s.pools[0][0]),['concurrent','zfstest'],'history retries and keeps the concurrent reading');
    injected=false;
    // An identical state is (correctly) not rewritten, so make sure this report has something to write.
    set(stateKey,{...read(stateKey),at:new RealDate(frozen-60000).toISOString()});
    const later={endTime:'2030-01-01T00:00:00Z',errors:0,repairedBytes:0};
    intercept({put:async key=>{if(key===stateKey && !injected){injected=true;set(stateKey,{...read(stateKey),at:new Date(Date.now()-1000).toISOString(),pools:{zfstest:{lastScrub:later}}});}}});
    assert.equal((await ingest(corrupted)).status,200);
    assert.deepEqual(read(stateKey).pools.zfstest.lastScrub,later,'state retries and keeps the concurrent writer\'s newer scrub');
    globalThis.Date=RealDate;
    // A state written by a newer report is never replaced by an older one.
    intercept({});
    const newer={...read(stateKey),at:new Date(Date.now()+3600000).toISOString(),marker:'newer'};set(stateKey,newer);
    assert.equal((await ingest(corrupted)).status,200);
    assert.equal(read(stateKey).marker,'newer','an older report does not overwrite newer state');
    // A newer reading in the same window (a later report that finished first) is kept.
    let receivedAt=null, window=false;
    intercept({put:async(key,value)=>{if(key==='snapshots/'+id+'.json')receivedAt=JSON.parse(value).receivedAt;},
      get:async key=>{if(key===historyKey && receivedAt && !window){window=true;
        const at=Date.parse(receivedAt)+1;set(historyKey,[{at:new Date(at).toISOString(),pools:[['newer-in-window',1,1,1]]}]);
        await new Promise(resolve=>setTimeout(resolve,5));}}});
    assert.equal((await ingest(corrupted)).status,200);
    assert.ok(window && Math.floor(Date.parse(receivedAt)/300000)===Math.floor((Date.parse(receivedAt)+1)/300000));
    assert.deepEqual(history().map(s=>s.pools[0][0]),['newer-in-window'],'the newer reading in the window is kept');
  } finally {env.BUCKET=realBucket;globalThis.Date=RealDate;}

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

  // The dashboard's Replace-token button asks for the right format per host kind,
  // and the server's answer passes the board's own validation.
  const boardContext=vm.createContext({});
  vm.runInContext(board.slice(board.indexOf('function credentialFormat('),board.indexOf('const context = document.modelContext;'))+';this.credentialFormat=credentialFormat;this.storageTokenCommand=storageTokenCommand;',boardContext);
  const listed=Object.fromEntries((await (await call('/api/hosts')).json()).hosts.map(h=>[h.id,h]));
  assert.equal(boardContext.credentialFormat(listed[docker.hostId]),'config','Docker hosts keep their collector.json flow');
  const viaBoard=await call('/api/hosts/'+id+'/collector','POST',{format:boardContext.credentialFormat(listed[id])});
  assert.equal(viaBoard.status,200,'the board requests storage-token for a storage host');
  assert.match(boardContext.storageTokenCommand(await viaBoard.json()),/^sudo bash <<'CROWSNEST_STORAGE_TOKEN'\n/);
  assert.throws(()=>boardContext.storageTokenCommand({tokenCommand:'rm -rf /'}),/incomplete/);
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
    // Pasted on another storage host, the command changes nothing there.
    const otherHost=JSON.stringify({...config,hostId:'99999999-9999-4999-8999-999999999999',hostToken:'test-host-token',nameSalt:'5a'.repeat(32)});
    await writeFile(file,otherHost);
    const wrongHost=spawnSync('python3',['-I','-',file],{input:python,encoding:'utf8'});
    assert.notEqual(wrongHost.status,0,'refuses a storage.json for a different host');
    assert.match(wrongHost.stderr,/belongs to a different storage host; nothing was changed/);
    assert.equal(await readFile(file,'utf8'),otherHost,'the other host keeps its token');
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
