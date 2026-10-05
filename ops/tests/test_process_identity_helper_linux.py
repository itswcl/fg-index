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
import shutil
import socket
import subprocess
import tempfile
import textwrap
import time
import unittest
import uuid


SYSTEMD = Path('/run/systemd/system')
PYTHON = '/usr/bin/python3.12'
CAPABILITY_FIELDS = ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')
APPARMOR_PROFILES = Path('/sys/kernel/security/apparmor/profiles')


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


def profile_source(role):
    proc_rules = ''
    if role == 'helper':
        proc_rules = '''\
            /proc/[0-9]*/exe r,
            /proc/[0-9]*/cwd r,
            /proc/[0-9]*/stat r,
            /proc/[0-9]*/cgroup r,
            owner /proc/[0-9]*/status r,
            /proc/[0-9]*/attr/current r,
            /proc/[0-9]*/fd/ r,
            /proc/[0-9]*/fd/** r,
            /proc/net/tcp r,
            /run/dbus/system_bus_socket rw,
            /usr/bin/systemctl ix,
            network unix stream,
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
    /usr/share/zoneinfo/Etc/UTC r,
    /opt/fg-index-identity-helper-*/ r,
    /opt/fg-index-identity-helper-*/** r,
    network unix stream,
PROFILE_RULES
}
'''
    return textwrap.dedent(body.replace('PROFILE_RULES', proc_rules)).replace(
        'PROFILE_NAME', 'fg-index-identity-policy-placeholder'
    )


