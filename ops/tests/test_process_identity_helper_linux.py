"""Linux-only test fixture for the v12.1 API-observation helper contract.

This is a disposable Python fixture, not the production helper. It proves the
zero-capability systemd/AppArmor observation path and stream binding in CI. The
aggregate gate remains HOLD for the native helper and remaining v11 matrix.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import inspect
import shutil
import socket
import subprocess
import tempfile
import textwrap
import time
import unittest
import uuid
from unittest import mock


SYSTEMD = Path('/run/systemd/system')
PYTHON = '/usr/bin/python3.12'
CAPABILITY_FIELDS = ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')
APPARMOR_PROFILES = Path('/sys/kernel/security/apparmor/profiles')
HELPER_RECORD_FIELDS = frozenset({
    'schema', 'helper_invocation_id', 'api_pid', 'api_invocation_id',
    'api_control_group', 'api_starttime', 'api_exe', 'api_cwd',
    'api_profile_label', 'api_capabilities', 'api_fd_inodes', 'listener',
    'pidfd_live', 'helper_capabilities', 'argv_ok', 'caller_parameters_absent',
})


def parse_helper_record_output(
    data, expected_helper_invocation_id, expected_api_pid,
    expected_api_invocation_id, expected_api_control_group,
    expected_exe, expected_cwd, expected_profile_label,
):
    """Parse exactly one bounded, unique-key helper record or reject it."""
    if not isinstance(expected_helper_invocation_id, str) or not expected_helper_invocation_id:
        raise ValueError('trusted helper InvocationID is unavailable')
    if type(expected_api_pid) is not int or expected_api_pid <= 0:
        raise ValueError('trusted API PID is unavailable')
    if any(not isinstance(value, str) or not value for value in (
        expected_api_invocation_id, expected_api_control_group,
        expected_exe, expected_cwd, expected_profile_label,
    )):
        raise ValueError('trusted API identity snapshot is incomplete')
    if not isinstance(data, bytes) or len(data) > 4096:
        raise ValueError('helper output exceeds the 4 KiB limit')
    if data.count(b'\n') != 1 or not data.endswith(b'\n') or b'\r' in data:
        raise ValueError('helper output is not exactly one newline-terminated record')

    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('helper JSON contains a duplicate key')
            result[key] = value
        return result

    def reject_nonstandard_constant(token):
        raise ValueError('helper JSON contains non-standard constant ' + token)

    try:
        record = json.loads(
            data[:-1].decode('ascii'), object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_nonstandard_constant,
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ValueError('helper output is not valid unique-key ASCII JSON') from exc
    if not isinstance(record, dict):
        raise ValueError('helper output is not a JSON object')
    if set(record) != HELPER_RECORD_FIELDS:
        raise ValueError('helper record has missing or unexpected fields')
    if record.get('schema') != 'fg-index.process-identity.helper.v1':
        raise ValueError('helper record schema mismatch')
    text_fields = (
        'helper_invocation_id', 'api_invocation_id', 'api_control_group',
        'api_starttime', 'api_exe', 'api_cwd', 'api_profile_label',
    )
    if any(not isinstance(record.get(key), str) or not record[key] for key in text_fields):
        raise ValueError('helper record contains an empty or non-string identity field')
    if not record['api_starttime'].isdecimal():
        raise ValueError('helper record start time is not decimal')
    if type(record.get('api_pid')) is not int or record['api_pid'] <= 0:
        raise ValueError('helper record API PID is not a positive integer')
    for key in ('api_capabilities', 'helper_capabilities'):
        values = record.get(key)
        if not isinstance(values, dict) or set(values) != set(CAPABILITY_FIELDS):
            raise ValueError('helper record capability fields have an invalid shape')
        if any(
            not isinstance(value, str) or len(value) != 16
            or any(character not in '0123456789abcdefABCDEF' for character in value)
            for value in values.values()
        ):
            raise ValueError('helper record capability mask is invalid')
    fd_inodes = record.get('api_fd_inodes')
    if (
        not isinstance(fd_inodes, list)
        or any(not isinstance(inode, str) or not inode.isdecimal() for inode in fd_inodes)
        or len(set(fd_inodes)) != len(fd_inodes)
    ):
        raise ValueError('helper record FD inode list has an invalid shape')
    listener = record.get('listener')
    if (
        not isinstance(listener, dict)
        or set(listener) != {'address', 'port', 'state', 'inode'}
        or not isinstance(listener.get('address'), str)
        or type(listener.get('port')) is not int
        or not isinstance(listener.get('state'), str)
        or not isinstance(listener.get('inode'), str)
        or not listener['inode'].isdecimal()
    ):
        raise ValueError('helper record listener has an invalid shape')
    if any(type(record.get(key)) is not bool for key in (
        'pidfd_live', 'argv_ok', 'caller_parameters_absent',
    )):
        raise ValueError('helper record boolean fields have an invalid type')
    if record.get('helper_invocation_id') != expected_helper_invocation_id:
        raise ValueError('helper record InvocationID mismatch')
    expected_identity = {
        'api_pid': expected_api_pid,
        'api_invocation_id': expected_api_invocation_id,
        'api_control_group': expected_api_control_group,
        'api_exe': expected_exe,
        'api_cwd': expected_cwd,
        'api_profile_label': expected_profile_label,
    }
    if any(record.get(key) != value for key, value in expected_identity.items()):
        raise ValueError('helper record API identity binding mismatch')
    if (
        record['listener']['address'] != '127.0.0.1'
        or record['listener']['port'] != 8080
        or record['listener']['state'] != '0A'
        or record['listener']['inode'] not in record['api_fd_inodes']
    ):
        raise ValueError('helper record listener binding mismatch')
    return record


class ProcessIdentityHelperOutputTests(unittest.TestCase):
    def setUp(self):
        self.record = {
            'schema': 'fg-index.process-identity.helper.v1',
            'helper_invocation_id': 'helper-invocation-1',
            'api_pid': 123,
            'api_invocation_id': 'api-invocation-1',
            'api_control_group': '/system.slice/api.service',
            'api_starttime': '456',
            'api_exe': PYTHON,
            'api_cwd': '/opt/fg-index',
            'api_profile_label': 'api-profile (enforce)',
            'api_capabilities': {key: '0000000000000000' for key in CAPABILITY_FIELDS},
            'api_fd_inodes': ['98765'],
            'listener': {'address': '127.0.0.1', 'port': 8080, 'state': '0A', 'inode': '98765'},
            'pidfd_live': True,
            'helper_capabilities': {key: '0000000000000000' for key in CAPABILITY_FIELDS},
            'argv_ok': True,
            'caller_parameters_absent': True,
        }
        self.valid = json.dumps(self.record, separators=(',', ':')).encode('ascii') + b'\n'

    def parse(self, output, expected_invocation='helper-invocation-1'):
        return parse_helper_record_output(
            output, expected_invocation, self.record['api_pid'],
            self.record['api_invocation_id'], self.record['api_control_group'],
            self.record['api_exe'], self.record['api_cwd'], self.record['api_profile_label'],
        )

    def assert_rejected(self, output, expected_invocation='helper-invocation-1'):
        with self.assertRaises(ValueError):
            self.parse(output, expected_invocation)

    def test_valid_record_at_exact_4k_limit(self):
        padded = self.valid[:-1] + b' ' * (4096 - len(self.valid)) + b'\n'
        self.assertEqual(4096, len(padded))
        self.assertEqual(
            self.record,
            self.parse(padded, 'helper-invocation-1'),
        )
        embedded_source = (
            'import json\n'
            + f'CAPABILITY_FIELDS = {CAPABILITY_FIELDS!r}\n'
            + f'HELPER_RECORD_FIELDS = {HELPER_RECORD_FIELDS!r}\n'
            + inspect.getsource(parse_helper_record_output)
        )
        namespace = {}
        exec(compile(embedded_source, '<embedded-helper-parser>', 'exec'), namespace)
        self.assertEqual(
            self.record,
            namespace['parse_helper_record_output'](
                self.valid, 'helper-invocation-1', 123, 'api-invocation-1',
                '/system.slice/api.service', PYTHON, '/opt/fg-index', 'api-profile (enforce)',
            ),
        )

    def test_rejects_hostile_record_framing_and_size(self):
        at_limit = self.valid[:-1] + b' ' * (4096 - len(self.valid)) + b'\n'
        cases = {
            'oversize': at_limit[:-1] + b' \n',
            'missing final LF': self.valid[:-1],
            'multiple records': self.valid + self.valid,
            'non-final LF': self.valid[:-1] + b'\n ',
            'blank line': self.valid + b'\n',
            'CRLF terminator': self.valid[:-1] + b'\r\n',
            'second JSON value': self.valid[:-1] + b' {}\n',
        }
        for name, output in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(output)

    def test_rejects_malformed_truncated_and_non_ascii_json(self):
        cases = {
            'malformed': b'{not-json}\n',
            'truncated': b'{"schema":"fg-index.process-identity.helper.v1"\n',
            'non-ascii': self.valid[:-1] + b'\xff\n',
            'deep nesting': b'[' * 1000 + b'0' + b']' * 1000 + b'\n',
        }
        for name, output in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(output)

    def test_rejects_duplicate_top_level_and_nested_json_keys(self):
        duplicate_top = self.valid.replace(
            b'{"schema":', b'{"schema":"duplicate","schema":', 1
        )
        duplicate_nested = self.valid.replace(
            b'"listener":{"address":', b'"listener":{"address":"duplicate","address":', 1
        )
        for name, output in (
            ('top-level', duplicate_top), ('nested', duplicate_nested),
        ):
            with self.subTest(name=name):
                self.assert_rejected(output)

    def test_rejects_non_objects_duplicate_schema_fields_and_non_finite_numbers(self):
        missing = dict(self.record)
        missing.pop('api_pid')
        extra = dict(self.record, unexpected=True)
        non_finite = dict(self.record, api_pid=float('nan'))
        cases = {
            'array': b'[]\n',
            'missing field': json.dumps(missing).encode('ascii') + b'\n',
            'extra field': json.dumps(extra).encode('ascii') + b'\n',
            'NaN': json.dumps(non_finite, separators=(',', ':')).encode('ascii') + b'\n',
            'Infinity': self.valid.replace(b'"api_pid":123', b'"api_pid":Infinity'),
            'nested NaN': self.valid.replace(b'"port":8080', b'"port":NaN'),
            'empty expected invocation': self.valid,
            'stale invocation': self.valid,
        }
        for name, output in cases.items():
            expected = '' if name == 'empty expected invocation' else (
                'prior-invocation' if name == 'stale invocation' else 'helper-invocation-1'
            )
            with self.subTest(name=name):
                self.assert_rejected(output, expected)

    def test_rejects_wrong_scalar_and_nested_field_shapes(self):
        malformed = []
        for field, value in (
            ('api_pid', '123'), ('api_pid', True), ('api_starttime', 456),
            ('helper_invocation_id', []), ('api_capabilities', []),
            ('helper_capabilities', None), ('api_fd_inodes', {}),
            ('listener', []), ('listener', {'address': '127.0.0.1'}),
            ('pidfd_live', 1),
        ):
            changed = dict(self.record)
            changed[field] = value
            malformed.append((field, changed))
        changed = dict(self.record)
        changed['api_capabilities'] = dict(self.record['api_capabilities'], CapEff=0)
        malformed.append(('capability value', changed))
        for name, record in malformed:
            output = json.dumps(record, separators=(',', ':')).encode('ascii') + b'\n'
            with self.subTest(name=name):
                self.assert_rejected(output)

    def test_rejects_api_snapshot_and_identity_mismatches(self):
        for field, value in (
            ('api_pid', 124), ('api_invocation_id', 'prior-invocation'),
            ('api_control_group', '/system.slice/other.service'),
            ('api_exe', '/usr/bin/other'), ('api_cwd', '/tmp'),
            ('api_profile_label', 'unconfined'),
        ):
            changed = dict(self.record, **{field: value})
            output = json.dumps(changed, separators=(',', ':')).encode('ascii') + b'\n'
            with self.subTest(field=field):
                self.assert_rejected(output)
        for name, listener in (
            ('wrong address', dict(self.record['listener'], address='0.0.0.0')),
            ('wrong port', dict(self.record['listener'], port=8081)),
            ('wrong state', dict(self.record['listener'], state='01')),
            ('unmatched inode', dict(self.record['listener'], inode='12345')),
        ):
            changed = dict(self.record, listener=listener)
            output = json.dumps(changed, separators=(',', ':')).encode('ascii') + b'\n'
            with self.subTest(listener=name):
                self.assert_rejected(output)


def systemctl_show(unit, *properties):
    result = subprocess.run(
        ['/usr/bin/systemctl', 'show', unit, *(f'--property={name}' for name in properties)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def load_state(unit):
    result = subprocess.run(
        ['/usr/bin/systemctl', 'show', unit, '--property=LoadState'],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        if 'could not be found' in result.stderr.lower() or 'not loaded' in result.stderr.lower():
            return 'not-found'
        raise RuntimeError(result.stderr.strip())
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line).get(
        'LoadState', 'unknown'
    )


def wait_for_unit_cgroup_empty(unit, expected=False, known_control_group='', timeout=10):
    """Wait for only this fixture unit's systemd cgroup to contain no PIDs."""
    deadline = time.monotonic() + timeout
    while True:
        state = load_state(unit)
        if state == 'not-found':
            cgroup_empty = not expected and not known_control_group
            if known_control_group:
                processes = Path('/sys/fs/cgroup') / known_control_group.lstrip('/') / 'cgroup.procs'
                try:
                    pids = {line for line in processes.read_text(encoding='ascii').splitlines() if line}
                except FileNotFoundError:
                    return True
                cgroup_empty = not pids
            if cgroup_empty:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
            continue
        properties = systemctl_show(
            unit, 'ActiveState', 'MainPID', 'ControlPID', 'ControlGroup'
        )
        stopped = (
            properties.get('ActiveState') in ('inactive', 'failed', 'dead')
            and properties.get('MainPID') == '0'
            and properties.get('ControlPID') == '0'
        )
        control_group = properties.get('ControlGroup', '') or known_control_group
        cgroup_empty = False
        if not control_group:
            cgroup_empty = stopped
        else:
            processes = Path('/sys/fs/cgroup') / control_group.lstrip('/') / 'cgroup.procs'
            try:
                pids = {line for line in processes.read_text(encoding='ascii').splitlines() if line}
            except FileNotFoundError:
                cgroup_empty = stopped
            else:
                cgroup_empty = not pids
        if stopped and cgroup_empty:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def profile_source(role, api_unit=None):
    proc_rules = ''
    dbus_rules = ''
    if role == 'helper':
        if not api_unit:
            raise ValueError('helper profile requires its fixed API unit name')
        api_object = ''.join(
            character if character.isalnum() else f'_{ord(character):02x}'
            for character in api_unit
        )
        proc_rules = '''\
            /proc/[0-9]*/exe r,
            /proc/[0-9]*/cwd r,
            /proc/[0-9]*/stat r,
            /proc/[0-9]*/cgroup r,
            owner /proc/[0-9]*/status r,
            /proc/[0-9]*/attr/current r,
            /proc/[0-9]*/fd/ r,
            /proc/[0-9]*/fd/** r,
            /proc/filesystems r,
            owner /proc/[0-9]*/mounts r,
            /proc/net/tcp r,
            /run/dbus/system_bus_socket rw,
            /usr/bin/systemctl ix,
            network unix stream,
'''
        dbus_rules = f'''\
            dbus send bus=system path=/org/freedesktop/DBus interface=org.freedesktop.DBus member=Hello peer=(name=org.freedesktop.DBus),
            dbus send bus=system path=/org/freedesktop/systemd1 interface=org.freedesktop.systemd1.Manager member=GetUnit peer=(name=org.freedesktop.systemd1),
            dbus send bus=system path=/org/freedesktop/systemd1/unit/{api_object} interface=org.freedesktop.DBus.Properties member=GetAll peer=(name=org.freedesktop.systemd1),
'''
    elif role == 'api':
        proc_rules = '''\
            network inet stream,
'''
    else:
        raise ValueError(role)

    body = '''\
profile PROFILE_NAME flags=(attach_disconnected) {
    /usr/bin/python3.12 rix,
    /usr/lib/python3.12/ r,
    /usr/lib/python3.12/encodings/ r,
    /usr/lib/python3.12/encodings/** r,
    /usr/lib/python3.12/** r,
    /usr/lib/python3.12/lib-dynload/** mr,
    /usr/lib/x86_64-linux-gnu/** mr,
    /lib/x86_64-linux-gnu/** mr,
    /etc/ld.so.cache r,
    /etc/passwd r,
    /etc/group r,
    /etc/nsswitch.conf r,
    /etc/locale.alias r,
    /usr/lib/locale/locale-archive r,
    /usr/lib/locale/C.utf8/LC_CTYPE r,
    /usr/lib/locale/C.utf8/LC_IDENTIFICATION r,
    /usr/share/zoneinfo/Etc/UTC r,
    /opt/fg-index-identity-helper-*/ r,
    /opt/fg-index-identity-helper-*/** r,
    network unix stream,
PROFILE_RULES
PROFILE_DBUS_RULES
}
'''
    return textwrap.dedent(body.replace('PROFILE_RULES', proc_rules).replace('PROFILE_DBUS_RULES', dbus_rules)).replace(
        'PROFILE_NAME', 'fg-index-identity-policy-placeholder'
    )


