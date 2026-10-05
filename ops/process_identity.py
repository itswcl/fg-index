"""Strict controller-side validation for the zero-capability observer record."""
from __future__ import annotations

import json
import errno
import hashlib
import os
import re
import select
import socket
import stat
import subprocess
import time
import uuid
from pathlib import Path

API_UNIT = 'fg-index-api.service'
OBSERVER_EXECUTABLE = '/usr/local/libexec/fg-index-deployment/process_identity_observer'
OBSERVER_PATH = OBSERVER_EXECUTABLE

MAX_RECORD_BYTES = 4096
CAPABILITY_FIELDS = frozenset({'CapEff', 'CapPrm', 'CapBnd', 'CapAmb'})
RECORD_FIELDS = frozenset({
    'schema', 'helper_invocation_id', 'api_pid', 'api_invocation_id',
    'api_control_group', 'api_starttime', 'api_exe', 'api_cwd',
    'api_profile_label', 'api_capabilities', 'api_fd_inodes', 'listener',
    'pidfd_live', 'helper_capabilities', 'argv_ok', 'caller_parameters_absent',
})
IDENTITY_FIELDS = ('api_invocation_id', 'api_control_group', 'api_exe',
                   'api_cwd', 'api_profile_label')


def _proc_open(pid: int, name: str, *, dir_fd: int | None = None, flags=None) -> int:
    flags = (os.O_RDONLY | os.O_CLOEXEC) if flags is None else flags
    if dir_fd is not None:
        return os.open(name, flags, dir_fd=dir_fd)
    return os.open(f'/proc/{pid}/{name}', flags)


def capability_masks(pid, *, proc_fd: int | None = None) -> dict[str, str]:
    values = {}
    with os.fdopen(_proc_open(pid, 'status', dir_fd=proc_fd), encoding='ascii') as reader:
        for line in reader:
            if ':' in line:
                key, value = line.split(':', 1)
                if key in CAPABILITY_FIELDS:
                    values[key] = value.strip()
    if set(values) != CAPABILITY_FIELDS:
        raise IdentityRecordError('process capability fields are unavailable')
    return values


class IdentityRecordError(ValueError):
    """An observer record is malformed, stale, ambiguous, or unbound."""


def digest_tree(root: Path, *, max_files: int = 8192,
                max_bytes: int = 64 * 1024 * 1024) -> str:
    """Hash a bounded tree of regular AppArmor feature files deterministically."""
    digest = hashlib.sha256()
    count = total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(files):
            path = Path(directory) / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise IdentityRecordError('AppArmor feature tree has an unsupported entry')
            count += 1
            total += info.st_size
            if count > max_files or total > max_bytes:
                raise IdentityRecordError('AppArmor feature tree exceeds its inspection bound')
            digest.update(str(path.relative_to(root)).encode('utf-8') + b'\0')
            with path.open('rb') as reader:
                for chunk in iter(lambda: reader.read(65536), b''):
                    digest.update(chunk)
    if count == 0:
        raise IdentityRecordError('AppArmor feature tree is empty')
    return digest.hexdigest()


def process_starttime(pid: int, *, proc_fd: int | None = None) -> str:
    with os.fdopen(_proc_open(pid, 'stat', dir_fd=proc_fd), encoding='ascii') as reader:
        raw = reader.read(4096)
    close = raw.rfind(')')
    if close < 0:
        raise IdentityRecordError('process stat is malformed')
    fields = raw[close + 2:].split()
    if len(fields) < 20 or not fields[19].isdecimal():
        raise IdentityRecordError('process start time is malformed')
    return fields[19]


def process_cgroup(pid: int, *, proc_fd: int | None = None) -> str:
    groups = []
    with os.fdopen(_proc_open(pid, 'cgroup', dir_fd=proc_fd), encoding='ascii') as reader:
        for line in reader:
            fields = line.rstrip('\n').split(':', 2)
            if len(fields) == 3 and fields[0] == '0' and fields[1] == '':
                groups.append(fields[2])
    if len(groups) != 1 or not groups[0].startswith('/system.slice/'):
        raise IdentityRecordError('process cgroup is unavailable or ambiguous')
    return groups[0]


