"""Linux measurement of zero-capability controller process identity reads.

This test uses disposable systemd units only. It never reads or changes a
production host. The API fixture runs as the unprivileged `nobody` account; the
controller fixture mirrors the root, empty-capability service context. CI reports
whether direct executable, cwd, pidfd, and listener ownership proof is
available. Access denial is evidence to hold and consider the separately
reviewed helper.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import textwrap
import time
import unittest
import uuid


SYSTEMD = Path('/run/systemd/system')
PYTHON = '/usr/bin/python3.12'


def systemctl_show(unit, *properties):
    result = subprocess.run(
        ['/usr/bin/systemctl', 'show', unit, *(f'--property={item}' for item in properties)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


class ProcessIdentityLinuxTest(unittest.TestCase):
    @unittest.skipUnless(
        os.geteuid() == 0 and SYSTEMD.is_dir()
        and os.environ.get('FG_INDEX_REQUIRE_PROCESS_IDENTITY_TEST') == '1',
        'actual zero-capability systemd identity proof runs in Linux CI',
    )
    def test_controller_measures_proc_pidfd_and_exact_listener_identity(self):
        suffix = uuid.uuid4().hex[:12]
        api_unit = f'fg-index-identity-api-{suffix}.service'
        controller_unit = f'fg-index-identity-controller-{suffix}.service'

        with tempfile.TemporaryDirectory(prefix='fg-index-identity-ci-', dir='/var/tmp') as directory:
            fixture = Path(directory)
            fixture.chmod(0o755)
            api_script_path = fixture / 'api_fixture.py'
            probe_script_path = fixture / 'controller_probe.py'
            api_script_path.write_text(textwrap.dedent('''\
                import socket
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 8080))
                listener.listen(8)
                while True:
                    connection, _ = listener.accept()
                    connection.close()
            '''))
            api_script_path.chmod(0o644)

            probe_script_path.write_text(textwrap.dedent(f'''\
                import errno
                import json
                import os
                import select
                import socket
                import subprocess

                API_UNIT = {api_unit!r}

                def readlink(path):
                    try:
                        return {{"value": os.readlink(path)}}
                    except OSError as exc:
                        return {{"errno": errno.errorcode.get(exc.errno, str(exc.errno))}}

                def inspect():
                    with open("/proc/self/status", encoding="ascii") as reader:
                        status = dict(line.split(":", 1) for line in reader if ":" in line)
                    capabilities = {{key: status[key].strip() for key in
                                    ("CapEff", "CapPrm", "CapBnd", "CapAmb")}}
                    raw = subprocess.run(
                        ["/usr/bin/systemctl", "show", API_UNIT,
                         "--property=MainPID", "--property=InvocationID"],
                        check=True, capture_output=True, text=True, timeout=10,
                    ).stdout
                    properties = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
                    pid = int(properties["MainPID"])
                    proc = f"/proc/{{pid}}"
                    observed = {{
                        "pid": pid,
                        "invocation_id": properties.get("InvocationID", ""),
                        "capabilities": capabilities,
                        "exe": readlink(proc + "/exe"),
                        "cwd": readlink(proc + "/cwd"),
                    }}
                    pidfd = -1
                    try:
                        pidfd = os.pidfd_open(pid, 0)
                        poller = select.poll()
                        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                        observed["pidfd_live"] = poller.poll(0) == []
                    except OSError as exc:
                        observed["pidfd_error"] = errno.errorcode.get(exc.errno, str(exc.errno))
                    finally:
                        if pidfd >= 0:
                            os.close(pidfd)

                    try:
                        fd_inodes = set()
                        for fd in os.listdir(proc + "/fd"):
                            target = os.readlink(proc + "/fd/" + fd)
                            if target.startswith("socket:[") and target.endswith("]"):
                                fd_inodes.add(target[8:-1])
                        observed["fd_inodes"] = sorted(fd_inodes)
                    except OSError as exc:
                        observed["fd_error"] = errno.errorcode.get(exc.errno, str(exc.errno))

                    try:
                        rows = []
                        with open("/proc/net/tcp", encoding="ascii") as reader:
                            next(reader)
                            for line in reader:
                                fields = line.split()
                                local_address, state, inode = fields[1], fields[3], fields[9]
                                address_hex, port_hex = local_address.split(":", 1)
                                address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
                                port = int(port_hex, 16)
                                if state == "0A" and address == "127.0.0.1" and port == 8080:
                                    rows.append(inode)
                        observed["listener_rows"] = rows
                        observed["listener_owned"] = (
                            len(rows) == 1 and rows[0] in observed.get("fd_inodes", [])
                        )
                    except OSError as exc:
                        observed["tcp_error"] = errno.errorcode.get(exc.errno, str(exc.errno))
                    return observed

                print(json.dumps(inspect(), sort_keys=True), flush=True)
            '''))
            probe_script_path.chmod(0o644)

            start_api = [
                '/usr/bin/systemd-run', '--quiet', '--collect', '--unit', api_unit,
                '--property=Type=simple', '--property=User=nobody', '--property=Group=nogroup',
                '--property=WorkingDirectory=' + directory,
                '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
                '--property=ProtectHome=yes', '--property=PrivateDevices=yes',
                '--property=PrivateTmp=yes', '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                '--property=RuntimeMaxSec=30s', PYTHON, str(api_script_path),
            ]
            subprocess.run(start_api, check=True, capture_output=True, timeout=15)
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', 8080), timeout=0.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            self.fail('API fixture did not bind 127.0.0.1:8080')
                        time.sleep(0.1)

                api = systemctl_show(api_unit, 'MainPID', 'InvocationID')
                self.assertGreater(int(api['MainPID']), 0)
                self.assertTrue(api.get('InvocationID'))

                probe = [
                    '/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect',
                    '--unit', controller_unit,
                    '--property=Type=oneshot', '--property=User=root',
                    '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                    '--property=NoNewPrivileges=yes', '--property=ProtectHome=read-only',
                    '--property=PrivateTmp=yes', '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                    '--property=RuntimeMaxSec=15s', PYTHON, str(probe_script_path),
                ]
                result = subprocess.run(probe, stdin=subprocess.DEVNULL, capture_output=True,
                                        text=True, timeout=25)
                self.assertEqual(0, result.returncode, result.stderr)
                lines = [line for line in result.stdout.splitlines() if line.strip()]
                self.assertEqual(1, len(lines), result.stdout)
                observed = json.loads(lines[0])

                self.assertEqual(int(api['MainPID']), observed['pid'], observed)
                self.assertEqual(api['InvocationID'], observed['invocation_id'], observed)
                self.assertEqual({key: '0000000000000000' for key in
                                  ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')},
                                 observed['capabilities'], observed)
                self.assertTrue(observed.get('pidfd_live'), observed)
                self.assertEqual(1, len(observed.get('listener_rows', [])), observed)
                for key, expected in (('exe', '/usr/bin/python3.12'), ('cwd', directory)):
                    value = observed[key]
                    if value != {'value': expected}:
                        self.assertIn(value, ({'errno': 'EACCES'}, {'errno': 'EPERM'}), observed)
                if 'fd_error' in observed:
                    self.assertIn(observed['fd_error'], ('EACCES', 'EPERM'), observed)
                else:
                    self.assertEqual(1, len(observed.get('fd_inodes', [])), observed)
                    self.assertTrue(observed.get('listener_owned'), observed)

                direct_proof = (
                    observed['exe'] == {'value': '/usr/bin/python3.12'}
                    and observed['cwd'] == {'value': directory}
                    and 'fd_error' not in observed
                    and observed.get('listener_owned') is True
                )
                outcome = 'PROVEN' if direct_proof else 'UNAVAILABLE; HOLD; helper candidate requires review'
                print('CONTROLLER_DIRECT_IDENTITY=' + outcome + ':' + json.dumps(observed, sort_keys=True))
            finally:
                subprocess.run(['/usr/bin/systemctl', 'stop', api_unit], capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'reset-failed', api_unit], capture_output=True, timeout=10)


if __name__ == '__main__':
    unittest.main()