def profile_name_and_source(role, api_unit=None):
    canonical = profile_source(role, api_unit).encode('utf-8')
    policy_digest = hashlib.sha256(canonical).hexdigest()
    name = f'fg-index-{role}-{policy_digest}'
    generated = profile_source(role, api_unit).replace('fg-index-identity-policy-placeholder', name)
    source_digest = hashlib.sha256(generated.encode('utf-8')).hexdigest()
    return name, policy_digest, source_digest, generated


class ProcessIdentityHelperCleanupTests(unittest.TestCase):
    def test_helper_policy_scopes_dbus_to_reading_the_fixed_api_unit(self):
        api_unit = 'fg-index-identity-helper-api-0123456789ab.service'
        _, _, source_digest, policy = profile_name_and_source('helper', api_unit)
        object_path = '/org/freedesktop/systemd1/unit/' + ''.join(
            character if character.isalnum() else f'_{ord(character):02x}'
            for character in api_unit
        )

        self.assertEqual(source_digest, hashlib.sha256(policy.encode('utf-8')).hexdigest())
        self.assertIn(
            'dbus send bus=system path=/org/freedesktop/DBus '
            'interface=org.freedesktop.DBus member=Hello '
            'peer=(name=org.freedesktop.DBus)',
            policy,
        )
        self.assertIn(
            'dbus send bus=system path=/org/freedesktop/systemd1 '
            'interface=org.freedesktop.systemd1.Manager member=GetUnit '
            'peer=(name=org.freedesktop.systemd1)',
            policy,
        )
        self.assertIn(
            f'dbus send bus=system path={object_path} '
            'interface=org.freedesktop.DBus.Properties member=GetAll '
            'peer=(name=org.freedesktop.systemd1)',
            policy,
        )
        for forbidden in ('dbus send bus=system,', 'member=StartUnit', 'member=StopUnit',
                          'member=RestartUnit'):
            self.assertNotIn(forbidden, policy)

    def test_missing_unexpected_unit_is_clean(self):
        with mock.patch(__name__ + '.load_state', return_value='not-found'):
            self.assertTrue(wait_for_unit_cgroup_empty('fixture.service'))

    def test_missing_expected_unit_without_cgroup_fails_closed(self):
        with (
            mock.patch(__name__ + '.load_state', return_value='not-found'),
            mock.patch(__name__ + '.time.monotonic', side_effect=[0, 2]),
            mock.patch(__name__ + '.time.sleep'),
        ):
            self.assertFalse(wait_for_unit_cgroup_empty('fixture.service', expected=True, timeout=1))

    def test_missing_unit_polls_captured_cgroup_until_empty(self):
        with (
            mock.patch(__name__ + '.load_state', side_effect=['not-found', 'not-found']),
            mock.patch.object(Path, 'read_text', side_effect=['123\n', '']),
            mock.patch(__name__ + '.time.monotonic', side_effect=[0, 0, 0]),
            mock.patch(__name__ + '.time.sleep') as sleep,
        ):
            self.assertTrue(wait_for_unit_cgroup_empty(
                'fixture.service', expected=True, known_control_group='/system.slice/fixture.service'
            ))
        sleep.assert_called_once_with(0.05)

    def test_loaded_unit_requires_stopped_pids_and_empty_cgroup(self):
        with (
            mock.patch(__name__ + '.load_state', return_value='loaded'),
            mock.patch(__name__ + '.systemctl_show', return_value={
                'ActiveState': 'inactive', 'MainPID': '0', 'ControlPID': '0',
                'ControlGroup': '/system.slice/fixture.service',
            }),
            mock.patch.object(Path, 'read_text', return_value=''),
        ):
            self.assertTrue(wait_for_unit_cgroup_empty('fixture.service', expected=True))

    def test_loaded_stopped_unit_with_no_control_group_proves_drain(self):
        with (
            mock.patch(__name__ + '.load_state', return_value='loaded'),
            mock.patch(__name__ + '.systemctl_show', return_value={
                'ActiveState': 'failed', 'MainPID': '0', 'ControlPID': '0', 'ControlGroup': '',
            }),
        ):
            self.assertTrue(wait_for_unit_cgroup_empty('fixture.service', expected=True))

    def test_nonempty_loaded_cgroup_times_out(self):
        with (
            mock.patch(__name__ + '.load_state', return_value='loaded'),
            mock.patch(__name__ + '.systemctl_show', return_value={
                'ActiveState': 'inactive', 'MainPID': '0', 'ControlPID': '0',
                'ControlGroup': '/system.slice/fixture.service',
            }),
            mock.patch.object(Path, 'read_text', return_value='123\n'),
            mock.patch(__name__ + '.time.monotonic', side_effect=[0, 0, 2]),
            mock.patch(__name__ + '.time.sleep'),
        ):
            self.assertFalse(wait_for_unit_cgroup_empty('fixture.service', expected=True, timeout=1))


