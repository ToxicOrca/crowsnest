"""Exercise the storage agent against every ZFS fixture and synthetic transport fakes."""
import contextlib
import importlib.util
import io
import json
import os
import re
import stat
import sys
import unittest
import urllib.error
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('crowsnest_storage', Path('storage-agent/crowsnest_storage.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

FIXTURES = Path('scripts/fixtures/zfs')
VERSION = (FIXTURES / 'captured/zpool-version.txt').read_bytes()
SALT = '5a' * 32
OTHER_SALT = 'c3' * 32
CONFIG = {'url': 'https://board.example.com', 'hostId': '00000000-0000-4000-8000-000000000000', 'hostToken': 'test-host-token', 'nameSalt': SALT}
# Empty device and sysfs roots: tests never read this machine's real devices.
EMPTY_ROOT = Path(TemporaryDirectory().name)
# Nothing identifying may leave the host: GUIDs (17+ digit integers), device
# paths, by-id/WWN/serial names, unstable dm-N names, physical paths, the name
# salt, or ZFS status/action text.
FORBIDDEN = re.compile(r'[0-9]{17,}|/dev/|/var/tmp|by-id|mpath-|35ffffff|GENERIC_SSD|SN0000|FICTIONAL_DISK|pci-|"guid"|devid|phys_path'
                       r'|\bdm-[0-9]|' + SALT + '|' + OTHER_SALT +
                       r'|One or more|zpool (?:clear|replace|online)|openzfs-docs|ZFS-8000')


def namer(salt=SALT, root=EMPTY_ROOT):
    return agent.DeviceNamer(salt, dev_root=str(Path(root, 'dev')), sys_root=str(Path(root, 'sys')))


def fixture_run(status, listing, datasets=None):
    """A fake run_command returning fixture bytes for the agent's fixed argv."""
    def run(program, arguments):
        if (program, tuple(arguments)) == ('zpool', ('--version',)):
            return VERSION
        if (program, tuple(arguments)) == ('zpool', agent.ZPOOL_STATUS):
            return status.read_bytes()
        if (program, tuple(arguments)) == ('zpool', agent.ZPOOL_LIST):
            return listing.read_bytes()
        if (program, tuple(arguments)) == ('zfs', agent.ZFS_LIST) and datasets:
            return datasets.read_bytes()
        raise agent.AgentError('command_failed', 'unexpected command ' + program)
    return run


def collect_files(status, listing, datasets=None, config=None, device_namer=None):
    run = fixture_run(status, listing, datasets)
    with patch.object(agent, 'run_command', run):
        storage, error = agent.collect(config if config is not None else {'datasets': datasets is not None},
                                       run=run, run_json_command=agent.run_json, namer=device_namer or namer())
    body, report = agent.encode_report(storage)
    return storage, error, body


def tree(pool):
    nodes = list(agent.walk(pool['vdevs'][0]))
    names = [node['name'] for node in nodes]
    assert len(names) == len(set(names)), 'vdev names must be unique within a pool: ' + repr(names)
    return {node['name']: node for node in nodes}


class FixtureChecks(unittest.TestCase):
    def assertPrivate(self, body):
        text = body.decode()
        self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text) and FORBIDDEN.search(text).group())
        self.assertLessEqual(len(body), agent.MAX_REPORT_BYTES)

    def test_every_fixture_parses_privately(self):
        pairs = []
        for status in sorted(FIXTURES.rglob('*status.json')):
            listing = status.with_name(status.name.replace('status', 'list'))
            self.assertTrue(listing.exists(), listing)
            pairs.append((status, listing))
        self.assertEqual(len(pairs), 1 + 8 + 6 + 7, 'captured host, 8 + 6 captured scenarios, 7 synthetic scenarios')
        for status, listing in pairs:
            with self.subTest(fixture=str(status)):
                storage, error, body = collect_files(status, listing)
                self.assertIsNone(error)
                self.assertEqual(storage['state'], 'ok')
                self.assertEqual(storage['zfsVersion'], '2.4.1-1')
                self.assertPrivate(body)
                for pool in storage['pools']:
                    tree(pool)  # Names are unique within each pool.
                    nodes = list(agent.walk(pool['vdevs'][0]))
                    for key in ('read', 'write', 'checksum'):
                        self.assertEqual(pool['errors'][key], sum(n[key] for n in nodes))
                    for node in nodes:
                        self.assertIn(node['class'], agent.VDEV_CLASSES, node)
                        self.assertNotEqual(node['type'], 'unknown', node)
                        self.assertNotEqual(node['state'], 'UNKNOWN', node)
                        self.assertRegex(node['name'], r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
                    if pool['scan']:
                        # Never one generic "processed" number: label it per scan type.
                        self.assertNotIn('processed', pool['scan'])
                        self.assertEqual('repairedBytes' in pool['scan'], pool['scan']['type'] == 'scrub')
                        self.assertEqual('resilveredBytes' in pool['scan'], pool['scan']['type'] == 'resilver')

    def test_captured_host(self):
        base = FIXTURES / 'captured'
        storage, error, body = collect_files(base / 'zpool-status.json', base / 'zpool-list.json', base / 'zfs-list.json')
        self.assertIsNone(error)
        pools = {p['name']: p for p in storage['pools']}
        self.assertEqual(list(pools), ['bulk', 'fast', 'guests'])
        guests = pools['guests']
        self.assertEqual((guests['capacityPercent'], guests['fragmentationPercent'], guests['size']), (62, 31, 2491081031680))
        self.assertEqual(guests['scan'], {'type': 'scrub', 'state': 'finished', 'startTime': '2026-09-06T03:00:00Z',
                                          'endTime': '2026-09-06T03:05:20Z', 'examinedBytes': 1562055120384,
                                          'totalBytes': 1561392245248, 'errors': 0, 'repairedBytes': 0})
        self.assertEqual(list(tree(guests)), ['guests', 'mirror-0', 'sda', 'sdb'])
        self.assertEqual(list(tree(pools['fast'])), ['fast', 'sdc'])
        # Multipath WWN names never leave the host: without an alias they become salted hashes.
        expected = ['disk-' + namer().digest('by-id:dm-uuid-mpath-35ffffff00000000' + n) for n in '1342']
        self.assertEqual(list(tree(pools['bulk'])), ['bulk', 'mirror-0', expected[0], expected[1], 'mirror-1', expected[2], expected[3]])
        self.assertTrue(all(re.fullmatch(r'disk-[0-9a-f]{8}', name) for name in expected))
        self.assertEqual(storage['datasetsStatus'], 'complete')
        datasets = {d['name']: d for d in storage['datasets']}
        self.assertEqual(len(datasets), 14)
        self.assertEqual(datasets['bulk/library']['mountpoint'], '/bulk/library')
        self.assertIsNone(datasets['guests/vm-301-disk-0']['mountpoint'], 'volumes have no mountpoint')
        self.assertIsNone(datasets['guests/vm-301-disk-0']['quota'], 'a volume has no quota')
        self.assertIsNone(datasets['bulk']['quota'], 'quota 0 means none')
        self.assertEqual(set(datasets['bulk']), {'name', 'used', 'available', 'referenced', 'quota', 'mountpoint'})

    def scenario(self, name):
        return collect_files(FIXTURES / 'captured-scenarios' / (name + '.status.json'),
                             FIXTURES / 'captured-scenarios' / (name + '.list.json'))[0]['pools'][0]

    def synthetic(self, name):
        return collect_files(FIXTURES / 'synthetic' / (name + '.zpool-status.json'),
                             FIXTURES / 'synthetic' / (name + '.zpool-list.json'))[0]['pools'][0]

    def test_captured_scenarios(self):
        for name in ('01-fresh-never-scrubbed', '02-with-data-never-scrubbed'):
            pool = self.scenario(name)
            self.assertIsNone(pool['scan'], 'missing scan_stats is the real never-scrubbed shape')
            self.assertEqual(list(tree(pool)), ['zfstest', 'mirror-0', 'disk1', 'disk2', 'mirror-1', 'disk3', 'disk4'])
            self.assertEqual(tree(pool)['disk1']['type'], 'file')
        self.assertEqual(self.scenario('02-with-data-never-scrubbed')['capacityPercent'], 61)
        scrubbing = self.scenario('03-scrub-in-progress')['scan']
        self.assertEqual((scrubbing['type'], scrubbing['state'], scrubbing['endTime'], scrubbing['repairedBytes']), ('scrub', 'scanning', None, 0))
        finished = self.scenario('04-scrub-finished')['scan']
        self.assertEqual((finished['state'], finished['endTime']), ('finished', '2026-11-11T02:43:44Z'))
        degraded = self.scenario('05-degraded-offline')
        self.assertEqual((degraded['state'], tree(degraded)['mirror-0']['state'], tree(degraded)['disk2']['state']), ('DEGRADED', 'DEGRADED', 'OFFLINE'))
        resilver = self.scenario('06-resilver-in-progress')
        self.assertEqual((resilver['scan']['type'], resilver['scan']['state'], resilver['scan']['resilveredBytes']), ('resilver', 'scanning', 108214784))
        replacing = tree(resilver)['replacing-1']
        self.assertEqual(replacing['type'], 'replacing')
        self.assertEqual([(c['name'], c['state']) for c in replacing['children']], [('disk2', 'OFFLINE'), ('disk5', 'ONLINE')])
        done = self.scenario('07-resilver-finished')
        self.assertEqual((done['state'], done['scan']['state'], done['scan']['resilveredBytes']), ('ONLINE', 'finished', 154008064))
        self.assertNotIn('replacing-1', tree(done))

    def classes(self, name):
        return collect_files(FIXTURES / 'captured-classes' / (name + '.status.json'),
                             FIXTURES / 'captured-classes' / (name + '.list.json'))[0]['pools'][0]

    def test_special_log_cache_and_spare_vdevs_are_reported(self):
        top = lambda pool: [(c['name'], c['type'], c['class'], c['state']) for c in pool['vdevs'][0]['children']]
        healthy = self.classes('01-all-healthy')
        # zpool status -j lists these beside `vdevs`; they become top-level children with their class.
        self.assertEqual(top(healthy), [('mirror-0', 'mirror', 'normal', 'ONLINE'), ('mirror-1', 'mirror', 'special', 'ONLINE'),
                                        ('log1', 'file', 'log', 'ONLINE'), ('cache1', 'file', 'l2cache', 'ONLINE'), ('spare1', 'file', 'spare', 'AVAIL')])
        self.assertEqual([c['class'] for c in tree(healthy)['mirror-1']['children']], ['special', 'special'])
        log = self.classes('02-log-offline')
        self.assertEqual((log['state'], tree(log)['log1']['state']), ('DEGRADED', 'OFFLINE'))
        # A cache device going offline leaves the pool ONLINE: only the vdev shows it.
        cache = self.classes('03-cache-offline')
        self.assertEqual((cache['state'], tree(cache)['cache1']['state']), ('ONLINE', 'OFFLINE'))
        for name in ('04-spare-inuse-resilvering', '05-spare-inuse-resilver-finished'):
            pool = self.classes(name)
            spare = tree(pool)['spare-1']
            self.assertEqual([(c['name'], c['class'], c['state']) for c in spare['children']], [('d2', 'normal', 'OFFLINE'), ('spare1', 'spare', 'ONLINE')])
            # The in-use spare is reported once (inside the tree), not again from `spares`.
            self.assertEqual([c['name'] for c in pool['vdevs'][0]['children']], ['mirror-0', 'mirror-1', 'log1', 'cache1'])
        self.assertEqual(self.classes('04-spare-inuse-resilvering')['scan']['resilveredBytes'], 65372160)
        special = self.classes('06-special-member-offline')
        self.assertEqual((special['state'], tree(special)['mirror-1']['state'], tree(special)['sp2']['state']), ('DEGRADED', 'DEGRADED', 'OFFLINE'))

    def test_vdev_sections_are_found_by_content_not_key_name(self):
        status = json.loads((FIXTURES / 'captured-classes/01-all-healthy.status.json').read_text())
        pool = status['pools']['zfstest2']
        pool['future_section'] = pool.pop('logs')  # A section name the agent has never seen.
        pool['future_section']['/var/tmp/fixture-vdevs-2/log1']['class'] = 'newclass'
        result = agent.pools_summary(status, {'pools': {}}, namer())[0]
        log = tree(result)['log1']
        self.assertEqual((log['class'], log['state']), ('other', 'ONLINE'))
        log_errors = json.loads(json.dumps(status))
        log_errors['pools']['zfstest2']['future_section']['/var/tmp/fixture-vdevs-2/log1']['write_errors'] = 7
        self.assertEqual(agent.pools_summary(log_errors, {'pools': {}}, namer())[0]['errors']['write'], 7, 'section vdevs count toward pool totals')

    def test_an_available_spare_is_healthy(self):
        self.assertFalse(agent.attention({'state': 'AVAIL', 'read': 0, 'write': 0, 'checksum': 0}))
        self.assertTrue(agent.attention({'state': 'INUSE', 'read': 0, 'write': 0, 'checksum': 0}))

    def test_silent_corruption_is_visible_only_in_vdev_counters(self):
        pool = self.scenario('08-checksum-errors-after-scrub')
        self.assertEqual((pool['state'], pool['dataErrors']), ('ONLINE', 0))
        self.assertEqual(tree(pool)['disk3']['checksum'], 16)
        self.assertEqual(pool['errors'], {'read': 0, 'write': 0, 'checksum': 16})
        self.assertEqual((pool['scan']['repairedBytes'], pool['scan']['errors']), (2097152, 0))

    def test_synthetic_scenarios(self):
        self.assertEqual(tree(self.synthetic('degraded-mirror'))['sde']['state'], 'UNAVAIL')
        faulted = tree(self.synthetic('faulted-vdev'))['sde']
        self.assertEqual((faulted['state'], faulted['read'], faulted['write']), ('FAULTED', 3, 41))
        corrupt = self.synthetic('checksum-errors')
        self.assertEqual((corrupt['dataErrors'], corrupt['errors']['checksum'], corrupt['scan']['errors'], corrupt['scan']['repairedBytes']), (2, 17, 2, 1048576))
        self.assertEqual(self.synthetic('scrub-in-progress')['scan']['state'], 'scanning')
        resilver = self.synthetic('resilver')
        self.assertEqual((resilver['scan']['type'], tree(resilver)['replacing-1']['type']), ('resilver', 'replacing'))
        self.assertIsNone(self.synthetic('never-scrubbed')['scan'])
        self.assertEqual(self.synthetic('capacity-92')['capacityPercent'], 92)


class MultipathNamingChecks(unittest.TestCase):
    """Names alerts and history key on: stable across reboots and dm-N renumbering."""
    WWIDS = ['35ffffff00000000' + n for n in '1234']

    def host(self, directory, numbers, aliases=True, partitions=False):
        """A fake /dev and /sys: by-id links to dm-N, and each map's dm name and uuid."""
        root = Path(directory, 'host-' + ''.join(map(str, numbers)) + ('-alias' if aliases else '') + ('-part' if partitions else ''))
        (root / 'dev/disk/by-id').mkdir(parents=True)
        for index, (wwid, number) in enumerate(zip(self.WWIDS, numbers)):
            device = 'dm-' + str(number)
            (root / 'dev' / device).touch()
            block = root / 'sys/block' / device / 'dm'
            block.mkdir(parents=True)
            (block / 'uuid').write_text('mpath-' + wwid + '\n')
            (block / 'name').write_text(('mpath' + 'abcd'[index] if aliases else wwid) + '\n')
            link = root / 'dev/disk/by-id' / ('dm-uuid-mpath-' + wwid)
            if partitions:
                # A kpartx partition map whose only slave is the multipath map.
                part = 'dm-' + str(number + 50)
                (root / 'dev' / part).touch()
                (root / 'sys/block' / part / 'dm').mkdir(parents=True)
                (root / 'sys/block' / part / 'dm/uuid').write_text('part1-mpath-' + wwid + '\n')
                (root / 'sys/block' / part / 'dm/name').write_text(('mpath' + 'abcd'[index] if aliases else wwid) + '-part1\n')
                (root / 'sys/block' / part / 'slaves').mkdir()
                (root / 'sys/block' / part / 'slaves' / device).touch()
                link.symlink_to('../../' + part)
            else:
                link.symlink_to('../../' + device)
        return root

    def multipath_pool(self, device_namer):
        base = FIXTURES / 'captured'
        storage, error, body = collect_files(base / 'zpool-status.json', base / 'zpool-list.json', device_namer=device_namer)
        self.assertIsNone(error)
        return [n['name'] for n in agent.walk(storage['pools'][0]['vdevs'][0])], body

    def test_aliases_are_used_and_survive_renumbering(self):
        with TemporaryDirectory() as directory:
            first, body = self.multipath_pool(namer(root=self.host(directory, [1, 2, 3, 4])))
            # Fixture order is wwid 1, 3, 4, 2 (mirror-0: 1, 3; mirror-1: 4, 2).
            self.assertEqual(first, ['bulk', 'mirror-0', 'mpatha', 'mpathc', 'mirror-1', 'mpathd', 'mpathb'])
            renumbered, _ = self.multipath_pool(namer(root=self.host(directory, [7, 3, 12, 0])))
            partitions, _ = self.multipath_pool(namer(root=self.host(directory, [5, 6, 7, 8], partitions=True)))
            self.assertEqual(renumbered, first, 'dm-N renumbering must not rename disks')
            self.assertEqual(partitions, first, 'partition maps are named by their parent multipath map')
            self.assertIsNone(FORBIDDEN.search(body.decode()))

    def test_unaliased_maps_use_stable_salted_hashes(self):
        with TemporaryDirectory() as directory:
            runs = [self.multipath_pool(namer(root=self.host(directory, numbers, aliases=False)))[0]
                    for numbers in ([1, 2, 3, 4], [9, 8, 7, 6])]
            runs.append(self.multipath_pool(namer())[0])  # No links at all, e.g. a removed disk.
            runs.append(self.multipath_pool(namer())[0])  # Repeated run.
            self.assertEqual(len({tuple(r) for r in runs}), 1, runs)
            leaves = [n for n in runs[0] if n.startswith('disk-')]
            self.assertEqual(len(leaves), 4)
            self.assertEqual(len(set(leaves)), 4, 'distinct disks never share a name')
            other, body = self.multipath_pool(namer(OTHER_SALT))
            self.assertTrue(set(leaves).isdisjoint(other), 'names depend on the install salt')
            for text in (body.decode(), json.dumps(runs)):
                self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text) and FORBIDDEN.search(text).group())

    def test_by_id_names_are_not_resolved_to_unstable_kernel_names(self):
        with TemporaryDirectory() as directory:
            (Path(directory) / 'dev/disk/by-id').mkdir(parents=True)
            (Path(directory) / 'dev/sdq1').touch()
            (Path(directory) / 'dev/disk/by-id/ata-MODEL_SERIAL9-part1').symlink_to('../../sdq1')
            node = {'name': 'ata-MODEL_SERIAL9-part1', 'vdev_type': 'disk', 'path': '/dev/disk/by-id/ata-MODEL_SERIAL9-part1',
                    'devid': 'ata-MODEL_SERIAL9-part1', 'guid': 7}
            name = namer(root=directory).name(node, 'tank', {})
        self.assertEqual(name, 'disk-' + namer().digest('by-id:ata-MODEL_SERIAL9-part1'))
        self.assertNotIn('sdq', name)
        self.assertNotIn('SERIAL', name)

    def test_identity_fallbacks_and_collisions(self):
        n = namer()
        self.assertEqual(n.identity({'path': '/dev/disk/by-id/wwn-0x5000'}), 'by-id:wwn-0x5000')
        self.assertEqual(n.identity({'guid': 42}), 'guid:42')
        with self.assertRaises(agent.AgentError):
            n.identity({})
        # Force every hash prefix to collide: names are lengthened, never shared.
        used = {}
        with patch.object(agent.DeviceNamer, 'digest', lambda self, identity, length=8: ('0' * 63 + identity[-1])[:length]):
            names = [n.name({'vdev_type': 'disk', 'name': 'x', 'devid': 'id' + c}, 'tank', used) for c in 'ab']
        self.assertEqual(len(set(names)), 2, names)
        self.assertEqual(names[0], 'disk-00000000')
        # Many distinct disks under the real HMAC never collide.
        used = {}
        names = [n.name({'vdev_type': 'disk', 'name': 'x', 'devid': 'wwn-0x' + format(i, '016x')}, 'tank', used) for i in range(agent.MAX_VDEVS_PER_POOL)]
        self.assertEqual(len(set(names)), len(names))

    def test_identifier_like_aliases_and_basenames_are_hashed(self):
        with TemporaryDirectory() as directory:
            for alias in ('ata-ST8000VN004_ZA1FAKE9', 'wwn-0x5000cca2b3c4d5e6', 'WD-WCC7K0FAKE12', '6001405abcdef0123456', 'dm-7'):
                with self.subTest(alias=alias):
                    root = Path(directory, 'alias-' + str(abs(hash(alias))))
                    (root / 'dev/disk/by-id').mkdir(parents=True)
                    (root / 'dev/dm-1').touch()
                    (root / 'sys/block/dm-1/dm').mkdir(parents=True)
                    (root / 'sys/block/dm-1/dm/uuid').write_text('mpath-36001405ffff0001\n')
                    (root / 'sys/block/dm-1/dm/name').write_text(alias + '\n')
                    (root / 'dev/disk/by-id/dm-uuid-mpath-36001405ffff0001').symlink_to('../../dm-1')
                    node = {'vdev_type': 'disk', 'name': 'dm-uuid-mpath-36001405ffff0001', 'devid': 'dm-uuid-mpath-36001405ffff0001',
                            'path': '/dev/disk/by-id/dm-uuid-mpath-36001405ffff0001'}
                    name = namer(root=root).name(node, 'tank', {})
                    self.assertRegex(name, r'^disk-[0-9a-f]{8}$')
        for base in ('ata-image-copy', 'S6PTNM0R912345X.img', '0x5000cca2b3c4.img'):
            with self.subTest(file=base):
                self.assertRegex(namer().name({'vdev_type': 'file', 'name': '/srv/' + base, 'guid': 5}, 'tank', {}), r'^file-[0-9a-f]{8}$')
        for alias in ('mpatha', 'shelf2-bay07'):
            self.assertTrue(agent.local_name(alias), alias)

    def test_invalid_salts_are_refused(self):
        for salt in (None, '', 'ab' * 31, 'AB' * 32, 'zz' * 32):
            with self.subTest(salt=salt), self.assertRaises(ValueError):
                agent.DeviceNamer(salt)


