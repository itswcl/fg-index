"""Linux measurement of zero-capability controller process identity reads.

This test uses disposable systemd units only. It never reads or changes a
production host. The API fixture runs as the unprivileged `fg-index` account;
controller fixture mirrors the root, empty-capability service context. Direct
executable, cwd, pidfd, and listener ownership proof is required. The complete
observation is printed before assertions so access denial is visible in CI and
keeps the check red until the design is resolved.
"""
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import tempfile
import textwrap
import time
import unittest
import uuid


SYSTEMD = Path('/run/systemd/system')
PYTHON = '/usr/bin/python3.12'
CAPABILITY_STATUS_FIELDS = ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')


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

        with tempfile.TemporaryDirectory(prefix='fg-index-identity-ci-', dir='/opt') as directory:
            fixture = Path(directory)
            fixture.chmod(0o755)
            api_user_created = False
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
                CAPABILITY_FIELDS = {CAPABILITY_STATUS_FIELDS!r}

                def readlink(path):
                    try:
                        return {{"value": os.readlink(path)}}
                    except OSError as exc:
                        return {{"errno": errno.errorcode.get(exc.errno, str(exc.errno))}}

                def inspect():
                    with open("/proc/self/status", encoding="ascii") as reader:
                        status = dict(line.split(":", 1) for line in reader if ":" in line)
                    capabilities = {{key: status[key].strip() for key in CAPABILITY_FIELDS}}
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
                '--property=Type=simple', '--property=User=fg-index', '--property=Group=fg-index',
                '--property=WorkingDirectory=' + directory,
                '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
                '--property=ProtectHome=yes', '--property=PrivateDevices=yes',
                '--property=PrivateTmp=yes', '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                '--property=RuntimeMaxSec=30s', PYTHON, str(api_script_path),
            ]
            try:
                try:
                    pwd.getpwnam('fg-index')
                except KeyError:
                    subprocess.run(
                        ['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                         '--shell', '/usr/sbin/nologin', 'fg-index'],
                        check=True, capture_output=True, timeout=10,
                    )
                    api_user_created = True
                subprocess.run(start_api, check=True, capture_output=True, timeout=15)
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', 8080), timeout=0.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            status = subprocess.run(
                                ['/usr/bin/systemctl', 'status', '--no-pager', api_unit],
                                capture_output=True, text=True, timeout=10,
                            )
                            self.fail(
                                'API fixture did not bind 127.0.0.1:8080\n'
                                + status.stdout + status.stderr
                            )
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

                print('CONTROLLER_DIRECT_IDENTITY=' + json.dumps(observed, sort_keys=True))
                self.assertEqual(int(api['MainPID']), observed['pid'], observed)
                self.assertEqual(api['InvocationID'], observed['invocation_id'], observed)
                self.assertEqual({key: '0000000000000000' for key in CAPABILITY_STATUS_FIELDS},
                                 observed['capabilities'], observed)
                self.assertEqual({'value': '/usr/bin/python3.12'}, observed['exe'], observed)
                self.assertEqual({'value': directory}, observed['cwd'], observed)
                self.assertTrue(observed.get('pidfd_live'), observed)
                self.assertEqual(1, len(observed.get('listener_rows', [])), observed)
                self.assertTrue(observed.get('listener_owned'), observed)
            finally:
                subprocess.run(['/usr/bin/systemctl', 'stop', api_unit], capture_output=True, timeout=15)
                subprocess.run(['/usr/bin/systemctl', 'reset-failed', api_unit], capture_output=True, timeout=10)
                if api_user_created:
                    subprocess.run(['/usr/sbin/userdel', 'fg-index'], capture_output=True, timeout=10)


if __name__ == '__main__':
    unittest.main()