class ProcessIdentityHelperLinuxTest(unittest.TestCase):
    @unittest.skipUnless(
        os.environ.get('FG_INDEX_REQUIRE_PROCESS_IDENTITY_TEST') == '1',
        'AppArmor helper E2E runs in Linux CI',
    )
    def test_zero_cap_helper_proves_exact_api_identity_with_enforcing_profiles(self):
        self.assertEqual(0, os.geteuid(), 'HOLD: helper E2E requires root systemd fixture control')
        self.assertTrue(SYSTEMD.is_dir(), 'HOLD: systemd runtime unavailable; do not skip helper proof')
        enabled_path = Path('/sys/module/apparmor/parameters/enabled')
        self.assertTrue(enabled_path.is_file(), 'HOLD: AppArmor kernel state unavailable')
        self.assertEqual('Y', enabled_path.read_text().strip(), 'HOLD: AppArmor is not enabled')
        self.assertTrue(APPARMOR_PROFILES.is_file(), 'HOLD: AppArmor profile table unavailable')
        parser = shutil.which('apparmor_parser')
        self.assertIsNotNone(parser, 'HOLD: apparmor_parser unavailable; do not skip')

        suffix = uuid.uuid4().hex[:12]
        api_unit = f'fg-index-identity-helper-api-{suffix}.service'
        controller_unit = f'fg-index-identity-helper-controller-{suffix}.service'
        helper_unit = f'fg-index-identity-helper-check-{suffix}.service'
        api_profile, api_policy_digest, api_source_digest, api_policy = profile_name_and_source('api')
        helper_profile, helper_policy_digest, helper_source_digest, helper_policy = profile_name_and_source(
            'helper', api_unit
        )

        with tempfile.TemporaryDirectory(prefix='fg-index-identity-helper-', dir='/opt') as directory:
            fixture = Path(directory)
            fixture.chmod(0o755)
            api_created = False
            group_created = False
            loaded_profiles = []
            cleanup_errors = []
            expected_units = set()
            captured_control_groups = {}
            api_script = fixture / 'api_fixture.py'
            helper_script = fixture / 'helper_fixture.py'
            controller_script = fixture / 'controller_fixture.py'
            api_policy_path = fixture / 'api.profile'
            helper_policy_path = fixture / 'helper.profile'
            receipt_path = fixture / 'profile-receipt.json'
            api_policy_path.write_text(api_policy, encoding='utf-8')
            helper_policy_path.write_text(helper_policy, encoding='utf-8')
            api_policy_path.chmod(0o600)
            helper_policy_path.chmod(0o600)

            parser_version = subprocess.run(
                [parser, '--version'], check=True, capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            receipt = {
                'api': {
                    'profile': api_profile,
                    'policy_sha256': api_policy_digest,
                    'source_sha256': api_source_digest,
                },
                'helper': {
                    'profile': helper_profile,
                    'policy_sha256': helper_policy_digest,
                    'source_sha256': helper_source_digest,
                },
                'parser': parser_version,
                'kernel': os.uname().release,
                'includes': [],
                'tunables': [],
            }
            receipt_path.write_text(json.dumps(receipt, sort_keys=True), encoding='ascii')
            receipt_path.chmod(0o600)
            self.assertEqual(0, receipt_path.stat().st_uid, 'profile receipt must be root-owned')
            self.assertEqual(api_source_digest, hashlib.sha256(api_policy_path.read_bytes()).hexdigest())
            self.assertEqual(helper_source_digest, hashlib.sha256(helper_policy_path.read_bytes()).hexdigest())

            api_script.write_text(textwrap.dedent(f'''\
                import socket

                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 8080))
                listener.listen(8)
                while True:
                    connection, _ = listener.accept()
                    connection.sendall(b"fixture-ready\\n")
                    connection.close()
            '''), encoding='utf-8')
            api_script.chmod(0o644)

            helper_script.write_text(textwrap.dedent(f'''\
                import ctypes
                import errno
                import json
                import os
                import select
                import socket
                import subprocess
                import sys

                API_UNIT = {api_unit!r}
                FIELDS = {CAPABILITY_FIELDS!r}
                EXPECTED_EXE = {PYTHON!r}
                EXPECTED_CWD = {directory!r}

                def unit_snapshot():
                    raw = subprocess.run(
                        ["/usr/bin/systemctl", "show", API_UNIT,
                         "--property=ActiveState", "--property=SubState", "--property=MainPID",
                         "--property=ControlPID", "--property=NRestarts", "--property=InvocationID",
                         "--property=ControlGroup"],
                        check=True, capture_output=True, text=True, timeout=8,
                    ).stdout
                    return dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)

                def starttime(pid):
                    raw = open(f"/proc/{{pid}}/stat", encoding="ascii").read()
                    return raw.rsplit(")", 1)[1].split()[19]

                def main():
                    if len(sys.argv) != 1 or any(key.startswith("FG_INDEX_API_") for key in os.environ):
                        raise RuntimeError("helper interface received caller parameters")
                    if "INVOCATION_ID" not in os.environ:
                        raise RuntimeError("systemd helper invocation ID missing")
                    if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
                        raise OSError(ctypes.get_errno(), "PR_SET_DUMPABLE failed")
                    before = unit_snapshot()
                    pid = int(before["MainPID"])
                    if (before.get("ActiveState") != "active" or before.get("SubState") != "running"
                            or pid <= 0 or before.get("ControlPID") != "0"
                            or before.get("NRestarts") != "0" or not before.get("InvocationID")):
                        raise RuntimeError("API unit snapshot is not an accepted active invocation")
                    pidfd = os.pidfd_open(pid, 0)
                    poller = select.poll()
                    poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                    if poller.poll(0):
                        raise RuntimeError("API pidfd is not live")
                    cgroup = before["ControlGroup"]
                    start_before = starttime(pid)
                    with open(f"/proc/{{pid}}/cgroup", encoding="ascii") as reader:
                        cgroup_rows = reader.read().splitlines()
                    if not any(row.endswith(cgroup) for row in cgroup_rows):
                        raise RuntimeError("API cgroup does not match the unit snapshot")
                    with open(f"/proc/{{pid}}/status", encoding="ascii") as reader:
                        api_status = dict(line.split(":", 1) for line in reader if ":" in line)
                    api_capabilities = {{key: api_status[key].strip() for key in FIELDS}}
                    exe = os.readlink(f"/proc/{{pid}}/exe")
                    cwd = os.readlink(f"/proc/{{pid}}/cwd")
                    with open(f"/proc/{{pid}}/attr/current", encoding="ascii") as reader:
                        api_profile_label = reader.read().strip()
                    fd_inodes = set()
                    for fd in os.listdir(f"/proc/{{pid}}/fd"):
                        target = os.readlink(f"/proc/{{pid}}/fd/{{fd}}")
                        if target.startswith("socket:[") and target.endswith("]"):
                            fd_inodes.add(target[8:-1])
                    listener_rows = []
                    with open("/proc/net/tcp", encoding="ascii") as reader:
                        next(reader)
                        for line in reader:
                            fields = line.split()
                            address_hex, port_hex = fields[1].split(":", 1)
                            address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
                            port = int(port_hex, 16)
                            if fields[3] == "0A" and address == "127.0.0.1" and port == 8080:
                                listener_rows.append({{"address": address, "port": port,
                                                      "state": fields[3], "inode": fields[9]}})
                    matching = [row for row in listener_rows if row["inode"] in fd_inodes]
                    if len(matching) != 1 or len(listener_rows) != 1:
                        raise RuntimeError("API listener inode correlation is not unique")
                    after = unit_snapshot()
                    start_after = starttime(pid)
                    if (after != before or start_after != start_before
                            or poller.poll(0)):
                        raise RuntimeError("API invocation changed during helper observation")
                    os.close(pidfd)
                    with open("/proc/self/status", encoding="ascii") as reader:
                        self_status = dict(line.split(":", 1) for line in reader if ":" in line)
                    helper_capabilities = {{key: self_status[key].strip() for key in FIELDS}}
                    record = {{
                        "schema": "fg-index.process-identity.helper.v1",
                        "helper_invocation_id": os.environ["INVOCATION_ID"],
                        "api_pid": pid,
                        "api_invocation_id": before["InvocationID"],
                        "api_control_group": cgroup,
                        "api_starttime": start_before,
                        "api_exe": exe,
                        "api_cwd": cwd,
                        "api_profile_label": api_profile_label,
                        "api_capabilities": api_capabilities,
                        "api_fd_inodes": sorted(fd_inodes),
                        "listener": matching[0],
                        "pidfd_live": True,
                        "helper_capabilities": helper_capabilities,
                        "argv_ok": len(sys.argv) == 1,
                        "caller_parameters_absent": not any(key.startswith("FG_INDEX_API_") for key in os.environ),
                    }}
                    print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)
                    extra = sys.stdin.buffer.read(1)
                    if extra:
                        return 86
                    return 0

                raise SystemExit(main())
            '''), encoding='utf-8')
            helper_script.chmod(0o644)
            helper_fixture_digest = hashlib.sha256(helper_script.read_bytes()).hexdigest()
            receipt['helper']['fixture_sha256'] = helper_fixture_digest
            receipt_path.write_text(json.dumps(receipt, sort_keys=True), encoding='ascii')
            receipt_path.chmod(0o600)

            controller_script.write_text(textwrap.dedent(f'''\
                import errno
                import hashlib
                import json
                import os
                import select
                import subprocess
                import tempfile
                import time

                API_UNIT = {api_unit!r}
                HELPER_UNIT = {helper_unit!r}
                CONTROLLER_UNIT = {controller_unit!r}
                HELPER_SCRIPT = {str(helper_script)!r}
                EXPECTED_EXE = {PYTHON!r}
                EXPECTED_CWD = {directory!r}
                API_POLICY_PATH = {str(api_policy_path)!r}
                API_POLICY_SOURCE_SHA256 = {api_source_digest!r}
                API_POLICY_SHA256 = {api_policy_digest!r}
                API_PROFILE = {api_profile!r}
                HELPER_POLICY_SHA256 = {helper_policy_digest!r}
                HELPER_PROFILE = {helper_profile!r}
                RECEIPT_PATH = {str(receipt_path)!r}
                APPARMOR_PARSER = {parser!r}
                APPARMOR_PARSER_VERSION = {parser_version!r}
                KERNEL_RELEASE = {os.uname().release!r}
                HELPER_POLICY_PATH = {str(helper_policy_path)!r}
                HELPER_SOURCE_SHA256 = {helper_source_digest!r}
                HELPER_FIXTURE_SHA256 = {helper_fixture_digest!r}
                CAPABILITY_FIELDS = {CAPABILITY_FIELDS!r}
                HELPER_RECORD_FIELDS = {HELPER_RECORD_FIELDS!r}

                PARSER_SOURCE_PLACEHOLDER

                def readlink(path):
                    try:
                        return {{"value": os.readlink(path)}}
                    except OSError as exc:
                        return {{"errno": errno.errorcode.get(exc.errno, str(exc.errno))}}

                def readtext(path):
                    try:
                        with open(path, encoding="ascii") as reader:
                            return {{"value": reader.read().strip()}}
                    except OSError as exc:
                        return {{"errno": errno.errorcode.get(exc.errno, str(exc.errno))}}

                def show(unit, *properties):
                    raw = subprocess.run(
                        ["/usr/bin/systemctl", "show", unit,
                         *("--property=" + name for name in properties)],
                        check=True, capture_output=True, text=True, timeout=8,
                    ).stdout
                    return dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)

                def capabilities(pid):
                    with open(f"/proc/{{pid}}/status", encoding="ascii") as reader:
                        status = dict(line.split(":", 1) for line in reader if ":" in line)
                    return {{key: status[key].strip() for key in CAPABILITY_FIELDS}}

                def live_profiles():
                    with open("/sys/kernel/security/apparmor/profiles", encoding="ascii") as reader:
                        return reader.read().splitlines()

                def starttime(pid):
                    with open(f"/proc/{{pid}}/stat", encoding="ascii") as reader:
                        return reader.read().rsplit(")", 1)[1].split()[19]

                summary = {{"aggregate_gate": "HOLD", "helper_state": "HOLD", "errors": []}}
                summary["aggregate_pending_gates"] = [
                    "native production helper and controller integration",
                    "API /proc/self and /proc/thread-self access under the exact profile",
                    "same-UID API-to-helper isolation before/after helper dumpability changes",
                    "helper-to-unrelated-same-UID-peer status-read denial",
                    "proc PID/TID/root aliases, descendants, and API exec/exit/PID-reuse races",
                    "foreign-controller rejection and exact listener ambiguity cases",
                    "stale profile/receipt mismatch and loaded-policy freshness negatives",
                    "malformed, duplicate, replayed, oversized, and timeout helper records",
                    "inventory/test of all lifecycle actors, shared lock, and direct manager bypass",
                    "replacement invocation at stop-job acceptance boundary",
                    "required production controller sandbox/context matrix",
                ]
                summary["api_profile_name"] = API_PROFILE
                summary["api_policy_sha256"] = API_POLICY_SHA256
                summary["helper_profile_name"] = HELPER_PROFILE
                summary["helper_policy_sha256"] = HELPER_POLICY_SHA256
                summary["apparmor_parser_version"] = APPARMOR_PARSER_VERSION
                summary["kernel_release"] = KERNEL_RELEASE
                summary["controller_control_group"] = ""
                summary["helper_control_group"] = ""
                controller_before = show(CONTROLLER_UNIT, "ActiveState", "SubState", "MainPID",
                                         "ControlPID", "NRestarts", "InvocationID", "ControlGroup")
                summary["controller_control_group"] = controller_before.get("ControlGroup", "")
                controller_starttime = starttime(os.getpid())
                with open(f"/proc/{{os.getpid()}}/cgroup", encoding="ascii") as reader:
                    controller_cgroup_rows = reader.read().splitlines()
                summary["controller_unit_identity_ok"] = (
                    controller_before.get("ActiveState") == "active"
                    and controller_before.get("SubState") == "running"
                    and controller_before.get("MainPID") == str(os.getpid())
                    and controller_before.get("ControlPID") == "0"
                    and controller_before.get("NRestarts") == "0"
                    and bool(controller_before.get("InvocationID"))
                    and any(row.endswith(controller_before.get("ControlGroup", ""))
                            for row in controller_cgroup_rows)
                )
                self_exe = readlink("/proc/self/exe")
                self_cwd = readlink("/proc/self/cwd")
                with open("/proc/self/status", encoding="ascii") as reader:
                    self_status = dict(line.split(":", 1) for line in reader if ":" in line)
                summary["controller_exe_ok"] = self_exe == {{"value": EXPECTED_EXE}}
                summary["controller_cwd_ok"] = self_cwd == {{"value": EXPECTED_CWD}}
                summary["controller_capabilities"] = {{key: self_status[key].strip() for key in CAPABILITY_FIELDS}}
                api_before = show(API_UNIT, "ActiveState", "SubState", "MainPID", "ControlPID",
                                  "NRestarts", "InvocationID", "ControlGroup", "AppArmorProfile",
                                  "Type", "User", "Group", "CapabilityBoundingSet",
                                  "AmbientCapabilities", "NoNewPrivileges", "Restart",
                                  "RestrictAddressFamilies", "SystemCallFilter", "ProtectSystem",
                                  "ProtectHome", "PrivateDevices", "PrivateTmp")
                api_pid = int(api_before["MainPID"])
                direct_api = {{"exe": readlink(f"/proc/{{api_pid}}/exe"),
                               "cwd": readlink(f"/proc/{{api_pid}}/cwd"),
                               "profile_label": readtext(f"/proc/{{api_pid}}/attr/current"),
                               "fd_errors": []}}
                try:
                    for fd in os.listdir(f"/proc/{{api_pid}}/fd"):
                        os.readlink(f"/proc/{{api_pid}}/fd/{{fd}}")
                except OSError as exc:
                    direct_api["fd_errors"].append(errno.errorcode.get(exc.errno, str(exc.errno)))
                summary["direct_api"] = direct_api
                direct_proc_errors = [
                    (name, value.get("errno"))
                    for name, value in (("exe", direct_api["exe"]), ("cwd", direct_api["cwd"]),
                                        ("attr_current", direct_api["profile_label"]))
                    if value.get("errno")
                ] + [("fd", code) for code in direct_api["fd_errors"]]
                direct_proc_denials = [item for item in direct_proc_errors if item[1] == "EACCES"]
                direct_proc_hard_holds = [item for item in direct_proc_errors if item[1] != "EACCES"]
                summary["direct_a_errors"] = direct_proc_errors
                summary["helper_required"] = bool(direct_proc_denials)
                summary["helper_fallback_selected"] = (
                    summary["helper_required"] and not direct_proc_hard_holds
                )
                summary["api_profile_property_ok"] = api_before.get("AppArmorProfile") == API_PROFILE
                api_denied_syscalls = set(api_before.get("SystemCallFilter", "").lstrip("~").split())
                summary["api_unit_sandbox_properties_ok"] = (
                    api_before.get("Type") == "simple"
                    and api_before.get("User") == "fg-index"
                    and api_before.get("Group") == "fg-index"
                    and api_before.get("CapabilityBoundingSet", "") == ""
                    and api_before.get("AmbientCapabilities", "") == ""
                    and api_before.get("NoNewPrivileges") == "yes"
                    and api_before.get("Restart") == "no"
                    and set(api_before.get("RestrictAddressFamilies", "").split())
                        == {{"AF_UNIX", "AF_INET", "AF_INET6"}}
                    and api_before.get("SystemCallFilter", "").startswith("~")
                    and {{"ptrace", "process_vm_readv", "process_vm_writev",
                         "process_madvise", "pidfd_getfd"}} <= api_denied_syscalls
                    and api_before.get("ProtectSystem") == "strict"
                    and api_before.get("ProtectHome") == "yes"
                    and api_before.get("PrivateDevices") == "yes"
                    and api_before.get("PrivateTmp") == "yes"
                )
                summary["api_live_profile_label_pre_helper_ok"] = (
                    direct_api["profile_label"] == {{"value": API_PROFILE + " (enforce)"}}
                )
                summary["api_live_profile_label_pre_helper"] = direct_api["profile_label"]
                profiles_before_helper = live_profiles()
                summary["api_profile_enforcing_pre_helper"] = API_PROFILE + " (enforce)" in profiles_before_helper
                summary["helper_profile_enforcing_pre_helper"] = HELPER_PROFILE + " (enforce)" in profiles_before_helper
                pre_helper_receipt = json.load(open(RECEIPT_PATH, encoding="ascii"))
                summary["api_profile_receipt_pre_helper_ok"] = (
                    pre_helper_receipt["api"]["profile"] == API_PROFILE
                    and pre_helper_receipt["api"]["policy_sha256"] == API_POLICY_SHA256
                    and pre_helper_receipt["api"]["source_sha256"] == API_POLICY_SOURCE_SHA256
                    and API_PROFILE == "fg-index-api-" + pre_helper_receipt["api"]["policy_sha256"]
                    and pre_helper_receipt["helper"]["profile"] == HELPER_PROFILE
                    and pre_helper_receipt["helper"]["policy_sha256"] == HELPER_POLICY_SHA256
                    and HELPER_PROFILE == "fg-index-helper-" + pre_helper_receipt["helper"]["policy_sha256"]
                    and pre_helper_receipt["parser"] == APPARMOR_PARSER_VERSION
                    and subprocess.run(
                        [APPARMOR_PARSER, "--version"], check=True, capture_output=True,
                        text=True, timeout=10,
                    ).stdout.strip() == APPARMOR_PARSER_VERSION
                    and pre_helper_receipt["kernel"] == KERNEL_RELEASE
                    and pre_helper_receipt["includes"] == []
                    and pre_helper_receipt["tunables"] == []
                    and os.stat(RECEIPT_PATH).st_uid == 0
                    and (os.stat(RECEIPT_PATH).st_mode & 0o777) == 0o600
                    and hashlib.sha256(open(API_POLICY_PATH, "rb").read()).hexdigest()
                        == API_POLICY_SOURCE_SHA256
                    and hashlib.sha256(open(HELPER_POLICY_PATH, "rb").read()).hexdigest()
                        == pre_helper_receipt["helper"]["source_sha256"]
                    and pre_helper_receipt["helper"]["source_sha256"] == HELPER_SOURCE_SHA256
                    and pre_helper_receipt["helper"]["fixture_sha256"] == HELPER_FIXTURE_SHA256
                    and hashlib.sha256(open(HELPER_SCRIPT, "rb").read()).hexdigest()
                        == HELPER_FIXTURE_SHA256
                )
                api_pidfd = os.pidfd_open(api_pid, 0)
                api_poll = select.poll()
                api_poll.register(api_pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                api_confirm_before_helper = show(
                    API_UNIT, "ActiveState", "SubState", "MainPID", "ControlPID",
                    "NRestarts", "InvocationID", "ControlGroup", "AppArmorProfile",
                    "Type", "User", "Group", "CapabilityBoundingSet",
                    "AmbientCapabilities", "NoNewPrivileges", "Restart",
                    "RestrictAddressFamilies", "SystemCallFilter", "ProtectSystem",
                    "ProtectHome", "PrivateDevices", "PrivateTmp",
                )
                summary["api_snapshot_pre_helper_ok"] = (
                    api_confirm_before_helper == api_before
                    and api_before.get("ActiveState") == "active"
                    and api_before.get("SubState") == "running"
                    and api_before.get("ControlPID") == "0"
                    and api_before.get("NRestarts") == "0"
                    and bool(api_before.get("InvocationID"))
                    and bool(api_before.get("ControlGroup"))
                    and api_pid > 0 and api_poll.poll(0) == []
                )
                summary["api_pre_helper_trust_ok"] = all(summary.get(key, False) for key in (
                    "api_profile_property_ok", "api_unit_sandbox_properties_ok",
                    "api_live_profile_label_pre_helper_ok",
                    "api_profile_enforcing_pre_helper", "helper_profile_enforcing_pre_helper",
                    "api_profile_receipt_pre_helper_ok", "api_snapshot_pre_helper_ok",
                )) and summary["helper_fallback_selected"]
                if not summary["api_pre_helper_trust_ok"]:
                    summary["helper_launch_refused"] = True
                    summary["errors"].append(
                        "HOLD: live API identity/profile trust gates or direct-denial fallback are incomplete"
                    )
                    print("API_PRE_HELPER_GATE=HOLD HELPER_LAUNCH=REFUSED", flush=True)
                    print(json.dumps(summary, sort_keys=True), flush=True)
                    raise SystemExit(0)
                helper_cursor_result = subprocess.run(
                    ["/usr/bin/journalctl", "--no-pager", "--show-cursor", "-n", "0"],
                    capture_output=True, text=True, timeout=10,
                )
                helper_journal_cursor = next(
                    (line.removeprefix("-- cursor: ") for line in helper_cursor_result.stdout.splitlines()
                     if line.startswith("-- cursor: ")),
                    None,
                )
                launch = [
                    "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait",
                    "--unit", HELPER_UNIT,
                    "--property=Type=oneshot", "--property=User=fg-index", "--property=Group=fg-index",
                    "--property=AppArmorProfile=" + HELPER_PROFILE,
                    "--property=CapabilityBoundingSet=", "--property=AmbientCapabilities=",
                    "--property=NoNewPrivileges=yes", "--property=ProtectSystem=strict",
                    "--property=ProtectHome=yes", "--property=PrivateTmp=yes",
                    "--property=RestrictAddressFamilies=AF_UNIX", "--property=Restart=no",
                    "--property=SystemCallFilter=~ptrace process_vm_readv process_vm_writev process_madvise pidfd_getfd",
                    "--property=TimeoutStartSec=20s", {PYTHON!r}, "-S", HELPER_SCRIPT,
                ]
                print("API_PRE_HELPER_GATE=PASS HELPER_LAUNCH=ALLOWED", flush=True)
                helper_stderr_file = tempfile.TemporaryFile()
                child = subprocess.Popen(launch, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=helper_stderr_file, bufsize=0)
                data = bytearray()
                deadline = time.monotonic() + 10
                while b"\\n" not in data and len(data) <= 4096:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        summary["errors"].append("helper output timeout")
                        break
                    ready, _, _ = select.select([child.stdout], [], [], remaining)
                    if not ready:
                        summary["errors"].append("helper output timeout")
                        break
                    chunk = os.read(child.stdout.fileno(), min(4097 - len(data), 4097))
                    if not chunk:
                        summary["errors"].append("helper exited before a complete output record")
                        break
                    data.extend(chunk)
                summary["output_bytes"] = len(data)
                summary["bounded_output_ok"] = len(data) <= 4096
                summary["one_record_ok"] = data.count(b"\\n") == 1 and data.endswith(b"\\n")
                helper = {{}}
                try:
                    helper = show(HELPER_UNIT, "MainPID", "InvocationID", "ControlGroup", "LoadState",
                                  "User", "Group", "AppArmorProfile", "CapabilityBoundingSet",
                                  "AmbientCapabilities", "NoNewPrivileges", "Restart", "ExecStart",
                                  "TimeoutStartUSec", "RestrictAddressFamilies", "SystemCallFilter",
                                  "ProtectSystem", "ProtectHome", "PrivateTmp", "FragmentPath")
                except (OSError, KeyError, ValueError, subprocess.SubprocessError) as exc:
                    summary["errors"].append("helper unit snapshot failed: " + str(exc))
                record = None
                try:
                    record = parse_helper_record_output(
                        bytes(data), helper.get("InvocationID", ""), api_pid,
                        api_before.get("InvocationID", ""),
                        api_before.get("ControlGroup", ""), EXPECTED_EXE,
                        EXPECTED_CWD, API_PROFILE + " (enforce)",
                    )
                except ValueError as exc:
                    summary["errors"].append("helper output rejected: " + str(exc))

                helper_pidfd = None
                try:
                    helper_pid = int(helper.get("MainPID", "0"))
                    summary["helper_control_group"] = helper.get("ControlGroup", "")
                    summary["helper_main_pid_valid"] = helper_pid > 0
                    helper_syscall_filter = helper.get("SystemCallFilter", "")
                    helper_denied_syscalls = set(helper_syscall_filter.lstrip("~").split())
                    summary["helper_unit_ok"] = (
                        helper_pid > 0 and helper.get("User") == "fg-index"
                        and helper.get("Group") == "fg-index"
                        and helper.get("AppArmorProfile") == HELPER_PROFILE
                        and helper.get("CapabilityBoundingSet", "") == ""
                        and helper.get("AmbientCapabilities", "") == ""
                        and helper.get("NoNewPrivileges") == "yes"
                        and helper.get("Restart") == "no"
                        and helper.get("TimeoutStartUSec") == "20s"
                        and helper.get("RestrictAddressFamilies") == "AF_UNIX"
                        and helper_syscall_filter.startswith("~")
                        and {{"ptrace", "process_vm_readv", "process_vm_writev",
                             "process_madvise", "pidfd_getfd"}} <= helper_denied_syscalls
                        and helper.get("ProtectSystem") == "strict"
                        and helper.get("ProtectHome") == "yes"
                        and helper.get("PrivateTmp") == "yes"
                        and "/run/systemd/transient/" in helper.get("FragmentPath", "")
                        and HELPER_SCRIPT in helper.get("ExecStart", "")
                    )
                    if helper_pid > 0:
                        helper_caps = capabilities(helper_pid)
                        summary["helper_capabilities"] = helper_caps
                        summary["helper_capabilities_zero"] = all(value == "0000000000000000" for value in helper_caps.values())
                        label_path = f"/proc/{{helper_pid}}/attr/current"
                        try:
                            helper_label = open(label_path, encoding="ascii").read().strip()
                            summary["helper_live_label"] = helper_label
                            summary["helper_live_label_ok"] = helper_label == HELPER_PROFILE + " (enforce)"
                        except OSError as exc:
                            summary["helper_live_label_errno"] = errno.errorcode.get(exc.errno, str(exc.errno))
                            summary["helper_live_label_ok"] = False
                        helper_pidfd = os.pidfd_open(helper_pid, 0)
                        helper_poll = select.poll()
                        helper_poll.register(helper_pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                        summary["helper_pidfd_live"] = helper_poll.poll(0) == []
                    else:
                        summary["helper_capabilities"] = {{}}
                        summary["helper_capabilities_zero"] = False
                        summary["helper_live_label_ok"] = False
                        summary["helper_pidfd_live"] = False
                    profiles = live_profiles()
                    summary["helper_profile_enforcing"] = HELPER_PROFILE + " (enforce)" in profiles
                    summary["api_profile_enforcing"] = API_PROFILE + " (enforce)" in profiles
                    receipt = json.load(open(RECEIPT_PATH, encoding="ascii"))
                    summary["profile_receipt_ok"] = (
                        receipt["helper"]["profile"] == HELPER_PROFILE
                        and receipt["helper"]["policy_sha256"] == HELPER_POLICY_SHA256
                        and HELPER_PROFILE == "fg-index-helper-" + receipt["helper"]["policy_sha256"]
                        and receipt["helper"]["source_sha256"] == HELPER_SOURCE_SHA256
                        and receipt["api"]["policy_sha256"] == API_POLICY_SHA256
                        and receipt["parser"] == APPARMOR_PARSER_VERSION
                        and receipt["kernel"] == KERNEL_RELEASE
                        and receipt["includes"] == []
                        and receipt["tunables"] == []
                        and subprocess.run(
                            [APPARMOR_PARSER, "--version"], check=True, capture_output=True,
                            text=True, timeout=10,
                        ).stdout.strip() == APPARMOR_PARSER_VERSION
                        and receipt["helper"]["fixture_sha256"] == HELPER_FIXTURE_SHA256
                        and os.stat(RECEIPT_PATH).st_uid == 0
                        and (os.stat(RECEIPT_PATH).st_mode & 0o777) == 0o600
                        and hashlib.sha256(open(HELPER_POLICY_PATH, "rb").read()).hexdigest()
                            == HELPER_SOURCE_SHA256
                        and hashlib.sha256(open(HELPER_SCRIPT, "rb").read()).hexdigest()
                            == HELPER_FIXTURE_SHA256
                    )
                    if record is not None:
                        summary["schema_ok"] = set(record) == HELPER_RECORD_FIELDS
                        summary["invocation_binding_ok"] = (
                            record.get("helper_invocation_id") == helper.get("InvocationID")
                        )
                        summary["api_snapshot_binding_ok"] = (
                            record.get("api_pid") == api_pid
                            and record.get("api_invocation_id") == api_before.get("InvocationID")
                            and record.get("api_control_group") == api_before.get("ControlGroup")
                            and isinstance(record.get("api_starttime"), str)
                            and record["api_starttime"].isdecimal()
                            and record.get("pidfd_live") is True
                        )
                        summary["api_identity_ok"] = (
                            record.get("api_exe") == EXPECTED_EXE
                            and record.get("api_cwd") == EXPECTED_CWD
                            and record.get("pidfd_live") is True
                            and record.get("listener") == {{"address": "127.0.0.1", "port": 8080,
                                                              "state": "0A", "inode": record.get("listener", {{}}).get("inode")}}
                            and record.get("listener", {{}}).get("inode") in record.get("api_fd_inodes", [])
                        )
                        summary["api_live_profile_label_ok"] = (
                            record.get("api_profile_label") == API_PROFILE + " (enforce)"
                        )
                        summary["helper_interface_ok"] = record.get("argv_ok") is True and record.get("caller_parameters_absent") is True
                        summary["helper_self_capability_record_ok"] = all(
                            record.get("helper_capabilities", {{}}).get(key) == "0000000000000000"
                            for key in CAPABILITY_FIELDS
                        )
                        summary["api_capability_record_ok"] = all(
                            record.get("api_capabilities", {{}}).get(key) == "0000000000000000"
                            for key in CAPABILITY_FIELDS
                        )
                    else:
                        summary["schema_ok"] = False
                        summary["invocation_binding_ok"] = False
                        summary["api_snapshot_binding_ok"] = False
                        summary["api_identity_ok"] = False
                        summary["api_live_profile_label_ok"] = False
                        summary["helper_interface_ok"] = False
                        summary["helper_self_capability_record_ok"] = False
                        summary["api_capability_record_ok"] = False

                    extra_ready, _, _ = select.select([child.stdout], [], [], 0.05)
                    summary["extra_output_absent"] = not extra_ready
                    api_after = show(API_UNIT, "ActiveState", "SubState", "MainPID", "ControlPID",
                                     "NRestarts", "InvocationID", "ControlGroup", "AppArmorProfile",
                                     "Type", "User", "Group", "CapabilityBoundingSet",
                                     "AmbientCapabilities", "NoNewPrivileges", "Restart",
                                     "RestrictAddressFamilies", "SystemCallFilter", "ProtectSystem",
                                     "ProtectHome", "PrivateDevices", "PrivateTmp")
                    summary["api_snapshot_stable"] = api_after == api_before and api_poll.poll(0) == []
                    api_label_after = readtext(f"/proc/{{api_pid}}/attr/current")
                    summary["api_profile_label_stable"] = (
                        api_label_after == direct_api["profile_label"]
                        and api_label_after == {{"value": API_PROFILE + " (enforce)"}}
                    )
                    summary["helper_live_checks_ok"] = all(summary.get(key, False) for key in (
                        "helper_unit_ok", "helper_capabilities_zero", "helper_live_label_ok",
                        "helper_profile_enforcing", "api_profile_enforcing", "api_profile_property_ok",
                        "api_live_profile_label_ok", "profile_receipt_ok",
                        "api_pre_helper_trust_ok", "api_profile_label_stable",
                        "helper_pidfd_live", "schema_ok", "invocation_binding_ok",
                        "api_snapshot_binding_ok", "api_identity_ok", "helper_interface_ok",
                        "helper_self_capability_record_ok", "extra_output_absent", "api_snapshot_stable",
                        "api_capability_record_ok",
                        "controller_unit_identity_ok",
                    ))
                    if not summary["helper_live_checks_ok"]:
                        summary["errors"].append("helper live identity/profile/result validation failed")
                    if not summary.get("helper_main_pid_valid") or not summary.get("one_record_ok"):
                        diagnostic_args = ["/usr/bin/journalctl", "--no-pager"]
                        if helper_journal_cursor:
                            diagnostic_args.append("--after-cursor=" + helper_journal_cursor)
                        helper_status = subprocess.run(
                            ["/usr/bin/systemctl", "status", "--no-pager", "--full", HELPER_UNIT],
                            capture_output=True, text=True, timeout=10,
                        )
                        helper_properties = subprocess.run(
                            ["/usr/bin/systemctl", "show", HELPER_UNIT,
                             "--property=LoadState", "--property=ActiveState", "--property=SubState",
                             "--property=Result", "--property=ExecMainCode", "--property=ExecMainStatus",
                             "--property=StatusText", "--property=MainPID", "--property=ControlPID",
                             "--property=InvocationID", "--property=ControlGroup", "--property=ExecStart"],
                            capture_output=True, text=True, timeout=10,
                        )
                        helper_unit_journal = subprocess.run(
                            [*diagnostic_args, "--unit=" + HELPER_UNIT, "-n", "100"],
                            capture_output=True, text=True, timeout=10,
                        )
                        kernel_args = list(diagnostic_args)
                        kernel_args.extend(["-k", "-n", "200"])
                        helper_kernel_journal = subprocess.run(
                            kernel_args, capture_output=True, text=True, timeout=10,
                        )
                        helper_audit_lines = [
                            line for line in helper_kernel_journal.stdout.splitlines()
                            if "apparmor=" in line.lower()
                            or API_PROFILE in line
                            or HELPER_PROFILE in line
                        ]
                        helper_stderr_file.seek(0, 2)
                        stderr_size = helper_stderr_file.tell()
                        helper_stderr_file.seek(max(0, stderr_size - 8000))
                        helper_stderr = helper_stderr_file.read(8000).decode("utf-8", "replace")
                        summary["helper_diagnostics"] = (
                            "SYSTEMD_RUN_STDERR:\\n" + helper_stderr
                            + "\\nHELPER_UNIT_PROPERTIES:\\n" + helper_properties.stdout[-8000:]
                            + "\\nHELPER_UNIT_STATUS:\\n" + helper_status.stdout[-8000:]
                            + helper_status.stderr[-1000:]
                            + "\\nHELPER_UNIT_JOURNAL:\\n" + helper_unit_journal.stdout[-8000:]
                            + "\\nAPPARMOR_KERNEL_AUDIT:\\n"
                            + ("\\n".join(helper_audit_lines)[-8000:] if helper_audit_lines else
                               "no matching AppArmor/kernel audit lines since helper launch")
                            + "\\nJOURNAL_ERRORS:\\n"
                            + helper_cursor_result.stderr[-1000:]
                            + helper_unit_journal.stderr[-1000:]
                            + helper_kernel_journal.stderr[-1000:]
                        )
                except (OSError, KeyError, ValueError, subprocess.SubprocessError) as exc:
                    summary["errors"].append("controller helper validation failed: " + str(exc))
                    summary["helper_live_checks_ok"] = False
                finally:
                    if child.stdin and not child.stdin.closed:
                        child.stdin.close()
                    try:
                        child.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                        summary["errors"].append("helper runner timeout after EOF")

                trailing_output = child.stdout.read(4097) if child.stdout else b""
                summary["post_eof_output_absent"] = not trailing_output
                summary["bounded_output_ok"] = (
                    summary.get("bounded_output_ok", False)
                    and len(data) + len(trailing_output) <= 4096
                )

                summary["helper_exit_zero"] = child.returncode == 0
                try:
                    controller_after = show(CONTROLLER_UNIT, "ActiveState", "SubState", "MainPID",
                                            "ControlPID", "NRestarts", "InvocationID", "ControlGroup")
                    api_after = show(API_UNIT, "ActiveState", "SubState", "MainPID", "ControlPID",
                                     "NRestarts", "InvocationID", "ControlGroup", "AppArmorProfile",
                                     "Type", "User", "Group", "CapabilityBoundingSet",
                                     "AmbientCapabilities", "NoNewPrivileges", "Restart",
                                     "RestrictAddressFamilies", "SystemCallFilter", "ProtectSystem",
                                     "ProtectHome", "PrivateDevices", "PrivateTmp")
                    summary["api_final_snapshot_stable"] = api_after == api_before and api_poll.poll(0) == []
                    summary["controller_final_snapshot_stable"] = (
                        controller_after == controller_before
                        and starttime(os.getpid()) == controller_starttime
                    )
                except Exception as exc:
                    summary["api_final_snapshot_stable"] = False
                    summary["controller_final_snapshot_stable"] = False
                    summary["errors"].append("API final snapshot failed: " + str(exc))
                os.close(api_pidfd)
                if helper_pidfd is not None:
                    os.close(helper_pidfd)
                helper_stderr_file.close()
                summary["helper_state"] = (
                    "PASS" if summary.get("helper_live_checks_ok") and summary.get("helper_exit_zero")
                    and summary.get("api_final_snapshot_stable")
                    and summary.get("controller_final_snapshot_stable")
                    and summary.get("post_eof_output_absent")
                    and summary.get("bounded_output_ok") else "HOLD"
                )
                print(json.dumps(summary, sort_keys=True), flush=True)
            ''').replace(
                'PARSER_SOURCE_PLACEHOLDER', inspect.getsource(parse_helper_record_output)
            ), encoding='utf-8')
            controller_script.chmod(0o644)

            try:
                try:
                    pwd.getpwnam('fg-index')
                    grp.getgrnam('fg-index')
                except KeyError:
                    subprocess.run(
                        ['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                         '--shell', '/usr/sbin/nologin', 'fg-index'],
                        check=True, capture_output=True, timeout=10,
                    )
                    api_created = True
                    group_created = True

                for role, path in (('api', api_policy_path), ('helper', helper_policy_path)):
                    loaded = subprocess.run(
                        [parser, '-r', '-W', str(path)],
                        capture_output=True, text=True, timeout=15,
                    )
                    self.assertEqual(0, loaded.returncode,
                                     f'HOLD: AppArmor {role} policy load failed: {loaded.stderr}')
                    loaded_profiles.append((role, path))
                profiles = APPARMOR_PROFILES.read_text(encoding='ascii').splitlines()
                self.assertIn(api_profile + ' (enforce)', profiles, 'HOLD: API profile not enforcing')
                self.assertIn(helper_profile + ' (enforce)', profiles, 'HOLD: helper profile not enforcing')

                start_api = [
                    '/usr/bin/systemd-run', '--quiet', '--unit', api_unit,
                    '--property=Type=simple', '--property=User=fg-index', '--property=Group=fg-index',
                    '--property=WorkingDirectory=' + directory,
                    '--property=AppArmorProfile=' + api_profile,
                    '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                    '--property=NoNewPrivileges=yes', '--property=SystemCallFilter=~ptrace process_vm_readv process_vm_writev process_madvise pidfd_getfd',
                    '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
                    '--property=PrivateDevices=yes', '--property=PrivateTmp=yes',
                    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                    '--property=RuntimeMaxSec=30s', PYTHON, '-S', str(api_script),
                ]
                cursor_result = subprocess.run(
                    ['/usr/bin/journalctl', '--no-pager', '--show-cursor', '-n', '0'],
                    capture_output=True, text=True, timeout=10,
                )
                journal_cursor = next(
                    (line.removeprefix('-- cursor: ') for line in cursor_result.stdout.splitlines()
                     if line.startswith('-- cursor: ')),
                    None,
                )
                api_launch = subprocess.run(start_api, capture_output=True, text=True, timeout=15)
                self.assertEqual(
                    0, api_launch.returncode,
                    'HOLD: systemd rejected the AppArmor API fixture\n'
                    + api_launch.stdout + api_launch.stderr,
                )
                expected_units.add(api_unit)
                captured_control_groups[api_unit] = systemctl_show(api_unit, 'ControlGroup').get(
                    'ControlGroup', ''
                )
                api_ready = False
                deadline = time.monotonic() + 10
                while not api_ready:
                    try:
                        with socket.create_connection(('127.0.0.1', 8080), timeout=0.25) as connection:
                            connection.settimeout(1)
                            response = bytearray()
                            while len(response) <= 64 and not response.endswith(b'\n'):
                                chunk = connection.recv(65 - len(response))
                                if not chunk:
                                    break
                                response.extend(chunk)
                            api_ready = bytes(response) == b'fixture-ready\n'
                    except OSError:
                        pass
                    if not api_ready:
                        if time.monotonic() >= deadline:
                            status = subprocess.run(
                                ['/usr/bin/systemctl', 'status', '--no-pager', api_unit],
                                capture_output=True, text=True, timeout=10,
                            )
                            unit_properties = subprocess.run(
                                ['/usr/bin/systemctl', 'show', api_unit],
                                capture_output=True, text=True, timeout=10,
                            )
                            journal_args = ['/usr/bin/journalctl', '--no-pager']
                            if journal_cursor:
                                journal_args.append('--after-cursor=' + journal_cursor)
                            unit_journal = subprocess.run(
                                [*journal_args, '--unit=' + api_unit, '-n', '100'],
                                capture_output=True, text=True, timeout=10,
                            )
                            kernel_journal = subprocess.run(
                                [*journal_args, '-k', '-n', '200'],
                                capture_output=True, text=True, timeout=10,
                            )
                            audit_lines = [
                                line for line in kernel_journal.stdout.splitlines()
                                if 'apparmor=' in line.lower()
                                or api_profile in line
                                or helper_profile in line
                            ]
                            diagnostics = (
                                '\nSYSTEMD_RUN_STDOUT:\n' + api_launch.stdout[-4000:]
                                + '\nSYSTEMD_RUN_STDERR:\n' + api_launch.stderr[-4000:]
                                + '\nAPI_UNIT_PROPERTIES:\n' + unit_properties.stdout[-8000:]
                                + '\nAPI_UNIT_STATUS:\n' + status.stdout[-8000:] + status.stderr[-2000:]
                                + '\nAPI_UNIT_JOURNAL:\n' + unit_journal.stdout[-8000:]
                                + '\nAPPARMOR_KERNEL_AUDIT:\n'
                                + ('\n'.join(audit_lines)[-8000:] if audit_lines else
                                   'no matching AppArmor/kernel audit lines since fixture start')
                                + '\nJOURNAL_ERRORS:\n'
                                + cursor_result.stderr[-1000:] + unit_journal.stderr[-1000:]
                                + kernel_journal.stderr[-1000:]
                            )
                            self.fail('HOLD: API fixture failed under enforcing AppArmor\n'
                                      + diagnostics)
                        time.sleep(0.1)
                self.assertTrue(api_ready, 'HOLD: API fixture readiness marker was not received')

                controller = [
                    '/usr/bin/systemd-run', '--quiet', '--pipe', '--wait',
                    '--unit', controller_unit,
                    '--property=Type=simple', '--property=User=root',
                    '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                    '--property=NoNewPrivileges=yes', '--property=WorkingDirectory=' + directory,
                    '--property=ProtectHome=read-only', '--property=PrivateTmp=yes',
                    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                    '--property=RuntimeMaxSec=45s', PYTHON, '-S', str(controller_script),
                ]
                expected_units.update((controller_unit, helper_unit))
                result = subprocess.run(controller, stdin=subprocess.DEVNULL, capture_output=True,
                                        text=True, timeout=55)
                lines = [line for line in result.stdout.splitlines() if line.strip()]
                for line in reversed(lines):
                    try:
                        controller_summary = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(controller_summary, dict):
                        captured_control_groups[controller_unit] = controller_summary.get(
                            'controller_control_group', ''
                        )
                        captured_control_groups[helper_unit] = controller_summary.get(
                            'helper_control_group', ''
                        )
                        break
                self.assertEqual(0, result.returncode, result.stderr + result.stdout)
                self.assertEqual(2, len(lines), result.stdout)
                summary = json.loads(lines[-1])
                self.assertEqual('API_PRE_HELPER_GATE=PASS HELPER_LAUNCH=ALLOWED', lines[0], result.stdout)
                print('HELPER_E2E_SUMMARY=' + json.dumps(summary, sort_keys=True))
                print('HELPER_E2E_AGGREGATE_GATE=' + summary.get('aggregate_gate', 'HOLD'))
                self.assertTrue(summary.get('controller_exe_ok'), summary)
                self.assertTrue(summary.get('controller_cwd_ok'), summary)
                self.assertTrue(
                    all(value == '0000000000000000' for value in summary.get('controller_capabilities', {}).values()),
                    summary,
                )
                self.assertEqual('PASS', summary.get('helper_state'), summary)
                self.assertTrue(summary.get('helper_required'), summary)
                self.assertEqual('HOLD', summary.get('aggregate_gate'), summary)
            finally:
                fixture_cgroups_empty = True
                for unit in (helper_unit, controller_unit, api_unit):
                    try:
                        state = load_state(unit)
                        if state == 'loaded':
                            active = systemctl_show(unit, 'ActiveState').get('ActiveState')
                            if active in ('active', 'activating', 'reloading', 'deactivating'):
                                subprocess.run(
                                    ['/usr/bin/systemctl', 'stop', unit],
                                    check=True, capture_output=True, timeout=15,
                                )
                        elif state != 'not-found':
                            fixture_cgroups_empty = False
                            cleanup_errors.append(f'fixture unit state is unknown: {unit} ({state})')
                        if not wait_for_unit_cgroup_empty(
                            unit,
                            expected=unit in expected_units,
                            known_control_group=captured_control_groups.get(unit, ''),
                        ):
                            fixture_cgroups_empty = False
                            cleanup_errors.append(f'fixture cgroup did not empty: {unit}')
                        if state == 'loaded':
                            subprocess.run(
                                ['/usr/bin/systemctl', 'reset-failed', unit],
                                check=True, capture_output=True, timeout=15,
                            )
                    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                        fixture_cgroups_empty = False
                        cleanup_errors.append(f'stop {unit}: {exc}')
                if fixture_cgroups_empty:
                    for role, path in reversed(loaded_profiles):
                        try:
                            subprocess.run(
                                [parser, '-R', str(path)], check=True,
                                capture_output=True, timeout=15,
                            )
                        except (OSError, subprocess.SubprocessError) as exc:
                            cleanup_errors.append(f'unload AppArmor {role} profile: {exc}')
                elif loaded_profiles:
                    cleanup_errors.append(
                        'retained AppArmor fixture profiles because a fixture cgroup is not proven empty'
                    )
                if api_created and fixture_cgroups_empty:
                    try:
                        subprocess.run(
                            ['/usr/sbin/userdel', 'fg-index'], check=True,
                            capture_output=True, timeout=10,
                        )
                    except (OSError, subprocess.SubprocessError) as exc:
                        cleanup_errors.append(f'userdel fg-index: {exc}')
                if group_created and fixture_cgroups_empty:
                    try:
                        grp.getgrnam('fg-index')
                    except KeyError:
                        pass
                    else:
                        try:
                            subprocess.run(
                                ['/usr/sbin/groupdel', 'fg-index'], check=True,
                                capture_output=True, timeout=10,
                            )
                        except (OSError, subprocess.SubprocessError) as exc:
                            cleanup_errors.append(f'groupdel fg-index: {exc}')
                if cleanup_errors:
                    raise RuntimeError('helper fixture cleanup failed: ' + '; '.join(cleanup_errors))


if __name__ == '__main__':
    unittest.main()
