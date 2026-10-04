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
        for name in ('fg-index-deployment.service', 'fg-index-deployment-watchdog.service'):
            parser = configparser.ConfigParser(interpolation=None)
            parser.read(UNITS / name)
            self.assertEqual('read-only', parser['Service']['ProtectHome'])
            self.assertEqual(str(ROLE_STAGE), parser['Service']['ReadWritePaths'])
            self.assertEqual('root', parser['Service']['User'])

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


if __name__ == '__main__':
    unittest.main()
