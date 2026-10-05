"""Linux kernel-permission characterization for root C and non-dumpable fg-index H.

This is deliberately not production acceptance: it uses the loaded unconfined
AppArmor profile to isolate the UID/capability/dumpability boundary. A denial
of any controller read required by process_identity.py is a HOLD for the current
architecture. The aggregate identity workflow remains HOLD independently.

The namespace path is especially relevant: Linux fs/proc/namespaces.c applies
ptrace_may_access(PTRACE_MODE_READ_FSCREDS) during both link following and
readlink; kernel/ptrace.c checks credentials/capability and dumpability before
the LSM hook.
"""
import json
import os
from pathlib import Path
import pwd
import grp
import select
import shutil
import subprocess
import tempfile
import textwrap
import time
import unittest
import uuid


SYSTEMD = Path('/run/systemd/system')
SYSTEMCTL = '/usr/bin/systemctl'
SYSTEMD_RUN = '/usr/bin/systemd-run'
PYTHON = '/usr/bin/python3.12'
GCC = shutil.which('gcc')
API_USER = 'fg-index'
API_GROUP = 'fg-index'
HELPER_SOURCE = Path('ops/tests/fixtures/process_identity_nondumpable_helper.c')
HELPER_PROFILE_ENV = 'FG_INDEX_TEST_HELPER_PROFILE'
CONTROLLER_PROFILE_ENV = 'FG_INDEX_TEST_CONTROLLER_PROFILE'


def systemctl_show(unit, *properties):
    result = subprocess.run(
        [SYSTEMCTL, 'show', unit, *(f'--property={name}' for name in properties)],
        check=True, capture_output=True, text=True, timeout=10,
    )
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def load_state(unit):
    result = subprocess.run(
        [SYSTEMCTL, 'show', unit, '--property=LoadState'],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        if 'could not be found' in result.stderr.lower() or 'not loaded' in result.stderr.lower():
            return 'not-found'
        raise RuntimeError(result.stderr.strip())
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line).get(
        'LoadState', 'unknown'
    )