def pidfd_is_live(fd: int) -> bool:
    poller = select.poll()
    poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    return poller.poll(0) == []


def cgroup_is_empty(control_group: str) -> bool:
    if (not isinstance(control_group, str) or not control_group.startswith('/system.slice/')
            or '..' in Path(control_group).parts):
        raise IdentityRecordError('captured cgroup path is invalid')
    root = Path('/sys/fs/cgroup')
    current = root
    for component in Path(control_group).parts[1:]:
        current = current / component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return True
        if not stat.S_ISDIR(info.st_mode):
            raise IdentityRecordError('captured cgroup path is not a directory')
    events = current / 'cgroup.events'
    values = dict(line.split() for line in events.read_text(encoding='ascii').splitlines())
    if values.get('populated') not in {'0', '1'}:
        raise IdentityRecordError('captured cgroup population state is unavailable')
    return values['populated'] == '0'


def listener_rows(proc_fd: int | None = None) -> list[dict]:
    rows = []
    net_fd = (os.open('net', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
                      dir_fd=proc_fd) if proc_fd is not None else None)
    for table, family in (('tcp', socket.AF_INET), ('tcp6', socket.AF_INET6)):
        try:
            table_fd = (_proc_open(0, table, dir_fd=net_fd) if net_fd is not None
                        else os.open('/proc/net/' + table, os.O_RDONLY | os.O_CLOEXEC))
        except FileNotFoundError:
            if family == socket.AF_INET6:
                continue
            raise
        with os.fdopen(table_fd, encoding='ascii') as reader:
            next(reader)
            for line in reader:
                fields = line.split()
                if len(fields) < 10 or fields[3] != '0A':
                    continue
                address_hex, port_hex = fields[1].split(':', 1)
                port = int(port_hex, 16)
                if port != 8080:
                    continue
                raw = bytes.fromhex(address_hex)
                if family == socket.AF_INET:
                    address = socket.inet_ntop(family, raw[::-1])
                else:
                    address = socket.inet_ntop(
                        family, b''.join(raw[index:index + 4][::-1]
                                         for index in range(0, 16, 4)))
                rows.append({'address': address, 'port': port,
                             'state': fields[3], 'inode': fields[9]})
    if net_fd is not None:
        os.close(net_fd)
    return rows


def _api_unit_snapshot(host) -> dict:
    props = host.properties(API_UNIT, [
        'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'NRestarts',
        'InvocationID', 'ControlGroup', 'AppArmorProfile',
    ])
    if (props['ActiveState'] != 'active' or props['NRestarts'] != '0'
            or props['ControlPID'] != '0' or not props['MainPID'].isdecimal()
            or int(props['MainPID']) <= 0 or not props['InvocationID']):
        raise IdentityRecordError('API unit is not a stable active invocation')
    return props


