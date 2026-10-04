"""Disabled unit namespace contract; actual root/systemd execution only in Linux CI."""
import configparser
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from ops.deploy_api_release import ROLE_STAGE

UNITS = Path(__file__).parents[1] / 'deployment/systemd'


class UnitAccessTest(unittest.TestCase):
    def test_both_units_expose_only_accepted_role_directory_under_readonly_home(self):
        for name in ('fg-index-deployment.service', 'fg-index-deployment-watchdog.service', 'fg-index-deployment-recovery.service'):
            parser = configparser.ConfigParser(interpolation=None)
            parser.read(UNITS / name)
            self.assertEqual('read-only', parser['Service']['ProtectHome'])
            self.assertEqual(str(ROLE_STAGE), parser['Service']['ReadWritePaths'])
            self.assertEqual('root', parser['Service']['User'])

    def test_api_unit_requires_a_fresh_guard_and_guard_is_lock_free(self):
        api = configparser.ConfigParser(interpolation=None)
        api.read(Path(__file__).parents[1] / 'oci/fg-index-api.service')
        self.assertNotIn('Requires', api['Unit'])
        dropin = configparser.ConfigParser(interpolation=None)
        dropin.read(UNITS / '20-deployment-boot-guard.conf')
        self.assertEqual('fg-index-api-boot-guard.service', dropin['Unit']['Requires'])
        self.assertEqual('fg-index-api-boot-guard.service', dropin['Unit']['After'])
        guard = configparser.ConfigParser(interpolation=None)
        guard.read(UNITS / 'fg-index-api-boot-guard.service')
        self.assertEqual('oneshot', guard['Service']['Type'])
        self.assertEqual('2min', guard['Service']['TimeoutStartSec'])
        self.assertNotIn('RemainAfterExit', guard['Service'])
        self.assertNotIn('ReadWritePaths', guard['Service'])
        self.assertIn('--boot-guard', guard['Service']['ExecStart'])
        recovery = configparser.ConfigParser(interpolation=None)
        recovery.read(UNITS / 'fg-index-deployment-recovery.service')
        self.assertIn('--recover', recovery['Service']['ExecStart'])
        self.assertEqual(str(ROLE_STAGE), recovery['Service']['ReadWritePaths'])

    @unittest.skipUnless(os.geteuid() == 0 and (Path('/run/systemd/system').is_dir() or os.environ.get('FG_INDEX_REQUIRE_SYSTEMD_NAMESPACE_TEST') == '1'), 'actual root/systemd namespace check runs in Linux CI')
    def test_service_namespace_reads_private_receipts_and_writes_shared_lock(self):
        self.assertTrue(Path('/run/systemd/system').is_dir(), 'Linux CI must run the actual namespace check')
        # Synthetic CI directory only; never touches the production role stage.
        with tempfile.TemporaryDirectory(prefix='fg-index-unit-test-', dir='/root') as directory:
            root = Path(directory)
            receipt = root / 'owner.json'
            receipt.write_text('{}\n')
            receipt.chmod(0o600)
            script = """import fcntl,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);assert (root/'owner.json').read_text()=='{}\\n'
fd=os.open(root/'role-deployment.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);os.fsync(fd);os.close(fd)
try:
 os.open('/root/fg-index-unit-outside-'+str(os.getpid()),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
except OSError:
 pass
else:
 raise AssertionError('root home outside whitelist was writable')
"""
            result = subprocess.run(['/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect',
                                     '--property=User=root', '--property=ProtectHome=read-only',
                                     '--property=ReadWritePaths=' + directory, '--property=PrivateTmp=yes',
                                     '--property=RuntimeMaxSec=10', '/usr/bin/python3.12', '-c', script, directory],
                                    capture_output=True, timeout=20)
            self.assertEqual(0, result.returncode, result.stderr.decode())
            self.assertEqual(0o600, (root / 'role-deployment.lock').stat().st_mode & 0o777)

    @unittest.skipUnless(os.geteuid() == 0 and Path('/run/systemd/system').is_dir(), 'actual systemd property serialization runs in Linux CI')
    def test_systemctl_show_may_omit_empty_environment_files_property(self):
        name = 'fg-index-empty-environment-fixture-' + str(os.getpid()) + '.service'
        unit = Path('/run/systemd/system') / name
        try:
            unit.write_text('[Unit]\nDescription=Empty environment property fixture\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n')
            unit.chmod(0o644)
            subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, capture_output=True, timeout=15)
            for include_all in (False, True):
                command = ['/usr/bin/systemctl', 'show', name]
                if include_all:
                    command.append('--all')
                command.append('--property=EnvironmentFiles')
                result = subprocess.run(command, check=True, capture_output=True, timeout=10)
                properties = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
                self.assertEqual('', properties.get('EnvironmentFiles', ''), 'fixture unexpectedly declares environment files')
        finally:
            unit.unlink(missing_ok=True)
            subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, capture_output=True, timeout=15)

    @unittest.skipUnless(os.geteuid() == 0 and Path('/run/systemd/system').is_dir(), 'actual systemd dependency execution runs in Linux CI')
    def test_guard_runs_for_each_api_start_and_failure_blocks_api_exec(self):
        suffix = str(os.getpid())
        guard_name = 'fg-index-boot-gate-fixture-' + suffix + '.service'
        api_name = 'fg-index-api-gate-fixture-' + suffix + '.service'
        guard_unit = Path('/run/systemd/system') / guard_name
        api_unit = Path('/run/systemd/system') / api_name
        controller_name = 'fg-index-controller-gate-fixture-' + suffix + '.service'
        controller_unit = Path('/run/systemd/system') / controller_name
        with tempfile.TemporaryDirectory(prefix='fg-index-gate-fixture-') as directory:
            root = Path(directory)
            script = root / 'fixture.py'
            calls, starts, fail = root / 'guard.calls', root / 'api.starts', root / 'fail.guard'
            script.write_text("""import pathlib,sys
mode,calls,starts,fail=sys.argv[1:]
if mode=='guard':
 calls=pathlib.Path(calls);calls.write_text(calls.read_text()+'x' if calls.exists() else 'x')
 raise SystemExit(1 if pathlib.Path(fail).exists() else 0)
starts=pathlib.Path(starts);starts.write_text(starts.read_text()+'x' if starts.exists() else 'x')
""")
            guard_unit.write_text('[Unit]\nDescription=Isolated guard fixture\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + str(script) + ' guard ' + str(calls) + ' ' + str(starts) + ' ' + str(fail) + '\n')
            api_unit.write_text('[Unit]\nDescription=Isolated API fixture\nRequires=' + guard_name + '\nAfter=' + guard_name + '\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + str(script) + ' api ' + str(calls) + ' ' + str(starts) + ' ' + str(fail) + '\n')
            controller_unit.write_text('[Unit]\nDescription=Isolated controller fixture\n\n[Service]\nType=oneshot\nTimeoutStartSec=10s\nExecStart=/usr/bin/systemctl start ' + api_name + '\n')
            guard_unit.chmod(0o644)
            api_unit.chmod(0o644)
            controller_unit.chmod(0o644)
            try:
                subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'start', api_name], check=True, capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'start', api_name], check=True, capture_output=True, timeout=15)
                self.assertEqual('xx', calls.read_text())
                self.assertEqual('xx', starts.read_text())
                fail.touch()
                result = subprocess.run(['/usr/bin/systemctl', 'start', api_name], capture_output=True, timeout=15)
                self.assertNotEqual(0, result.returncode)
                self.assertEqual('xxx', calls.read_text())
                self.assertEqual('xx', starts.read_text(), 'API ExecStart ran after guard failure')
                fail.unlink()
                subprocess.run(['/usr/bin/systemctl', 'reset-failed', api_name, guard_name], capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'start', controller_name], check=True, capture_output=True, timeout=15)
                self.assertEqual('xxxx', calls.read_text())
                self.assertEqual('xxx', starts.read_text(), 'controller waiting on API and its guard deadlocked')
            finally:
                subprocess.run(['/usr/bin/systemctl', 'stop', controller_name, api_name, guard_name], capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'reset-failed', controller_name, api_name, guard_name], capture_output=True, timeout=15)
                controller_unit.unlink(missing_ok=True)
                api_unit.unlink(missing_ok=True)
                guard_unit.unlink(missing_ok=True)
                subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, capture_output=True, timeout=15)


if __name__ == '__main__':
    unittest.main()
