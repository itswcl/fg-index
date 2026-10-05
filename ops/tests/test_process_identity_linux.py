"""Linux measurement of zero-capability process identity observation paths.

This test uses disposable systemd units only. It never reads or changes a
production host. The API fixture runs as the unprivileged `fg-index` account;
controller fixture mirrors the root, empty-capability service context. C
(controller) executable/CWD reads remain a hard requirement. Direct reads of A
(API) are reported separately: denial is UNAVAILABLE/HOLD and marks the helper
as required, never an API identity pass. This focused commit does not implement
the helper E2E; aggregate acceptance remains HOLD until that proof and every
other v11 Linux context/race gate are implemented.
"""
import json
import grp
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
    def test_zero_cap_controller_reports_direct_api_identity_diagnosis(self):
        suffix = uuid.uuid4().hex[:12]
        api_unit = f'fg-index-identity-api-{suffix}.service'
        controller_unit = f'fg-index-identity-controller-{suffix}.service'

        with tempfile.TemporaryDirectory(prefix='fg-index-identity-ci-', dir='/opt') as directory:
            fixture = Path(directory)
            fixture.chmod(0o755)
            api_user_created = False
            api_group_created = False
            api_script_path = fixture / 'api_fixture.py'
            probe_script_path = fixture / 'controller_probe.py'
            api_script_path.write_text(textwrap.dedent(f'''\
                import json
                import os
                import socket

                with open("/proc/self/status", encoding="ascii") as reader:
                    status = dict(line.split(":", 1) for line in reader if ":" in line)
                capabilities = {{key: status[key].strip() for key in {CAPABILITY_STATUS_FIELDS!r}}}
                capability_report = json.dumps(capabilities, sort_keys=True).encode("ascii")

                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 8080))
                listener.listen(8)
                while True:
                    connection, _ = listener.accept()
                    connection.sendall(capability_report)
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
                        "controller_pid": os.getpid(),
                        "controller_exe": readlink("/proc/self/exe"),
                        "controller_cwd": readlink("/proc/self/cwd"),
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

                    fd_inodes = set()
                    fd_errors = []
                    try:
                        fd_names = os.listdir(proc + "/fd")
                    except OSError as exc:
                        fd_names = []
                        fd_errors.append(errno.errorcode.get(exc.errno, str(exc.errno)))
                    for fd in fd_names:
                        try:
                            target = os.readlink(proc + "/fd/" + fd)
                            if target.startswith("socket:[") and target.endswith("]"):
                                fd_inodes.add(target[8:-1])
                        except OSError as exc:
                            fd_errors.append(errno.errorcode.get(exc.errno, str(exc.errno)))
                    observed["fd_inodes"] = sorted(fd_inodes)
                    if fd_errors:
                        observed["fd_errors"] = fd_errors

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
                    operation_errors = []
                    for operation in ("exe", "cwd"):
                        if "errno" in observed[operation]:
                            operation_errors.append((operation, observed[operation]["errno"]))
                    operation_errors.extend(("fd", code) for code in fd_errors)
                    if "tcp_error" in observed:
                        operation_errors.append(("tcp", observed["tcp_error"]))
                    if not observed.get("pidfd_live", False):
                        operation_errors.append(("pidfd", observed.get("pidfd_error", "NOT_LIVE")))
                    observed["direct_a_state"] = (
                        "PASS" if not operation_errors and observed.get("listener_owned")
                        else "UNAVAILABLE/HOLD" if any(code == "EACCES" for _, code in operation_errors)
                        else "HOLD"
                    )
                    observed["direct_a_errors"] = operation_errors
                    observed["aggregate_gate"] = "HOLD"
                    observed["helper_required"] = observed["direct_a_state"] == "UNAVAILABLE/HOLD"
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
                    api_group_created = True
                subprocess.run(start_api, check=True, capture_output=True, timeout=15)
                deadline = time.monotonic() + 10
                api_capabilities = None
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', 8080), timeout=0.25) as connection:
                            connection.settimeout(1)
                            chunks = []
                            while True:
                                chunk = connection.recv(4096)
                                if not chunk:
                                    break
                                chunks.append(chunk)
                            api_capabilities = json.loads(b''.join(chunks).decode('ascii'))
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
                    '--property=WorkingDirectory=' + directory,
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
                print('DIRECT_A_DIAGNOSIS=' + observed['direct_a_state'])
                print('AGGREGATE_PROCESS_IDENTITY_GATE=' + observed['aggregate_gate'])
                self.assertEqual({'value': '/usr/bin/python3.12'}, observed['controller_exe'], observed)
                self.assertEqual({'value': directory}, observed['controller_cwd'], observed)
                self.assertEqual(int(api['MainPID']), observed['pid'], observed)
                self.assertEqual(api['InvocationID'], observed['invocation_id'], observed)
                self.assertEqual(
                    {key: '0000000000000000' for key in CAPABILITY_STATUS_FIELDS},
                    api_capabilities,
                    'API fixture must run with empty effective/permitted/bounding/ambient capabilities',
                )
                self.assertEqual({key: '0000000000000000' for key in CAPABILITY_STATUS_FIELDS},
                                 observed['capabilities'], observed)
                self.assertTrue(observed.get('pidfd_live'), observed)
                self.assertEqual('HOLD', observed['aggregate_gate'], observed)
                if observed['direct_a_state'] == 'UNAVAILABLE/HOLD':
                    self.assertTrue(observed['helper_required'], observed)
                    self.assertTrue(
                        any(code == 'EACCES' for _, code in observed['direct_a_errors']), observed
                    )
                    self.assertEqual({'errno': 'EACCES'}, observed['exe'], observed)
                    self.assertEqual({'errno': 'EACCES'}, observed['cwd'], observed)
                    self.assertIn('EACCES', observed.get('fd_errors', []), observed)
                else:
                    self.assertEqual('PASS', observed['direct_a_state'], observed)
                    self.assertEqual({'value': '/usr/bin/python3.12'}, observed['exe'], observed)
                    self.assertEqual({'value': directory}, observed['cwd'], observed)
                    self.assertEqual(1, len(observed.get('listener_rows', [])), observed)
                    self.assertTrue(observed.get('listener_owned'), observed)
            finally:
                for unit in (api_unit, controller_unit):
                    unit_state = subprocess.run(
                        ['/usr/bin/systemctl', 'show', unit, '--property=LoadState'],
                        capture_output=True, text=True, timeout=10,
                    )
                    if unit_state.returncode == 0 and 'LoadState=loaded' in unit_state.stdout:
                        subprocess.run(
                            ['/usr/bin/systemctl', 'stop', unit],
                            check=True, capture_output=True, timeout=15,
                        )
                    subprocess.run(
                        ['/usr/bin/systemctl', 'reset-failed', unit],
                        capture_output=True, timeout=10,
                    )
                if api_user_created:
                    subprocess.run(
                        ['/usr/sbin/userdel', 'fg-index'],
                        check=True, capture_output=True, timeout=10,
                    )
                if api_group_created:
                    try:
                        grp.getgrnam('fg-index')
                    except KeyError:
                        pass
                    else:
                        subprocess.run(
                            ['/usr/sbin/groupdel', 'fg-index'],
                            check=True, capture_output=True, timeout=10,
                        )


if __name__ == '__main__':
    unittest.main()