def profile_name_and_source(role):
    canonical = profile_source(role).encode('utf-8')
    policy_digest = hashlib.sha256(canonical).hexdigest()
    name = f'fg-index-{role}-{policy_digest}'
    generated = profile_source(role).replace('fg-index-identity-policy-placeholder', name)
    source_digest = hashlib.sha256(generated.encode('utf-8')).hexdigest()
    return name, policy_digest, source_digest, generated


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
        helper_profile, helper_policy_digest, helper_source_digest, helper_policy = profile_name_and_source('helper')

        with tempfile.TemporaryDirectory(prefix='fg-index-identity-helper-', dir='/opt') as directory:
            fixture = Path(directory)
            fixture.chmod(0o755)
            api_created = False
            group_created = False
            loaded_profiles = []
            cleanup_errors = []
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
                    "same-UID peer, startup alias, descendant, and adversarial request isolation",
                    "stale-process/current-profile mismatch negative case",
                    "malformed, replayed, oversized, and timeout helper output cases",
                    "all production API lifecycle actors and shared stop lock",
                    "replacement invocation at stop-job acceptance boundary",
                    "required production controller sandbox/context matrix",
                ]
                summary["api_profile_name"] = API_PROFILE
                summary["api_policy_sha256"] = API_POLICY_SHA256
                summary["helper_profile_name"] = HELPER_PROFILE
                summary["helper_policy_sha256"] = HELPER_POLICY_SHA256
                summary["apparmor_parser_version"] = APPARMOR_PARSER_VERSION
                summary["kernel_release"] = KERNEL_RELEASE
                controller_before = show(CONTROLLER_UNIT, "ActiveState", "SubState", "MainPID",
                                         "ControlPID", "NRestarts", "InvocationID", "ControlGroup")
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
                launch = [
                    "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait", "--collect",
                    "--unit", HELPER_UNIT,
                    "--property=Type=oneshot", "--property=User=fg-index", "--property=Group=fg-index",
                    "--property=AppArmorProfile=" + HELPER_PROFILE,
                    "--property=CapabilityBoundingSet=", "--property=AmbientCapabilities=",
                    "--property=NoNewPrivileges=yes", "--property=ProtectSystem=strict",
                    "--property=ProtectHome=yes", "--property=PrivateTmp=yes",
                    "--property=RestrictAddressFamilies=AF_UNIX", "--property=Restart=no",
                    "--property=SystemCallFilter=~ptrace process_vm_readv process_vm_writev process_madvise pidfd_getfd",
                    "--property=RuntimeMaxSec=20s", {PYTHON!r}, "-S", HELPER_SCRIPT,
                ]
                print("API_PRE_HELPER_GATE=PASS HELPER_LAUNCH=ALLOWED", flush=True)
                child = subprocess.Popen(launch, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, bufsize=0)
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
                record = None
                if summary["bounded_output_ok"] and summary["one_record_ok"]:
                    try:
                        record = json.loads(bytes(data[:-1]).decode("ascii"))
                    except (UnicodeError, json.JSONDecodeError):
                        summary["errors"].append("helper output malformed")
                else:
                    summary["errors"].append("helper output is oversized or not one record")

                try:
                    helper = show(HELPER_UNIT, "MainPID", "InvocationID", "ControlGroup", "LoadState",
                                  "User", "Group", "AppArmorProfile", "CapabilityBoundingSet",
                                  "AmbientCapabilities", "NoNewPrivileges", "Restart", "ExecStart",
                                  "RestrictAddressFamilies", "SystemCallFilter", "ProtectSystem",
                                  "ProtectHome", "PrivateTmp",
                                  "FragmentPath")
                    helper_pid = int(helper.get("MainPID", "0"))
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
                    helper_pidfd = os.pidfd_open(helper_pid, 0)
                    helper_poll = select.poll()
                    helper_poll.register(helper_pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                    summary["helper_pidfd_live"] = helper_poll.poll(0) == []
                    if record is not None:
                        expected_fields = {{
                            "schema", "helper_invocation_id", "api_pid", "api_invocation_id",
                            "api_control_group", "api_starttime", "api_exe", "api_cwd",
                            "api_profile_label", "api_capabilities", "api_fd_inodes", "listener",
                            "pidfd_live", "helper_capabilities",
                            "argv_ok", "caller_parameters_absent",
                        }}
                        summary["schema_ok"] = set(record) == expected_fields
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
                summary["helper_state"] = (
                    "PASS" if summary.get("helper_live_checks_ok") and summary.get("helper_exit_zero")
                    and summary.get("api_final_snapshot_stable")
                    and summary.get("controller_final_snapshot_stable")
                    and summary.get("post_eof_output_absent")
                    and summary.get("bounded_output_ok") else "HOLD"
                )
                print(json.dumps(summary, sort_keys=True), flush=True)
            '''), encoding='utf-8')
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
                    '/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect',
                    '--unit', controller_unit,
                    '--property=Type=simple', '--property=User=root',
                    '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
                    '--property=NoNewPrivileges=yes', '--property=WorkingDirectory=' + directory,
                    '--property=ProtectHome=read-only', '--property=PrivateTmp=yes',
                    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
                    '--property=RuntimeMaxSec=45s', PYTHON, '-S', str(controller_script),
                ]
                result = subprocess.run(controller, stdin=subprocess.DEVNULL, capture_output=True,
                                        text=True, timeout=55)
                lines = [line for line in result.stdout.splitlines() if line.strip()]
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
                for unit in (helper_unit, controller_unit, api_unit):
                    try:
                        if load_state(unit) == 'loaded':
                            active = systemctl_show(unit, 'ActiveState').get('ActiveState')
                            if active in ('active', 'activating', 'reloading', 'deactivating'):
                                subprocess.run(
                                    ['/usr/bin/systemctl', 'stop', unit],
                                    check=True, capture_output=True, timeout=15,
                                )
                            subprocess.run(
                                ['/usr/bin/systemctl', 'reset-failed', unit],
                                check=True, capture_output=True, timeout=15,
                            )
                    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                        cleanup_errors.append(f'stop {unit}: {exc}')
                for role, path in reversed(loaded_profiles):
                    try:
                        subprocess.run(
                            [parser, '-R', str(path)], check=True,
                            capture_output=True, timeout=15,
                        )
                    except (OSError, subprocess.SubprocessError) as exc:
                        cleanup_errors.append(f'unload AppArmor {role} profile: {exc}')
                if api_created:
                    try:
                        subprocess.run(
                            ['/usr/sbin/userdel', 'fg-index'], check=True,
                            capture_output=True, timeout=10,
                        )
                    except (OSError, subprocess.SubprocessError) as exc:
                        cleanup_errors.append(f'userdel fg-index: {exc}')
                if group_created:
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
