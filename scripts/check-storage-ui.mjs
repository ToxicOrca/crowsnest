// Storage hosts in the dashboard: the host list API, resumed storage setup, and the board's storage helpers.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {testBucket} from './test-storage.mjs';
import {agentReports} from './storage-fixtures.mjs';

const source=await readFile('dist/server/index.js','utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const objects=new Map();
const env={SITE_ORIGIN:'https://board.example',AUTH_MODE:'standalone',DEFER_NOTIFICATIONS:true,BUCKET:testBucket(objects)};
const viewer={'oai-authenticated-user-id':'standalone-owner',Origin:env.SITE_ORIGIN};
const call=(path,method='GET',data,headers=viewer)=>worker.fetch(new Request(env.SITE_ORIGIN+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
const clone=value=>JSON.parse(JSON.stringify(value));
// Fixture scans carry real capture dates; move them to an hour ago so the check never ages.
const iso=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
const fresh=name=>{const report=clone(agentReports[name]);for(const pool of report.storage.pools)if(pool.scan){pool.scan.startTime=iso(Date.now()-4200000);if(pool.scan.endTime)pool.scan.endTime=iso(Date.now()-3600000);}return report;};
const tokenFrom=command=>JSON.parse(command.match(/cat > storage\.json <<'CROWSNEST_FILE_EOF'\n([\s\S]*?)\nCROWSNEST_FILE_EOF/)[1]).hostToken;
const listed=async name=>(await (await call('/api/hosts')).json()).hosts.find(h=>h.name===name);
const ingest=(id,token,report)=>call('/api/ingest/'+id,'POST',report,{Authorization:'Bearer '+token});
const settings=data=>call('/api/notifications','PATCH',{enabled:false,recoveries:true,...data});

// Enrollment, then a resumed setup before the first report: a new token that activates on first use.
const setup=await (await call('/api/hosts','POST',{name:'nas',kind:'storage',format:'setup'})).json();
const id=setup.hostId, firstToken=tokenFrom(setup.setupCommand);
let host=await listed('nas');
assert.equal(host.kind,'storage');
assert.deepEqual(host.storageAlerts,[],'no report yet: no storage issues');
const resumed=await call('/api/hosts/'+id+'/collector','POST',{format:'setup'});
assert.equal(resumed.status,200);
const resumedSetup=await resumed.json();
assert.equal(resumedSetup.kind,'storage');
assert.equal(resumedSetup.hostId,id);
assert.ok(resumedSetup.setupCommand.startsWith("sudo bash <<'CROWSNEST_STORAGE_SETUP'\nexport CROWSNEST_PREPARE_ONLY=1\n"));
const resumedToken=tokenFrom(resumedSetup.setupCommand);
assert.notEqual(resumedToken,firstToken);
for(const format of ['compose','config','update'])assert.equal((await call('/api/hosts/'+id+'/collector','POST',{format})).status,400,format);
assert.equal((await ingest(id,resumedToken,fresh('captured-scenarios/05-degraded-offline'))).status,200,'the resumed setup token reports');
assert.equal((await ingest(id,firstToken,fresh('captured-scenarios/05-degraded-offline'))).status,403,'and replaces the original token');
const again=await call('/api/hosts/'+id+'/collector','POST',{format:'setup'});
assert.equal(again.status,409,'a reporting storage host replaces its token instead of repeating setup');
assert.match((await again.json()).error,/already reports/);
assert.equal((await call('/api/hosts/'+id+'/collector','POST',{format:'storage-token'})).status,200,'token replacement still works');

// Storage issues on the host list use the alert rules, all on, with the operator's thresholds.
host=await listed('nas');
const ids=host.storageAlerts.map(a=>a.id).sort();
assert.deepEqual(ids,['zfs:pool:zfstest','zfs:vdev:zfstest/disk2']);
const pool=host.storageAlerts.find(a=>a.id==='zfs:pool:zfstest');
assert.deepEqual(pool,{id:'zfs:pool:zfstest',rule:'pool',pool:'zfstest',severity:'high',text:'zfstest: pool is DEGRADED'});
assert.deepEqual(host.storageAlerts.find(a=>a.rule==='vdev'),{id:'zfs:vdev:zfstest/disk2',rule:'vdev',pool:'zfstest',severity:'default',text:'zfstest/disk2: OFFLINE'});
// Turning a rule off changes what ntfy sends, not what the dashboard shows.
assert.equal((await settings({storagePoolAlerts:false,storageVdevAlerts:false,hostReports:false})).status,200);
assert.deepEqual((await listed('nas')).storageAlerts.map(a=>a.id).sort(),ids,'disabled rules still show on the dashboard');
// Thresholds do apply: a lower warning shows a capacity issue at the reported usage.
const capacity=agentReports['captured-scenarios/05-degraded-offline'].storage.pools[0].capacityPercent;
assert.ok(capacity>=50 && capacity<80,'fixture capacity '+capacity);
assert.equal((await settings({storageCapacityWarn:50,storageCapacityHigh:capacity+1})).status,200);
assert.deepEqual((await listed('nas')).storageAlerts.find(a=>a.rule==='capacity'),{id:'zfs:capacity:zfstest',rule:'capacity',pool:'zfstest',severity:'low',text:'zfstest: capacity reached 50% (warning)'});
assert.equal((await settings({storageCapacityWarn:80,storageCapacityHigh:90})).status,200);
// An agent that cannot read ZFS is one host-level issue (pool null), shown even with report alerts off.
const failed={agentVersion:agentReports['captured-scenarios/05-degraded-offline'].agentVersion,agentProtocol:1,storage:{state:'error',error:'permission_denied',zfsVersion:null,pools:[],datasetsStatus:'disabled'}};
assert.equal((await ingest(id,resumedToken,failed)).status,200);
assert.deepEqual((await listed('nas')).storageAlerts,[{id:'zfs:agent:',rule:'agent',pool:null,severity:'default',text:'Storage agent cannot read ZFS (permission_denied)'}]);
// Docker hosts carry no storage issues.
assert.equal((await call('/api/hosts','POST',{name:'docker-host',format:'setup'})).status,200);
assert.equal('storageAlerts' in (await listed('docker-host')),false);
const dockerId=(await listed('docker-host')).id;
assert.equal((await call('/api/hosts/'+dockerId+'/collector','POST',{format:'storage-token'})).status,400);

// Board: the settings form uses the server's limits and every storage rule.
const html=await readFile('worker/board.html','utf8'), board=await readFile('worker/board.js','utf8');
const rules=vm.createContext({});vm.runInContext(await readFile('worker/storage.js','utf8')+'\nthis.api={STORAGE_ALERT_DEFAULTS,STORAGE_ALERT_NUMBERS,storageTimeText,storageAttention};',rules);
for(const [key,value] of Object.entries(rules.api.STORAGE_ALERT_DEFAULTS)) {
  const input=html.match(new RegExp('<input id="notifications-'+key+'"[^>]*>'))?.[0];
  assert.ok(input,'settings input for '+key);
  if(typeof value==='boolean')assert.match(input,/type="checkbox" checked/,key+' starts on, like the server default');
  else {
    const [min,max]=rules.api.STORAGE_ALERT_NUMBERS[key];
    assert.ok(input.includes('min="'+min+'" max="'+max+'"') && input.includes('value="'+value+'"'),key+' limits match the server: '+input);
  }
}
for(const id of ['storage-view','pool-cards','storage-filter','storage-fleet','pool-rows','host-kind','kind-storage','dataset-rows','storage-retry'])assert.ok(html.includes('id="'+id+'"'),id);
assert.ok(html.includes('id="storage-status" class="storage-status" role="status"'),'scrub detail errors are announced');
// Board helpers, evaluated from board.js itself.
const slice=(from,to)=>{const start=board.indexOf(from),end=board.indexOf(to,start);assert.ok(start>=0 && end>start,from);return board.slice(start,end);};
const helpers=vm.createContext({Date,Math,Number,String,Object});
// A minimal node() stand-in so element-building helpers run without a DOM.
const stubNode='function node(tag,className="",text){const el={tag,className,textContent:text,children:[],title:"",classList:{contains:c=>el.className.split(" ").includes(c)},append(...kids){el.children.push(...kids);}};return el;}';
vm.runInContext([await readFile('worker/versions.js','utf8'),'let lastError="", availableStorageAgentVersion="0.2.0";',stubNode,
  slice('const age = iso','function node('),slice('function staleAfterSeconds','function groupMatches('),slice('function storageAgentInfo(','function collectorInfo('),
  slice('function reportDate(','function renderResourceOverview('),slice('// ZFS storage hosts. Issues come','function vdevItem('),
  'this.api={storageEngineText,stateClass,scanProgress,lastScrubText,storageAgentInfo,poolAlerts,storageAlerts,deviceErrorText,poolStateClass,poolRank,alertText,poolBadge};'].join('\n'),helpers);
const ui=helpers.api;
assert.equal(ui.storageEngineText({storage:{state:'ok',zfsVersion:'2.4.1-1'}}),'OpenZFS 2.4.1-1');
assert.equal(ui.storageEngineText({storage:{state:'error',zfsVersion:null}}),'ZFS status unavailable');
assert.deepEqual(clone(['ONLINE','DEGRADED','FAULTED','UNAVAIL','OFFLINE','AVAIL'].map(ui.stateClass)),['good','warn','bad','bad','bad','']);
assert.equal(ui.scanProgress({type:'scrub',state:'scanning',examinedBytes:50,totalBytes:200,startTime:null}),'Scrub in progress · 25% examined');
assert.equal(ui.scanProgress({type:'resilver',state:'scanning',examinedBytes:0,totalBytes:0,startTime:null}),'Resilver in progress');
assert.equal(ui.scanProgress({type:'scrub',state:'finished'}),'');
const ended=new Date(Date.now()-3*86400000).toISOString();
// The remembered scrub wins over this report (a resilver hides the last scrub in zpool status).
assert.match(ui.lastScrubText({scan:{type:'resilver',state:'finished',endTime:ended}},{status:'known',endTime:ended,errors:0,repairedBytes:0}).text,/ · 3d ago · repaired 0 B · 0 errors$/);
// A newer finished scrub in this report wins over remembered details loaded earlier; an older one does not.
const newer=new Date(Date.now()-86400000).toISOString();
assert.match(ui.lastScrubText({scan:{type:'scrub',state:'finished',endTime:newer,errors:0,repairedBytes:0}},{status:'known',endTime:ended,errors:0,repairedBytes:0}).text,/ · 1d ago · /,'the newer scrub in the report');
assert.match(ui.lastScrubText({scan:{type:'scrub',state:'finished',endTime:ended,errors:0,repairedBytes:0}},{status:'known',endTime:newer,errors:1,repairedBytes:0}).text,/ · 1d ago · repaired 0 B · 1 error$/,'the newer remembered scrub');
assert.deepEqual(clone(ui.lastScrubText({scan:null},null)),{text:'Never scrubbed',warn:false});
assert.deepEqual(clone(ui.lastScrubText({scan:{type:'resilver',state:'finished',endTime:ended}},{status:'unknown'})),{text:'No completed scrub seen yet',warn:false});
// Before the scrub details load, a finished scrub in this report is shown; repairs are a warning.
const repaired=ui.lastScrubText({scan:{type:'scrub',state:'finished',endTime:ended,errors:0,repairedBytes:2097152}},null);
assert.match(repaired.text,/repaired 2 MiB · 0 errors$/);assert.equal(repaired.warn,true);
const agentHost=status=>({kind:'storage',staleAfterSeconds:180,snapshot:{receivedAt:new Date().toISOString(),agentVersion:status}});
assert.equal(ui.storageAgentInfo(agentHost('0.1.0')).text,'Storage agent v0.1.0 · this dashboard ships v0.2.0');
assert.equal(ui.storageAgentInfo(agentHost('0.1.0')).short,'Storage agent v0.1.0 · update available');
assert.equal(ui.storageAgentInfo(agentHost('0.2.0')).text,'Storage agent v0.2.0 · current');
assert.equal(ui.storageAgentInfo({kind:'storage',snapshot:null}).text,'Storage agent awaiting first report');
const listedHost={kind:'storage',storageAlerts:[{pool:'tank',text:'a'},{pool:'bulk',text:'b'},{pool:null,text:'c'}]};
assert.deepEqual(clone(ui.poolAlerts(listedHost,'tank').map(a=>a.text)),['a']);
assert.deepEqual(clone(ui.storageAlerts({kind:'docker',storageAlerts:[{pool:'x'}]})),[],'only storage hosts have storage issues');
// Device errors: the pool's own counters stay 0 while a member disk has errors (the preview's coldpool and tank).
const fixturePool=name=>clone(agentReports[name].storage.pools[0]);
const coldpool=fixturePool('synthetic/checksum-errors'), faulted=fixturePool('synthetic/faulted-vdev'), healthy=fixturePool('synthetic/scrub-in-progress');
assert.deepEqual(clone(coldpool.errors),{read:0,write:0,checksum:0},'the fixture keeps root counters at 0');
assert.equal(ui.deviceErrorText(coldpool),'17 checksum (sdd)');
assert.equal(ui.deviceErrorText(faulted),'3 read, 41 write (sde)');
assert.equal(ui.deviceErrorText(healthy),'None');
const many=fixturePool('synthetic/checksum-errors');for(const disk of many.vdevs[0].children[0].children)disk.read=1;many.vdevs[0].children[0].read=2;
many.vdevs[0].children.push({...clone(many.vdevs[0].children[0]),name:'mirror-1',children:[{...clone(many.vdevs[0].children[0].children[0]),name:'sdf'}]});
assert.equal(ui.deviceErrorText(many),'2 read (mirror-0); 1 read, 17 checksum (sdd); 1 read (sde); +2 more','groups and members, capped at three');
// ONLINE keeps its text, but any open issue (or device errors alone) colors it as a warning.
assert.equal(ui.poolStateClass(coldpool,[]),'warn','device errors alone');
assert.equal(ui.poolStateClass(healthy,[{rule:'scrub-age'}]),'warn','any open issue');
assert.equal(ui.poolStateClass(healthy,[]),'good');
assert.equal(ui.poolStateClass(faulted,[]),'warn','DEGRADED keeps its own class');
assert.equal(ui.poolStateClass({...healthy,state:'FAULTED'},[]),'bad');
// The warning ONLINE badge names its reason for screen readers; other badges carry only the state.
const badge=ui.poolBadge(coldpool,[]);
assert.equal(badge.className,'pill warn');assert.equal(badge.textContent,'ONLINE');
assert.deepEqual(clone(badge.children.map(c=>[c.className,c.textContent])),[['sr-only',', with open storage issues']],'warning ONLINE badge explains itself');
assert.deepEqual(clone(ui.poolBadge(healthy,[]).children),[],'healthy badge has no extra text');
assert.deepEqual(clone(ui.poolBadge(faulted,[]).children),[],'DEGRADED speaks for itself');
assert.equal(ui.poolBadge(healthy,[{rule:'capacity'}],' · last known').textContent,'ONLINE · last known');
// Severity order: not ONLINE, data errors, device errors, capacity, scrub issues, healthy.
const ranked=[[healthy,[],'healthy'],[healthy,[{rule:'scrub-age'}],'scrub'],[healthy,[{rule:'capacity'}],'capacity'],[coldpool,[],'devices'],
  [healthy,[{rule:'data-errors'}],'data'],[faulted,[],'degraded'],[null,[{rule:'agent'}],'agent']];
assert.deepEqual([...ranked].sort((a,b)=>ui.poolRank(a[0],a[1])-ui.poolRank(b[0],b[1])).map(r=>r[2]),['degraded','agent','data','devices','capacity','scrub','healthy']);
assert.ok(ui.poolRank(healthy,[{rule:'capacity'},{rule:'data-errors'},{rule:'scrub-age'}])<ui.poolRank(coldpool,[]),'the worst issue decides');
// A scrub that found or repaired errors ranks with device errors, above capacity and overdue scrubs.
assert.equal(ui.poolRank(healthy,[{rule:'scrub-errors'}]),ui.poolRank(coldpool,[]),'scrub-found errors rank with device errors');
assert.ok(ui.poolRank(healthy,[{rule:'scrub-errors'}])<ui.poolRank(healthy,[{rule:'capacity'}]),'scrub-found errors rank above capacity');
assert.deepEqual(clone(ui.poolAlerts({kind:'storage',storageAlerts:[{pool:'p',rule:'scrub-age'},{pool:'p',rule:'capacity'},{pool:'p',rule:'scrub-errors'},{pool:'p',rule:'errors'},{pool:'p',rule:'data-errors'}]},'p').map(a=>a.rule)),['data-errors','scrub-errors','errors','capacity','scrub-age'],'issues list most severe first');
// Times: readable UTC in alert text (ntfy), the viewer's own format on the dashboard; never raw ISO.
assert.equal(rules.api.storageTimeText('2026-11-09T06:27:00Z'),'9 Nov 2026, 06:27 UTC');
const scrubbed=fixturePool('synthetic/checksum-errors');scrubbed.name='coldpool';scrubbed.vdevs[0].name='coldpool';
const end=new Date(Date.now()-3*86400000).toISOString().replace(/\.\d{3}Z$/,'Z');Object.assign(scrubbed.scan,{endTime:end,startTime:end});
const shown=clone(rules.api.storageAttention({receivedAt:end,storage:{state:'ok',pools:[scrubbed]}},{pools:{coldpool:{lastScrub:{endTime:end,errors:2,repairedBytes:1048576}}}},rules.api.STORAGE_ALERT_DEFAULTS,Date.now()));
const scrubIssue=shown.find(a=>a.rule==='scrub-errors');
assert.deepEqual(scrubIssue.time,{at:end,text:rules.api.storageTimeText(end)});
assert.ok(!/\d{4}-\d\d-\d\dT/.test(scrubIssue.text),'no ISO time in alert text: '+scrubIssue.text);
assert.equal(ui.alertText(scrubIssue),scrubIssue.text.replace(scrubIssue.time.text,new Date(end).toLocaleString()));
assert.notEqual(ui.alertText(scrubIssue),scrubIssue.text);
assert.equal(ui.alertText({text:'tank: pool is DEGRADED'}),'tank: pool is DEGRADED');
const never=fixturePool('captured-scenarios/01-fresh-never-scrubbed');
assert.deepEqual(clone(rules.api.storageAttention({storage:{state:'ok',pools:[never]}},{pools:{[never.name]:{firstSeen:new Date(Date.now()-40*86400000).toISOString()}}},rules.api.STORAGE_ALERT_DEFAULTS,Date.now()).filter(a=>a.rule==='scrub-age').map(a=>a.text)),[never.name+': never scrubbed']);
// The heading says "Fleet" only with storage hosts; Docker-only dashboards keep upstream's text.
assert.ok(html.includes('<title>Crowsnest · Docker fleet monitor</title>') && html.includes('<h1 id="fleet-heading">Docker fleet</h1>'));
console.log('Storage UI checks passed: storage issues on the host list (all rules shown, thresholds applied, agent errors, none on Docker hosts), resumed storage setup and its token, settings limits matching the server, and board storage helpers (device errors, pool state color, severity order, issue times).');
