#!/usr/bin/env python3
"""Root deployment transactions. Default --check is read-only; timers are opt-in."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")
NODE = re.compile(r"v24\.\d+\.\d+")
API = "fg-index-api.service"
BOOT_GUARD = "fg-index-api-boot-guard.service"
RECOVERY = "fg-index-deployment-recovery.service"
CONTROLLER_TIMEOUTS = {
    'fg-index-deployment.service': '30min',
    'fg-index-deployment-watchdog.service': '10min',
    RECOVERY: '10min',
}
IMAGE_VALIDATION_SECONDS = 90
BOOT_GUARD_DROPIN = Path('/etc/systemd/system/fg-index-api.service.d/20-deployment-boot-guard.conf')
POLLER = "fg-index-release-poller.service"
PROMOTER = Path("/usr/local/libexec/fg-index-release-promoter/promote_api_release.py")
STATE = Path("/var/lib/fg-index-deployment")
POLICY = Path("/etc/fg-index/deployment-policy.json")
RELEASES = Path("/opt/fg-index/releases")
CURRENT = Path("/opt/fg-index/current")
NODE_RELEASES = Path("/opt/nodejs/releases")
NODE_CURRENT = Path("/opt/nodejs/current")
ROLE_STAGE = Path("/root/fg-index-api-activation-fa654555b1692111af882f45")
API_WORKING_DIRECTORY = '/opt/fg-index/current/apps/api-server'
API_NODE_EXECUTABLE = '/opt/nodejs/current/bin/node'
SYSTEMD_API_AFTER = {'network-online.target', 'sysinit.target', 'basic.target',
                    'systemd-journald.socket', 'systemd-tmpfiles-setup.service', 'system.slice'}
SYSTEMD_API_REQUIRES = {'sysinit.target', 'system.slice'}
ROLE_LOCK = ROLE_STAGE / "role-deployment.lock"
OWNER_RECEIPT = ROLE_STAGE / "scheduler-owner-receipt.json"
BOOT_RECEIPT = ROLE_STAGE / "boot-enable-receipt.json"
BOOT_LINK = Path("/etc/systemd/system/multi-user.target.wants/fg-index-api.service")
ROLE_OVERRIDE = Path("/etc/systemd/system/fg-index-api.service.d/10-scheduler-owner.conf")
ROLE_OVERRIDE_SHA = "32452cac8814231866521e8e5af192f7aa4df9b12573309ac071e499b8bcef64"
RETENTION = Path("/etc/fg-index-release-poller/retention-policy.json")
STAGED = Path("/var/lib/fg-index-release-poller/staged")


class PersistenceError(RuntimeError):
    """State durability is uncertain; only stop owned processes and HOLD."""


class DependencyDegraded(RuntimeError):
    """Read-only database probe failed; this alone does not justify code rollback."""


class Hold(RuntimeError):
    """No further mutation is safe without reviewed operator intervention."""


def require(condition, reason):
    if not condition:
        raise Hold(reason)


def digest_file(path, deadline=None):
    h = hashlib.sha256()
    with path.open('rb') as reader:
        for chunk in iter(lambda: reader.read(1024 * 1024), b''):
            require(deadline is None or time.monotonic() < deadline, 'image hashing deadline exceeded')
            h.update(chunk)
    return h.hexdigest()


def trusted(path, directory=False, private=False, uid=0):
    try:
        info = path.lstat()
    except OSError as error:
        raise Hold('required trusted path is unavailable') from error
    require(info.st_uid == uid and not info.st_mode & 0o022, 'untrusted ownership or permissions')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'unexpected filesystem type')
    if private:
        require(not info.st_mode & 0o077, 'state is not private')
    require(not any(n.startswith('system.posix_acl') for n in os.listxattr(path, follow_symlinks=False)), 'unexpected ACL')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, data, mode=0o600):
    name = None
    try:
        fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as writer:
            json.dump(data, writer, sort_keys=True)
            writer.write('\n')
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    except OSError as error:
        raise PersistenceError('atomic state/policy persistence failed') from error
    finally:
        if name is not None and os.path.exists(name):
            os.unlink(name)


def read_json(path, uid=0, max_bytes=1024 * 1024):
    trusted(path, private=True, uid=uid)
    require(path.stat().st_size <= max_bytes, 'oversized configuration/state')
    value = json.loads(path.read_text())
    require(isinstance(value, dict), 'invalid configuration/state')
    return value


class Store:
    """Private files and shared lock; callers never create an implicit initial state."""
    def __init__(self, root=STATE, uid=0, lock_path=ROLE_LOCK):
        self.root, self.uid, self.lock_path = root, uid, lock_path

    def inspect(self):
        trusted(self.root.parent, directory=True, uid=self.uid)
        trusted(self.root, directory=True, private=True, uid=self.uid)

    @contextmanager
    def lock(self):
        self.inspect()
        trusted(self.lock_path.parent, directory=True, private=True, uid=self.uid)
        fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            trusted(self.lock_path, private=True, uid=self.uid)
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Hold('another deployment/role operation holds the lock') from error
            yield

    def load(self):
        self.inspect()
        data = read_json(self.root / 'state.json', self.uid)
        require(set(data) == {'schema_version', 'current', 'rollback', 'transaction', 'rejected', 'hold', 'failures'}, 'unknown state fields')
        require(data['schema_version'] == 1 and isinstance(data['rejected'], list), 'invalid state schema')
        require(all(isinstance(s, str) and SHA.fullmatch(s) for s in data['rejected']), 'invalid rejected set')
        require(type(data['failures']) is int and 0 <= data['failures'] <= 2, 'invalid watchdog counter')
        require(data['hold'] is None or isinstance(data['hold'], str), 'invalid hold')
        for receipt in [data['current'], data['rollback']]:
            if receipt is not None:
                validate_receipt(receipt)
        tx = data['transaction']
        if tx is not None:
            require(isinstance(tx, dict) and set(tx) == {'stage', 'previous', 'next', 'role'}, 'invalid transaction')
            require(tx['stage'] in {'promoting', 'intent', 'stopped', 'switching', 'switched', 'started', 'rolling-back'}, 'unknown transaction stage')
            validate_receipt(tx['previous'])
            if tx['stage'] == 'promoting':
                require(isinstance(tx['next'], str) and SHA.fullmatch(tx['next']), 'invalid promotion intent')
            else:
                validate_receipt(tx['next'])
            validate_role(tx['role'])
        return data

    def save(self, data):
        try:
            atomic_json(self.root / 'state.json', data)
        except OSError as error:
            raise PersistenceError('private state persistence failed') from error


def validate_role(role):
    require(isinstance(role, dict) and set(role) == {'generation', 'enabled'}, 'invalid role receipt')
    require(type(role['generation']) is int and role['generation'] > 0 and type(role['enabled']) is bool, 'invalid role generation')


def validate_receipt(receipt):
    require(isinstance(receipt, dict) and set(receipt) == {'sha', 'node', 'inventory', 'schema'}, 'invalid image receipt')
    require(isinstance(receipt['sha'], str) and SHA.fullmatch(receipt['sha']), 'invalid source receipt')
    require(isinstance(receipt['node'], str) and NODE.fullmatch(receipt['node']), 'invalid runtime receipt')
    require(all(isinstance(receipt[k], str) and DIGEST.fullmatch(receipt[k]) for k in ('inventory', 'schema')), 'invalid image fingerprints')


def node_target(version):
    require(isinstance(version, str) and NODE.fullmatch(version), 'invalid runtime target')
    return NODE_RELEASES / ('node-' + version)


def validate_loaded_unit(props, role, boot_guard_enabled=False, automatic_mount_requires=(), automatic_mount_after=()):
    require(props['User'] == props['Group'] == 'fg-index' and props['ControlPID'] == '0', 'unit identity/control process drift')
    require(props['FragmentPath'] == '/etc/systemd/system/' + API, 'unit fragment drift')
    require(props['WorkingDirectory'] == API_WORKING_DIRECTORY, 'loaded working directory drift')
    require(props['EnvironmentFiles'] == '/etc/fg-index/api.env (ignore_errors=no)', 'loaded environment file drift')
    expected_requires = SYSTEMD_API_REQUIRES | ({BOOT_GUARD} if boot_guard_enabled else set()) | set(automatic_mount_requires)
    expected_after = SYSTEMD_API_AFTER | ({BOOT_GUARD} if boot_guard_enabled else set()) | set(automatic_mount_after)
    loaded_requires = set(props['Requires'].split())
    loaded_after = set(props['After'].split())
    require(loaded_requires == expected_requires and
            loaded_after == expected_after,
            'boot authorization dependency drift')
    drops = ' '.join(str(p) for p in (([ROLE_OVERRIDE] if role['enabled'] else []) +
                                      ([BOOT_GUARD_DROPIN] if boot_guard_enabled else [])))
    require(props['DropInPaths'] == drops, 'unknown or duplicate unit drop-ins')
    enabled = str(role['enabled']).lower()
    argv = '/usr/bin/env NODE_ENV=production HOST=127.0.0.1 PORT=8080 SCHEDULERS_ENABLED=' + enabled + ' /opt/nodejs/current/bin/node /opt/fg-index/current/apps/api-server/dist/index.js'
    loaded = props['ExecStart']
    match = re.fullmatch(r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=([^;{}]+?) ;[^{}]*\}', loaded)
    require(match and match.group(1) == '/usr/bin/env' and match.group(2) == argv and match.group(3) == 'no', 'loaded exact executable/argv/count drift')


def validate_loaded_poller(props):
    require(props['User'] == props['Group'] == 'fg-index-release-poller', 'loaded poller identity drift')
    require(props['FragmentPath'] == '/etc/systemd/system/' + POLLER and props['DropInPaths'] == '', 'loaded poller paths drift')
    require(props['EnvironmentFiles'] == '' and props['WorkingDirectory'] == '', 'loaded poller environment/working directory drift')
    require(props['TimeoutStartUSec'] == '3min', 'loaded poller timeout drift')
    argv = '/usr/bin/python3.12 /usr/local/libexec/fg-index-release-poller/poller.py --root /var/lib/fg-index-release-poller'
    match = re.fullmatch(r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=([^;{}]+?) ;[^{}]*\}', props['ExecStart'])
    require(match and match.group(1) == '/usr/bin/python3.12' and match.group(2) == argv and match.group(3) == 'no', 'loaded poller executable/argv/count drift')


def validate_loaded_controller(props, unit, action):
    require(props['User'] == 'root' and props['Type'] == 'oneshot' and
            props['TimeoutStartUSec'] == CONTROLLER_TIMEOUTS[unit] and
            props['FragmentPath'] == '/etc/systemd/system/' + unit and props['DropInPaths'] == '',
            'loaded controller unit drift')
    argv = '/usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py ' + action
    match = re.fullmatch(r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=([^;{}]+?) ;[^{}]*\}', props['ExecStart'])
    require(match and match.group(1) == '/usr/bin/python3.12' and match.group(2) == argv and match.group(3) == 'no',
            'loaded controller executable/argv drift')


def validate_loaded_guard(props):
    require(props['User'] == props['Group'] == 'root' and props['Type'] == 'oneshot' and
            props['TimeoutStartUSec'] == '2min' and
            props['FragmentPath'] == '/etc/systemd/system/' + BOOT_GUARD and props['DropInPaths'] == '',
            'loaded boot guard unit drift')
    argv = '/usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py --boot-guard'
    match = re.fullmatch(r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=([^;{}]+?) ;[^{}]*\}', props['ExecStart'])
    require(match and match.group(1) == '/usr/bin/python3.12' and match.group(2) == argv and match.group(3) == 'no',
            'loaded boot guard executable/argv drift')


def validate_policy_shape(policy):
    fields = {'schema_version', 'role', 'boot_enabled', 'schema', 'nodes', 'pins', 'manual_adoption'}
    require(set(policy) in (fields, fields | {'boot_guard_enabled'}), 'unknown policy fields')
    if 'boot_guard_enabled' in policy:
        require(type(policy['boot_guard_enabled']) is bool, 'invalid boot guard phase')


class Host:
    """Fixed host paths/commands. Application probe code always runs as fg-index."""
    def __init__(self):
        trusted(POLICY.parent, directory=True)
        self.policy = read_json(POLICY)
        p = self.policy
        validate_policy_shape(p)
        require(p['schema_version'] == 1, 'unknown policy schema')
        validate_role(p['role'])
        require(type(p['boot_enabled']) is bool, 'invalid accepted boot policy')
        require(isinstance(p['schema'], str) and DIGEST.fullmatch(p['schema']), 'missing accepted schema fingerprint')
        require(isinstance(p['nodes'], dict) and p['nodes'], 'no accepted Node runtime')
        for version, digest in p['nodes'].items():
            require(NODE.fullmatch(version) and DIGEST.fullmatch(digest), 'invalid Node policy')
        require(isinstance(p['manual_adoption'], dict), 'invalid adoption policy')
        require(all(SHA.fullmatch(s) and DIGEST.fullmatch(d) for s, d in p['manual_adoption'].items()), 'invalid adoption approval')
        self.gid = grp.getgrnam('fg-index').gr_gid

    @property
    def role(self):
        return self.policy['role'].copy()

    @property
    def boot_guard_enabled(self):
        return self.policy.get('boot_guard_enabled', False)

    @staticmethod
    def command(argv, timeout):
        result = subprocess.run(argv, capture_output=True, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
        require(result.returncode == 0, 'fixed host operation failed')
        return result.stdout.decode('utf-8')

    def main_sha(self):
        def fetch(path):
            request = Request('https://api.github.com/repos/itswcl/fg-index/' + path,
                              headers={'User-Agent': 'fg-index-deployment/1', 'Accept': 'application/vnd.github+json'})
            with urlopen(request, timeout=15) as response:
                raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, 'oversized public metadata')
            return json.loads(raw)
        sha = fetch('git/ref/heads/main')['object']['sha']
        require(isinstance(sha, str) and SHA.fullmatch(sha), 'invalid public main')
        release = fetch('releases/tags/api-' + sha)
        require(release.get('immutable') is True and release.get('draft') is False and release.get('prerelease') is False,
                'main has no stable immutable publication')
        tag = fetch('git/ref/tags/api-' + sha)['object']
        require(tag.get('type') == 'commit' and tag.get('sha') == sha, 'publication is not direct exact-main tag')
        return sha

    def preflight(self):
        require(read_json(POLICY) == self.policy, 'policy or role generation changed during operation')
        for path in (RELEASES.parent, RELEASES, NODE_CURRENT.parent, NODE_RELEASES, RETENTION.parent, PROMOTER.parent):
            trusted(path, directory=True)
        expected = {str(PROMOTER), '/etc/fg-index-release-promoter/trusted_root.jsonl',
                    '/usr/local/libexec/fg-index-release-poller/poller.py',
                    '/usr/local/libexec/fg-index-deployment/deploy_api_release.py',
                    '/usr/local/libexec/fg-index-deployment/retain_api_releases.py',
                    '/etc/systemd/system/fg-index-release-retire@.service',
                    '/etc/systemd/system/' + API, '/etc/systemd/system/' + POLLER}
        controller_unit_paths = {'/etc/systemd/system/fg-index-deployment.service',
                                 '/etc/systemd/system/fg-index-deployment-watchdog.service',
                                 '/etc/systemd/system/' + BOOT_GUARD,
                                 '/etc/systemd/system/' + RECOVERY}
        attached_unit_pins = controller_unit_paths & set(self.policy['pins'])
        require(not attached_unit_pins or attached_unit_pins == controller_unit_paths,
                'partial deployment guard unit pin set')
        if attached_unit_pins:
            expected |= controller_unit_paths
        if self.boot_guard_enabled:
            require(attached_unit_pins == controller_unit_paths, 'guard phase requires all fixed deployment units')
        if self.boot_guard_enabled:
            expected.add(str(BOOT_GUARD_DROPIN))
            require(self.policy['pins'].get(str(BOOT_GUARD_DROPIN)) is not None, 'boot guard policy requires its exact API drop-in pin')
        else:
            require(not BOOT_GUARD_DROPIN.exists() and not BOOT_GUARD_DROPIN.is_symlink(),
                    'unaccepted API boot guard drop-in is present')
        if self.role['enabled']:
            expected |= {str(ROLE_OVERRIDE), str(OWNER_RECEIPT)}
            require(self.policy['pins'].get(str(ROLE_OVERRIDE)) == ROLE_OVERRIDE_SHA, 'unaccepted role override')
            receipt = read_json(OWNER_RECEIPT)
            require(receipt.get('stage') == 'complete' and receipt.get('role') == 'true' and receipt.get('owner_generation') == self.role['generation'] and receipt.get('new_owner') == 'oci' and receipt.get('old_owner') == 'render' and receipt.get('dropin_sha256') == ROLE_OVERRIDE_SHA, 'uncommitted scheduler owner receipt')
            require(isinstance(receipt.get('render_off_evidence_sha256'), str) and DIGEST.fullmatch(receipt['render_off_evidence_sha256']), 'missing Render-off ownership evidence')
        else:
            require(not OWNER_RECEIPT.exists() and not OWNER_RECEIPT.is_symlink(), 'existing owner receipt requires reviewed role disposition')
        if self.policy['boot_enabled']:
            require(self.role['enabled'], 'boot receipt contract requires accepted OCI owner')
            expected.add(str(BOOT_RECEIPT))
            boot = read_json(BOOT_RECEIPT)
            require(boot.get('stage') == 'complete' and boot.get('role') == 'true' and boot.get('owner_generation') == self.role['generation'] and boot.get('dropin_sha256') == ROLE_OVERRIDE_SHA, 'unaccepted boot-enable receipt')
            trusted(BOOT_LINK.parent, directory=True)
            info = BOOT_LINK.lstat()
            require(stat.S_ISLNK(info.st_mode) and info.st_uid == info.st_gid == 0 and os.readlink(BOOT_LINK) == '/etc/systemd/system/' + API, 'boot link drift')
        else:
            require(not BOOT_LINK.exists() and not BOOT_LINK.is_symlink() and not BOOT_RECEIPT.exists() and not BOOT_RECEIPT.is_symlink(), 'boot configuration requires reviewed acceptance')
        require(set(self.policy['pins']) == expected, 'unexpected or missing accepted helper/unit/role pins')
        for name, digest in self.policy['pins'].items():
            require(name in expected, 'unsupported policy pin')
            require(isinstance(digest, str) and DIGEST.fullmatch(digest), 'invalid pin')
            path = Path(name)
            trusted(path.parent, directory=True)
            trusted(path)
            require(digest_file(path) == digest, 'accepted source/unit drift')
        if attached_unit_pins:
            for unit, action in (('fg-index-deployment.service', '--once'),
                                 ('fg-index-deployment-watchdog.service', '--watchdog'),
                                 (RECOVERY, '--recover')):
                props = self.properties(unit, ['User', 'Type', 'TimeoutStartUSec', 'FragmentPath', 'DropInPaths', 'ExecStart'])
                validate_loaded_controller(props, unit, action)
            props = self.properties(BOOT_GUARD, ['User', 'Group', 'Type', 'TimeoutStartUSec', 'FragmentPath', 'DropInPaths', 'ExecStart'])
            validate_loaded_guard(props)
        trusted(Path('/etc/fg-index/api.env'))
        require(stat.S_IMODE(Path('/etc/fg-index/api.env').stat().st_mode) == 0o640 and Path('/etc/fg-index/api.env').stat().st_gid == self.gid, 'environment permission drift')
        for name in ('fg-index-release-poller.timer', 'fg-index-api.service'):
            props = self.properties(name, ['UnitFileState', 'ActiveState'])
            expected_enabled = 'enabled' if name == API and self.policy['boot_enabled'] else 'disabled'
            require(props['UnitFileState'] == expected_enabled, 'unaccepted unit enablement')
            if name.endswith('.timer'):
                require(props['ActiveState'] == 'inactive', 'competing poller timer')
        props = self.properties(API, ['User', 'Group', 'FragmentPath', 'DropInPaths', 'ExecStart', 'ControlPID', 'WorkingDirectory', 'EnvironmentFiles', 'Requires', 'After'])
        mount_requires, mount_after = self.automatic_api_mount_dependencies(props['Requires'], props['After'])
        validate_loaded_unit(props, self.role, self.boot_guard_enabled,
                             mount_requires, mount_after)
        self.poller_contract()

    def retention(self, store):
        if __package__:
            from .retain_api_releases import Retention
        else:
            from retain_api_releases import Retention
        return Retention(self, store)

    def prepare_retention(self, store, state, incoming):
        self.retention(store).prepare(state, incoming)

    def record_image(self, store, receipt):
        self.retention(store).record(receipt)

    def retire_quarantine(self, generation):
        require(type(generation) is int and generation > 0, 'invalid retirement generation')
        name = 'fg-index-release-retire@' + str(generation) + '.service'
        props = self.properties(name, ['User', 'Group', 'FragmentPath', 'DropInPaths', 'ExecStart', 'EnvironmentFiles', 'WorkingDirectory', 'TimeoutStartUSec', 'ActiveState', 'MainPID', 'ControlPID'], allow_missing_empty=('EnvironmentFiles',))
        argv = '/usr/bin/python3.12 /usr/local/libexec/fg-index-release-poller/poller.py --root /var/lib/fg-index-release-poller --retire-rejected --generation ' + str(generation)
        match = re.fullmatch(r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=([^;{}]+?) ;[^{}]*\}', props['ExecStart'])
        require(match and match.group(1) == '/usr/bin/python3.12' and match.group(2) == argv and match.group(3) == 'no', 'retirement loaded argv drift')
        require(props['User'] == props['Group'] == 'fg-index-release-poller' and props['FragmentPath'] == '/etc/systemd/system/fg-index-release-retire@.service' and props['DropInPaths'] == props['EnvironmentFiles'] == props['WorkingDirectory'] == '' and props['TimeoutStartUSec'] == '3min', 'retirement loaded contract drift')
        require(props['ActiveState'] == 'inactive' and props['MainPID'] == props['ControlPID'] == '0', 'retirement instance already active/failed')
        self.command(['/usr/bin/systemctl', 'start', name], 185)
        result = self.properties(name, ['ActiveState', 'Result', 'ExecMainStatus', 'MainPID'])
        require(result == {'ActiveState': 'inactive', 'Result': 'success', 'ExecMainStatus': '0', 'MainPID': '0'}, 'retirement did not finish successfully')

    def poller_contract(self):
        props = self.properties(POLLER, ['User', 'Group', 'FragmentPath', 'DropInPaths', 'ExecStart', 'EnvironmentFiles', 'WorkingDirectory', 'TimeoutStartUSec'], allow_missing_empty=('EnvironmentFiles',))
        validate_loaded_poller(props)

    def _verify_empty_environment_contract(self, unit, values):
        if unit == POLLER:
            fragment = Path('/etc/systemd/system/fg-index-release-poller.service')
        elif re.fullmatch(r'fg-index-release-retire@[1-9][0-9]*\.service', unit):
            fragment = Path('/etc/systemd/system/fg-index-release-retire@.service')
        else:
            raise Hold('empty environment compatibility is unsupported for this unit')
        require(values.get('FragmentPath') == str(fragment) and values.get('DropInPaths') == '', 'empty environment compatibility unit paths drift')
        trusted(fragment.parent, directory=True)
        trusted(fragment)
        pin = self.policy['pins'].get(str(fragment))
        require(isinstance(pin, str) and DIGEST.fullmatch(pin) and digest_file(fragment) == pin, 'empty environment unit pin drift')
        content = fragment.read_text()
        require(not re.search(r'(?im)^[ \t]*Environment(?:File)?[ \t]*=', content), 'unit source configures an environment')

    def properties(self, unit, names, allow_missing_empty=()):
        text = self.command(['/usr/bin/systemctl', 'show', '--all', *['--property=' + n for n in names], '--', unit], 5)
        values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        missing = set(names) - set(values)
        require(not (set(values) - set(names)) and missing <= set(allow_missing_empty), 'incomplete systemd properties')
        if allow_missing_empty:
            self._verify_empty_environment_contract(unit, values)
        for name in missing:
            require(name == 'EnvironmentFiles', 'unsupported absent empty property')
            values[name] = ''
        return values

    def automatic_api_mount_dependencies(self, requires, after):
        """Return systemd mount dependencies that cover only fixed API paths."""
        targets = set()
        with open('/proc/self/mountinfo', encoding='utf-8') as reader:
            for line in reader:
                fields = line.split(' - ', 1)[0].split()
                if len(fields) >= 5:
                    target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), fields[4])
                    targets.add(target)
        base_requires = SYSTEMD_API_REQUIRES | {BOOT_GUARD}
        base_after = SYSTEMD_API_AFTER | {BOOT_GUARD}
        required = set(requires.split()) - base_requires
        ordered = set(after.split()) - base_after
        require(required <= ordered, 'API mount requirement lacks matching ordering dependency: ' + ','.join(sorted(required - ordered)))
        candidates = required | ordered
        automatic_after = set()
        automatic_requires = set()
        permitted_paths = (API_WORKING_DIRECTORY, API_NODE_EXECUTABLE, '/tmp', '/var/tmp')
        required_paths = (API_WORKING_DIRECTORY, API_NODE_EXECUTABLE)
        for unit in candidates:
            require(unit.endswith('.mount'), 'unexpected API dependency: ' + unit)
            mount = self.properties(unit, ['Where'])['Where']
            covers = lambda paths: any(mount == '/' or path == mount or path.startswith(mount.rstrip('/') + '/') for path in paths)
            require(mount in targets and covers(permitted_paths),
                    'API dependency mount does not cover an allowed fixed path')
            automatic_after.add(unit)
            if unit in required:
                require(covers(required_paths), 'API Requires mount does not cover its executable or working directory')
                automatic_requires.add(unit)
        return automatic_requires, automatic_after

    def links(self):
        values = []
        for path in (CURRENT, NODE_CURRENT):
            info = path.lstat()
            require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'current link is not root-owned')
            values.append(os.readlink(path))
        return tuple(values)

    def targets(self, receipt):
        return (str(RELEASES / receipt['sha']), str(node_target(receipt['node'])))

    def verify(self, receipt):
        require(self.image(receipt['sha']) == receipt, 'root image receipt drift')

    def image(self, sha, root=None):
        require(isinstance(sha, str) and SHA.fullmatch(sha), 'invalid image SHA')
        root = root if root is not None else RELEASES / sha
        trusted(root, directory=True)
        h = hashlib.sha256()
        count, total = 0, 0
        deadline = time.monotonic() + IMAGE_VALIDATION_SECONDS
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs.sort()
            for name in sorted(dirs + files):
                path = Path(directory) / name
                info = path.lstat()
                count += 1
                require(count <= 100000 and time.monotonic() < deadline, 'image inventory budget exceeded')
                require(info.st_uid == 0 and info.st_gid == self.gid and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), 'image ownership drift')
                require(not any(n.startswith('system.posix_acl') for n in os.listxattr(path, follow_symlinks=False)), 'image ACL drift')
                relative = str(path.relative_to(root))
                if stat.S_ISREG(info.st_mode):
                    total += info.st_size
                    require(total <= 4 * 1024**3, 'image inventory byte budget exceeded')
                    value = digest_file(path, deadline)
                elif stat.S_ISDIR(info.st_mode):
                    value = 'directory'
                elif stat.S_ISLNK(info.st_mode):
                    require(path.resolve().is_relative_to(root), 'image link escapes')
                    value = 'link:' + os.readlink(path)
                else:
                    raise Hold('unsupported image entry')
                h.update(json.dumps([relative, stat.S_IMODE(info.st_mode), value], separators=(',', ':')).encode() + b'\n')
        manifest = dict(line.split('=', 1) for line in (root / 'RELEASE-MANIFEST.txt').read_text().splitlines())
        require(manifest.get('source_commit') == sha, 'image manifest source drift')
        node = manifest.get('node_version', '')
        require(node in self.policy['nodes'], 'unprovisioned runtime')
        node_root = node_target(node)
        trusted(node_root, directory=True)
        trusted(node_root / 'bin', directory=True)
        trusted(node_root / 'bin/node')
        require(digest_file(node_root / 'bin/node', deadline) == self.policy['nodes'][node], 'runtime binary drift')
        schema = digest_file(root / 'apps/api-server/prisma/schema.prisma', deadline)
        require(schema == self.policy['schema'], 'schema fingerprint not explicitly accepted')
        return {'sha': sha, 'node': node, 'inventory': h.hexdigest(), 'schema': schema}

    def protect(self, receipts):
        trusted(RETENTION)
        previous = json.loads(RETENTION.read_text())
        require(previous.get('schema_version') in (1, 2), 'unknown retention policy')
        if previous['schema_version'] == 1:
            require(set(previous) == {'schema_version', 'protected_shas'}, 'unknown retention policy fields')
        else:
            require(set(previous) == {'schema_version', 'generation', 'protected_shas', 'retire_rejected'}, 'unknown retirement policy fields')
        require(isinstance(previous['protected_shas'], list) and all(isinstance(s, str) and SHA.fullmatch(s) for s in previous['protected_shas']), 'invalid protected set')
        protected = set(previous['protected_shas']) | {r['sha'] for r in receipts if r}
        require(len(protected) <= 3, 'protected capacity requires reviewed retirement')
        previous['protected_shas'] = sorted(protected)
        require(not any(r['sha'] in protected for r in previous.get('retire_rejected', [])), 'retirement request conflicts with live protection')
        atomic_json(RETENTION, previous, 0o644)

    def poll(self):
        self.poller_contract()
        props = self.properties(POLLER, ['ActiveState', 'MainPID', 'ControlPID'])
        require(props['ActiveState'] == 'inactive' and props['MainPID'] == props['ControlPID'] == '0', 'poller already active or failed')
        self.command(['/usr/bin/systemctl', 'start', POLLER], 185)
        props = self.properties(POLLER, ['ActiveState', 'Result', 'ExecMainStatus', 'MainPID'])
        require(props == {'ActiveState': 'inactive', 'Result': 'success', 'ExecMainStatus': '0', 'MainPID': '0'}, 'poller did not finish successfully')

    def promote(self, sha):
        # Share the unprivileged poller lock; do not recursively delete quarantine.
        path = STAGED / '.release-poller.lock'
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'r') as lock:
            info = os.fstat(lock.fileno())
            require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077, 'invalid quarantine lock')
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Hold('quarantine busy') from error
            require(not (RELEASES / sha).exists(), 'unknown existing image cannot be adopted implicitly')
            self.command(['/usr/bin/python3.12', str(PROMOTER), sha], 185)
        return self.image(sha)

    def stopped(self):
        p = self.properties(API, ['ActiveState', 'MainPID', 'ControlPID'])
        require(p['ActiveState'] in ('inactive', 'failed') and p['MainPID'] == p['ControlPID'] == '0', 'API stop is ambiguous')
        listeners = self.command(['/usr/bin/ss', '-H', '-ltnp', 'sport = :8080'], 5)
        require(not listeners.strip(), 'API listener survives stop')

    def stop_owned(self, previous, candidate):
        links = self.links()
        require(all(v in {a, b} for v, a, b in zip(links, self.targets(previous), self.targets(candidate))), 'unknown links; cannot stop unowned process')
        props = self.properties(API, ['User', 'Group', 'FragmentPath', 'DropInPaths', 'ExecStart', 'ControlPID', 'WorkingDirectory', 'EnvironmentFiles', 'Requires', 'After'])
        mount_requires, mount_after = self.automatic_api_mount_dependencies(props['Requires'], props['After'])
        validate_loaded_unit(props, self.role, self.boot_guard_enabled,
                             mount_requires, mount_after)
        pid = self.properties(API, ['MainPID'])['MainPID']
        if pid != '0':
            require(pid.isdigit(), 'invalid owned PID')
            require(os.readlink('/proc/' + pid + '/exe') in {self.targets(r)[1] + '/bin/node' for r in (previous, candidate)}, 'unowned runtime executable')
            require(os.readlink('/proc/' + pid + '/cwd') in {self.targets(r)[0] + '/apps/api-server' for r in (previous, candidate)}, 'unowned runtime working directory')
        self.stop()

    def stop(self):
        self.command(['/usr/bin/systemctl', 'stop', API], 35)
        self.stopped()

    def switch(self, old, new):
        require(self.links() == self.targets(old), 'links changed outside transaction')
        self.stopped()
        for path, target in zip((CURRENT, NODE_CURRENT), self.targets(new)):
            require(not path.with_name(path.name + '.deployment-next').exists() and not path.with_name(path.name + '.deployment-next').is_symlink(), 'unknown temporary link')
            temp = path.with_name(path.name + '.deployment-next')
            os.symlink(target, temp)
            os.replace(temp, path)
            sync_directory(path.parent)

    def restore(self, previous, candidate):
        # A crash may occur between the two atomic link updates. Only these two
        # transaction-owned target pairs are eligible for restoration.
        self.stopped()
        links = self.links()
        require(all(v in {a, b} for v, a, b in zip(links, self.targets(previous), self.targets(candidate))), 'unknown link during recovery')
        for path, target in zip((CURRENT, NODE_CURRENT), self.targets(previous)):
            temp = path.with_name(path.name + '.deployment-next')
            if temp.is_symlink():
                require(temp.lstat().st_uid == 0 and os.readlink(temp) in {target, self.targets(candidate)[0 if path == CURRENT else 1]}, 'unknown pending link')
                temp.unlink()
            require(not temp.exists(), 'unknown pending entry')
            os.symlink(target, temp)
            os.replace(temp, path)
            sync_directory(path.parent)

    def start(self):
        BootGate(self, Store()).authorize_start()
        self.command(['/usr/bin/systemctl', 'start', API], 135)

    def active_controller(self):
        """Return the one live, fixed controller activation context, if any."""
        names = ('fg-index-deployment.service', 'fg-index-deployment-watchdog.service', RECOVERY)
        active = []
        for name in names:
            props = self.properties(name, ['ActiveState', 'MainPID', 'NRestarts', 'InvocationID', 'FragmentPath', 'DropInPaths', 'User', 'Type', 'TimeoutStartUSec', 'ExecStart'])
            action = {'fg-index-deployment.service': '--once',
                      'fg-index-deployment-watchdog.service': '--watchdog',
                      RECOVERY: '--recover'}[name]
            validate_loaded_controller(props, name, action)
            if props['ActiveState'] == 'activating':
                require(props['MainPID'].isdigit() and int(props['MainPID']) > 0 and
                        props['NRestarts'] == '0' and re.fullmatch(r'[0-9a-f]{32}', props['InvocationID']) and
                        props['FragmentPath'] == '/etc/systemd/system/' + name and props['DropInPaths'] == '',
                        'controller invocation is restarting or unidentified')
                pid = props['MainPID']
                require(os.readlink('/proc/' + pid + '/exe') == '/usr/bin/python3.12', 'controller executable drift')
                argv = Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0')[:-1]
                require(argv == [b'/usr/bin/python3.12', b'/usr/local/libexec/fg-index-deployment/deploy_api_release.py', action.encode()],
                        'controller command line drift')
                active.append({'unit': name, 'pid': pid, 'invocation': props['InvocationID'], 'restarts': 0})
        require(len(active) <= 1, 'multiple controller invocations are active')
        return active[0] if active else None

    def require_recovery_context(self):
        context = self.active_controller()
        require(context is not None and context['unit'] == RECOVERY,
                'recovery must run from the fixed operator recovery unit')

    def runtime(self, receipt, listener_required=True):
        self.preflight()
        require(self.links() == self.targets(receipt), 'runtime link identity mismatch')
        p = self.properties(API, ['ActiveState', 'MainPID', 'NRestarts', 'ControlPID'])
        require(p['ActiveState'] == 'active' and p['NRestarts'] == p['ControlPID'] == '0', 'API failed or restarted')
        require(p['MainPID'].isdigit() and int(p['MainPID']) > 0, 'no stable positive API PID')
        pid = p['MainPID']
        require(os.readlink('/proc/' + pid + '/exe') == self.targets(receipt)[1] + '/bin/node', 'running executable mismatch')
        require(os.readlink('/proc/' + pid + '/cwd') == self.targets(receipt)[0] + '/apps/api-server', 'running working directory mismatch')
        listeners = self.command(['/usr/bin/ss', '-H', '-ltnp'], 5).splitlines()
        own = [line for line in listeners if 'pid=' + pid + ',' in line]
        require(not own or (len(own) == 1 and '127.0.0.1:8080' in own[0]), 'API listener identity/address mismatch')
        if listener_required:
            require(len(own) == 1, 'API listener missing')
        return pid

    def probe(self, receipt):
        pid = self.runtime(receipt, listener_required=False)
        deadline = time.monotonic() + 60
        while True:
            require(self.runtime(receipt, listener_required=False) == pid, 'API PID changed during startup')
            try:
                try:
                    response = urlopen('http://127.0.0.1:8080/health', timeout=3)
                except HTTPError as error:
                    response = error
                with response:
                    raw = response.read(65537)
                    code = response.code
                require(code in (200, 503) and len(raw) <= 65536, 'hard HTTP failure')
                body = json.loads(raw)
                require(isinstance(body, dict) and body.get('status') in ('ok', 'degraded') and isinstance(body.get('uptime'), (int, float)), 'invalid health contract')
                self.runtime(receipt)
                break
            except Exception:
                require(time.monotonic() < deadline, 'HTTP acceptance deadline exceeded')
                time.sleep(1)
        # All imports/client access execute under the API identity and unit env,
        # never as root. Captured child output is discarded on every error.
        prefix = ['/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect',
                  '--property=User=fg-index', '--property=Group=fg-index', '--property=EnvironmentFile=/etc/fg-index/api.env',
                  '--property=WorkingDirectory=' + self.targets(receipt)[0] + '/apps/api-server',
                  '--property=RuntimeMaxSec=8', '--property=TimeoutStopSec=2', '--property=NoNewPrivileges=yes']
        node = [self.targets(receipt)[1] + '/bin/node', '--input-type=module', '-e']
        ws = "const ws=new WebSocket('ws://127.0.0.1:8080');await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error()),5000);ws.onopen=()=>{clearTimeout(t);ws.close();resolve();};ws.onerror=()=>reject(Error());});"
        self.command(prefix + ['--unit=fg-index-deployment-ws-probe'] + node + [ws], 12)
        db = "import {createRequire} from 'node:module';const require=createRequire(process.cwd()+'/probe.cjs');const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();try{await db.$queryRawUnsafe('SELECT 1');}finally{await db.$disconnect();}"
        try:
            self.command(prefix + ['--unit=fg-index-deployment-db-probe'] + node + [db], 12)
        except Exception:
            require(self.runtime(receipt) == pid, 'API PID changed during DB failure')
            raise DependencyDegraded('database acceptance unavailable') from None
        require(self.runtime(receipt) == pid, 'API PID changed during acceptance')
        return {'pid': pid, 'cold_cache': code == 503}


class BootGate:
    """Authorize one API start from committed state or a live owned transaction."""
    def __init__(self, host, store):
        self.host, self.store = host, store

    def authorize_start(self):
        self.host.preflight()
        state = self.store.load()
        require(self.host.boot_guard_enabled, 'boot guard phase is not enabled')
        role = self.host.role
        require(self.host.policy['boot_enabled'] is True and role['enabled'] is True,
                'API boot is not accepted')
        if state['transaction'] is None:
            require(state['hold'] is None and state['current'] is not None,
                    'committed API state is not startable')
            receipt = state['current']
            require(receipt['sha'] not in state['rejected'], 'committed image is rejected')
            require(self.host.links() == self.host.targets(receipt), 'committed links do not match state')
            self.host.verify(receipt)
            return receipt

        tx = state['transaction']
        require(state['hold'] is None and tx['role'] == role, 'transaction is held or role drifted')
        if tx['stage'] == 'switched':
            receipt = tx['next']
            require(self.host.links() == self.host.targets(receipt), 'switched links do not match transaction')
        elif tx['stage'] == 'rolling-back':
            receipt = tx['previous']
            require(self.host.links() == self.host.targets(receipt), 'rollback links do not match transaction')
        else:
            raise Hold('transaction stage does not authorize API start')
        context = self.host.active_controller()
        require(context is not None and context['restarts'] == 0,
                'API start is outside a live controller invocation')
        require(self.host.properties(API, ['NRestarts'])['NRestarts'] == '0',
                'API already restarted during this transaction')
        self.host.verify(receipt)
        return receipt


class Controller:
    """One transaction interface shared by CLI and failure/recovery tests."""
    def __init__(self, host, store):
        self.host, self.store = host, store

    def check(self):
        self.host.preflight()
        state = self.store.load()
        require(state['hold'] is None and state['transaction'] is None, 'operator recovery required')
        require(state['current'] is not None, 'explicit adoption required')
        self.host.verify(state['current'])
        if state['rollback']:
            self.host.verify(state['rollback'])
        self.host.runtime(state['current'])
        return state

    def boot_guard(self):
        BootGate(self.host, self.store).authorize_start()
        return 'start-authorized'

    def adopt(self, sha, inventory):
        with self.store.lock():
            self.host.preflight()
            require(not (self.store.root / 'state.json').exists(), 'state already exists')
            require(self.host.policy['manual_adoption'].get(sha) == inventory, 'manual adoption is not explicitly approved')
            receipt = self.host.image(sha)
            require(receipt['inventory'] == inventory, 'approved inventory mismatch')
            self.host.probe(receipt)
            self.host.protect([receipt])
            self.store.save({'schema_version': 1, 'current': receipt, 'rollback': None,
                             'transaction': None, 'rejected': [], 'hold': None, 'failures': 0})
            return 'adopted'

    def adopt_retention(self):
        with self.store.lock():
            state = self.check()
            self.host.retention(self.store).adopt(state)
            return 'retention-adopted'

    def recover_retention(self):
        require(self.host.boot_guard_enabled, 'retention recovery is disabled until the API boot guard is attached')
        with self.store.lock():
            state = self.check()
            self.host.retention(self.store).recover(state)
            return 'retention-recovered'

    def once(self):
        require(self.host.boot_guard_enabled, 'deployment is disabled until the API boot guard is attached')
        with self.store.lock():
            state = self.check()
            self.host.probe(state['current'])  # baseline DB failure cannot trigger code rollback
            sha = self.host.main_sha()
            if sha == state['current']['sha']:
                return 'unchanged'
            require(sha not in state['rejected'], 'rejected SHA requires reviewed new revision')
            self.host.prepare_retention(self.store, state, sha)
            self.host.protect([state['current'], state['rollback']])
            self.host.poll()
            require(self.host.main_sha() == sha, 'main moved during poll')
            state['transaction'] = {'stage': 'promoting', 'previous': state['current'], 'next': sha, 'role': self.host.role}
            self.store.save(state)
            try:
                candidate = self.host.promote(sha)
                self.host.record_image(self.store, candidate)
                self.host.protect([state['current'], state['rollback'], candidate])
                require(self.host.main_sha() == sha, 'main moved after promotion; inactive image retained')
                self.host.preflight()
                require(self.host.role == state['transaction']['role'], 'scheduler role changed')
                require(self.host.links() == self.host.targets(state['current']), 'links drifted before activation')
                state['transaction'].update(stage='intent', next=candidate)
                self.store.save(state)
                self.host.stop()
                self.stage(state, 'stopped')
                self.stage(state, 'switching')
                self.host.switch(state['current'], candidate)
                self.stage(state, 'switched')
                self.host.start()
                self.stage(state, 'started')
                self.host.probe(candidate)
                committed = copy.deepcopy(state)
                committed.update(rollback=state['current'], current=candidate, transaction=None, hold=None, failures=0)
                self.store.save(committed)
                return 'committed'
            except PersistenceError:
                self.persistence_hold(state)
            except Exception:
                tx = state['transaction']
                if tx and tx['stage'] in {'stopped', 'switching', 'switched', 'started'}:
                    return self.rollback(state)
                state['hold'] = 'promotion or stop incomplete; review transaction and inactive image'
                self.store.save(state)
                raise Hold(state['hold']) from None

    def stage(self, state, stage):
        state['transaction']['stage'] = stage
        self.store.save(state)

    def persistence_hold(self, state):
        # Never restart after an uncertain replace/fsync. Preserve the original
        # started/rolling-back transaction even if a commit became visible.
        tx = state['transaction']
        if tx and isinstance(tx['next'], dict):
            try:
                self.host.stop_owned(tx['previous'], tx['next'])
            except Exception:
                pass  # Unknown identity/failed stop stays HOLD, never overwritten.
        held = copy.deepcopy(state)
        held['hold'] = 'persistence uncertain; owned API stopped if identity confirmed'
        try:
            self.store.save(held)
        except Exception:
            pass
        raise Hold(held['hold']) from None

    def rollback(self, state):
        tx = state['transaction']
        try:
            self.host.preflight()
            require(self.host.role == tx['role'], 'role generation drift during recovery')
            self.stage(state, 'rolling-back')
            self.host.stop_owned(tx['previous'], tx['next'])
            self.host.verify(tx['previous'])
            self.host.verify(tx['next'])
            self.host.restore(tx['previous'], tx['next'])
            self.host.start()
            self.host.probe(tx['previous'])
            committed = copy.deepcopy(state)
            committed['rejected'] = sorted(set(state['rejected']) | {tx['next']['sha']})
            if committed['rollback'] == tx['previous']:
                committed['rollback'] = None
            committed.update(current=tx['previous'], transaction=None, hold=None, failures=0)
            self.store.save(committed)
            return 'rolled-back'
        except PersistenceError:
            self.persistence_hold(state)
        except Exception:
            try:
                self.host.stop_owned(tx['previous'], tx['next'])
            except Exception:
                pass
            state['hold'] = 'rollback incomplete; review before further action'
            self.store.save(state)
            raise Hold(state['hold']) from None

    def recover(self):
        require(self.host.boot_guard_enabled, 'recovery is disabled until the API boot guard is attached')
        with self.store.lock():
            self.host.preflight()
            if hasattr(self.host, 'require_recovery_context'):
                self.host.require_recovery_context()
            state = self.store.load()
            tx = state['transaction']
            require(tx is not None, 'ambiguous receipt requires operator review')
            if tx['stage'] == 'promoting':
                require(isinstance(tx['next'], str) and tx['next'] not in state['rejected'], 'invalid promotion recovery')
                require(state['hold'] in (None, 'promotion or stop incomplete; review transaction and inactive image'),
                        'held state requires evidence review')
                require(self.host.role == tx['role'] and self.host.links() == self.host.targets(tx['previous']),
                        'promotion recovery identity drift')
                self.host.verify(tx['previous'])
                state['rejected'] = sorted(set(state['rejected']) | {tx['next']})
                state.update(transaction=None, hold=None, failures=0)
                self.store.save(state)
                try:
                    self.host.start()
                    self.host.probe(state['current'])
                except Exception:
                    state['hold'] = 'previous image failed after promotion recovery'
                    self.store.save(state)
                    try:
                        self.host.stop()
                    except Exception:
                        pass
                    raise Hold(state['hold']) from None
                return 'recovered-promotion'
            require(tx['stage'] != 'promoting', 'ambiguous receipt requires operator review')
            require(state['hold'] is None or
                    (tx['stage'] == 'rolling-back' and state['hold'] == 'rollback incomplete; review before further action'),
                    'held state requires evidence review')
            state['hold'] = None
            return self.rollback(state)

    def watchdog(self):
        require(self.host.boot_guard_enabled, 'watchdog is disabled until the API boot guard is attached')
        with self.store.lock():
            self.host.preflight()
            state = self.store.load()
            require(state['hold'] is None and state['transaction'] is None and state['current'] is not None, 'operator recovery required')
            self.host.verify(state['current'])
            try:
                self.host.probe(state['current'])
                state['failures'] = 0
                self.store.save(state)
                return 'healthy'
            except PersistenceError:
                raise Hold('watchdog persistence uncertain') from None
            except DependencyDegraded:
                state['failures'] = 0
                self.store.save(state)
                return 'dependency-degraded'
            except Exception:
                state['failures'] = min(2, state['failures'] + 1)
                self.store.save(state)
                if state['failures'] < 2:
                    return 'degraded'
                require(state['rollback'] is not None, 'no accepted rollback image')
                state['transaction'] = {'stage': 'intent', 'previous': state['rollback'], 'next': state['current'], 'role': self.host.role}
                self.store.save(state)
                return self.rollback(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    for name in ('check', 'once', 'recover', 'watchdog', 'boot-guard', 'adopt-retention', 'recover-retention'):
        group.add_argument('--' + name, action='store_true')
    group.add_argument('--adopt', metavar='SHA')
    parser.add_argument('--inventory', metavar='SHA256')
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'controller requires root')
        require(bool(args.adopt) == bool(args.inventory), '--adopt requires --inventory')
        controller = Controller(Host(), Store())
        if args.adopt:
            result = controller.adopt(args.adopt, args.inventory)
        else:
            action = next((name for name in ('once', 'recover', 'watchdog', 'boot_guard', 'adopt_retention', 'recover_retention') if getattr(args, name)), 'check')
            result = getattr(controller, action)()
        print('deployment: ' + (result if isinstance(result, str) else 'check passed'))
        return 0
    except Exception:
        # No exception detail, child output, health payload, env or token in logs.
        print('deployment: HOLD; inspect private state and reviewed policy', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
