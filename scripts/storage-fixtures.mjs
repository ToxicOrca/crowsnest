// Storage-agent reports for every ZFS fixture, produced by the real agent.
import {spawnSync} from 'node:child_process';
// Reports come from the real agent over every fixture, so agent and server must agree.
export const agentReports=JSON.parse(spawnSync('python3',['-I','-c',`
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