def observe_api(host, receipt: dict, *, listener_required: bool) -> dict:
    """Collect exact A identity directly, falling back only on EACCES."""
    api_before = _api_unit_snapshot(host)
    pid = int(api_before['MainPID'])
    pidfd = os.pidfd_open(pid, 0)
    proc_fd = os.open(f'/proc/{pid}', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        if not pidfd_is_live(pidfd):
            raise IdentityRecordError('API process exited before observation')
        starttime = process_starttime(pid, proc_fd=proc_fd)
        cgroup = process_cgroup(pid, proc_fd=proc_fd)
        if cgroup != api_before['ControlGroup'] or not pidfd_is_live(pidfd):
            raise IdentityRecordError('API cgroup or pidfd differs from its unit snapshot')
        bundle = host.process_identity_bundle()
        api_label = bundle['profiles']['api']['label']
        if api_before['AppArmorProfile'] != api_label:
            raise IdentityRecordError('loaded API profile differs from the pinned pair')
        if not host.loaded_process_profile(api_label) or host.process_profile(pid, proc_fd=proc_fd) != api_label:
            raise IdentityRecordError('live API profile is not the accepted enforcing profile')
        try:
            api_capabilities = capability_masks(pid, proc_fd=proc_fd)
            if api_capabilities != {key: '0000000000000000' for key in CAPABILITY_FIELDS}:
                raise IdentityRecordError('API process capabilities are not empty')
            exe = os.readlink('exe', dir_fd=proc_fd)
            cwd = os.readlink('cwd', dir_fd=proc_fd)
            fd_inodes = []
            fd_dir = os.open('fd', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
                             dir_fd=proc_fd)
            try:
                names = os.listdir(fd_dir)
                for name in names:
                    target = os.readlink(name, dir_fd=fd_dir)
                    if target.startswith('socket:[') and target.endswith(']'):
                        inode = target[8:-1]
                        if not inode.isdecimal():
                            raise IdentityRecordError('API socket inode is malformed')
                        fd_inodes.append(inode)
            finally:
                os.close(fd_dir)
            fd_inodes = sorted(set(fd_inodes))
        except PermissionError as error:
            if error.errno != errno.EACCES:
                raise
            return run_fixed_observer(
                host, api_before=api_before,
                expected_exe=str(host.targets(receipt)[1] / 'bin/node'),
                expected_cwd=str(host.targets(receipt)[0] / 'apps/api-server'),
                listener_required=listener_required, api_pidfd=pidfd,
                api_proc_fd=proc_fd, api_starttime=starttime,
                api_cgroup=cgroup,
            )
        expected_exe = str(host.targets(receipt)[1] / 'bin/node')
        expected_cwd = str(host.targets(receipt)[0] / 'apps/api-server')
        if exe != expected_exe or cwd != expected_cwd:
            raise IdentityRecordError('API executable or working directory mismatch')
        rows = listener_rows(proc_fd)
        if not rows:
            listener = None
        elif (len(rows) == 1 and rows[0]['address'] == '127.0.0.1'
              and rows[0]['state'] == '0A' and rows[0]['inode'] in fd_inodes):
            listener = rows[0]
        else:
            raise IdentityRecordError('API listener is ambiguous or not owned by A')
        if listener_required and listener is None:
            raise IdentityRecordError('API listener is missing')
        after = _api_unit_snapshot(host)
        after_exe = os.readlink('exe', dir_fd=proc_fd)
        after_cwd = os.readlink('cwd', dir_fd=proc_fd)
        after_caps = capability_masks(pid, proc_fd=proc_fd)
        after_profile = host.process_profile(pid, proc_fd=proc_fd)
        after_fd_inodes = []
        after_fd_dir = os.open('fd', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
                               dir_fd=proc_fd)
        try:
            for name in os.listdir(after_fd_dir):
                target = os.readlink(name, dir_fd=after_fd_dir)
                if target.startswith('socket:[') and target.endswith(']'):
                    after_fd_inodes.append(target[8:-1])
        finally:
            os.close(after_fd_dir)
        after_fd_inodes = sorted(set(after_fd_inodes))
        after_rows = listener_rows(proc_fd)
        if (after != api_before or process_starttime(pid, proc_fd=proc_fd) != starttime
                or process_cgroup(pid, proc_fd=proc_fd) != cgroup or not pidfd_is_live(pidfd)
                or after_exe != exe or after_cwd != cwd
                or after_caps != api_capabilities or after_profile != api_label
                or after_fd_inodes != fd_inodes or after_rows != rows):
            raise IdentityRecordError('API process or unit changed during observation')
        return {'pid': pid, 'starttime': starttime, 'cgroup': cgroup,
                'exe': exe, 'cwd': cwd, 'fd_inodes': fd_inodes,
                'listener': listener, 'invocation_id': api_before['InvocationID'],
                'capabilities': api_capabilities}
    finally:
        os.close(proc_fd)
        os.close(pidfd)


def _read_record_line(stream, timeout: float) -> tuple[bytes, bytes]:
    deadline = time.monotonic() + timeout
    data = bytearray()
    fd = stream.fileno()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise IdentityRecordError('observer record timed out')
        chunk = os.read(fd, MAX_RECORD_BYTES + 1 - len(data))
        if not chunk:
            raise IdentityRecordError('observer exited without a complete record')
        data.extend(chunk)
        if len(data) > MAX_RECORD_BYTES:
            raise IdentityRecordError('observer record exceeds its bound')
        newline = data.find(b'\n')
        if newline >= 0:
            return bytes(data[:newline + 1]), bytes(data[newline + 1:])


def _read_completion_output(stream, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    data = bytearray()
    fd = stream.fileno()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise IdentityRecordError('observer completion output timed out')
        chunk = os.read(fd, MAX_RECORD_BYTES + 1 - len(data))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > MAX_RECORD_BYTES:
            raise IdentityRecordError('observer completion output exceeds its bound')


def run_fixed_observer(host, *, api_before: dict, expected_exe: str,
                       expected_cwd: str, listener_required: bool,
                       api_pidfd: int, api_proc_fd: int,
                       api_starttime: str, api_cgroup: str) -> dict:
    """Run the exact zero-capability observer and bind its record to live units."""
    bundle = host.process_identity_bundle()
    api_label = bundle['profiles']['api']['label']
    helper_label = bundle['profiles']['helper']['label']
    if api_before.get('AppArmorProfile') != api_label:
        raise IdentityRecordError('loaded API profile does not match the pinned pair')
    api_pid = int(api_before['MainPID'])
    if api_cgroup != api_before['ControlGroup']:
        raise IdentityRecordError('API process cgroup differs from its unit snapshot')
    if not pidfd_is_live(api_pidfd):
        raise IdentityRecordError('API process exited before observer launch')
    api_profile = host.process_profile(api_pid, proc_fd=api_proc_fd)
    if api_profile != api_label:
        raise IdentityRecordError('live API profile does not match the pinned pair')

    unit = 'fg-index-process-observer-' + uuid.uuid4().hex + '.service'
    proc_bind = f'/proc/{os.getpid()}/fd/{api_proc_fd}:/proc/{api_pid}'
    unset_environment = (
        'HOME LOGNAME USER SHELL LANG LANGUAGE LC_ALL LC_CTYPE LC_MESSAGES '
        'LC_NUMERIC LC_TIME LC_COLLATE LC_MONETARY LC_PAPER LC_NAME LC_ADDRESS '
        'LC_TELEPHONE LC_MEASUREMENT LC_IDENTIFICATION PATH')
    argv = [
        '/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect',
        '--unit=' + unit,
        '--property=Type=oneshot', '--property=User=fg-index',
        '--property=Group=fg-index', '--property=WorkingDirectory=/',
        '--property=AppArmorProfile=' + helper_label,
        '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
        '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
        '--property=ProtectHome=yes', '--property=PrivateTmp=yes',
        '--property=PrivateNetwork=no', '--property=NetworkNamespacePath=',
        '--property=JoinsNamespaceOf=', '--property=TemporaryFileSystem=/proc:ro',
        '--property=BindReadOnlyPaths=' + proc_bind,
        '--property=ProtectKernelTunables=yes', '--property=ProtectKernelModules=yes',
        '--property=ProtectControlGroups=yes', '--property=RestrictSUIDSGID=yes',
        '--property=RestrictRealtime=yes', '--property=LockPersonality=yes',
        '--property=SystemCallArchitectures=native',
        '--property=RestrictAddressFamilies=AF_UNIX',
        '--property=SystemCallFilter=~setns unshare',
        '--property=SetLoginEnvironment=no',
        '--property=UnsetEnvironment=' + unset_environment,
        '--property=TimeoutStartSec=20s', OBSERVER_EXECUTABLE,
    ]
    child = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, bufsize=0,
        env={'LANG': 'C', 'LC_ALL': 'C', 'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
    handed_off = False
    try:
        record_bytes, remainder = _read_record_line(child.stdout, 20)
        if remainder:
            raise IdentityRecordError('observer wrote data after its record')
        helper = host.properties(unit, [
            'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'NRestarts',
            'InvocationID', 'ControlGroup', 'FragmentPath', 'DropInPaths',
            'User', 'Group', 'Type', 'WorkingDirectory', 'ExecStart',
            'AppArmorProfile', 'Restart', 'KillMode', 'CapabilityBoundingSet',
            'AmbientCapabilities', 'NoNewPrivileges', 'RestrictAddressFamilies',
            'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'ProtectKernelTunables',
            'ProtectKernelModules', 'ProtectControlGroups', 'RestrictSUIDSGID',
            'RestrictRealtime', 'LockPersonality', 'SystemCallArchitectures',
            'TimeoutStartUSec', 'Environment', 'UnsetEnvironment',
            'SetLoginEnvironment', 'PrivateNetwork', 'NetworkNamespacePath',
            'JoinsNamespaceOf', 'TemporaryFileSystem', 'BindReadOnlyPaths',
            'SystemCallFilter', 'ProtectProc', 'ProcSubset',
        ])
        helper_pid = int(helper['MainPID']) if helper['MainPID'].isdecimal() else 0
        exec_match = re.fullmatch(
            r'\{ path=([^;{}]+?) ; argv\[\]=([^;{}]+?) ; ignore_errors=no ;[^{}]*\}',
            helper['ExecStart'])
        if (helper['ActiveState'] != 'activating' or helper['ControlPID'] != '0'
                or helper['NRestarts'] != '0' or helper['User'] != 'fg-index'
                or helper['Group'] != 'fg-index' or helper['Type'] != 'oneshot'
                or helper['WorkingDirectory'] != '/' or helper['DropInPaths'] != ''
                or not exec_match or exec_match.group(1) != OBSERVER_EXECUTABLE
                or exec_match.group(2) != OBSERVER_EXECUTABLE
                or helper['AppArmorProfile'] != helper_label
                or helper['CapabilityBoundingSet'] != ''
                or helper['AmbientCapabilities'] != ''
                or helper['NoNewPrivileges'] != 'yes'
                or helper['RestrictAddressFamilies'] != 'AF_UNIX'
                or helper['PrivateNetwork'] != 'no'
                or helper['NetworkNamespacePath'] != ''
                or helper['JoinsNamespaceOf'] != ''
                or helper['TemporaryFileSystem'] != '/proc:ro'
                or helper['BindReadOnlyPaths'] != proc_bind
                or helper['SystemCallFilter'] != '~setns unshare'
                or helper['ProtectProc'] != 'default' or helper['ProcSubset'] != 'all'
                or helper['Restart'] != 'no' or helper['KillMode'] != 'control-group'
                or helper['ProtectSystem'] != 'strict' or helper['ProtectHome'] != 'yes'
                or helper['PrivateTmp'] != 'yes'
                or helper['ProtectKernelTunables'] != 'yes'
                or helper['ProtectKernelModules'] != 'yes'
                or helper['ProtectControlGroups'] != 'yes'
                or helper['RestrictSUIDSGID'] != 'yes'
                or helper['RestrictRealtime'] != 'yes'
                or helper['LockPersonality'] != 'yes'
                or helper['SystemCallArchitectures'] != 'native'
                or helper['TimeoutStartUSec'] != '20s'
                or helper['Environment'] != ''
                or helper['SetLoginEnvironment'] != 'no'
                or helper['UnsetEnvironment'] != unset_environment
                or not re.fullmatch(r'[0-9a-f]{32}', helper['InvocationID'])
                or helper_pid <= 0
                or helper['FragmentPath'] != '/run/systemd/transient/' + unit):
            raise IdentityRecordError('observer unit contract drift')
        # Pin H before reading any of its /proc identity fields.
        helper_pidfd = os.pidfd_open(helper_pid, 0)
        try:
            if not pidfd_is_live(helper_pidfd):
                raise IdentityRecordError('observer exited before acceptance')
            helper_starttime = process_starttime(helper_pid)
            helper_cgroup = process_cgroup(helper_pid)
            if helper_cgroup != helper['ControlGroup']:
                raise IdentityRecordError('observer process cgroup differs from its unit')
            if (os.readlink(f'/proc/{helper_pid}/exe') != OBSERVER_EXECUTABLE
                    or os.readlink(f'/proc/{helper_pid}/cwd') != '/'
                    or host.process_profile(helper_pid) != helper_label):
                raise IdentityRecordError('observer live process identity mismatch')
            if not host.loaded_process_profile(helper_label):
                raise IdentityRecordError('observer profile is not loaded in enforce mode')
            api_after = host.properties(API_UNIT, list(api_before))
            if api_after != api_before or process_starttime(api_pid, proc_fd=api_proc_fd) != api_starttime:
                raise IdentityRecordError('API unit or process changed during observation')
            if not pidfd_is_live(api_pidfd) or process_cgroup(api_pid, proc_fd=api_proc_fd) != api_cgroup:
                raise IdentityRecordError('API process exited or changed cgroup')
            if host.process_profile(api_pid, proc_fd=api_proc_fd) != api_label:
                raise IdentityRecordError('API profile changed during observation')
            api_ns = os.stat(f'/proc/{api_pid}/ns/net')
            helper_ns = os.stat(f'/proc/{helper_pid}/ns/net')
            controller_ns = os.stat('/proc/self/ns/net')
            if {(st.st_dev, st.st_ino) for st in (api_ns, helper_ns, controller_ns)}.__len__() != 1:
                raise IdentityRecordError('API, observer, and controller network namespaces differ')
            record = parse_helper_record(
                record_bytes,
                helper_invocation_id=helper['InvocationID'],
                api_pid=api_pid,
                api_invocation_id=api_before['InvocationID'],
                api_control_group=api_cgroup,
                expected_exe=expected_exe,
                expected_cwd=expected_cwd,
                api_profile_label=api_label,
                listener_required=listener_required,
            )
            if record['api_starttime'] != api_starttime:
                raise IdentityRecordError('observer API start time mismatch')
            if (not pidfd_is_live(helper_pidfd)
                    or process_starttime(helper_pid) != helper_starttime
                    or process_cgroup(helper_pid) != helper_cgroup
                    or host.process_profile(helper_pid) != helper_label
                    or host.process_profile(api_pid, proc_fd=api_proc_fd) != api_label):
                raise IdentityRecordError('observer process changed before record acceptance')
            handed_off = True
        finally:
            os.close(helper_pidfd)
        child.stdin.close()
        remaining = _read_completion_output(child.stdout, 20)
        status = child.wait(timeout=20)
        if remaining or status != 0:
            raise IdentityRecordError('observer completion or output framing failed')
        if host.properties(API_UNIT, list(api_before)) != api_before:
            raise IdentityRecordError('API unit changed before observer completion')
        return record
    finally:
        if child.poll() is None:
            try:
                child.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    host.command(['/usr/bin/systemctl', 'stop', unit], 10)
                finally:
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)
        if not handed_off and child.poll() is None:
            raise IdentityRecordError('observer cleanup could not be confirmed')

def parse_helper_record(data: bytes, *, helper_invocation_id: str,
                        api_pid: int, api_invocation_id: str,
                        api_control_group: str, expected_exe: str,
                        expected_cwd: str, api_profile_label: str,
                        listener_required: bool = True) -> dict:
    """Validate one bounded helper result against C's independent API snapshot."""
    if not isinstance(data, bytes) or len(data) > MAX_RECORD_BYTES:
        raise IdentityRecordError('observer output exceeds its bound')
    if data.count(b'\n') != 1 or not data.endswith(b'\n') or b'\r' in data:
        raise IdentityRecordError('observer output framing is invalid')

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise IdentityRecordError('observer JSON repeats a field')
            result[key] = value
        return result

    def reject_constant(token):
        raise IdentityRecordError('observer JSON uses a non-standard constant')

    try:
        record = json.loads(data[:-1].decode('ascii'), object_pairs_hook=unique_keys,
                            parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise IdentityRecordError('observer output is not valid ASCII JSON') from error
    if not isinstance(record, dict) or set(record) != RECORD_FIELDS:
        raise IdentityRecordError('observer record fields do not match the fixed schema')
    if record['schema'] != 'fg-index.process-identity.helper.v1':
        raise IdentityRecordError('observer schema version mismatch')
    if (not isinstance(helper_invocation_id, str) or not helper_invocation_id
            or record['helper_invocation_id'] != helper_invocation_id):
        raise IdentityRecordError('observer invocation binding mismatch')
    if type(api_pid) is not int or api_pid <= 0 or type(record['api_pid']) is not int:
        raise IdentityRecordError('API PID is invalid')
    expected_identity = {
        'api_pid': api_pid,
        'api_invocation_id': api_invocation_id,
        'api_control_group': api_control_group,
        'api_exe': expected_exe,
        'api_cwd': expected_cwd,
        'api_profile_label': api_profile_label,
    }
    if any(record.get(key) != value for key, value in expected_identity.items()):
        raise IdentityRecordError('observer API identity does not match C snapshot')
    for key in ('helper_invocation_id', 'api_invocation_id',
                'api_control_group', 'api_starttime', 'api_exe', 'api_cwd',
                'api_profile_label'):
        if not isinstance(record.get(key), str) or not record[key]:
            raise IdentityRecordError('observer record has an empty identity field')
    if not record['api_starttime'].isdecimal():
        raise IdentityRecordError('observer start time is malformed')
    for key in ('api_capabilities', 'helper_capabilities'):
        value = record.get(key)
        if (not isinstance(value, dict) or set(value) != CAPABILITY_FIELDS
                or any(not isinstance(mask, str) or len(mask) != 16
                       or any(char not in '0123456789abcdefABCDEF' for char in mask)
                       for mask in value.values())):
            raise IdentityRecordError('observer capability record is malformed')
    if record['helper_capabilities'] != {key: '0000000000000000' for key in CAPABILITY_FIELDS}:
        raise IdentityRecordError('observer process has non-empty capabilities')
    if record['api_capabilities'] != {key: '0000000000000000' for key in CAPABILITY_FIELDS}:
        raise IdentityRecordError('API process has non-empty capabilities')
    inodes = record.get('api_fd_inodes')
    if (not isinstance(inodes, list)
            or any(not isinstance(inode, str) or not inode.isdecimal() for inode in inodes)
            or len(set(inodes)) != len(inodes)):
        raise IdentityRecordError('observer socket inode list is malformed')
    listener = record.get('listener')
    if listener is None:
        if listener_required:
            raise IdentityRecordError('API listener is missing')
    elif (not isinstance(listener, dict)
          or set(listener) != {'address', 'port', 'state', 'inode'}
          or listener.get('address') != '127.0.0.1'
          or type(listener.get('port')) is not int or listener['port'] != 8080
          or listener.get('state') != '0A'
          or not isinstance(listener.get('inode'), str)
          or not listener['inode'].isdecimal()
          or listener['inode'] not in inodes):
        raise IdentityRecordError('observer listener is not uniquely bound to API FD')
    for key in ('pidfd_live', 'argv_ok', 'caller_parameters_absent'):
        if record.get(key) is not True:
            raise IdentityRecordError('observer process/lifecycle assertion failed')
    return record