def cgroup_empty(unit, known_control_group, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if load_state(unit) == 'not-found':
            if not known_control_group:
                return True
            path = Path('/sys/fs/cgroup') / known_control_group.lstrip('/')
            try:
                return not (path / 'cgroup.procs').read_text().split()
            except FileNotFoundError:
                return True
        props = systemctl_show(unit, 'ActiveState', 'MainPID', 'ControlPID', 'ControlGroup')
        cgroup = props.get('ControlGroup') or known_control_group
        stopped = props.get('ActiveState') in ('inactive', 'failed', 'dead')
        stopped = stopped and props.get('MainPID') == '0' and props.get('ControlPID') == '0'
        if not cgroup:
            if stopped:
                return True
        else:
            path = Path('/sys/fs/cgroup') / cgroup.lstrip('/')
            try:
                empty = not (path / 'cgroup.procs').read_text().split()
            except FileNotFoundError:
                empty = stopped
            if stopped and empty:
                return True
        time.sleep(0.05)
    return False


def wait_line(stream, timeout=10):
    deadline = time.monotonic() + timeout
    result = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([stream], [], [], 0.1)
        if not ready:
            continue
        chunk = os.read(stream.fileno(), 4096)
        if not chunk:
            break
        result.extend(chunk)
        if b'\n' in result:
            return bytes(result).split(b'\n', 1)[0]
    raise RuntimeError(f'HOLD: unit emitted no complete probe record: {bytes(result)!r}')


class ProcessIdentityDumpabilityLinuxTest(unittest.TestCase):
    @unittest.skipUnless(
        os.environ.get('FG_INDEX_REQUIRE_PROCESS_IDENTITY_BOUNDARY_TEST') == '1',
        'root systemd Linux boundary probe runs in CI',
    )
    def test_root_empty_cap_controller_cannot_assume_non_dumpable_helper_reads(self):
        self.assertEqual('Linux', os.uname().sysname, 'HOLD: Linux required')
        self.assertEqual(0, os.geteuid(), 'HOLD: root systemd fixture control required')
        self.assertTrue(SYSTEMD.is_dir(), 'HOLD: systemd runtime unavailable')
        self.assertTrue(Path('/sys/fs/cgroup/cgroup.controllers').is_file(),
                        'HOLD: cgroup v2 required')
        self.assertTrue(Path(HELPER_SOURCE).is_file(), 'HOLD: helper fixture source is missing')
        self.assertTrue(GCC, 'HOLD: GCC/glibc Linux toolchain required')

        helper_profile = os.environ.get(HELPER_PROFILE_ENV, '')
        controller_profile = os.environ.get(CONTROLLER_PROFILE_ENV, '')
        self.assertTrue(helper_profile, f'HOLD: {HELPER_PROFILE_ENV} is required')
        self.assertTrue(controller_profile, f'HOLD: {CONTROLLER_PROFILE_ENV} is required')
        self.assertEqual('unconfined', helper_profile,
                         'HOLD: this fixture is only the unconfined kernel-boundary characterization')
        self.assertEqual('unconfined', controller_profile,
                         'HOLD: this fixture is only the unconfined kernel-boundary characterization')

        try:
            grp.getgrnam(API_GROUP)
            created_group = False
        except KeyError:
            subprocess.run(['/usr/sbin/groupadd', '--system', API_GROUP], check=True,
                           capture_output=True, timeout=10)
            created_group = True
        try:
            account = pwd.getpwnam(API_USER)
            created_user = False
        except KeyError:
            subprocess.run([
                '/usr/sbin/useradd', '--system', '--no-create-home', '--gid', API_GROUP,
                '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', API_USER,
            ], check=True, capture_output=True, timeout=10)
            created_user = True
            account = pwd.getpwnam(API_USER)
        group = grp.getgrnam(API_GROUP)

        suffix = uuid.uuid4().hex[:12]
        helper_unit = f'fg-index-boundary-helper-{suffix}.service'
        controller_unit = f'fg-index-boundary-controller-{suffix}.service'
        units = (controller_unit, helper_unit)
        known_cgroups = {}
        failures = []
        controller = None
        helper = None

        directory = tempfile.mkdtemp(prefix='fg-index-boundary-', dir='/opt')
        fixture = Path(directory)
        fixture.chmod(0o755)
        helper_binary = fixture / 'non-dumpable-helper'
        subprocess.run([
            GCC, '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
            '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
            '-Wl,-z,relro,-z,now', '-Wl,-z,noexecstack',
            str(HELPER_SOURCE), '-o', str(helper_binary),
        ], check=True, capture_output=True, timeout=30)
        helper_binary.chmod(0o755)

        probe_script = fixture / 'controller_probe.py'
        probe_script.write_text(textwrap.dedent('''\
            import errno
            import json
            import os
            import sys

            pid = int(sys.argv[1])
            ns_fd = int(sys.argv[2])
            root = f'/proc/{pid}'
            targets = {
                'ns_net': root + '/ns/net',
                'exe': root + '/exe',
                'cwd': root + '/cwd',
                'attr_current': root + '/attr/current',
                'retained_ns_fd': root + f'/fd/{ns_fd}',
                'retained_ns_fdinfo': root + f'/fdinfo/{ns_fd}',
            }
            def attempt(path, operation):
                try:
                    if operation == 'stat':
                        info = os.stat(path)
                        return {'result': 'allowed', 'inode': info.st_ino}
                    if operation == 'readlink':
                        return {'result': 'allowed', 'target': os.readlink(path)}
                    if operation == 'read':
                        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
                        try:
                            raw = os.read(fd, 256)
                        finally:
                            os.close(fd)
                        return {'result': 'allowed', 'bytes': len(raw)}
                    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
                    try:
                        return {'result': 'allowed', 'mode': os.fstat(fd).st_mode}
                    finally:
                        os.close(fd)
                except OSError as exc:
                    return {'result': 'denied', 'errno': errno.errorcode.get(exc.errno, str(exc.errno))}
            cases = {
                'ns_stat': attempt(targets['ns_net'], 'stat'),
                'ns_readlink': attempt(targets['ns_net'], 'readlink'),
                'ns_open': attempt(targets['ns_net'], 'open'),
                'exe_stat': attempt(targets['exe'], 'stat'),
                'exe_readlink': attempt(targets['exe'], 'readlink'),
                'exe_open': attempt(targets['exe'], 'open'),
                'cwd_stat': attempt(targets['cwd'], 'stat'),
                'cwd_readlink': attempt(targets['cwd'], 'readlink'),
                'cwd_open': attempt(targets['cwd'], 'open'),
                'attr_stat': attempt(targets['attr_current'], 'stat'),
                'attr_readlink': attempt(targets['attr_current'], 'readlink'),
                'attr_open': attempt(targets['attr_current'], 'open'),
                'attr_read': attempt(targets['attr_current'], 'read'),
                'retained_ns_fd_open': attempt(targets['retained_ns_fd'], 'open'),
                'retained_ns_fdinfo_read': attempt(targets['retained_ns_fdinfo'], 'read'),
            }
            caps = {}
            with open('/proc/self/status', encoding='ascii') as status:
                for line in status:
                    if ':' in line:
                        key, value = line.split(':', 1)
                        if key in {'CapEff', 'CapPrm', 'CapBnd', 'CapAmb'}:
                            caps[key] = value.strip()
            with open('/proc/self/attr/current', encoding='ascii') as current:
                profile = current.read(512).strip()
            print(json.dumps({'pid': os.getpid(), 'uid': os.getuid(), 'caps': caps,
                              'profile': profile, 'cases': cases},
                             sort_keys=True, separators=(',', ':')), flush=True)
            sys.stdin.buffer.read()
        '''), encoding='utf-8')
        probe_script.chmod(0o644)

        try:
            helper_start = subprocess.Popen([
                SYSTEMD_RUN, '--quiet', '--pipe', '--wait', '--unit', helper_unit,
                '--property=Type=simple', f'--property=User={account.pw_name}',
                f'--property=Group={group.gr_name}',
                f'--property=AppArmorProfile={helper_profile}',
                '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                '--property=NoNewPrivileges=yes', '--property=Restart=no',
                '--property=RuntimeMaxSec=60s', str(helper_binary),
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                bufsize=0)
            helper = helper_start
            helper_line = wait_line(helper.stdout)
            helper_fields = helper_line.decode('ascii').split(maxsplit=9)
            self.assertEqual(10, len(helper_fields),
                             f'HOLD: malformed helper record: {helper_line!r}')
            (helper_pid_text, helper_uid_text, helper_gid_text, helper_ns_fd_text,
             helper_effective, helper_permitted, helper_inheritable,
             helper_bounding, helper_ambient, helper_actual_profile) = helper_fields
            helper_pid = int(helper_pid_text)
            helper_uid = int(helper_uid_text)
            helper_gid = int(helper_gid_text)
            helper_ns_fd = int(helper_ns_fd_text)
            helper_props = {}
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                helper_props = systemctl_show(
                    helper_unit, 'ActiveState', 'MainPID', 'ControlPID', 'InvocationID',
                    'ControlGroup', 'User', 'Group', 'AppArmorProfile',
                    'CapabilityBoundingSet', 'AmbientCapabilities', 'NoNewPrivileges',
                )
                if int(helper_props.get('MainPID', '0')) == helper_pid:
                    break
                time.sleep(0.05)
            self.assertEqual('active', helper_props.get('ActiveState'))
            self.assertEqual(account.pw_name, helper_props.get('User'))
            self.assertEqual(group.gr_name, helper_props.get('Group'))
            self.assertEqual(helper_profile, helper_props.get('AppArmorProfile'))
            self.assertEqual('', helper_props.get('CapabilityBoundingSet'))
            self.assertEqual('', helper_props.get('AmbientCapabilities'))
            self.assertEqual('yes', helper_props.get('NoNewPrivileges'))
            known_cgroups[helper_unit] = helper_props.get('ControlGroup', '')
            self.assertEqual(account.pw_uid, helper_uid)
            self.assertEqual(group.gr_gid, helper_gid)
            self.assertEqual('0000000000000000', helper_effective)
            self.assertEqual('0000000000000000', helper_permitted)
            self.assertEqual('0000000000000000', helper_inheritable)
            self.assertEqual('0000000000000000', helper_bounding)
            self.assertEqual('0000000000000000', helper_ambient)
            self.assertEqual(helper_profile,
                             helper_actual_profile.removesuffix(' (enforce)'))
            helper_status = {}
            with open(f'/proc/{helper_pid}/status', encoding='ascii') as status:
                for line in status:
                    if ':' in line:
                        key, value = line.split(':', 1)
                        if key in {'Uid', 'Gid'}:
                            helper_status[key] = value.split()
            self.assertEqual([str(account.pw_uid)] * 4, helper_status.get('Uid'))
            self.assertEqual([str(group.gr_gid)] * 4, helper_status.get('Gid'))

            controller = subprocess.Popen([
                SYSTEMD_RUN, '--quiet', '--pipe', '--wait', '--unit', controller_unit,
                '--property=Type=simple', '--property=User=root', '--property=Group=root',
                f'--property=AppArmorProfile={controller_profile}',
                '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                '--property=NoNewPrivileges=yes', '--property=Restart=no',
                '--property=RuntimeMaxSec=60s', PYTHON, '-S', str(probe_script),
                str(helper_pid), str(helper_ns_fd),
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                bufsize=0)
            controller_line = wait_line(controller.stdout)
            record = json.loads(controller_line)
            controller_pid = int(record['pid'])
            controller_props = {}
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                controller_props = systemctl_show(
                    controller_unit, 'ActiveState', 'MainPID', 'ControlPID',
                    'ControlGroup', 'User', 'Group', 'AppArmorProfile',
                    'CapabilityBoundingSet', 'AmbientCapabilities', 'NoNewPrivileges',
                )
                if int(controller_props.get('MainPID', '0')) == controller_pid:
                    break
                time.sleep(0.05)
            self.assertEqual('active', controller_props.get('ActiveState'))
            self.assertEqual('root', controller_props.get('User'))
            self.assertEqual('root', controller_props.get('Group'))
            self.assertEqual(controller_profile, controller_props.get('AppArmorProfile'))
            self.assertEqual('', controller_props.get('CapabilityBoundingSet'))
            self.assertEqual('', controller_props.get('AmbientCapabilities'))
            self.assertEqual('yes', controller_props.get('NoNewPrivileges'))
            self.assertEqual(0, record['uid'])
            self.assertEqual(controller_profile,
                             record['profile'].removesuffix(' (enforce)'))
            self.assertEqual(
                {name: '0000000000000000' for name in
                 ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')},
                record['caps'],
            )
            known_cgroups[controller_unit] = controller_props.get('ControlGroup', '')

            required = ('ns_stat', 'exe_readlink', 'cwd_readlink', 'attr_read')
            denied = {name: record['cases'][name] for name in required
                      if record['cases'][name]['result'] != 'allowed'}
            record['units'] = {'helper': helper_props, 'controller': controller_props}
            print('BOUNDARY_PROBE=' + json.dumps(record, sort_keys=True), flush=True)
            self.assertFalse(
                denied,
                'HOLD: root empty-cap controller cannot complete required helper identity '
                f'reads. Controller observations: {json.dumps(record, sort_keys=True)}',
            )
        except Exception as exc:
            failures.append(exc)
        finally:
            for process in (controller, helper):
                if process is not None:
                    try:
                        if process.stdin and not process.stdin.closed:
                            process.stdin.close()
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        try:
                            process.terminate()
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            failures.append(RuntimeError('systemd-run client did not exit'))
            for unit in units:
                try:
                    state = load_state(unit)
                    if state == 'loaded':
                        props = systemctl_show(unit, 'ActiveState')
                        if props.get('ActiveState') in (
                            'active', 'activating', 'reloading', 'deactivating',
                        ):
                            subprocess.run([SYSTEMCTL, 'stop', unit], check=True,
                                           capture_output=True, timeout=20)
                    if not cgroup_empty(unit, known_cgroups.get(unit, ''), timeout=10):
                        failures.append(RuntimeError(
                            f'fixture cgroup not proven empty; retained {unit}'
                        ))
                except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                    failures.append(RuntimeError(f'cleanup failed for {unit}: {exc}'))
            drained = all(cgroup_empty(unit, known_cgroups.get(unit, ''), timeout=1)
                          for unit in units)
            if drained:
                shutil.rmtree(directory)
                if created_user:
                    subprocess.run(['/usr/sbin/userdel', API_USER], check=True,
                                   capture_output=True, timeout=10)
                if created_group:
                    try:
                        grp.getgrnam(API_GROUP)
                    except KeyError:
                        pass  # userdel may already have removed the now-empty group.
                    else:
                        try:
                            subprocess.run(['/usr/sbin/groupdel', API_GROUP], check=True,
                                           capture_output=True, timeout=10)
                        except subprocess.CalledProcessError as exc:
                            try:
                                grp.getgrnam(API_GROUP)
                            except KeyError:
                                pass  # Treat a concurrent/automatic removal as successful cleanup.
                            else:
                                failures.append(RuntimeError(
                                    f'cleanup failed to remove fixture group: {exc}'
                                ))
            else:
                failures.append(RuntimeError(
                    f'fixture cgroup not proven empty; retained artifacts at {directory}'
                ))
            if failures:
                raise failures[0]


if __name__ == '__main__':
    unittest.main()