class ParsingChecks(unittest.TestCase):
    def pool(self, **overrides):
        root = {'name': 'tank', 'vdev_type': 'root', 'state': 'ONLINE', 'guid': 1,
                'vdevs': {'sda': {'name': 'sda', 'vdev_type': 'disk', 'state': 'ONLINE', 'guid': 2}}}
        pool = {'name': 'tank', 'state': 'ONLINE', 'vdevs': {'tank': root}, 'error_count': 0, **overrides}
        return {'pools': {'tank': pool}}

    def summary(self, status, listing=None):
        return agent.pools_summary(status, listing or {'pools': {}}, namer())

    def test_scan_function_none_is_never_scrubbed(self):
        self.assertIsNone(self.summary(self.pool(scan_stats={'function': 'NONE', 'state': 'NONE'}))[0]['scan'])
        self.assertIsNone(self.summary(self.pool())[0]['scan'])

    def test_unknown_values_degrade_without_rejecting_the_report(self):
        status = self.pool(state='NEWSTATE', scan_stats={'function': 'FUTURE', 'state': 'PAUSED'})
        status['pools']['tank']['vdevs']['tank']['vdevs']['sda'].update(vdev_type='newtype', state='WEIRD')
        pool = self.summary(status)[0]
        self.assertEqual((pool['state'], pool['scan']['type'], pool['scan']['state']), ('UNKNOWN', 'other', 'unknown'))
        self.assertNotIn('repairedBytes', pool['scan'])
        leaf = pool['vdevs'][0]['children'][0]
        self.assertEqual((leaf['type'], leaf['state'], leaf['name']), ('unknown', 'UNKNOWN', 'sda'), 'a kernel name is safe for any type')
        status['pools']['tank']['vdevs']['tank']['vdevs']['sda']['name'] = 'scsi-SERIAL'
        self.assertEqual(self.summary(status)[0]['vdevs'][0]['children'][0]['name'], 'device-' + namer().digest('guid:2'))
        self.assertIsNone(pool['size'], 'a pool missing from zpool list has null sizes')

    def test_pass_through_names(self):
        cases = [({'vdev_type': 'disk', 'name': 'sda1'}, 'sda'), ({'vdev_type': 'disk', 'name': 'nvme0n1p2'}, 'nvme0n1'),
                 ({'vdev_type': 'disk', 'name': 'sdab'}, 'sdab'), ({'vdev_type': 'disk', 'name': 'dm-3'}, None),
                 ({'vdev_type': 'disk', 'name': 'wwn-0x5000', 'path': '/dev/disk/by-id/wwn-0x5000'}, None),
                 ({'vdev_type': 'file', 'name': '/srv/images/vdev-a.img'}, 'vdev-a.img'), ({'vdev_type': 'file', 'name': '/srv/bad name'}, None),
                 ({'vdev_type': 'mirror', 'name': 'mirror-0'}, 'mirror-0'), ({'vdev_type': 'raidz', 'name': 'raidz2-1'}, 'raidz2-1'),
                 ({'vdev_type': 'draid', 'name': 'draid1:4d:6c:1s-0'}, 'draid1:4d:6c:1s-0'),
                 ({'vdev_type': 'replacing', 'name': 'replacing-1'}, 'replacing-1'),
                 ({'vdev_type': 'mirror', 'name': '/weird/name'}, None), ({'vdev_type': 'root', 'name': 'x'}, 'tank')]
        for node, expected in cases:
            with self.subTest(node=node):
                self.assertEqual(namer().preferred(node, 'tank'), expected)
        # Without a pass-through name, every type falls back to its salted hash, never a position.
        for node, label in (({'vdev_type': 'disk', 'name': 'dm-3', 'guid': 9}, 'disk'), ({'vdev_type': 'file', 'name': '/srv/bad name', 'guid': 9}, 'file'),
                            ({'vdev_type': 'mirror', 'name': '/weird/name', 'guid': 9}, 'mirror')):
            with self.subTest(node=node):
                self.assertEqual(namer().name(node, 'tank', {}), label + '-' + namer().digest('guid:9'))

    def test_names_are_unique_within_a_pool(self):
        status = self.pool()
        status['pools']['tank']['vdevs']['tank']['vdevs'] = {
            'a': {'name': '/srv/a/vdev.img', 'vdev_type': 'file', 'state': 'ONLINE', 'path': '/srv/a/vdev.img', 'guid': 11},
            'b': {'name': '/srv/b/vdev.img', 'vdev_type': 'file', 'state': 'ONLINE', 'path': '/srv/b/vdev.img', 'guid': 12}}
        names = [n['name'] for n in agent.walk(self.summary(status)[0]['vdevs'][0])]
        self.assertEqual(names, ['tank', 'vdev.img', 'file-' + namer().digest('guid:12')])

    def test_limits(self):
        many = {'pools': {}}
        for i in range(agent.MAX_POOLS + 1):
            pool = self.pool()['pools']['tank']
            pool = json.loads(json.dumps(pool).replace('tank', 'p' + str(i)))
            many['pools']['p' + str(i)] = pool
        with self.assertRaises(agent.AgentError) as raised:
            self.summary(many)
        self.assertEqual(raised.exception.code, 'limit_exceeded')
        # A wide tree is pruned, never hiding an unhealthy or erroring vdev.
        leaves = {'sd' + chr(97 + i // 26) + chr(97 + i % 26): {'name': 'sd' + chr(97 + i // 26) + chr(97 + i % 26), 'vdev_type': 'disk', 'state': 'ONLINE'} for i in range(200)}
        leaves['sdzz'] = {'name': 'sdzz', 'vdev_type': 'disk', 'state': 'ONLINE', 'checksum_errors': 4}
        leaves['sdzy'] = {'name': 'sdzy', 'vdev_type': 'disk', 'state': 'FAULTED'}
        wide = self.pool()
        wide['pools']['tank']['vdevs']['tank']['vdevs'] = {'raidz3-0': {'name': 'raidz3-0', 'vdev_type': 'raidz', 'state': 'DEGRADED', 'vdevs': leaves}}
        pool = self.summary(wide)[0]
        names = [n['name'] for n in agent.walk(pool['vdevs'][0])]
        self.assertTrue(pool['vdevsTruncated'])
        self.assertEqual(names, ['tank', 'raidz3-0', 'sdzz', 'sdzy'])
        self.assertEqual(pool['errors']['checksum'], 4, 'totals come from the full tree')
        deep = {'name': 'sda', 'vdev_type': 'disk', 'state': 'ONLINE'}
        for level in range(agent.MAX_VDEV_DEPTH + 1):
            deep = {'name': 'mirror-' + str(level), 'vdev_type': 'mirror', 'state': 'ONLINE', 'vdevs': {'x': deep}}
        tall = self.pool()
        tall['pools']['tank']['vdevs']['tank']['vdevs'] = {'m': deep}
        with self.assertRaises(agent.AgentError) as raised:
            self.summary(tall)
        self.assertEqual(raised.exception.code, 'invalid_output')
        datasets = {'datasets': {'tank/d' + str(i): {'properties': {'used': {'value': 1}, 'mountpoint': {'value': '-'}}} for i in range(70)}}
        result, truncated = agent.datasets_summary(datasets, {'tank'})
        self.assertEqual((len(result), truncated), (agent.MAX_DATASETS, True))

    def test_invalid_shapes_are_errors(self):
        for status in ({'pools': []}, {'pools': {'tank': {'name': 'other', 'vdevs': {}}}}, {'pools': {'../x': {'name': '../x'}}},
                       self.pool(error_count=-1), self.pool(error_count=True), self.pool(vdevs={})):
            with self.subTest(status=status), self.assertRaises(agent.AgentError) as raised:
                self.summary(status)
            self.assertEqual(raised.exception.code, 'invalid_output')

    def test_versions(self):
        run = lambda output: (lambda program, arguments: output)
        self.assertEqual(agent.zfs_version(run(b'zfs-2.3.0\nzfs-kmod-2.3.0\n')), '2.3.0')
        for output in (b'zfs-2.2.6-pve1\nzfs-kmod-2.2.6-pve1\n', b'zfs-0.8.6\n', b'garbage\n', b''):
            with self.subTest(output=output), self.assertRaises(agent.AgentError) as raised:
                agent.zfs_version(run(output))
            self.assertEqual(raised.exception.code, 'unsupported_version')

    def test_old_openzfs_reports_an_error_state_without_text_parsing(self):
        calls = []

        def run(program, arguments):
            calls.append((program, arguments))
            return b'zfs-2.2.6-pve1\n'
        storage, error = agent.collect(CONFIG, run=run, run_json_command=lambda p, a: self.fail('must not query'))
        self.assertEqual((storage['state'], storage['error'], storage['pools'], error.code), ('error', 'unsupported_version', [], 'unsupported_version'))
        self.assertEqual(calls, [('zpool', ('--version',))])
        body, report = agent.encode_report(storage)
        self.assertEqual(report['storage']['error'], 'unsupported_version')

    def test_dataset_lengths_use_the_dashboards_unit(self):
        clef = '\U0001D11E'  # Outside the BMP: one code point, two UTF-16 units.
        self.assertEqual((agent.utf16_length(clef * 3), len(clef * 3)), (6, 3))
        listing = lambda mountpoint: {'datasets': {'tank': {'properties': {'used': {'value': 1}, 'mountpoint': {'value': mountpoint}}}}}
        self.assertEqual(len(agent.datasets_summary(listing('/' + clef * 127), {'tank'})[0]), 1, '255 units is within the limit')
        with self.assertRaises(agent.AgentError):
            agent.datasets_summary(listing('/' + clef * 128), {'tank'})  # 128 code points, 257 units.

    def test_datasets_are_limited_to_reported_pools_and_depth_one(self):
        properties = {'used': {'value': 1}, 'mountpoint': {'value': '-'}}
        listing = {'datasets': {name: {'properties': properties} for name in ('tank', 'tank/a', 'tank/a/b', 'gone', 'gone/x', 'tankish/y')}}
        result, truncated = agent.datasets_summary(listing, {'tank'})
        self.assertEqual(([d['name'] for d in result], truncated), (['tank', 'tank/a'], False))

    def test_dataset_failure_keeps_pool_status(self):
        base = FIXTURES / 'captured'
        run = fixture_run(base / 'zpool-status.json', base / 'zpool-list.json')
        with patch.object(agent, 'run_command', run):
            storage, error = agent.collect({}, run=run, run_json_command=agent.run_json, namer=namer())
        self.assertEqual((error, storage['state'], len(storage['pools']), storage['datasetsStatus']), (None, 'ok', 3, 'unavailable'))
        self.assertNotIn('datasets', storage)

    def test_report_size_limit(self):
        storage = {'state': 'ok', 'error': None, 'zfsVersion': '2.4.1', 'pools': [], 'datasetsStatus': 'complete',
                   'datasets': [{'name': 'x' * 250, 'mountpoint': '/' + 'y' * 250} for _ in range(400)]}
        body, report = agent.encode_report(storage)
        self.assertLessEqual(len(body), agent.MAX_REPORT_BYTES)
        self.assertEqual((report['storage']['datasetsStatus'], report['storage']['state']), ('report_limit', 'ok'))
        storage = {'state': 'ok', 'error': None, 'zfsVersion': '2.4.1', 'pools': [{'name': 'x' * 200000}], 'datasetsStatus': 'disabled'}
        body, report = agent.encode_report(storage)
        self.assertEqual((report['storage']['state'], report['storage']['error'], report['storage']['pools']), ('error', 'report_limit', []))
        self.assertEqual(json.loads(body)['agentVersion'], agent.AGENT_VERSION)


class CommandChecks(unittest.TestCase):
    def fake(self, directory, body):
        path = Path(directory, 'zpool')
        path.write_text('#!' + sys.executable + '\nimport json, os, sys, time\n' + body + '\n')
        path.chmod(stat.S_IRWXU)
        return path

    def test_fixed_argv_clean_environment_and_absolute_path(self):
        with TemporaryDirectory() as directory, patch.object(agent, 'SAFE_PATH', directory), \
                patch.dict(os.environ, {'CROWSNEST_SECRET': 'must-not-leak', 'HOME': '/root'}):
            self.fake(directory, 'print(json.dumps({"argv": sys.argv, "env": dict(os.environ)}))')
            seen = agent.run_json('zpool', agent.ZPOOL_STATUS)
        self.assertEqual(seen['argv'], [str(Path(directory, 'zpool')), 'status', '-j', '--json-int'])
        self.assertEqual(seen['env'].get('PATH'), directory)
        self.assertEqual(seen['env'].get('LC_ALL'), 'C')
        self.assertFalse(set(seen['env']) - {'PATH', 'LC_ALL', 'LC_CTYPE'}, seen['env'])

    def test_command_failures_map_to_fixed_codes(self):
        cases = [('sys.stderr.write("invalid option \'j\'\\n"); sys.exit(2)', 'unsupported_version'),
                 ('sys.stderr.write("Permission denied the ZFS utilities must be run as root.\\n"); sys.exit(1)', 'permission_denied'),
                 ('sys.stderr.write("internal error\\n"); sys.exit(1)', 'command_failed'),
                 ('time.sleep(5)', 'timeout'),
                 ('print("{not json")', 'invalid_output'),
                 ('sys.stdout.write("x" * (8 * 1024 * 1024 + 1))', 'invalid_output')]
        for body, code in cases:
            with self.subTest(code=code), TemporaryDirectory() as directory, patch.object(agent, 'SAFE_PATH', directory), \
                    patch.object(agent, 'COMMAND_TIMEOUT', 1), self.assertRaises(agent.AgentError) as raised:
                self.fake(directory, body)
                agent.run_json('zpool', agent.ZPOOL_STATUS)
            self.assertEqual(raised.exception.code, code)
        with TemporaryDirectory() as directory, patch.object(agent, 'SAFE_PATH', directory), self.assertRaises(agent.AgentError) as raised:
            agent.run_command('zpool', ('--version',))
        self.assertEqual(raised.exception.code, 'zfs_unavailable')


class Response(io.BytesIO):
    status = 200


class Sink:
    def __init__(self, body=b'{"ok":true}'):
        self.requests, self.body = [], body

    def open(self, request, timeout):
        assert timeout == 20
        self.requests.append(request)
        return Response(self.body)


class DeliveryChecks(unittest.TestCase):
    def test_config_validation(self):
        self.assertEqual(agent.check_config(CONFIG), 'https://board.example.com/api/ingest/' + CONFIG['hostId'])
        self.assertTrue(agent.check_config({**CONFIG, 'url': 'https://board.example.com:8443/'}))
        with self.assertRaises(ValueError):
            agent.check_config({k: v for k, v in CONFIG.items() if k != 'nameSalt'})
        for change in ({'url': 'http://board.example.com'}, {'url': 'https://board.example.com/path'}, {'url': 'https://u:p@board.example.com'},
                       {'url': 'https://board.example.com?x=1'}, {'url': 'https://board.example.com:99999'}, {'hostId': 'abc'},
                       {'hostToken': 'test-host-token' + ' with space'}, {'hostToken': ''}, {'serviceToken': 'test-service-token'}, {'datasets': 'yes'}, {'extra': 1},
                       {'nameSalt': ''}, {'nameSalt': 'ab' * 31}, {'nameSalt': 'AB' * 32}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                agent.check_config({**CONFIG, **change})

    def test_delivery_requires_acknowledgement_and_never_logs_the_token(self):
        storage = {'state': 'ok', 'error': None, 'zfsVersion': '2.4.1', 'pools': [], 'datasetsStatus': 'disabled'}
        sink, output = Sink(), io.StringIO()
        with contextlib.redirect_stdout(output):
            agent.report_once(CONFIG, sink, collect_storage=lambda config: (storage, None))
        request = sink.requests[0]
        self.assertEqual((request.get_method(), request.full_url), ('POST', 'https://board.example.com/api/ingest/' + CONFIG['hostId']))
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-host-token')
        self.assertEqual(json.loads(request.data), {'agentVersion': agent.AGENT_VERSION, 'agentProtocol': 1, 'storage': storage})
        self.assertIn('Storage status delivered: 0 pool(s)', output.getvalue())
        self.assertNotIn('test-host-token', output.getvalue())
        for body in (b'{"ok":false}', b'[]', b'x' * 9000):
            with self.subTest(body=body), self.assertRaises(ValueError):
                agent.report_once(CONFIG, Sink(body), collect_storage=lambda config: (storage, None))

    def test_error_state_is_still_delivered(self):
        error = agent.AgentError('permission_denied', 'zpool permission denied')
        storage = {'state': 'error', 'error': 'permission_denied', 'zfsVersion': '2.4.1', 'pools': [], 'datasetsStatus': 'disabled'}
        sink, output = Sink(), io.StringIO()
        with contextlib.redirect_stdout(output):
            agent.report_once(CONFIG, sink, collect_storage=lambda config: (storage, error))
        self.assertEqual(json.loads(sink.requests[0].data)['storage']['error'], 'permission_denied')
        self.assertIn('Collection failed: permission_denied', output.getvalue())
        self.assertIn('storage agent error: permission_denied', output.getvalue())

    def test_redirects_are_refused(self):
        self.assertIsNone(agent.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://elsewhere.example.com'))

    def test_once_reports_failure_exit_code(self):
        with TemporaryDirectory() as directory:
            path = Path(directory, 'storage.json')
            path.write_text(json.dumps(CONFIG))
            failing = urllib.error.HTTPError(CONFIG['url'], 403, 'Forbidden', {}, io.BytesIO(b''))
            with patch.object(agent, 'report_once', side_effect=failing), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(agent.main(['--config', str(path), '--once']), 1)
            self.assertIn('Reporting failed: HTTP 403', output.getvalue())
            with patch.object(agent, 'report_once'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(agent.main(['--config', str(path), '--once']), 0)
            path.write_text(json.dumps({**CONFIG, 'url': 'http://board.example.com'}))
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(agent.main(['--config', str(path), '--once']), 1)
            self.assertNotIn('test-host-token', errors.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(agent.main(['--bogus']), 2)


class CheckModeChecks(unittest.TestCase):
    def test_check_mode_needs_no_credentials_or_network(self):
        base = FIXTURES / 'captured'
        run = fixture_run(base / 'zpool-status.json', base / 'zpool-list.json', base / 'zfs-list.json')
        # Hermetic: --check builds its own namer, so point it at empty device roots.
        hermetic = lambda salt, dev_root='/dev', sys_root='/sys', real=agent.DeviceNamer: real(salt, str(EMPTY_ROOT / 'dev'), str(EMPTY_ROOT / 'sys'))
        with patch.object(agent, 'run_command', run), patch.object(agent, 'DeviceNamer', hermetic), \
                patch.object(agent, 'load_config', side_effect=AssertionError('must not read credentials')), \
                patch.object(agent, 'deliver', side_effect=AssertionError('must not send')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(agent.main(['--check']), 0)
        self.assertEqual(output.getvalue().strip(), '3 pool(s), datasets complete')

    def test_check_mode_fails_when_zfs_is_unreadable(self):
        def denied(program, arguments):
            raise agent.AgentError('permission_denied', 'zpool permission denied')
        with patch.object(agent, 'run_command', denied), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(agent.main(['--check']), 1)
        self.assertEqual(output.getvalue().strip(), 'storage agent error: permission_denied')


class VersionChecks(unittest.TestCase):
    def test_version_metadata_matches(self):
        metadata = json.loads(Path('storage-agent/version.json').read_text())
        self.assertEqual((metadata['version'], metadata['protocol']), (agent.AGENT_VERSION, agent.AGENT_PROTOCOL))
        self.assertRegex(agent.AGENT_VERSION, r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')

    def test_installer_heredoc_delimiter_cannot_appear_in_sources(self):
        for path in ('storage-agent/crowsnest_storage.py', 'storage-agent/crowsnest-storage.service'):
            self.assertNotIn('CROWSNEST_FILE_EOF', Path(path).read_text())


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if result.wasSuccessful():
        print('Passed: storage agent parsing of every captured and synthetic ZFS fixture, private allowlisted output, '
              'per-type scan bytes, per-vdev counters, stable private vdev names, limits, error states, clean commands, and delivery.')
    sys.exit(0 if result.wasSuccessful() else 1)
