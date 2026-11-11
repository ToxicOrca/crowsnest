import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Render the installer the way the dashboard embeds collector files: quoted heredocs.
const config={url:'https://board.example.com',hostId:'00000000-0000-4000-8000-000000000000',hostToken:'test-host-token'};
const agent=readFileSync('storage-agent/crowsnest_storage.py','utf8'), unit=readFileSync('storage-agent/crowsnest-storage.service','utf8');
const files=[['crowsnest_storage.py',agent],['crowsnest-storage.service',unit],['storage.json',JSON.stringify(config,null,2)]];
const render=entries=>readFileSync('storage-agent/setup.sh','utf8').replace('__WRITE_FILES__',()=>entries.map(([file,body])=>"cat > "+file+" <<'CROWSNEST_FILE_EOF'\n"+body+"\nCROWSNEST_FILE_EOF\n").join(''));
const installer=render(files);
const root=mkdtempSync(path.join(os.tmpdir(),'crowsnest-storage-install-test-'));
const bin=path.join(root,'bin'), calls=path.join(root,'calls'), script=path.join(root,'crowsnest-storage-setup.sh');
mkdirSync(bin);
writeFileSync(script,installer);
const shim=(name,body)=>{writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\nset -eu\nprintf \'%s %s\\n\' '+name+' "$*" >> "$TEST_CALLS"\n'+body+'\n');chmodSync(path.join(bin,name),0o755);};
shim('id',`if [[ "$*" == '-u' ]]; then if [[ "\${TEST_AS_ROOT:-}" == 1 ]]; then echo 0; else echo 1000; fi; exit 0; fi
if [[ "$*" == '-u crowsnest-storage' && "\${TEST_USER_EXISTS:-}" == 1 ]]; then echo 999; exit 0; fi
exit 1`);
for(const name of ['useradd','chown'])shim(name,'');
shim('runuser',`if [[ "\${TEST_CHECK_FAILURE:-}" == 1 ]]; then echo 'storage agent error: permission_denied'; exit 1; fi
echo '3 pool(s), datasets complete'`);
shim('systemctl',`if [[ "$*" == 'enable --now crowsnest-storage' && "\${TEST_START_FAILURE:-}" == 1 ]]; then exit 1; fi`);
shim('zpool','');
const run=(target,extra={},args=[])=>{
  writeFileSync(calls,'');
  const result=spawnSync('bash',[script,...args],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_CALLS:calls,CROWSNEST_STORAGE_ROOT:target,TEST_AS_ROOT:'1',...extra}});
  return {...result,calls:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean)};
};
const mode=file=>statSync(file).mode&0o777;
const layout=target=>({app:path.join(target,'opt/crowsnest-storage'),etc:path.join(target,'etc/crowsnest-storage'),unit:path.join(target,'etc/systemd/system/crowsnest-storage.service')});
try {
  assert.equal(spawnSync('bash',['-n',script]).status,0,'installer is valid Bash');
  assert.ok(!installer.includes('__WRITE_FILES__'));

  // Prepare-only: inspectable files, private credentials, verified access, nothing started.
  const target=path.join(root,'prepared'), paths=layout(target);
  let result=run(target,{CROWSNEST_PREPARE_ONLY:'1'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(mode(paths.app),0o755);
  assert.equal(mode(path.join(paths.app,'crowsnest_storage.py')),0o644);
  assert.equal(mode(paths.etc),0o750);
  assert.equal(mode(path.join(paths.etc,'storage.json')),0o600);
  assert.equal(mode(paths.unit),0o644);
  assert.equal(readFileSync(path.join(paths.app,'crowsnest_storage.py'),'utf8'),agent+'\n');
  assert.equal(readFileSync(paths.unit,'utf8'),unit+'\n');
  // The vdev-name salt is generated on the host; the dashboard-provided config never has one.
  const {nameSalt,...installed}=JSON.parse(readFileSync(path.join(paths.etc,'storage.json'),'utf8'));
  assert.deepEqual(installed,config);
  assert.match(nameSalt,/^[0-9a-f]{64}$/);
  assert.ok(!result.stdout.includes(nameSalt)&&!result.stderr.includes(nameSalt),'never prints the salt');
  assert.ok(!existsSync(path.join(paths.app,'storage.json')) && !existsSync(path.join(paths.app,'crowsnest-storage.service')),'credentials and unit leave the code directory');
  assert.ok(result.calls.includes('useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin crowsnest-storage'));
  assert.ok(result.calls.includes('chown crowsnest-storage:crowsnest-storage -- '+path.join(paths.etc,'storage.json')),'only the service user can read its token');
  assert.ok(result.calls.includes('chown root:root -- '+paths.app+' crowsnest_storage.py '+paths.unit),'the service user cannot modify its own code or unit');
  assert.ok(result.calls.includes('runuser -u crowsnest-storage -- /usr/bin/python3 -I '+path.join(paths.app,'crowsnest_storage.py')+' --check'),'access is proven as the unprivileged user');
  assert.ok(!result.calls.some(call=>call.startsWith('systemctl')),'prepare-only starts nothing');
  assert.match(result.stdout,/sudo systemctl daemon-reload && sudo systemctl enable --now crowsnest-storage/);
  assert.ok(!result.stdout.includes(config.hostToken)&&!result.stderr.includes(config.hostToken),'never prints the token');

  // Refuses to overwrite any part of an existing installation.
  result=run(target);
  assert.equal(result.status,1);assert.match(result.stderr,/refusing to overwrite/);
  assert.ok(!result.calls.some(call=>call.startsWith('useradd')));
  for(const part of ['app','etc','unit']) {
    const partial=path.join(root,'partial-'+part), parts=layout(partial);
    mkdirSync(path.dirname(parts[part]),{recursive:true});writeFileSync(parts[part],'');
    result=run(partial);assert.equal(result.status,1,part);assert.match(result.stderr,/refusing to overwrite/);
  }
  result=run(path.join(root,'existing-user'),{TEST_USER_EXISTS:'1'});
  assert.equal(result.status,1);assert.match(result.stderr,/already exists/);assert.ok(!existsSync(path.join(root,'existing-user')));

  // Root, absolute staging paths, and no arguments.
  result=run(path.join(root,'not-root'),{TEST_AS_ROOT:'0'});
  assert.equal(result.status,1);assert.match(result.stderr,/Run with sudo/);assert.ok(!existsSync(path.join(root,'not-root')));
  result=run('relative/path');assert.equal(result.status,1);assert.match(result.stderr,/absolute path/);
  result=run(path.join(root,'args'),{},['extra']);assert.equal(result.status,1);assert.match(result.stderr,/Usage/);

  // Unprivileged access failure keeps files for inspection and starts nothing.
  const denied=path.join(root,'denied');
  result=run(denied,{TEST_CHECK_FAILURE:'1'});
  assert.equal(result.status,1);assert.match(result.stderr,/cannot read ZFS status/);assert.match(result.stderr,/Do not run the agent as root/);
  assert.ok(existsSync(path.join(layout(denied).etc,'storage.json')));
  assert.ok(!result.calls.some(call=>call.startsWith('systemctl')));

  // Full install enables and starts the unit; a startup failure is reported.
  result=run(path.join(root,'installed'));
  assert.equal(result.status,0,result.stderr);
  assert.notEqual(JSON.parse(readFileSync(path.join(layout(path.join(root,'installed')).etc,'storage.json'),'utf8')).nameSalt,nameSalt,'each install has its own salt');
  assert.deepEqual(result.calls.filter(call=>call.startsWith('systemctl')),['systemctl daemon-reload','systemctl enable --now crowsnest-storage']);
  assert.match(result.stdout,/journalctl -u crowsnest-storage -f/);
  result=run(path.join(root,'start-failure'),{TEST_START_FAILURE:'1'});
  assert.equal(result.status,1);assert.match(result.stderr,/Startup failed/);

  // A salt supplied by the dashboard would not be host-local: refuse it.
  writeFileSync(script,render([files[0],files[1],['storage.json',JSON.stringify({...config,nameSalt:'ab'.repeat(32)})]]));
  result=run(path.join(root,'supplied-salt'));
  assert.equal(result.status,1);assert.match(result.stderr,/already contains a name salt/);
  assert.ok(!result.calls.some(call=>call.startsWith('runuser')||call.startsWith('systemctl')));
  writeFileSync(script,installer);

  // A host without OpenZFS is refused before anything is created.
  rmSync(path.join(bin,'zpool'));
  result=run(path.join(root,'no-zfs'));
  assert.equal(result.status,1);assert.match(result.stderr,/zpool was not found/);assert.ok(!result.calls.some(call=>call.startsWith('useradd')));
  console.log('Passed: storage agent installer root requirement, refusal to overwrite, private credential ownership, host-local name salt, unprivileged access proof, prepare-only review, startup, and missing OpenZFS.');
} finally {rmSync(root,{recursive:true,force:true});}
