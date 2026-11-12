// Storage alerts through the real ingest and notification pipeline (standalone mode).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {testBucket} from './test-storage.mjs';
import {agentReports} from './storage-fixtures.mjs';

const source=await readFile('dist/server/index.js','utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const objects=new Map(), requests=[];
const env={SITE_ORIGIN:'https://board.example',AUTH_MODE:'standalone',NTFY_URL:'https://ntfy.example.com/fleet',BUCKET:testBucket(objects)};
const viewer={'oai-authenticated-user-id':'standalone-owner',Origin:env.SITE_ORIGIN};
const call=(path,method='GET',data,headers=viewer)=>worker.fetch(new Request(env.SITE_ORIGIN+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
const read=key=>objects.has(key)?JSON.parse(objects.get(key)):null;
const set=(key,value)=>objects.set(key,JSON.stringify(value));
const clone=value=>JSON.parse(JSON.stringify(value));
const originalFetch=globalThis.fetch;
let failNext=0;
globalThis.fetch=async(url,options)=>{if(failNext>0){failNext--;throw new Error('simulated ntfy outage');}requests.push(JSON.parse(options.body));return new Response(JSON.stringify({id:'test-message',event:'message',topic:'fleet'}));};
const DAY=86400000, iso=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
// Fixture scans carry real capture dates; move them to "an hour ago" so the check never ages.
const fresh=(report,endedAgo=3600000)=>{
  for(const pool of report.storage.pools)if(pool.scan) {
    pool.scan.startTime=iso(Date.now()-endedAgo-600000);
    if(pool.scan.endTime)pool.scan.endTime=iso(Date.now()-endedAgo);
  }
  return report;
};
const fixture=(name,endedAgo)=>fresh(clone(agentReports[name]),endedAgo);
const vdev=(report,name)=>{const find=node=>node.name===name?node:(node.children||[]).map(find).find(Boolean);return find(report.storage.pools[0].vdevs[0]);};
const withCapacity=(report,percent)=>{const pool=report.storage.pools[0];pool.allocated=Math.floor(pool.size*percent/100)+1;pool.free=pool.size-pool.allocated;pool.capacityPercent=percent;return report;};

async function enroll(name) {
  const setup=await (await call('/api/hosts','POST',{name,kind:'storage'})).json();
  const token=JSON.parse(setup.setupCommand.match(/cat > storage\.json <<'CROWSNEST_FILE_EOF'\n([\s\S]*?)\nCROWSNEST_FILE_EOF/)[1]).hostToken;
  const id=setup.hostId, key='notifications/hosts/'+id+'.json';
  const unblock=()=>{const saved=read(key);if(saved){saved.nextAttemptAt=0;set(key,saved);}};
  return {
    id,unblock,
    // One report a minute later than the last; returns the messages it sent.
    async send(report) {
      const snapshot=read('snapshots/'+id+'.json');
      if(snapshot){snapshot.receivedAt=iso(Date.now()-60000);set('snapshots/'+id+'.json',snapshot);}
      unblock();const before=requests.length;
      assert.equal((await call('/api/ingest/'+id,'POST',report,{Authorization:'Bearer '+token})).status,200);
      return requests.slice(before);
    },
    lines:sent=>sent.flatMap(m=>m.message.split('\n').slice(1)),
    saved:()=>read(key),
    cool:()=>{const saved=read(key);saved.cooldowns={};set(key,saved);},
    // Age every cooldown past the 10-minute window, as if that much time had passed.
    expire:()=>{const saved=read(key);for(const id of Object.keys(saved.cooldowns||{}))saved.cooldowns[id]-=11*60000;set(key,saved);},
    state:()=>read('storage/'+id+'.json'),
    setState:value=>set('storage/'+id+'.json',value),
  };
}
const sweep=async()=>{objects.delete('notifications/sweep.json');let work;await worker.scheduled(null,env,{waitUntil:p=>{work=p;}});await work;};
const settings=data=>call('/api/notifications','PATCH',{enabled:true,recoveries:true,...data});

try {
  let before;
  // Settings: defaults, validation, and a body with every field (well inside the 1 KiB settings limit).
  const defaults=await (await call('/api/notifications')).json();
  assert.deepEqual([defaults.storagePoolAlerts,defaults.storageVdevAlerts,defaults.storageErrorAlerts,defaults.storageScrubErrorAlerts,defaults.storageScrubAgeAlerts,defaults.storageCapacityAlerts],[true,true,true,true,true,true]);
  assert.deepEqual([defaults.storageScrubDays,defaults.storageCapacityWarn,defaults.storageCapacityHigh],[35,80,90]);
  for(const bad of [{storageScrubDays:0},{storageScrubDays:366},{storageScrubDays:'35'},{storageCapacityWarn:49},{storageCapacityHigh:101},{storageCapacityAlerts:'yes'},{storageCapacity:80}])
    assert.equal((await settings(bad)).status,400,JSON.stringify(bad));
  assert.equal((await settings({storageCapacityWarn:90,storageCapacityHigh:90})).status,400,'warning must be below high');
  assert.equal((await settings({storageCapacityWarn:95})).status,400,'checked against the stored high threshold too');
  const everything={enabled:true,recoveries:true,hostReports:true,unhealthy:true,restarting:true,dead:true,staleMinutes:2,priority:4,cpuAlerts:false,cpuThreshold:150,memoryAlerts:false,memoryMiB:1024,resourceMinutes:5,restartBursts:false,restartCount:5,restartWindowMinutes:10,cooldownMinutes:10,
    storagePoolAlerts:true,storageVdevAlerts:true,storageErrorAlerts:true,storageScrubErrorAlerts:true,storageScrubAgeAlerts:true,storageScrubDays:35,storageCapacityAlerts:true,storageCapacityWarn:80,storageCapacityHigh:90};
  assert.ok(JSON.stringify(everything,null,2).length<1024);
  assert.equal((await call('/api/notifications','PATCH',everything)).status,200,'a body with every setting is accepted');

  const nas=await enroll('nas');
  // A healthy pool with a clean, recent scrub sends nothing.
  assert.deepEqual(await nas.send(fixture('captured-scenarios/04-scrub-finished')),[]);

  // Capture 08: pool ONLINE, no data errors, but a disk's checksum counter and a repairing scrub.
  let sent=await nas.send(fixture('captured-scenarios/08-checksum-errors-after-scrub'));
  assert.equal(sent.length,1);
  const scrubLine=nas.lines(sent).find(l=>l.includes('scrub finished'));
  assert.deepEqual(nas.lines(sent),['Alert: zfstest/disk3: read 0, write 0, checksum 16 error(s)',scrubLine]);
  assert.match(scrubLine,/^Alert: zfstest: scrub finished \S+ repaired 2\.0 MiB with 0 error\(s\)$/);
  assert.equal(sent[0].priority,4);
  assert.equal(new URL(sent[0].click).searchParams.get('host'),nas.id);
  assert.deepEqual(await nas.send(fixture('captured-scenarios/08-checksum-errors-after-scrub')),[],'unchanged errors are not repeated');

  // A counter decrease (zpool clear, then new errors) is a new baseline: no alert.
  const partial=fixture('captured-scenarios/08-checksum-errors-after-scrub');vdev(partial,'disk3').checksum=5;
  nas.cool();  // So only the reset rule, not the cooldown, can keep this quiet.
  assert.deepEqual(await nas.send(partial),[],'a decrease is a reset, not an alert');
  assert.deepEqual(nas.saved().storageCounters['zfs:errors:zfstest/disk3'],{read:0,write:0,checksum:5});
  // An increase over the new baseline alerts; a further increase waits for the cooldown.
  const more=clone(partial);vdev(more,'disk3').checksum=7;
  assert.deepEqual(nas.lines(await nas.send(more)),['Alert: zfstest/disk3: read 0, write 0, checksum 7 error(s)']);
  const most=clone(more);vdev(most,'disk3').checksum=9;
  assert.deepEqual(await nas.send(most),[],'an increase inside the cooldown waits');
  nas.cool();
  assert.deepEqual(nas.lines(await nas.send(most)),['Alert: zfstest/disk3: read 0, write 0, checksum 9 error(s)']);
  // Counters back to zero: the alert clears.
  const cleared=clone(most);vdev(cleared,'disk3').checksum=0;
  assert.deepEqual(nas.lines(await nas.send(cleared)),['Cleared: zfstest/disk3: error counters cleared (zpool clear or reboot)']);

  // Pool and vdev state. The DEGRADED mirror is explained by its OFFLINE disk, so only the disk alerts.
  // A pool that is not ONLINE is at least high priority even when the operator chose default priority.
  await settings({priority:3});
  sent=await nas.send(fixture('captured-scenarios/05-degraded-offline'));
  assert.deepEqual(nas.lines(sent).filter(l=>!l.includes('scrub')),['Alert: zfstest: pool is DEGRADED','Alert: zfstest/disk2: OFFLINE']);
  assert.equal(sent[0].priority,4);
  // The agent losing ZFS access is an alert of its own; the pool alerts stay delivered, not "cleared".
  const failed={agentVersion:agentReports['captured-scenarios/04-scrub-finished'].agentVersion,agentProtocol:1,storage:{state:'error',error:'permission_denied',zfsVersion:'2.4.1-1',pools:[],datasetsStatus:'disabled'}};
  assert.deepEqual(nas.lines(await nas.send(failed)),['Alert: Storage agent cannot read ZFS (permission_denied)']);
  assert.ok(nas.saved().delivered['zfs:pool:zfstest'],'pool alert kept while the agent cannot read ZFS');
  sent=await nas.send(fixture('captured-scenarios/05-degraded-offline'));
  assert.deepEqual(nas.lines(sent),['Cleared: Storage agent can read ZFS again']);
  // A pruned tree that omits the OFFLINE disk does not prove it recovered.
  const pruned=fixture('captured-scenarios/05-degraded-offline');
  const mirror=vdev(pruned,'mirror-0');mirror.children=mirror.children.filter(c=>c.name!=='disk2');pruned.storage.pools[0].vdevsTruncated=true;
  assert.deepEqual(await nas.send(pruned),[]);
  assert.ok(nas.saved().delivered['zfs:vdev:zfstest/disk2']);
  // Recovery needs a second consecutive report (flap protection); both alerts stay on record until then.
  assert.deepEqual(await nas.send(fixture('captured-scenarios/07-resilver-finished')),[],'one clean report is not yet a recovery');
  assert.ok(nas.saved().delivered['zfs:pool:zfstest'] && nas.saved().delivered['zfs:vdev:zfstest/disk2'],'held alerts stay on record');
  nas.unblock();before=requests.length;await sweep();
  assert.deepEqual(requests.slice(before),[],'a sweep re-reading the same report is not a second report');
  assert.ok(read('notifications/sweep.json').pending>=1,'a held recovery is reported as pending');
  sent=await nas.send(fixture('captured-scenarios/07-resilver-finished'));
  assert.deepEqual(nas.lines(sent).sort(),['Cleared: zfstest/disk2: vdev no longer reported; check the dashboard','Cleared: zfstest: pool is ONLINE again']);
  assert.equal(sent[0].priority,3,'recoveries only use default priority');
  await settings({priority:4});

  // Maintenance pauses storage alerts like any other; they arrive once it ends.
  nas.expire();  // A vdev re-alert inside the cooldown would wait (flap protection, tested below).
  assert.equal((await call('/api/hosts/'+nas.id+'/maintenance','POST',{minutes:15})).status,200);
  assert.deepEqual(await nas.send(fixture('captured-scenarios/05-degraded-offline')),[]);
  assert.equal((await call('/api/hosts/'+nas.id+'/maintenance','POST',{minutes:0})).status,200);
  assert.deepEqual(nas.lines(await nas.send(fixture('captured-scenarios/05-degraded-offline'))).filter(l=>!l.includes('scrub')),['Alert: zfstest: pool is DEGRADED','Alert: zfstest/disk2: OFFLINE']);
  // Turning a rule off retires its alert silently; turning it on alerts again.
  await settings({storageVdevAlerts:false});
  assert.deepEqual(await nas.send(fixture('captured-scenarios/05-degraded-offline')),[],'disabling is not a recovery');
  assert.equal(nas.saved().delivered['zfs:vdev:zfstest/disk2'],undefined);
  await settings({storageVdevAlerts:true});
  assert.deepEqual(nas.lines(await nas.send(fixture('captured-scenarios/05-degraded-offline'))),['Alert: zfstest/disk2: OFFLINE']);

  // Stale at 180 s; the recovery names the storage agent.
  const snapshot=read('snapshots/'+nas.id+'.json');snapshot.receivedAt=iso(Date.now()-200000);set('snapshots/'+nas.id+'.json',snapshot);
  nas.unblock();before=requests.length;await sweep();
  assert.deepEqual(requests.slice(before).map(m=>m.message),['nas\nAlert: No storage agent report for more than three minutes']);
  assert.ok(nas.saved().delivered['zfs:pool:zfstest'],'a stale host keeps its pool alerts');
  sent=await nas.send(fixture('captured-scenarios/05-degraded-offline'));
  assert.deepEqual(nas.lines(sent),['Cleared: Storage agent reporting resumed']);

  // Hot spares, log, cache and special vdevs (captured on a second host).
  const spare=await enroll('nas-classes');
  assert.deepEqual(await spare.send(fixture('captured-classes/01-all-healthy')),[],'an AVAIL spare is healthy');
  // Each capture is reported twice: a vdev recovery needs a second consecutive report.
  const settle=async name=>[...await spare.send(fixture('captured-classes/'+name)),...await spare.send(fixture('captured-classes/'+name))];
  sent=await settle('03-cache-offline');
  assert.deepEqual(spare.lines(sent),['Alert: zfstest2/cache1 (cache): OFFLINE'],'a cache device alerts while the pool is ONLINE');
  assert.equal(sent[0].priority,4);
  sent=await settle('02-log-offline');
  assert.deepEqual(spare.lines(sent),['Alert: zfstest2: pool is DEGRADED','Alert: zfstest2/log1 (log): OFFLINE','Cleared: zfstest2/cache1: vdev is healthy again']);
  sent=await settle('06-special-member-offline');
  assert.deepEqual(spare.lines(sent),['Alert: zfstest2/sp2 (special): OFFLINE','Cleared: zfstest2/log1: vdev is healthy again']);
  sent=await settle('04-spare-inuse-resilvering');
  assert.deepEqual(spare.lines(sent),['Alert: zfstest2/d2: OFFLINE','Cleared: zfstest2/sp2: vdev is healthy again'],'the in-use spare is ONLINE and not an alert');
  sent=await settle('05-spare-inuse-resilver-finished');
  assert.deepEqual(sent,[]);
  // A spare that comes back as AVAIL is healthy again, not "now AVAIL".
  const lostSpare=fixture('captured-classes/01-all-healthy');vdev(lostSpare,'spare1').state='UNAVAIL';
  assert.ok(spare.lines([...await spare.send(lostSpare),...await spare.send(lostSpare)]).includes('Alert: zfstest2/spare1 (spare): UNAVAIL'));
  spare.expire();
  assert.ok(spare.lines(await settle('01-all-healthy')).includes('Cleared: zfstest2/spare1: vdev is healthy again'),'an AVAIL spare is a recovery');

  // Capacity: 80% warning, 90% high, with two points of hysteresis and the cooldown.
  const cap=await enroll('nas-capacity');
  const full=percent=>withCapacity(fixture('synthetic/capacity-92'),percent);
  sent=await cap.send(full(92));
  assert.deepEqual(cap.lines(sent),['Alert: tank: capacity reached 90% (high)']);
  assert.equal(sent[0].priority,4);
  assert.deepEqual(await cap.send(full(89)),[],'hysteresis holds the high alert at 89%');
  assert.deepEqual(await cap.send(full(87)),[],'the change to a warning waits for the cooldown');
  cap.cool();
  sent=await cap.send(full(87));
  assert.deepEqual(cap.lines(sent),['Alert: tank: capacity reached 80% (warning)']);
  assert.equal(sent[0].priority,3,'a warning alone is default priority');
  assert.deepEqual(await cap.send(full(79)),[],'hysteresis holds the warning at 79%');
  const unknown=full(79);unknown.storage.pools[0].capacityPercent=null;
  assert.deepEqual(await cap.send(unknown),[],'an unknown capacity is not a recovery');
  assert.deepEqual(cap.lines(await cap.send(full(77))),['Cleared: tank: capacity back below the alert threshold']);
  // A threshold change retires the alerts that depend on it without a recovery message.
  cap.cool();
  assert.deepEqual(cap.lines(await cap.send(full(85))),['Alert: tank: capacity reached 80% (warning)']);
  await settings({storageCapacityWarn:88});
  assert.deepEqual(await cap.send(full(85)),[],'raising the threshold is not a recovery');
  await settings({storageCapacityWarn:80});
  assert.deepEqual(cap.lines(await cap.send(full(85))),['Alert: tank: capacity reached 80% (warning)']);

  // Scrub age (default 35 days), using the remembered scrub.
  const age=await enroll('nas-scrub');
  const old=fixture('captured-scenarios/04-scrub-finished',40*DAY);
  sent=await age.send(old);
  assert.equal(sent.length,1);
  assert.match(age.lines(sent)[0],/^Alert: zfstest: last completed scrub \(\S+\) is older than 35 days$/);
  assert.equal(sent[0].priority,3);
  // A resilver hides the last scrub in zpool status; the remembered scrub still counts.
  const resilver=fixture('captured-scenarios/06-resilver-in-progress');
  assert.equal(resilver.storage.pools[0].scan.type,'resilver');
  assert.ok(!age.lines(await age.send(resilver)).some(l=>l.includes('scrub')),'the scrub-age alert stays delivered during a resilver');
  assert.ok(age.saved().delivered['zfs:scrub-age:zfstest']);
  // A scrub in progress keeps the alert until it finishes; then it clears.
  const running=fixture('captured-scenarios/03-scrub-in-progress');
  assert.deepEqual(age.lines(await age.send(running)).filter(l=>l.includes('scrub')),[],'a running scrub does not clear the alert yet');
  assert.ok(age.saved().delivered['zfs:scrub-age:zfstest']);
  assert.deepEqual(age.lines(await age.send(fixture('captured-scenarios/04-scrub-finished'))).filter(l=>l.includes('scrub')),['Cleared: zfstest: scrubbed recently']);
  sent=await age.send(old);
  assert.deepEqual(age.lines(sent).filter(l=>l.includes('scrub')),[],'an older scrub report does not replace the remembered newer scrub');
  // Remembered scrub 40 days old, made by editing the state the server keeps.
  const remembered=age.state();remembered.pools.zfstest.lastScrub.endTime=iso(Date.now()-40*DAY);age.setState(remembered);
  const resilvered=fixture('captured-scenarios/07-resilver-finished');
  assert.match(age.lines(await age.send(resilvered)).join('|'),/Alert: zfstest: last completed scrub \(\S+\) is older than 35 days/);
  await settings({storageScrubDays:60});
  assert.deepEqual(age.lines(await age.send(resilvered)).filter(l=>l.includes('scrub')),[],'a longer period is not a recovery');
  await settings({storageScrubDays:35});
  assert.match(age.lines(await age.send(resilvered)).join('|'),/Alert: zfstest: last completed scrub/);
  // "never" (no scan record) and "unknown" (none seen) alert only after the server watched the pool for the period.
  const never=await enroll('nas-never');
  const neverReport=fixture('captured-scenarios/01-fresh-never-scrubbed');
  assert.equal(neverReport.storage.pools[0].scan,null);
  assert.deepEqual(await never.send(neverReport),[],'a new pool is not overdue on day one');
  const watched=never.state();watched.pools.zfstest.firstSeen=iso(Date.now()-36*DAY);never.setState(watched);
  assert.deepEqual(never.lines(await never.send(neverReport)),['Alert: zfstest: never scrubbed in 35 days']);
  const unseen=await enroll('nas-unseen');
  assert.ok(!unseen.lines(await unseen.send(fixture('captured-scenarios/07-resilver-finished'))).some(l=>l.includes('scrub')));
  const unseenState=unseen.state();unseenState.pools.zfstest.firstSeen=iso(Date.now()-36*DAY);unseen.setState(unseenState);
  assert.ok(unseen.lines(await unseen.send(fixture('captured-scenarios/07-resilver-finished'))).includes('Alert: zfstest: no completed scrub seen in 35 days'));

  // A scrub that found errors.
  const found=await enroll('nas-found');
  sent=await found.send(fixture('synthetic/checksum-errors'));
  assert.ok(found.lines(sent).some(l=>/^Alert: tank: scrub finished \S+ repaired 1\.0 MiB with 2 error\(s\)$/.test(l)),found.lines(sent).join('|'));
  // Permanent data errors alert like counters: a decrease is a new baseline, zero clears.
  assert.ok(found.lines(sent).includes('Alert: tank: 2 permanent data error(s); zpool status -v lists the affected files'),found.lines(sent).join('|'));
  const fewer=fixture('synthetic/checksum-errors');fewer.storage.pools[0].dataErrors=1;
  found.cool();
  assert.deepEqual(found.lines(await found.send(fewer)).filter(l=>l.includes('data error')),[],'fewer data errors is not an alert');
  const none=fixture('synthetic/checksum-errors');none.storage.pools[0].dataErrors=0;
  assert.deepEqual(found.lines(await found.send(none)).filter(l=>l.includes('data error')),['Cleared: tank: no permanent data errors reported']);

  // Remembered scrubs survive a report without the pool (bounded).
  const state=found.state(), known=state.pools.tank.lastScrub;
  assert.ok(known && state.pools.tank.firstSeen && state.pools.tank.lastSeen);
  await found.send(fixture('captured-scenarios/04-scrub-finished'));
  assert.deepEqual(found.state().pools.tank.lastScrub,known,'an absent pool keeps its remembered scrub');
  await found.send(fixture('synthetic/checksum-errors'));
  assert.deepEqual(found.state().pools.tank.lastScrub,known);
  const crowded=found.state();
  for(let i=0;i<20;i++)crowded.pools['old'+i]={lastScrub:null,firstSeen:crowded.at,lastSeen:iso(Date.parse(crowded.at)-(i+1)*60000)};
  found.setState(crowded);
  await found.send(fixture('synthetic/checksum-errors'));
  const kept=Object.keys(found.state().pools);
  assert.equal(kept.length,1+16,'at most 16 absent pools are remembered');
  // zfstest (absent since two reports ago) is the most recently seen absent pool.
  assert.deepEqual(kept,['tank','zfstest',...Array.from({length:15},(_,i)=>'old'+i)],'the most recently seen are kept');

  // A change held by the cooldown keeps the delivered alert on record (text and counters).
  // 16 -> 20 inside the cooldown -> 5 after it: the 5 is a reset against 16, not a new alert.
  const held=await enroll('nas-held');
  const errs=n=>{const r=fixture('captured-scenarios/08-checksum-errors-after-scrub');vdev(r,'disk3').checksum=n;return r;};
  const disk3='zfs:errors:zfstest/disk3', text16='zfstest/disk3: read 0, write 0, checksum 16 error(s)';
  assert.ok(held.lines(await held.send(errs(16))).includes('Alert: '+text16));
  assert.deepEqual(await held.send(errs(20)),[],'an increase inside the cooldown waits');
  assert.equal(held.saved().delivered[disk3],text16,'the delivered alert stays on record');
  assert.deepEqual(held.saved().storageCounters[disk3],{read:0,write:0,checksum:16},'with the counters it was delivered with');
  held.expire();
  assert.deepEqual(await held.send(errs(5)),[],'a reset after a held increase is quiet');
  assert.equal(held.saved().delivered[disk3],'zfstest/disk3: read 0, write 0, checksum 5 error(s)');
  // A later increase over the reset baseline alerts (the cooldown has passed).
  assert.deepEqual(held.lines(await held.send(errs(20))),['Alert: zfstest/disk3: read 0, write 0, checksum 20 error(s)']);
  // 92 -> 85 inside the cooldown -> 70: the high alert stays on record and its recovery arrives.
  const fill=await enroll('nas-fill');
  const level=percent=>withCapacity(fixture('synthetic/capacity-92'),percent);
  assert.deepEqual(fill.lines(await fill.send(level(92))),['Alert: tank: capacity reached 90% (high)']);
  assert.deepEqual(await fill.send(level(85)),[],'the change to a warning waits for the cooldown');
  assert.equal(fill.saved().delivered['zfs:capacity:tank'],'tank: capacity reached 90% (high)','the high alert stays on record');
  assert.deepEqual(fill.lines(await fill.send(level(70))),['Cleared: tank: capacity back below the alert threshold'],'the recovery is not lost');
  fill.expire();
  assert.deepEqual(await fill.send(level(70)),[],'and is not repeated');
  // Changing only the high threshold does not re-send a warning that names the warning threshold.
  assert.deepEqual(fill.lines(await fill.send(level(85))),['Alert: tank: capacity reached 80% (warning)']);
  await settings({storageCapacityHigh:95});
  assert.deepEqual(await fill.send(level(85)),[],'a high-threshold change keeps the warning');
  assert.equal(fill.saved().delivered['zfs:capacity:tank'],'tank: capacity reached 80% (warning)');
  // Lowering high below the current usage escalates at once (the threshold change clears the cooldown).
  await settings({storageCapacityHigh:85});
  assert.deepEqual(fill.lines(await fill.send(level(85))),['Alert: tank: capacity reached 85% (high)']);
  await settings({storageCapacityWarn:75});
  assert.deepEqual(await fill.send(level(85)),[],'a warning-threshold change keeps the high alert');
  await settings({storageCapacityWarn:80,storageCapacityHigh:90});

  // A group vdev leaving UNAVAIL for DEGRADED is not "healthy again".
  const group=await enroll('nas-group');
  const degraded=fixture('captured-scenarios/05-degraded-offline');
  const unavail=clone(degraded);vdev(unavail,'mirror-0').state='UNAVAIL';
  for(const child of vdev(unavail,'mirror-0').children)child.state=child.name==='disk2'?'OFFLINE':'FAULTED';
  assert.ok(group.lines(await group.send(unavail)).includes('Alert: zfstest/mirror-0: UNAVAIL'));
  assert.deepEqual(await group.send(degraded),[],'the first report without the alerts holds them');
  assert.deepEqual(group.lines(await group.send(degraded)).sort(),['Cleared: zfstest/disk1: vdev is healthy again','Cleared: zfstest/mirror-0: now DEGRADED; see its member devices']);

  // Flap protection: a disk alternating ONLINE/FAULTED every report sends at most one message
  // per cooldown window, and its alert stays on record throughout. The pool alert is immediate.
  const flap=await enroll('nas-flap');
  const healthy=fixture('captured-scenarios/04-scrub-finished');
  const faulted=clone(healthy);faulted.storage.pools[0].state='DEGRADED';vdev(faulted,'mirror-0').state='DEGRADED';vdev(faulted,'disk1').state='FAULTED';
  assert.deepEqual(await flap.send(healthy),[]);
  for(let window=0;window<3;window++) {
    const messages=[];
    for(let report=0;report<8;report++) {
      messages.push(...await flap.send(report%2?healthy:faulted));
      assert.ok(flap.saved().delivered['zfs:vdev:zfstest/disk1'],'window '+window+' report '+report+': the alert stays on record');
    }
    assert.ok(messages.length<=1,'window '+window+': '+messages.length+' messages');
    if(window===0)assert.deepEqual(flap.lines(messages),['Alert: zfstest: pool is DEGRADED','Alert: zfstest/disk1: FAULTED'],'the first fault alerts at once');
    else assert.deepEqual(messages,[],'still flapping: the alert was never cleared, so nothing repeats');
    flap.expire();
  }
  // Two consecutive clean reports are a recovery.
  assert.deepEqual(await flap.send(faulted),[]);
  assert.deepEqual(await flap.send(healthy),[]);
  assert.deepEqual(flap.lines(await flap.send(healthy)).sort(),['Cleared: zfstest/disk1: vdev is healthy again','Cleared: zfstest: pool is ONLINE again']);
  // A released recovery whose publish fails is retried on the next sweep, not held for two more reports.
  assert.deepEqual(flap.lines(await flap.send(faulted)),['Alert: zfstest: pool is DEGRADED','Alert: zfstest/disk1: FAULTED']);
  assert.deepEqual(await flap.send(healthy),[]);
  failNext=1;assert.deepEqual(await flap.send(healthy),[],'the publish fails');
  assert.ok(flap.saved().delivered['zfs:vdev:zfstest/disk1']);
  flap.unblock();before=requests.length;await sweep();
  assert.deepEqual(flap.lines(requests.slice(before).filter(m=>m.message.startsWith('nas-flap\n'))).sort(),['Cleared: zfstest/disk1: vdev is healthy again','Cleared: zfstest: pool is ONLINE again'],'the retry sends the recovery');
  flap.expire();
  // A slower flap (two reports each way): the fault alerts once, and its quick return
  // inside the cooldown re-alerts the pool at once but holds the vdev alert for the window.
  assert.deepEqual(flap.lines(await flap.send(faulted)),['Alert: zfstest: pool is DEGRADED','Alert: zfstest/disk1: FAULTED']);
  assert.deepEqual(await flap.send(healthy),[]);
  assert.deepEqual(flap.lines(await flap.send(healthy)).sort(),['Cleared: zfstest/disk1: vdev is healthy again','Cleared: zfstest: pool is ONLINE again']);
  assert.deepEqual(flap.lines(await flap.send(faulted)),['Alert: zfstest: pool is DEGRADED'],'the pool alert is never delayed');
  flap.expire();
  assert.deepEqual(flap.lines(await flap.send(faulted)),['Alert: zfstest/disk1: FAULTED']);
  // A FAULTED -> REMOVED change inside the window waits too, keeping the FAULTED alert on record.
  const removed=clone(faulted);vdev(removed,'disk1').state='REMOVED';
  assert.deepEqual(await flap.send(removed),[]);
  assert.equal(flap.saved().delivered['zfs:vdev:zfstest/disk1'],'zfstest/disk1: FAULTED');
  const failedPool=clone(removed);failedPool.storage.pools[0].state='UNAVAIL';
  assert.deepEqual(flap.lines(await flap.send(failedPool)),['Alert: zfstest: pool is UNAVAIL'],'a pool state change is immediate');

  // Report alerts off: the agent error is not sent.
  await settings({hostReports:false});
  assert.deepEqual(found.lines(await found.send(failed)),[]);
  await settings({hostReports:true});
  console.log('Passed: storage alerts for pool and vdev state (class-aware: idle spares, log, cache, special), counter and permanent data error increases with resets as new baselines, scrubs that found errors, scrub age with remembered, never and unknown scrubs, capacity warning/high with hysteresis, agent errors and staleness, maintenance, cooldowns, retired rules and thresholds, recovery wording, and remembered scrubs for absent pools.');
} finally {
  globalThis.fetch=originalFetch;
}
