// Embedded by build-board.mjs. Destination and credentials are operator-managed runtime values.
function ntfyDestination(value) {
  try {
    const url=new URL(value), host=url.hostname.toLowerCase();
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || (url.port && url.port!=='443') || !host.includes('.') || /[\[\]:]/.test(host) || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || !/^\/[a-zA-Z0-9_-]{1,64}$/.test(url.pathname))return null;
    const topic=url.pathname.slice(1);
    if(['app','docs','static','file','v1','_matrix'].includes(topic))return null;
    return {url:url.href,origin:url.origin,topic};
  }catch{return null;}
}
async function notificationSettings(env) {
  const object=await env.BUCKET.get('notifications/settings.json');
  return {...{enabled:env.NTFY_ENABLED==='true',recoveries:true,hostReports:true,unhealthy:true,restarting:true,dead:true,staleMinutes:2,priority:4},...SIGNAL_DEFAULTS,...STORAGE_ALERT_DEFAULTS,...object?await object.json():{}};
}
async function hostMaintenance(bucket,id) {
  const object=await bucket.get('maintenance/hosts/'+id+'.json');
  return object?await object.json():{};
}
async function notificationStatus(env) {
  const settings=await notificationSettings(env), destination=ntfyDestination(env.NTFY_URL);
  const object=await env.BUCKET.get('notifications/delivery.json');
  const delivery=object?await object.json():{};
  const sweep=await env.BUCKET.get('notifications/sweep.json'), lastSweep=sweep?await sweep.json():{};
  return {...settings,configured:!!destination,destination:destination?.url||null,authenticated:!!env.NTFY_TOKEN,...delivery,lastSweepAt:lastSweep.at||null};
}
function notificationIssues(host,snapshot,now,policy) {
  if(!snapshot)return (!policy || policy.hostReports) && now-Date.parse(host.createdAt)>600000?{report:'Awaiting the first '+(host.kind==='storage'?'storage agent':'collector')+' report'}:{};
  const staleAfter=staleAfterMs(host);
  if(now-Date.parse(snapshot.receivedAt)>staleAfter) {
    // The configured delay can lengthen, never shorten, the host kind's stale threshold.
    const minutes=Math.max(policy?.staleMinutes||2,staleAfter/60000);
    const source=host.kind==='storage'?'storage agent':'collector';
    return (!policy || policy.hostReports) && now-Date.parse(snapshot.receivedAt)>minutes*60000?{report:'No '+source+' report for more than '+({2:'two',3:'three'}[minutes]||minutes)+' minutes'}:{};
  }
  const issues={};
  for(const c of snapshot.containers)if(issueKinds(c).some(kind=>!policy || policy[kind]))issues[c.id]=c.name+': '+c.state+'/'+c.health;
  return issues;
}
function issueKinds(container) {
  return [...container.health==='unhealthy'?['unhealthy']:[],...['restarting','dead'].includes(container.state)?[container.state]:[]];
}
function deliveredIssueKinds(id,text,saved) {
  if(signalKind(id))return [signalKind(id)];
  if(storageAlertKind(id))return [storageAlertKind(id)];
  if(id==='report')return ['hostReports'];
  if(saved.kinds?.[id])return saved.kinds[id];
  const match=text.match(/: ([^/]+)\/([^/]+)$/);
  return match?issueKinds({state:match[1],health:match[2]}):[];
}
async function publishNtfy(env,destination,message,title,priority=3,alert=false,target=null) {
  const authorization=env.NTFY_TOKEN?{Authorization:'Bearer '+env.NTFY_TOKEN}:{};
  const click=target || dashboardOrigin(env.DASHBOARD_ORIGIN)||dashboardOrigin(env.SITE_ORIGIN);
  let response;
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),5000);
  try {
    response=await fetch(destination.origin+'/',{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json',...authorization},body:JSON.stringify({topic:destination.topic,title,message,priority,tags:[alert?'warning':'white_check_mark'],...(click?{click}: {})})});
    if(!response.ok)throw new Error('HTTP '+response.status);
    // An HTTP success alone does not prove that ntfy accepted the message.
    const acknowledgement=await readJson(response,16384);
    if(acknowledgement.event!=='message' || acknowledgement.topic!==destination.topic || typeof acknowledgement.id!=='string')throw new Error('Invalid acknowledgement');
    await env.BUCKET.put('notifications/delivery.json',JSON.stringify({lastSuccessAt:new Date().toISOString(),lastError:null}));
  }catch(error) {
    const reason=/^HTTP \d{3}$/.test(error.message)?error.message:error.message==='Invalid acknowledgement'?error.message:'Connection or acknowledgement failed';
    console.error('ntfy delivery failed',reason,error?.name);
    if(reason==='Connection or acknowledgement failed') {
      let detail=String(error?.message||'Unknown transport error');
      for(const secret of [env.NTFY_TOKEN,env.COLLECTOR_SERVICE_TOKEN])if(secret)detail=detail.replaceAll(secret,'[redacted]');
      console.error('ntfy transport detail',detail.slice(0,240));
    }
    const old=await env.BUCKET.get('notifications/delivery.json');
    const previous=old?await old.json():{};
    await env.BUCKET.put('notifications/delivery.json',JSON.stringify({...previous,lastError:reason,lastFailureAt:new Date().toISOString()}));
    throw new Error(reason);
  }finally{clearTimeout(timer);}
}
async function notifyHost(env,host,snapshot,settings,now=Date.now()) {
  if(!settings.enabled || !ntfyDestination(env.NTFY_URL))return {sent:0,pending:0};
  // A conditional short lease prevents concurrent report/sweep deliveries.
  const key='notifications/locks/'+host.id+'.json',owner=crypto.randomUUID();
  let acquired=false;
  for(let attempt=0;attempt<3;attempt++) {
    const object=await env.BUCKET.get(key),lease=object?await object.json():{};
    const leaseNow=Date.now();
    if(lease.until>leaseNow)return {sent:0,pending:1};
    if(await env.BUCKET.put(key,JSON.stringify({owner,until:leaseNow+15000}),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}})){acquired=true;break;}
  }
  if(!acquired)return {sent:0,pending:1};
  try{return await notifyHostUnlocked(env,host,snapshot,settings,now);}
  finally {
    const object=await env.BUCKET.get(key);
    if(object && (await object.json()).owner===owner)await env.BUCKET.put(key,JSON.stringify({until:0}),{onlyIf:{etagMatches:object.etag}});
  }
}
async function notifyHostUnlocked(env,host,snapshot,settings,now=Date.now()) {
  const destination=ntfyDestination(env.NTFY_URL);
  if(!settings.enabled || !destination)return {sent:0,pending:0};
  const maintenance=await hostMaintenance(env.BUCKET,host.id);
  // Keep the delivered baseline intact: changes that clear entirely during a pause
  // must not generate recovery messages for alerts that were never sent.
  if(Date.parse(maintenance.until)>now)return {sent:0,pending:0};
  const key='notifications/hosts/'+host.id+'.json', object=await env.BUCKET.get(key);
  const saved=object?await object.json():{delivered:{}};
  // A newly configured destination gets its own baseline.
  if(saved.destination!==destination.url){saved.delivered={};saved.destination=destination.url;saved.nextAttemptAt=0;saved.attempts=0;}
  if(saved.maintenanceRevision!==maintenance.revision){saved.nextAttemptAt=0;saved.attempts=0;saved.maintenanceRevision=maintenance.revision;}
  const policy=signalPolicy(settings);
  if(saved.signalPolicy!==policy){for(const id of Object.keys(saved.delivered))if(signalKind(id))delete saved.delivered[id];saved.cooldowns={};saved.signalPolicy=policy;}
  // Disabling an alert category silently retires its delivered baseline.
  // It must not announce that a problem recovered because the policy changed.
  for(const [id,text] of Object.entries(saved.delivered)) {
    const kinds=deliveredIssueKinds(id,text,saved);
    if(!kinds.length || !kinds.some(kind=>settings[kind])){delete saved.delivered[id];if(storageAlertRule(id))delete saved.cooldowns?.[id];}
  }
  // A changed storage threshold retires the alerts that depend on it, like a signal policy change.
  const thresholds=storageAlertThresholds(settings);
  for(const [rule,values] of Object.entries(thresholds))if(saved.storageThresholds && JSON.stringify(saved.storageThresholds[rule])!==JSON.stringify(values))
    for(const id of new Set([...Object.keys(saved.delivered),...Object.keys(saved.cooldowns||{})]))if(storageAlertRule(id)===rule) {
      delete saved.cooldowns?.[id];
      if(storageThresholdRetires(id,saved.delivered[id],saved.storageThresholds[rule],values))delete saved.delivered[id];
    }
  saved.storageThresholds=thresholds;
  const current=notificationIssues(host,snapshot,now,settings), added=[], removed=[],addedIds=[];
  const observations=settings.cpuAlerts || settings.memoryAlerts || settings.restartBursts?await env.BUCKET.get('signals/'+host.id+'.json'):null;
  const advanced=advancedIssues(snapshot,observations?await observations.json():null,settings);
  Object.assign(current,advanced.issues);
  for(const id of advanced.uncertain)if(saved.delivered[id])current[id]=saved.delivered[id];
  let storage=null, held=0;
  saved.storageCounters??={};
  if(host.kind==='storage' && snapshot?.storage && now-Date.parse(snapshot.receivedAt)<=staleAfterMs(host)) {
    const state=await env.BUCKET.get('storage/'+host.id+'.json');
    storage=storageIssues(snapshot,state?await state.json():null,settings,saved.delivered,now);
    Object.assign(current,storage.issues);
    for(const id of storage.uncertain)if(saved.delivered[id])current[id]=saved.delivered[id];
    // Counters only fall on zpool clear, a reboot or a later scrub: a decrease is a new baseline, never an alert.
    for(const [id,counts] of Object.entries(storage.counters)) {
      const old=saved.storageCounters[id];
      if(saved.delivered[id] && old && Object.keys(counts).every(key=>counts[key]<=old[key])){saved.delivered[id]=current[id];saved.storageCounters[id]=counts;}
    }
    // Flap protection: a pool or vdev recovery needs two consecutive reports without the alert.
    // Sweeps re-read the same report (same receivedAt), so they never count as the second one.
    const clearing={};
    for(const [id,text] of Object.entries(saved.delivered))if(!current[id] && storageAlertHeld(id)) {
      const first=saved.storageClearing?.[id];
      clearing[id]=first||snapshot.receivedAt;
      if(!first || first===snapshot.receivedAt){current[id]=text;held++;}
    }
    saved.storageClearing=clearing;
  }
  const blocked=[];
  for(const [id,text] of Object.entries(current))if(saved.delivered[id]!==text) {
    if((signalKind(id) || storageAlertCooled(id)) && (saved.cooldowns?.[id]||0)+settings.cooldownMinutes*60000>now)blocked.push(id);
    else{added.push(text);addedIds.push(id);}
  }
  for(const [id,text] of Object.entries(saved.delivered))if(!current[id])removed.push(id==='report'?(snapshot?(host.kind==='storage'?'Storage agent':'Collector')+' reporting resumed':'Report warning cleared'):storageAlertRule(id)?storageRecoveryText(id,snapshot):text.split(': ')[0]+': '+(signalKind(id)?({cpu:'CPU',memory:'Memory',burst:'Restart burst'})[id.split(':')[0]]+' alert cleared on a fresh report':'no longer in an alert state or no longer reported; check the dashboard'));
  // Suppress stale container recovery messages while their host cannot report.
  const stale=!snapshot || now-Date.parse(snapshot.receivedAt)>staleAfterMs(host);
  if(stale)removed.length=0;
  // Retain delivered container alerts until a fresh report can resolve them.
  const baseline=stale?{...saved.delivered,...current}:{...current};
  // A blocked change to a delivered storage alert keeps the delivered text (and its counters):
  // the alert is still on record, so a later recovery or counter reset is judged against it.
  for(const id of blocked)if(storageAlertCooled(id) && saved.delivered[id])baseline[id]=saved.delivered[id];else delete baseline[id];
  const kinds={...stale?saved.kinds||{}:{},...Object.fromEntries((snapshot?.containers||[]).filter(c=>current[c.id]).map(c=>[c.id,issueKinds(c)])),...current.report?{report:['hostReports']}: {}};
  for(const id of Object.keys(current))if(signalKind(id))kinds[id]=[signalKind(id)];
  // Counters stay with the alert text they were delivered with (the text carries all three counts).
  const counters=Object.fromEntries(Object.keys(baseline).filter(storageAlertCounted)
    .map(id=>[id,baseline[id]===current[id] && storage?.counters[id]?storage.counters[id]:saved.storageCounters[id]]).filter(([,value])=>value));
  const lines=[...added.map(x=>'Alert: '+x),...(settings.recoveries?removed.map(x=>'Cleared: '+x):[])];
  if(!lines.length){saved.delivered=baseline;saved.kinds=kinds;saved.storageCounters=counters;saved.attempts=0;await env.BUCKET.put(key,JSON.stringify(saved));return {sent:0,pending:blocked.length || held?1:0};}
  if(saved.nextAttemptAt>now)return {sent:0,pending:1};
  let message=host.name+'\n'+lines.slice(0,10).map(x=>x.slice(0,280)).join('\n')+(lines.length>10?'\n'+(lines.length-10)+' more changes. Open Crowsnest for details.':'');
  while(new TextEncoder().encode(message).length>3500)message=message.slice(0,-1);
  try {
    const targets=[...addedIds,...Object.keys(saved.delivered).filter(id=>!current[id])].map(id=>signalContainer(id)||(/^[a-f0-9]{64}$/.test(id)?id:null));
    const container=targets.length && targets.every(id=>id && id===targets[0])?targets[0]:null;
    // A pool that is not ONLINE, or high capacity, is at least high priority; warnings alone are default priority.
    const priority=!added.length?3:addedIds.some(id=>storage?.high.has(id))?Math.max(settings.priority,4):addedIds.every(id=>storage?.low.has(id))?3:settings.priority;
    await publishNtfy(env,destination,message,'Crowsnest · '+host.name,priority,added.length>0,notificationLink(env,host.id,container));
    saved.delivered=baseline;saved.kinds=kinds;saved.storageCounters=counters;saved.attempts=0;saved.nextAttemptAt=now+30000;
    saved.cooldowns=Object.fromEntries(Object.entries(saved.cooldowns||{}).filter(([,at])=>now-at<3600000));
    for(const id of addedIds)if(signalKind(id) || storageAlertCooled(id))saved.cooldowns[id]=now;
    await env.BUCKET.put(key,JSON.stringify(saved));return {sent:1,pending:0};
  }catch {
    saved.attempts=Math.min((saved.attempts||0)+1,6);
    saved.nextAttemptAt=now+Math.min(900000,30000*2**(saved.attempts-1));
    await env.BUCKET.put(key,JSON.stringify(saved));return {sent:0,pending:1};
  }
}
async function sweepNotifications(env) {
  const settings=await notificationSettings(env), now=Date.now();
  const prior=await env.BUCKET.get('notifications/sweep.json'), last=prior?await prior.json():{};
  if(now-Date.parse(last.at)<30000)return {ok:true,skipped:true};
  await env.BUCKET.put('notifications/sweep.json',JSON.stringify({at:new Date(now).toISOString()}));
  let cursor, checked=0, sent=0, pending=0;
  do {
    const list=await env.BUCKET.list({prefix:'hosts/',cursor});
    for(let i=0;i<list.objects.length;i+=5) {
      const results=await Promise.all(list.objects.slice(i,i+5).map(async item=>{
        const object=await env.BUCKET.get(item.key);if(!object)return {sent:0,pending:0};
        const host=await object.json(), snapshot=await env.BUCKET.get('snapshots/'+host.id+'.json');
        return notifyHost(env,host,snapshot?await snapshot.json():null,settings,now);
      }));
      for(const result of results){checked++;sent+=result.sent;pending+=result.pending;}
    }
    cursor=list.truncated?list.cursor:undefined;
  }while(cursor);
  const result={ok:true,checked,sent,pending,at:new Date().toISOString()};
  await env.BUCKET.put('notifications/sweep.json',JSON.stringify(result));
  return result;
}
