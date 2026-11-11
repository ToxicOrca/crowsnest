// Embedded by build-board.mjs. ZFS storage hosts (standalone deployments only):
// the shared stale threshold, strict report validation, bounded capacity
// history, remembered scrub completions, and storage activity events.
const STALE_DOCKER_MS = 120000;
const STALE_STORAGE_MS = 180000;
// Every staleness decision goes through this helper; storage agents report every 60 s.
function staleAfterMs(hostOrSnapshot) {return hostOrSnapshot?.kind==='storage'?STALE_STORAGE_MS:STALE_DOCKER_MS;}
const STORAGE_LIMITS = {pools:16,vdevsPerPool:128,depth:6,datasets:64,eventsPerReport:20};
const STORAGE_HISTORY_WINDOW = 300000;
const STORAGE_HISTORY_RETENTION = 86400000;
const STORAGE_HISTORY_READINGS = 288;
const STORAGE_HISTORY_MAX_BYTES = 262144;
const STORAGE_POOL_STATES = new Set(['ONLINE','DEGRADED','FAULTED','OFFLINE','UNAVAIL','REMOVED','SUSPENDED','UNKNOWN']);
const STORAGE_VDEV_STATES = new Set([...STORAGE_POOL_STATES,'CANT_OPEN','CORRUPT_DATA','NO_REPLICAS','BAD_GUID_SUM','TOO_SMALL','BAD_LABEL','SPLIT']);
const STORAGE_GROUP_TYPES = new Set(['root','mirror','raidz','draid','replacing','spare','unknown']);
const STORAGE_VDEV_TYPES = new Set([...STORAGE_GROUP_TYPES,'disk','file','dspare','indirect','hole','missing']);
const STORAGE_SCAN_TYPES = new Set(['scrub','resilver','errorscrub','other']);
const STORAGE_SCAN_STATES = new Set(['scanning','finished','canceled','unknown']);
const STORAGE_ERRORS = new Set(['zfs_unavailable','unsupported_version','permission_denied','command_failed','timeout','invalid_output','limit_exceeded','report_limit']);
const STORAGE_DATASET_STATUS = new Set(['complete','truncated','unavailable','disabled','report_limit']);
const STORAGE_POOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
// Vdev names: the server independently allows only the shapes the agent can emit,
// per vdev type, so privacy never rests on the agent alone.
const STORAGE_KERNEL_NAME = /^(?:(?:sd|vd|xvd|hd)[a-z]{1,4}|nvme[0-9]{1,3}n[0-9]{1,3}|mmcblk[0-9]{1,3}|md[0-9]{1,4}|loop[0-9]{1,4}|nbd[0-9]{1,3}|zd[0-9]{1,5}|rbd[0-9]{1,4})$/;
const STORAGE_GROUP_NAME = /^(?:mirror|raidz[1-3]?|draid[1-3](?::[0-9]{1,3}[dcs]){0,3}|replacing|spare|indirect|hole|missing)-[0-9]{1,4}$/;
const STORAGE_HASH_NAME = /^(?:disk|file|device|dspare|mirror|raidz|draid|replacing|spare|indirect|hole|missing)-[0-9a-f]{8,64}$/;
// Multipath aliases and file basenames: a short local name...
const STORAGE_LOCAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// ...that does not look like a device identifier (by-id prefixes, WWNs, EUIs,
// long hex, serial-like runs) or an unstable dm-N. Mirrored in the agent.
const STORAGE_IDENTIFIER = /^(?:ata|scsi|sata|sas|wwn|nvme|dm-uuid|dm-name|usb|ide|virtio|mmc|memstick|pci|eui|naa|lvm-pv-uuid|md-uuid|md-name|uuid)[-_.]|0x[0-9a-f]{4,}|[0-9a-f]{12,}|^dm-[0-9]+$/i;
function storageSerialLike(name) {return (name.match(/[A-Za-z0-9]{8,}/g)||[]).some(run=>(run.match(/[0-9]/g)||[]).length>=2 && (run.match(/[A-Za-z]/g)||[]).length>=2);}
function storageVdevNameAllowed(type,name) {
  if(STORAGE_HASH_NAME.test(name))return name.startsWith((type==='unknown'?'device':type)+'-') || type==='unknown';
  if(['mirror','raidz','draid','replacing','spare','indirect','hole','missing'].includes(type))return STORAGE_GROUP_NAME.test(name);
  if(STORAGE_KERNEL_NAME.test(name))return ['disk','dspare','unknown'].includes(type);
  if(!['disk','file','dspare','unknown'].includes(type) || !STORAGE_LOCAL_NAME.test(name))return false;
  return !STORAGE_IDENTIFIER.test(name) && !storageSerialLike(name);
}
const STORAGE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
function storageEnabled(env) {return env.AUTH_MODE==='standalone';}
function storageInvalid(message) {throw new Error('Invalid storage report: '+message);}
function storageObject(value,what) {if(!value || typeof value!=='object' || Array.isArray(value))storageInvalid(what);return value;}
function storageCount(value,what) {if(!Number.isSafeInteger(value) || value<0)storageInvalid(what);return value;}
function storageBytes(value,what) {return value===null?null:storageCount(value,what);}
function storagePercent(value,what) {if(value!==null && (!Number.isSafeInteger(value) || value<0 || value>100))storageInvalid(what);return value;}
function storageTime(value,what) {if(value!==null && (typeof value!=='string' || !STORAGE_TIME.test(value) || !Number.isFinite(Date.parse(value))))storageInvalid(what);return value;}
// Lengths are UTF-16 code units (JavaScript's String length); the agent measures the same unit.
function storageText(value,max,what) {if(typeof value!=='string' || !value.length || value.length>max || /[\x00-\x1f\x7f]/.test(value))storageInvalid(what);return value;}
function validatedVdev(node,names,depth,counter) {
  storageObject(node,'vdev');
  if(depth>STORAGE_LIMITS.depth)storageInvalid('vdev tree too deep');
  if(++counter.count>STORAGE_LIMITS.vdevsPerPool)storageInvalid('too many vdevs');
  if(!STORAGE_VDEV_TYPES.has(node.type) || !STORAGE_VDEV_STATES.has(node.state))storageInvalid('vdev type or state');
  // Only the top of the tree is a root; it is named after its pool (checked in validatedPool).
  if((node.type==='root')!==(depth===0))storageInvalid('pool root vdev');
  if(typeof node.name!=='string' || node.type!=='root' && !storageVdevNameAllowed(node.type,node.name))storageInvalid('vdev name');
  if(names.has(node.name))storageInvalid('duplicate vdev name');
  names.add(node.name);
  const vdev={name:node.name,type:node.type,state:node.state,read:storageCount(node.read,'read errors'),write:storageCount(node.write,'write errors'),checksum:storageCount(node.checksum,'checksum errors')};
  if(node.children!==undefined) {
    // Leaves (disk, file, ...) never have children in ZFS output.
    if(!STORAGE_GROUP_TYPES.has(node.type) || !Array.isArray(node.children))storageInvalid('vdev children');
    vdev.children=node.children.map(child=>validatedVdev(child,names,depth+1,counter));
  }
  return vdev;
}
function storageNodes(vdev) {return [vdev,...(vdev.children||[]).flatMap(storageNodes)];}
function validatedScan(scan) {
  if(scan===null)return null;  // The agent sends null when ZFS has no scan_stats: never scanned.
  storageObject(scan,'scan');
  if(!STORAGE_SCAN_TYPES.has(scan.type) || !STORAGE_SCAN_STATES.has(scan.state))storageInvalid('scan type or state');
  const result={type:scan.type,state:scan.state,startTime:storageTime(scan.startTime,'scan start'),endTime:storageTime(scan.endTime,'scan end'),
    examinedBytes:storageCount(scan.examinedBytes,'scan examined'),totalBytes:storageCount(scan.totalBytes,'scan total'),errors:storageCount(scan.errors,'scan errors')};
  if(scan.state==='scanning' && result.endTime!==null)storageInvalid('a running scan has no end time');
  // `processed` means different things per scan type; each label belongs to exactly one type.
  if((scan.repairedBytes!==undefined)!==(scan.type==='scrub') || (scan.resilveredBytes!==undefined)!==(scan.type==='resilver'))storageInvalid('scan byte label');
  if(scan.type==='scrub')result.repairedBytes=storageCount(scan.repairedBytes,'scan repaired');
  if(scan.type==='resilver')result.resilveredBytes=storageCount(scan.resilveredBytes,'scan resilvered');
  return result;
}
function validatedPool(pool,seen) {
  storageObject(pool,'pool');
  if(typeof pool.name!=='string' || !STORAGE_POOL_NAME.test(pool.name) || seen.has(pool.name))storageInvalid('pool name');
  if(!STORAGE_POOL_STATES.has(pool.state))storageInvalid('pool state');
  seen.add(pool.name);
  if(!Array.isArray(pool.vdevs) || pool.vdevs.length!==1 || typeof pool.vdevsTruncated!=='boolean')storageInvalid('pool vdevs');
  if(pool.vdevs[0]?.type!=='root' || pool.vdevs[0]?.name!==pool.name)storageInvalid('pool root vdev');
  const root=validatedVdev(pool.vdevs[0],new Set(),0,{count:0});
  const errors=storageObject(pool.errors,'pool errors'), nodes=storageNodes(root), totals={};
  for(const key of ['read','write','checksum']) {
    totals[key]=storageCount(errors[key],'pool '+key+' errors');
    // Totals sum the agent's full tree; a pruned tree can only show less, never more.
    const shown=nodes.reduce((sum,node)=>sum+node[key],0);
    if(pool.vdevsTruncated?shown>totals[key]:shown!==totals[key])storageInvalid('pool error totals');
  }
  const size=storageBytes(pool.size,'pool size'), allocated=storageBytes(pool.allocated,'pool allocated'), free=storageBytes(pool.free,'pool free');
  const capacity=storagePercent(pool.capacityPercent,'pool capacity');
  // Reject impossible sizes only: exact equalities are not relied on for every ZFS layout.
  if(size!==null && (allocated!==null && allocated>size || free!==null && free>size || allocated!==null && free!==null && allocated+free>size))storageInvalid('pool sizes');
  if(size && allocated!==null && capacity!==null && Math.abs(capacity-Math.floor(allocated*100/size))>1)storageInvalid('pool capacity does not match its sizes');
  return {name:pool.name,state:pool.state,size,allocated,free,capacityPercent:capacity,fragmentationPercent:storagePercent(pool.fragmentationPercent,'pool fragmentation'),
    errors:totals,dataErrors:storageCount(pool.dataErrors,'pool data errors'),scan:validatedScan(pool.scan),vdevs:[root],vdevsTruncated:pool.vdevsTruncated};
}
function validatedDataset(dataset,seen,pools) {
  storageObject(dataset,'dataset');
  storageText(dataset.name,256,'dataset name');
  if(seen.has(dataset.name))storageInvalid('duplicate dataset');
  // `zfs list -d 1`: a reported pool's root dataset or one of its direct children.
  const parts=dataset.name.split('/');
  if(parts.length>2 || !pools.has(parts[0]) || parts[1]==='')storageInvalid('dataset pool or depth');
  seen.add(dataset.name);
  if(dataset.mountpoint!==null)storageText(dataset.mountpoint,256,'dataset mountpoint');
  return {name:dataset.name,used:storageBytes(dataset.used,'dataset used'),available:storageBytes(dataset.available,'dataset available'),
    referenced:storageBytes(dataset.referenced,'dataset referenced'),quota:storageBytes(dataset.quota,'dataset quota'),mountpoint:dataset.mountpoint};
}
// Like validatedReport: known fields are strict, unknown fields are dropped.
function validatedStorageReport(data) {
  storageObject(data,'report');
  if(!validCollectorVersion(data.agentVersion))storageInvalid('agent version');
  if(!Number.isSafeInteger(data.agentProtocol) || data.agentProtocol<1 || data.agentProtocol>65535)storageInvalid('agent protocol');
  const storage=storageObject(data.storage,'storage section');
  if(!['ok','error'].includes(storage.state))storageInvalid('state');
  if(storage.state==='ok'?storage.error!==null:!STORAGE_ERRORS.has(storage.error))storageInvalid('error code');
  if(storage.zfsVersion!==null && (typeof storage.zfsVersion!=='string' || !/^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9._+~-]{0,40}$/.test(storage.zfsVersion)))storageInvalid('zfs version');
  // A successful report always knows the OpenZFS version; only a failure may lack it.
  if(storage.state==='ok' && storage.zfsVersion===null)storageInvalid('missing zfs version');
  if(!Array.isArray(storage.pools) || storage.pools.length>STORAGE_LIMITS.pools || storage.state==='error' && storage.pools.length)storageInvalid('pools');
  if(!STORAGE_DATASET_STATUS.has(storage.datasetsStatus))storageInvalid('dataset status');
  const listed=['complete','truncated'].includes(storage.datasetsStatus);
  if(listed!==Array.isArray(storage.datasets) || listed && storage.datasets.length>STORAGE_LIMITS.datasets)storageInvalid('datasets');
  if(storage.state==='error' && listed)storageInvalid('datasets in an error report');
  const pools=new Set(), datasets=new Set();
  const validPools=storage.pools.map(pool=>validatedPool(pool,pools));
  return {kind:'storage',containers:[],agentVersion:data.agentVersion,agentProtocol:data.agentProtocol,
    storage:{state:storage.state,error:storage.error,zfsVersion:storage.zfsVersion,pools:validPools,
      datasetsStatus:storage.datasetsStatus,...listed?{datasets:storage.datasets.map(dataset=>validatedDataset(dataset,datasets,pools))}:{}},
    receivedAt:new Date().toISOString()};
}
function storageByteText(value) {
  const units=['B','KiB','MiB','GiB','TiB','PiB'];let n=value,i=0;
  while(n>=1024 && i<units.length-1){n/=1024;i++;}
  return (i?n.toFixed(n<10?1:0):String(n))+' '+units[i];
}
function storageVdevs(pool) {return new Map(storageNodes(pool.vdevs[0]).map(node=>[node.name,node]));}
function scanEvent(name,previous,scan) {
  if(!scan)return null;
  const same=previous && previous.type===scan.type && previous.startTime===scan.startTime;
  const label=scan.type==='errorscrub'?'error scrub':scan.type;
  if(scan.state==='scanning' && !(same && previous.state==='scanning'))return name+': '+label+' started';
  if(scan.state==='finished' && !(same && previous.state==='finished' && previous.endTime===scan.endTime)) {
    const detail=scan.type==='scrub'?'repaired '+storageByteText(scan.repairedBytes)+', '+scan.errors+' error(s)':scan.type==='resilver'?'resilvered '+storageByteText(scan.resilveredBytes)+', '+scan.errors+' error(s)':scan.errors+' error(s)';
    return name+': '+label+' finished ('+detail+')';
  }
  if(scan.state==='canceled' && !(same && previous.state==='canceled'))return name+': '+label+' canceled';
  return null;
}
function counterText(before,after) {return ['read','write','checksum'].filter(key=>before[key]!==after[key]).map(key=>key+' '+before[key]+' → '+after[key]).join(', ');}
// Activity for one storage report. Counters only ever increase until `zpool clear`
// or a reboot resets them; any decrease is reported as a reset, never as an error.
// Pool comparisons use the last successful report (the baseline kept in
// storage/<id>), so changes that happen while the agent reports errors are kept.
function storageEvents(previous,report,baseline=null) {
  const at=report.receivedAt, lines=[], current=report.storage;
  if(!previous || previous.kind!=='storage')return [event('report','First storage agent report received',at)];
  if(Date.parse(at)-Date.parse(previous.receivedAt)>staleAfterMs(report))lines.push(['report','Reporting resumed after a gap']);
  if(previous.agentVersion!==report.agentVersion)lines.push(['collector','Storage agent now reports v'+report.agentVersion]);
  const before=previous.storage;
  if(before.zfsVersion!==current.zfsVersion && current.zfsVersion)lines.push(['host','OpenZFS changed to '+current.zfsVersion]);
  if(current.state==='error' && (before.state!=='error' || before.error!==current.error))lines.push(['storage','Storage agent error: '+current.error]);
  if(current.state==='ok' && before.state==='error')lines.push(['storage','Storage agent recovered; pool status is available again']);
  const baselinePools=baseline || (before.state==='ok'?before.pools:null);
  if(current.state==='ok' && baselinePools) {
    const old=new Map(baselinePools.map(pool=>[pool.name,pool]));
    for(const pool of current.pools) {
      const prior=old.get(pool.name);old.delete(pool.name);
      if(!prior){lines.push(['storage','Pool '+pool.name+' appeared ('+pool.state+')']);continue;}
      if(prior.state!==pool.state)lines.push(['storage',pool.name+': '+prior.state+' → '+pool.state]);
      if(pool.dataErrors>prior.dataErrors)lines.push(['storage',pool.name+': permanent data errors '+prior.dataErrors+' → '+pool.dataErrors]);
      else if(pool.dataErrors<prior.dataErrors)lines.push(['storage',pool.name+': permanent data errors cleared ('+prior.dataErrors+' → '+pool.dataErrors+')']);
      const vdevs=storageVdevs(pool), priorVdevs=storageVdevs(prior), complete=!pool.vdevsTruncated && !prior.vdevsTruncated;
      for(const [name,vdev] of vdevs) {
        const was=priorVdevs.get(name), label=name===pool.name?pool.name:pool.name+'/'+name;
        if(!was) {
          // In a pruned tree a healthy vdev can be absent; only a complete tree proves an addition.
          if(complete)lines.push(['storage',label+': added ('+vdev.state+')']);
          if(vdev.read || vdev.write || vdev.checksum)lines.push(['storage',label+': reported errors (read '+vdev.read+', write '+vdev.write+', checksum '+vdev.checksum+')']);
          continue;
        }
        if(was.state!==vdev.state && name!==pool.name)lines.push(['storage',label+': '+was.state+' → '+vdev.state]);
        const keys=['read','write','checksum'];
        if(keys.some(key=>vdev[key]<was[key]))lines.push(['storage',label+': error counters reset (zpool clear or reboot); now read '+vdev.read+', write '+vdev.write+', checksum '+vdev.checksum]);
        else if(keys.some(key=>vdev[key]>was[key]))lines.push(['storage',label+': errors increased ('+counterText(was,vdev)+')']);
      }
      if(complete)for(const name of priorVdevs.keys())if(!vdevs.has(name))lines.push(['storage',pool.name+'/'+name+': removed']);
      const scan=scanEvent(pool.name,prior.scan,pool.scan);
      if(scan)lines.push(['storage',scan]);
    }
    for(const pool of old.values())lines.push(['storage','Pool '+pool.name+' is no longer reported']);
  }
  const shown=lines.slice(0,STORAGE_LIMITS.eventsPerReport).map(([kind,text])=>event(kind,text,at));
  if(lines.length>STORAGE_LIMITS.eventsPerReport)shown.push(event('storage',(lines.length-STORAGE_LIMITS.eventsPerReport)+' more storage changes in this report',at));
  return shown;
}
function retainedStorageHistory(samples,now) {
  return samples.filter(s=>Number.isFinite(Date.parse(s.at)) && Date.parse(s.at)>now-STORAGE_HISTORY_RETENTION && Date.parse(s.at)<=now).slice(-STORAGE_HISTORY_READINGS);
}
// Same window approach as recordResources: each five-minute window keeps its latest reading.
async function recordStorageHistory(bucket,id,report) {
  if(report.storage.state!=='ok')return;
  const now=Date.parse(report.receivedAt), key='storage-history/'+id+'.json';
  const entry={at:report.receivedAt,pools:report.storage.pools.map(pool=>[pool.name,pool.capacityPercent,pool.allocated,pool.size])};
  for(let attempt=0;attempt<3;attempt++) {
    const object=await bucket.get(key), samples=retainedStorageHistory(object?await object.json():[],Date.now());
    const window=Math.floor(now/STORAGE_HISTORY_WINDOW);
    const index=samples.findIndex(s=>Math.floor(Date.parse(s.at)/STORAGE_HISTORY_WINDOW)===window);
    if(index>=0){if(Date.parse(samples[index].at)>now)return;samples[index]=entry;}else samples.push(entry);
    samples.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    let slice=samples.slice(-STORAGE_HISTORY_READINGS), payload=JSON.stringify(slice);
    const byteLength=value=>typeof Buffer!=='undefined'?Buffer.byteLength(value):new TextEncoder().encode(value).length;
    while(byteLength(payload)>STORAGE_HISTORY_MAX_BYTES && slice.length>1){slice=slice.slice(1);payload=JSON.stringify(slice);}
    if(await bucket.put(key,payload,{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}}))return;
  }
  throw new Error('Storage history changed');
}
// zpool status only shows the latest scan, so a resilver hides the last scrub.
// Remember each pool's last completed scrub; a pool never seen scrubbing is "unknown".
async function storageBaseline(bucket,id) {
  const object=await bucket.get('storage/'+id+'.json');
  return object?(await object.json()).baseline||null:null;
}
async function recordStorageState(bucket,id,report) {
  if(report.storage.state!=='ok')return;
  const key='storage/'+id+'.json';
  for(let attempt=0;attempt<3;attempt++) {
    const object=await bucket.get(key), saved=object?await object.json():{pools:{}};
    if(saved.at && Date.parse(saved.at)>Date.parse(report.receivedAt))return;
    const pools={};
    for(const pool of report.storage.pools) {
      const remembered=saved.pools?.[pool.name]?.lastScrub||null, scan=pool.scan;
      const completed=scan && scan.type==='scrub' && scan.state==='finished' && scan.endTime?{endTime:scan.endTime,errors:scan.errors,repairedBytes:scan.repairedBytes}:null;
      pools[pool.name]={lastScrub:completed && (!remembered || Date.parse(completed.endTime)>=Date.parse(remembered.endTime))?completed:remembered};
    }
    // The last successful pools are the baseline for the next report's activity.
    const value=JSON.stringify({at:report.receivedAt,pools,baseline:report.storage.pools});
    if(object && value===JSON.stringify(saved))return;
    if(await bucket.put(key,value,{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}}))return;
  }
  throw new Error('Storage state changed');
}
function storageScrubStatus(pool,remembered) {
  // A missing scan_stats (scan null) proves the pool was never scanned; otherwise
  // the server can only vouch for completions it has seen.
  if(pool.scan===null)return {status:'never'};
  if(remembered?.lastScrub)return {status:'known',...remembered.lastScrub};
  return {status:'unknown'};
}
