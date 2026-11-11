"""Crowsnest ZFS storage agent: read-only pool status, outbound HTTPS only.

Python 3.9+ standard library only. Runs read-only `zpool`/`zfs` queries and
sends an allowlisted summary. Never transmits GUIDs, serial numbers,
/dev/disk/by-id paths, physical paths, or ZFS status text, and never logs
credentials.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import selectors
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AGENT_VERSION = '0.1.0'
AGENT_PROTOCOL = 1
DEFAULT_CONFIG = '/etc/crowsnest-storage/storage.json'
INTERVAL = 60
COMMAND_TIMEOUT = 20
MAX_COMMAND_OUTPUT = 8 * 1024 * 1024
MAX_COMMAND_STDERR = 65536
KILL_GRACE = 2
# A zpool stuck in uninterruptible kernel sleep (e.g. a SUSPENDED pool) cannot be
# killed or reaped. Such children are abandoned, never waited on; while this many are
# still stuck, no new query is started and the agent reports a timeout at once.
MAX_STUCK_CHILDREN = 2
ABANDONED = []
MAX_REPORT_BYTES = 131072
MAX_POOLS = 16
MAX_VDEVS_PER_POOL = 128
MAX_VDEV_DEPTH = 6
MAX_DATASETS = 64
MAX_NAME = 128
MAX_DATASET_NAME = 256
MAX_MOUNTPOINT = 256
MIN_ZFS = (2, 3, 0)
SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'
# Commands are fixed: no user-controlled arguments ever reach the shell-free argv.
ZPOOL_STATUS = ('status', '-j', '--json-int')
ZPOOL_LIST = ('list', '-j', '--json-int')
ZFS_LIST = ('list', '-j', '--json-int', '-o', 'name,used,avail,refer,quota,mountpoint', '-d', '1')

POOL_STATES = {'ONLINE', 'DEGRADED', 'FAULTED', 'OFFLINE', 'UNAVAIL', 'REMOVED', 'SUSPENDED'}
# AVAIL and INUSE are hot-spare states.
VDEV_STATES = POOL_STATES | {'CANT_OPEN', 'CORRUPT_DATA', 'NO_REPLICAS', 'BAD_GUID_SUM', 'TOO_SMALL', 'BAD_LABEL', 'SPLIT', 'AVAIL', 'INUSE'}
HEALTHY_STATES = {'ONLINE', 'AVAIL'}  # An available hot spare is healthy.
VDEV_CLASSES = {'normal', 'special', 'dedup', 'log', 'l2cache', 'spare'}
GROUP_TYPES = {'root', 'mirror', 'raidz', 'draid', 'replacing', 'spare'}
LEAF_TYPES = {'disk', 'file', 'dspare', 'indirect', 'hole', 'missing'}
SCAN_TYPES = {'SCRUB': 'scrub', 'RESILVER': 'resilver', 'ERRORSCRUB': 'errorscrub'}
SCAN_STATES = {'SCANNING': 'scanning', 'FINISHED': 'finished', 'CANCELED': 'canceled'}
ERROR_CODES = {'zfs_unavailable', 'unsupported_version', 'permission_denied', 'command_failed',
               'timeout', 'invalid_output', 'limit_exceeded', 'report_limit'}
# Kernel block-device names ZFS itself reports (e.g. `sda`), with an optional
# partition suffix to remove. dm-N is deliberately absent: it is renumbered
# across reboots and multipath reloads, so it is never used as a name.
# The bases match the dashboard's allowlist (worker/storage.js STORAGE_KERNEL_NAME).
KERNEL_NAME = re.compile(r'(?:((?:sd|vd|xvd|hd)[a-z]{1,4})[0-9]*'
                         r'|(nvme[0-9]{1,3}n[0-9]{1,3}|mmcblk[0-9]{1,3}|md[0-9]{1,4}|loop[0-9]{1,4}|nbd[0-9]{1,3}|zd[0-9]{1,5}|rbd[0-9]{1,4})(?:p[0-9]+)?)')
DM_DEVICE = re.compile(r'dm-[0-9]+')
NAME_SALT = re.compile(r'[0-9a-f]{64}')
HASH_LENGTH = 8
# Same patterns as the dashboard (worker/storage.js); a name the dashboard would
# reject is never sent: it falls back to the salted hash instead.
GROUP_NAME = re.compile(r'(?:mirror|raidz[1-3]?|draid[1-3](?::[0-9]{1,3}[dcs]){0,3}|replacing|spare|indirect|hole|missing)-[0-9]{1,4}')
SAFE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,63}')
IDENTIFIER = re.compile(r'^(?:ata|scsi|sata|sas|wwn|nvme|dm-uuid|dm-name|usb|ide|virtio|mmc|memstick|pci|eui|naa|lvm-pv-uuid|md-uuid|md-name|uuid)[-_.]'
                        r'|0x[0-9a-f]{4,}|[0-9a-f]{12,}|^dm-[0-9]+$', re.I)


KERNEL_BASE = re.compile(r'(?:sd|vd|xvd|hd)[a-z]{1,4}|nvme[0-9]{1,3}n[0-9]{1,3}|mmcblk[0-9]{1,3}|md[0-9]{1,4}|loop[0-9]{1,4}|nbd[0-9]{1,3}|zd[0-9]{1,5}|rbd[0-9]{1,4}')
HASH_NAME = re.compile(r'(disk|file|device|dspare|mirror|raidz|draid|replacing|spare|indirect|hole|missing)-[0-9a-f]{8}')
# Only multipath user_friendly_names (mpatha, mpathbz, ...). A custom alias cannot be
# told apart from a drive model or serial by its shape, so it is hashed instead.
ALIAS_NAME = re.compile(r'mpath[a-z]{1,4}')
NAMED_GROUP_TYPES = {'mirror', 'raidz', 'draid', 'replacing', 'spare', 'indirect', 'hole', 'missing'}


def serial_like(name):
    """Serial- or model-like: letter/digit runs, also across - _ . : separators."""
    compact = re.sub(r'[-_.:]', '', name)
    runs = re.findall(r'[A-Za-z0-9]{8,}', name) + re.findall(r'[A-Za-z0-9]{8,}', compact)
    return (any(len(re.findall(r'[0-9]', run)) >= 2 and len(re.findall(r'[A-Za-z]', run)) >= 2 for run in runs)
            or bool(re.search(r'[0-9]{8,}', compact)))


def name_allowed(vtype, name):
    """The dashboard's rule (worker/storage.js storageVdevNameAllowed), mirrored exactly.

    `vtype` is the reported type (unrecognized types are 'unknown'). A name this
    rejects is never sent; the vdev is named by its salted hash instead.
    """
    if not isinstance(name, str):
        return False
    hashed = HASH_NAME.fullmatch(name)
    if hashed:
        return hashed.group(1) == ('device' if vtype == 'unknown' else vtype)
    if vtype in NAMED_GROUP_TYPES:
        return bool(GROUP_NAME.fullmatch(name))
    if vtype in ('disk', 'dspare', 'unknown'):
        return bool(KERNEL_BASE.fullmatch(name) or ALIAS_NAME.fullmatch(name))
    if vtype == 'file':
        return (bool(SAFE_NAME.fullmatch(name)) and not KERNEL_BASE.fullmatch(name)
                and not IDENTIFIER.search(name) and not serial_like(name))
    return False
# ZFS pool names: a letter, then letters, digits, _ - . : and spaces; at most 255 bytes.
POOL_NAME = re.compile(r'[A-Za-z][A-Za-z0-9_.: -]{0,254}')


class AgentError(Exception):
    """A collection failure reported to the dashboard as a fixed code only."""

    def __init__(self, code, detail=''):
        assert code in ERROR_CODES
        super().__init__(code)
        self.code = code
        self.detail = detail


def integer(value, maximum=2**64 - 1):
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
        raise AgentError('invalid_output', 'expected a non-negative integer')
    return value


def counter(node, key):
    # Error counters are bounded to JavaScript's exact integer range.
    return integer(node.get(key, 0), 9007199254740991)


def byte_count(value):
    return integer(value, 9007199254740991)


def iso(seconds):
    if seconds == 0:
        return None
    return datetime.fromtimestamp(integer(seconds, 253402300799), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def kernel_name(value):
    match = KERNEL_NAME.fullmatch(value or '')
    return next((group for group in match.groups() if group), None) if match else None


class DeviceNamer:
    """Stable, private vdev names; alerts and history key on them.

    Names survive reboots and dm-N renumbering: ZFS-reported kernel names,
    group names and file basenames pass through; multipath members use their
    multipath alias; anything else becomes <type>-<HMAC of its by-id name or
    WWN>. The install-time salt keys the HMAC and is never sent or logged.
    """

    def __init__(self, salt, dev_root='/dev', sys_root='/sys'):
        if not isinstance(salt, str) or not NAME_SALT.fullmatch(salt):
            raise ValueError('Invalid name salt')
        self._key = bytes.fromhex(salt)
        self.dev_root, self.sys_root = dev_root, sys_root

    def digest(self, identity, length=HASH_LENGTH):
        return hmac.new(self._key, identity.encode('utf-8', 'surrogateescape'), hashlib.sha256).hexdigest()[:length]

    def _sys(self, device, *parts):
        try:
            with open(os.path.join(self.sys_root, 'block', device, *parts), 'rb') as source:
                return source.read(4097).decode('ascii').strip() or None
        except (OSError, UnicodeDecodeError):
            return None

    def dm_device(self, node):
        """dm-N behind a vdev, used only to look up its alias; never sent."""
        for candidate in (node.get('name'), node.get('path')):
            if not isinstance(candidate, str):
                continue
            if DM_DEVICE.fullmatch(candidate):
                return candidate
            if candidate.startswith('/dev/'):
                try:
                    target = os.path.basename(os.path.realpath(self.dev_root + candidate[4:]))
                except (OSError, ValueError):
                    continue
                if DM_DEVICE.fullmatch(target):
                    return target
        return None

    def multipath_alias(self, device):
        uuid = self._sys(device, 'dm', 'uuid') or ''
        if re.match(r'part[0-9]+-mpath-', uuid):
            # A kpartx partition map: name the member by its parent multipath map.
            try:
                parents = os.listdir(os.path.join(self.sys_root, 'block', device, 'slaves'))
            except OSError:
                return None
            if len(parents) != 1 or not DM_DEVICE.fullmatch(parents[0]):
                return None
            device, uuid = parents[0], self._sys(parents[0], 'dm', 'uuid') or ''
        if not uuid.startswith('mpath-'):
            return None
        alias, wwid = self._sys(device, 'dm', 'name'), uuid[len('mpath-'):]
        # Without user_friendly_names or an alias the map is named by its WWID: not an alias.
        if not alias or not wwid or wwid in alias or not ALIAS_NAME.fullmatch(alias):
            return None
        return alias

    def identity(self, node):
        """Stable hash input: by-id name (often the WWN), dm UUID, or vdev GUID."""
        devid, path = node.get('devid'), node.get('path')
        if isinstance(devid, str) and devid:
            return 'by-id:' + devid
        if isinstance(path, str) and path.startswith('/dev/disk/by-id/') and len(path) > 16:
            return 'by-id:' + path[16:]
        device = self.dm_device(node)
        uuid = self._sys(device, 'dm', 'uuid') if device else None
        if uuid:
            return 'dm-uuid:' + uuid
        if isinstance(node.get('guid'), int) and not isinstance(node.get('guid'), bool):
            return 'guid:' + str(node['guid'])
        if isinstance(path, str) and path:
            return 'path:' + path
        raise AgentError('invalid_output', 'vdev has no stable identity')

    def preferred(self, node, pool_name):
        """A pass-through name the dashboard accepts, or None to name the vdev by hash."""
        vtype, name = node.get('vdev_type'), node.get('name')
        if vtype == 'root':
            return pool_name
        reported = vtype if vtype in GROUP_TYPES | LEAF_TYPES else 'unknown'
        if vtype in GROUP_TYPES or vtype in ('indirect', 'hole', 'missing'):
            candidate = name
        elif vtype == 'file':
            candidate = os.path.basename(name) if isinstance(name, str) else None
        else:
            # By-id names are not resolved to sdX: kernel ordering is not stable either.
            device = self.dm_device(node)
            candidate = kernel_name(name) or (self.multipath_alias(device) if device else None)
        return candidate if name_allowed(reported, candidate) else None

    def hashed(self, node, identity, attempt=0):
        vtype = node.get('vdev_type')
        label = vtype if vtype in GROUP_TYPES | LEAF_TYPES else 'device'
        # Always exactly 8 hex digits, so a 16-hex WWN or EUI can never pass as a hash.
        return label + '-' + self.digest(identity if attempt == 0 else identity + '#' + str(attempt))

    def name(self, node, pool_name, used):
        """Unique within the pool: `used` maps each assigned name to its identity."""
        preferred = self.preferred(node, pool_name)
        if preferred and preferred not in used:
            # A unique sentinel: any hashed name that collides with it is lengthened.
            used[preferred] = object()
            return preferred
        identity = self.identity(node)
        attempt, candidate = 0, self.hashed(node, identity)
        # Distinct disks never share a name: re-hash with a counter on any collision.
        while candidate in used and used[candidate] != identity:
            attempt += 1
            if attempt > 64:
                raise AgentError('invalid_output', 'duplicate vdev identity')
            candidate = self.hashed(node, identity, attempt)
        if candidate in used:
            raise AgentError('invalid_output', 'duplicate vdev identity')
        used[candidate] = identity
        return candidate


def vdev_tree(node, pool_name, namer, depth=0, used=None, parent_class='normal'):
    """Allowlisted vdev tree. Names are unique within a pool (alerts key on them)."""
    used = used if used is not None else {}
    if not isinstance(node, dict):
        raise AgentError('invalid_output', 'vdev is not an object')
    if depth > MAX_VDEV_DEPTH:
        raise AgentError('invalid_output', 'vdev tree too deep')
    name = namer.name(node, pool_name, used)
    vtype, state = node.get('vdev_type'), node.get('state')
    raw_class = node.get('class', parent_class)
    vclass = raw_class if raw_class in VDEV_CLASSES else 'other'
    result = {'name': name,
              'type': vtype if vtype in GROUP_TYPES | LEAF_TYPES else 'unknown',
              'class': vclass,
              'state': state if state in VDEV_STATES else 'UNKNOWN',
              'read': counter(node, 'read_errors'), 'write': counter(node, 'write_errors'),
              'checksum': counter(node, 'checksum_errors')}
    children = node.get('vdevs')
    if children is not None:
        if not isinstance(children, dict):
            raise AgentError('invalid_output', 'vdev children are not an object')
        result['children'] = [vdev_tree(child, pool_name, namer, depth + 1, used, vclass) for child in children.values()]
    return result


def walk(node):
    yield node
    for child in node.get('children', ()):
        yield from walk(child)


def attention(node):
    return node['state'] not in HEALTHY_STATES or node['read'] or node['write'] or node['checksum']


def raw_nodes(node):
    yield node
    for child in (node.get('vdevs') or {}).values() if isinstance(node.get('vdevs'), dict) else ():
        yield from raw_nodes(child)


def vdev_sections(pool):
    """Top-level vdevs outside the main tree: special, logs, l2cache, spares, ...

    `zpool status -j` lists these next to `vdevs`. They are recognized by content
    (objects of vdevs), not by key name, so a class missing from the captured
    fixtures is still reported rather than silently dropped.
    """
    for key, section in pool.items():
        if key == 'vdevs' or not isinstance(section, dict) or not section:
            continue
        if all(isinstance(top, dict) and 'vdev_type' in top for top in section.values()):
            yield from section.values()


def bounded_tree(root):
    """Keep the tree within the cap without hiding an unhealthy or erroring vdev."""
    if sum(1 for _ in walk(root)) <= MAX_VDEVS_PER_POOL:
        return root, False

    def prune(node, depth):
        kept = [c for c in (prune(child, depth + 1) for child in node.get('children', ())) if c]
        if depth > 1 and not kept and not attention(node):
            return None
        copy = {k: v for k, v in node.items() if k != 'children'}
        if 'children' in node:
            copy['children'] = kept
        return copy

    pruned = prune(root, 0)
    if sum(1 for _ in walk(pruned)) > MAX_VDEVS_PER_POOL:
        raise AgentError('limit_exceeded', 'too many vdevs need attention')
    return pruned, True


def scan_summary(stats):
    """Latest scan only. A missing scan_stats means the pool was never scanned."""
    if stats is None:
        return None
    if not isinstance(stats, dict):
        raise AgentError('invalid_output', 'scan_stats is not an object')
    function = stats.get('function')
    if function in (None, 'NONE'):
        return None
    kind = SCAN_TYPES.get(function, 'other')
    state = SCAN_STATES.get(stats.get('state'), 'unknown')
    scan = {'type': kind, 'state': state, 'startTime': iso(stats.get('start_time', 0)),
            'endTime': iso(stats.get('end_time', 0)) if state != 'scanning' else None,
            'examinedBytes': byte_count(stats.get('examined', 0)),
            'totalBytes': byte_count(stats.get('to_examine', 0)),
            'errors': counter(stats, 'errors')}
    # `processed` is bytes repaired by a scrub but bytes resilvered so far by a
    # resilver; label it per scan type and never send one generic number.
    if kind == 'scrub':
        scan['repairedBytes'] = byte_count(stats.get('processed', 0))
    elif kind == 'resilver':
        scan['resilveredBytes'] = byte_count(stats.get('processed', 0))
    return scan


def list_property(properties, key):
    value = (properties.get(key) or {}).get('value') if isinstance(properties, dict) else None
    if value is None or value == '-':
        return None
    return byte_count(value)


def pools_summary(status, listing, namer):
    if not isinstance(status, dict) or not isinstance(status.get('pools', {}), dict):
        raise AgentError('invalid_output', 'zpool status has no pools object')
    if not isinstance(listing, dict) or not isinstance(listing.get('pools', {}), dict):
        raise AgentError('invalid_output', 'zpool list has no pools object')
    pools = status.get('pools', {})
    if len(pools) > MAX_POOLS:
        raise AgentError('limit_exceeded', 'too many pools')
    listed = listing.get('pools', {})
    result = []
    for name, pool in pools.items():
        if not isinstance(pool, dict) or not isinstance(name, str) or not POOL_NAME.fullmatch(name) or pool.get('name') != name:
            raise AgentError('invalid_output', 'invalid pool entry')
        roots = pool.get('vdevs')
        if not isinstance(roots, dict) or len(roots) != 1:
            raise AgentError('invalid_output', 'pool needs exactly one root vdev')
        raw_root = next(iter(roots.values()))
        used = {}
        tree = vdev_tree(raw_root, name, namer, used=used)
        tree.setdefault('children', [])
        # An in-use hot spare appears both inside the tree and in `spares`; report it once.
        seen = {n.get('guid') for n in raw_nodes(raw_root) if isinstance(n, dict) and isinstance(n.get('guid'), int)}
        for top in vdev_sections(pool):
            if isinstance(top.get('guid'), int) and top['guid'] in seen:
                continue
            seen.add(top.get('guid'))
            tree['children'].append(vdev_tree(top, name, namer, depth=1, used=used, parent_class=top.get('class', 'other')))
        nodes = list(walk(tree))
        tree, truncated = bounded_tree(tree)
        properties = (listed.get(name) or {}).get('properties')
        capacity, fragmentation = list_property(properties, 'capacity'), list_property(properties, 'fragmentation')
        state = pool.get('state')
        result.append({
            'name': name,
            'state': state if state in POOL_STATES else 'UNKNOWN',
            # Sizes are null if the pool appeared between the two commands.
            'size': list_property(properties, 'size'),
            'allocated': list_property(properties, 'allocated'),
            'free': list_property(properties, 'free'),
            'capacityPercent': capacity if capacity is None or capacity <= 100 else None,
            'fragmentationPercent': fragmentation if fragmentation is None or fragmentation <= 100 else None,
            # Pool totals are the root vdev's own counters, as on zpool status's pool
            # line (a failure is counted at each level that fails, so a tree sum would
            # overstate). Alerts use per-vdev counters. error_count (permanent data
            # errors) is separate and can be 0 while a vdev reports checksum errors.
            'errors': {key: tree[key] for key in ('read', 'write', 'checksum')},
            'dataErrors': counter(pool, 'error_count'),
            'scan': scan_summary(pool.get('scan_stats')),
            'vdevs': [tree],
            'vdevsTruncated': truncated,
        })
    return result


def utf16_length(text):
    """Length in UTF-16 code units, the unit the dashboard (JavaScript) measures."""
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def datasets_summary(listing, pool_names):
    if not isinstance(listing, dict) or not isinstance(listing.get('datasets', {}), dict):
        raise AgentError('invalid_output', 'zfs list has no datasets object')
    # Only roots and direct children of pools in this report (`-d 1`; pools can
    # appear or go between the two commands).
    items = [(name, dataset) for name, dataset in listing.get('datasets', {}).items()
             if isinstance(name, str) and name.split('/')[0] in pool_names and name.count('/') <= 1 and not name.endswith('/')]
    result = []
    for name, dataset in items[:MAX_DATASETS]:
        properties = dataset.get('properties') if isinstance(dataset, dict) else None
        if (not 0 < utf16_length(name) <= MAX_DATASET_NAME or not name.isprintable()
                or not isinstance(properties, dict)):
            raise AgentError('invalid_output', 'invalid dataset entry')
        mountpoint = (properties.get('mountpoint') or {}).get('value')
        if mountpoint == '-' or mountpoint is None:
            mountpoint = None
        elif not isinstance(mountpoint, str) or utf16_length(mountpoint) > MAX_MOUNTPOINT or not mountpoint.isprintable():
            raise AgentError('invalid_output', 'invalid mountpoint')
        quota = list_property(properties, 'quota')
        result.append({'name': name, 'used': list_property(properties, 'used'),
                       'available': list_property(properties, 'available'),
                       'referenced': list_property(properties, 'referenced'),
                       'quota': quota or None, 'mountpoint': mountpoint})
    return result, len(items) > MAX_DATASETS


def find_command(name):
    for directory in SAFE_PATH.split(':'):
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise AgentError('zfs_unavailable', name + ' not found')


def stuck_children():
    """Count abandoned children still running; reap any that have exited (non-blocking)."""
    ABANDONED[:] = [child for child in ABANDONED if child.poll() is None]
    return len(ABANDONED)


def abandon(child):
    """Kill a query without ever blocking on it: close our pipes, kill its process
    group, allow a short grace period, then give up on it if it still has not exited."""
    for stream in (child.stdout, child.stderr):
        try:
            stream.close()
        except OSError:
            pass
    try:
        os.killpg(child.pid, signal.SIGKILL)  # Its own session: grandchildren too.
    except OSError:
        pass
    try:
        child.kill()
    except OSError:
        pass
    try:
        child.wait(timeout=KILL_GRACE)
    except subprocess.TimeoutExpired:
        ABANDONED.append(child)


def run_command(program, arguments):
    """Run a fixed read-only query with a clean environment, a deadline and output caps.

    Output is read as it arrives, so the cap is enforced without buffering more than
    it; on a timeout the child is abandoned rather than waited on (see abandon()).
    """
    if stuck_children() >= MAX_STUCK_CHILDREN:
        raise AgentError('timeout', 'earlier queries are still stuck; not starting ' + program)
    command = find_command(program)
    try:
        child = subprocess.Popen([command, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env={'PATH': SAFE_PATH, 'LC_ALL': 'C'},
                                 close_fds=True, start_new_session=True)
    except OSError as error:
        raise AgentError('zfs_unavailable', type(error).__name__) from error
    deadline = time.monotonic() + COMMAND_TIMEOUT
    output, errors, failure = bytearray(), bytearray(), None
    buffers = {child.stdout.fileno(): (output, MAX_COMMAND_OUTPUT), child.stderr.fileno(): (errors, MAX_COMMAND_STDERR)}
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        selector.register(child.stderr, selectors.EVENT_READ)
        while selector.get_map() and failure is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = AgentError('timeout', program + ' timed out')
                break
            for key, _ in selector.select(remaining):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer, limit = buffers[key.fd]
                buffer.extend(chunk)
                if len(buffer) > limit:
                    failure = AgentError('invalid_output', program + ' output exceeds limit')
                    break
    if failure is None:
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            failure = AgentError('timeout', program + ' timed out')
    if failure is not None:
        abandon(child)
        raise failure
    child.stdout.close()
    child.stderr.close()
    if child.returncode != 0:
        message = bytes(errors).decode('utf-8', 'replace')
        if re.search(r'invalid option|unrecognized option|unknown option', message, re.I):
            raise AgentError('unsupported_version', program + ' does not support JSON output')
        if re.search(r'permission denied|not permitted', message, re.I):
            raise AgentError('permission_denied', program + ' permission denied')
        raise AgentError('command_failed', program + ' exited with ' + str(child.returncode))
    return bytes(output)


def run_json(program, arguments):
    try:
        return json.loads(run_command(program, arguments))
    except (ValueError, UnicodeDecodeError) as error:
        raise AgentError('invalid_output', program + ' returned invalid JSON') from error


def zfs_version(run=run_command):
    """Userland OpenZFS version; JSON output requires 2.3.0 or newer."""
    first = run('zpool', ('--version',)).decode('utf-8', 'replace').splitlines()[:1]
    match = re.fullmatch(r'zfs-([0-9]+)\.([0-9]+)\.([0-9]+)([A-Za-z0-9._+~-]{0,40})', first[0].strip() if first else '')
    if not match:
        raise AgentError('unsupported_version', 'unrecognized zpool --version output')
    version = match.group(1) + '.' + match.group(2) + '.' + match.group(3) + match.group(4)
    if tuple(int(match.group(i)) for i in (1, 2, 3)) < MIN_ZFS:
        raise AgentError('unsupported_version', 'OpenZFS ' + version + ' lacks JSON output')
    return version


def collect(config, run=None, run_json_command=None, namer=None):
    """Build the `storage` section; failures become a clear error state, never text parsing."""
    # Resolve defaults at call time so one patched runner reaches every query.
    run, run_json_command = run or run_command, run_json_command or run_json
    # --check runs without configuration; its throwaway salt only affects names it never sends.
    namer = namer or DeviceNamer(config.get('nameSalt') or secrets.token_hex(32))
    storage = {'state': 'ok', 'error': None, 'zfsVersion': None, 'pools': [], 'datasetsStatus': 'disabled'}
    try:
        storage['zfsVersion'] = zfs_version(run)
        status = run_json_command('zpool', ZPOOL_STATUS)
        listing = run_json_command('zpool', ZPOOL_LIST)
        storage['pools'] = pools_summary(status, listing, namer)
    except AgentError as error:
        return {**storage, 'state': 'error', 'error': error.code, 'pools': []}, error
    if config.get('datasets', True):
        # Optional dataset usage must never prevent pool status.
        try:
            datasets, truncated = datasets_summary(run_json_command('zfs', ZFS_LIST), {pool['name'] for pool in storage['pools']})
            storage['datasets'] = datasets
            storage['datasetsStatus'] = 'truncated' if truncated else 'complete'
        except AgentError:
            storage['datasetsStatus'] = 'unavailable'
    return storage, None


def encode_report(storage):
    report = {'agentVersion': AGENT_VERSION, 'agentProtocol': AGENT_PROTOCOL, 'storage': storage}
    body = json.dumps(report, separators=(',', ':')).encode()
    if len(body) > MAX_REPORT_BYTES and 'datasets' in storage:
        storage = {k: v for k, v in storage.items() if k != 'datasets'}
        storage['datasetsStatus'] = 'report_limit'
        return encode_report(storage)
    if len(body) > MAX_REPORT_BYTES:
        storage = {'state': 'error', 'error': 'report_limit', 'zfsVersion': storage.get('zfsVersion'),
                   'pools': [], 'datasetsStatus': storage.get('datasetsStatus', 'disabled')}
        return encode_report(storage)
    return body, report


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def check_config(config):
    """Standalone dashboards only: an HTTPS origin, a host ID, a per-host token and the local name salt."""
    if not isinstance(config, dict) or set(config) - {'url', 'hostId', 'hostToken', 'nameSalt', 'datasets'}:
        raise ValueError('Invalid storage agent configuration')
    url = urllib.parse.urlsplit(config.get('url') if isinstance(config.get('url'), str) else '')
    url.port  # Raises ValueError for an invalid port.
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment
            or not isinstance(config.get('hostId'), str)
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['hostId'])):
        raise ValueError('Invalid dashboard destination')
    if not isinstance(config.get('hostToken'), str) or not re.fullmatch(r'[\x21-\x7e]{1,8192}', config['hostToken']):
        raise ValueError('Invalid reporting credentials')
    # Generated on this host at install; never sent to the dashboard.
    if not isinstance(config.get('nameSalt'), str) or not NAME_SALT.fullmatch(config['nameSalt']):
        raise ValueError('Invalid or missing name salt; rerun setup or restore storage.json')
    if 'datasets' in config and not isinstance(config['datasets'], bool):
        raise ValueError('Invalid storage agent configuration')
    return config['url'].rstrip('/') + '/api/ingest/' + config['hostId']


def read_limited(response, limit):
    body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Response exceeds limit')
    return json.loads(body)


def deliver(config, opener, body):
    request = urllib.request.Request(check_config(config), data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['hostToken']})
    with opener.open(request, timeout=20) as response:
        acknowledgement = read_limited(response, 8192)
        if response.status != 200 or not isinstance(acknowledgement, dict) or acknowledgement.get('ok') is not True:
            raise ValueError('Report was not accepted')


def load_config(path):
    with open(path, 'rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError('Configuration file is too large')
    config = json.loads(raw)
    check_config(config)
    return config


def describe(storage):
    if storage['state'] == 'error':
        return 'storage agent error: ' + storage['error']
    return str(len(storage['pools'])) + ' pool(s), datasets ' + storage['datasetsStatus']


def report_once(config, opener, collect_storage=collect):
    storage, error = collect_storage(config)
    if error is not None:
        # Local detail is fixed text from this agent, never ZFS output or credentials.
        print('Collection failed: ' + error.code + (' (' + error.detail + ')' if error.detail else ''), flush=True)
    body, report = encode_report(storage)
    deliver(config, opener, body)
    print('Storage status delivered: ' + describe(report['storage']), flush=True)


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    path = DEFAULT_CONFIG
    if '--config' in arguments:
        index = arguments.index('--config')
        path = arguments[index + 1]
        del arguments[index:index + 2]
    if arguments not in ([], ['--check'], ['--once']):
        print('Usage: crowsnest_storage.py [--config PATH] [--check | --once]', file=sys.stderr)
        return 2
    if arguments == ['--check']:
        # Local verification without credentials or network: proves read access to ZFS.
        storage, error = collect({})
        print(describe(storage))
        return 1 if error else 0
    try:
        config = load_config(path)
    except (OSError, ValueError) as error:
        print('Configuration error: ' + type(error).__name__ + ': ' + str(error)[:200], file=sys.stderr)
        return 1
    opener = urllib.request.build_opener(NoRedirect())
    while True:
        started = time.monotonic()
        delivered = False
        try:
            report_once(config, opener)
            delivered = True
        except urllib.error.HTTPError as error:
            print('Reporting failed: HTTP ' + str(error.code) + '; will retry', flush=True)
            error.close()
        except Exception as error:
            print('Reporting failed: ' + type(error).__name__ + '; will retry', flush=True)
        if arguments == ['--once']:
            return 0 if delivered else 1
        time.sleep(max(1, INTERVAL - (time.monotonic() - started)))


if __name__ == '__main__':
    sys.exit(main())
