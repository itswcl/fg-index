"""Stage-zero feasibility gate for one exact sparse-/proc systemd candidate.

The ordinary-/proc control proves that the native self-observation fixture
works. The candidate then uses a read-only tmpfs at /proc and one pinned API
proc-directory bind. The Python harness is privileged root infrastructure; it
is not the proposed capability-empty controller C/H integration. The disposable
A target and native H probe run as fg-index with empty capability sets. A
nonzero candidate exit is a failed design gate, never a passing expected-negative
test. This does not prove a cross-process identity, channel, lifecycle, or
production AppArmor contract.
"""

import grp
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid


REPO = Path(__file__).resolve().parents[2]
FIXTURE_SOURCE = REPO / "ops/tests/process_identity_preflight.c"
SYSTEMD_RUN = "/usr/bin/systemd-run"
SYSTEMCTL = "/usr/bin/systemctl"
JOURNALCTL = "/usr/bin/journalctl"
ACCOUNT = "fg-index"
STATUS_FIELDS = ("Uid", "Gid", "CapEff", "CapPrm", "CapBnd", "CapAmb", "NoNewPrivs")


def run(argv, *, timeout=20, check=True):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {argv!r}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def show(unit):
    result = run([
        SYSTEMCTL, "show", unit,
        "--property=LoadState", "--property=ActiveState", "--property=SubState",
        "--property=Result", "--property=MainPID", "--property=ExecMainPID",
        "--property=ExecMainCode", "--property=ExecMainStatus",
        "--property=InvocationID", "--property=ControlGroup",
        "--property=User", "--property=Group", "--property=NoNewPrivileges",
        "--property=CapabilityBoundingSet", "--property=AmbientCapabilities",
        "--property=TemporaryFileSystem", "--property=BindReadOnlyPaths",
    ], check=False)
    if result.returncode:
        if "could not be found" in result.stderr.lower():
            return {}
        raise RuntimeError(f"cannot inspect {unit}: {result.stderr.strip()}")
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def status(pid):
    values = {}
    with open(f"/proc/{pid}/status", encoding="ascii") as stream:
        for line in stream:
            name, sep, value = line.partition(":")
            if sep and name in STATUS_FIELDS:
                values[name] = value.strip()
    missing = set(STATUS_FIELDS) - values.keys()
    if missing:
        raise RuntimeError(f"/proc/{pid}/status missing fields: {sorted(missing)}")
    return values


def proc_mounts(pid):
    mounts = []
    with open(f"/proc/{pid}/mountinfo", encoding="utf-8") as stream:
        for line in stream:
            before, sep, after = line.rstrip("\n").partition(" - ")
            left, right = before.split(), after.split()
            if not sep or len(left) < 6 or len(right) < 3:
                raise RuntimeError(f"malformed /proc/{pid}/mountinfo row: {line!r}")
            mountpoint = left[4].replace("\\040", " ")
            if mountpoint == "/proc" or mountpoint.startswith("/proc/"):
                mounts.append({
                    "device": left[2],
                    "root": left[3].replace("\\040", " "),
                    "mountpoint": mountpoint,
                    "mount_options": left[5].split(","),
                    "filesystem": right[0],
                    "source": right[1],
                    "super_options": right[2].split(","),
                })
    return mounts


def apparmor(pid):
    enabled_file = Path("/sys/module/apparmor/parameters/enabled")
    enabled = enabled_file.read_text(encoding="ascii").strip() if enabled_file.exists() else "unavailable"
    try:
        profile = Path(f"/proc/{pid}/attr/current").read_text(encoding="utf-8").strip()
    except OSError as error:
        profile = f"unavailable (errno={error.errno})"
    if profile == "unconfined" or profile.startswith("unconfined "):
        scope = "unconfined; filesystem/proc boundary evidence only"
    elif profile.startswith("unavailable"):
        scope = "unavailable; no production-profile acceptance"
    else:
        scope = "profile recorded; no production-profile acceptance"
    return {"kernel_enabled": enabled, "profile": profile, "scope": scope}


def log_platform():
    uname = run(["/usr/bin/uname", "-a"]).stdout.strip()
    systemd = run([SYSTEMCTL, "--version"]).stdout.splitlines()[0].strip()
    print(f"KERNEL_ARCH={uname}", flush=True)
    print(f"SYSTEMD_VERSION={systemd}", flush=True)
    print("OS_RELEASE_BEGIN", flush=True)
    print(Path("/etc/os-release").read_text(encoding="utf-8").strip(), flush=True)
    print("OS_RELEASE_END", flush=True)


def cgroup_empty(control_group):
    if not control_group or control_group == "/":
        return "unknown", None
    path = Path("/sys/fs/cgroup") / control_group.lstrip("/")
    events = path / "cgroup.events"
    if not path.exists():
        return "removed-by-systemd", str(path)
    values = dict(line.split() for line in events.read_text(encoding="ascii").splitlines())
    populated = values.get("populated")
    procs_file = path / "cgroup.procs"
    if not procs_file.exists():
        return "missing-cgroup.procs", str(path)
    procs = procs_file.read_text(encoding="ascii").split()
    state = "empty" if populated == "0" and not procs else f"populated={populated},procs={procs}"
    return state, str(path)


def filesystem_identity(value):
    return value.st_dev, value.st_ino


def parse_systemd_array(value):
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return value.split() if value else []


def parse_systemd_bind_paths(value):
    parsed = []
    for item in parse_systemd_array(value):
        ignore_missing = item.startswith("-")
        if ignore_missing:
            item = item[1:]
        fields = item.split(":")
        if len(fields) == 2:
            source, destination = fields
            option = ""
        elif len(fields) == 3:
            source, destination, option = fields
        else:
            raise RuntimeError(f"unparseable systemd bind path entry: {item!r}")
        if not source or not destination or option not in ("", "rbind", "norbind"):
            raise RuntimeError(f"invalid systemd bind path entry: {item!r}")
        parsed.append({
            "source": source,
            "destination": destination,
            "recursive": option == "rbind",
            "option": option,
            "ignore_missing": ignore_missing,
        })
    return parsed


def ensure_account():
    user_created = False
    group_created = False
    try:
        user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        user = None
        user_created = True
    try:
        group = grp.getgrnam(ACCOUNT)
    except KeyError:
        group = None
        group_created = True
        run(["/usr/sbin/groupadd", "--system", ACCOUNT])
        group = grp.getgrnam(ACCOUNT)
    if user_created:
        try:
            run([
                "/usr/sbin/useradd", "--system", "--gid", ACCOUNT,
                "--no-create-home", "--home-dir", "/nonexistent",
                "--shell", "/usr/sbin/nologin", ACCOUNT,
            ])
            user = pwd.getpwnam(ACCOUNT)
        except Exception:
            if group_created:
                run(["/usr/sbin/groupdel", ACCOUNT], check=False)
            raise
    return user, group, user_created, group_created


class StageZeroPreflightTest(unittest.TestCase):
    def test_positive_control_then_exact_sparse_proc_candidate(self):
        self.assertEqual(0, os.geteuid(), "stage-zero gate must run as root")
        for path in (SYSTEMD_RUN, SYSTEMCTL, JOURNALCTL, "/usr/bin/gcc"):
            self.assertTrue(Path(path).is_file(), f"missing Linux CI prerequisite: {path}")
        self.assertTrue(FIXTURE_SOURCE.is_file(), f"missing native fixture: {FIXTURE_SOURCE}")
        log_platform()

        user, group, user_created, group_created = ensure_account()
        print(
            "HARNESS_CONTEXT=privileged-root fixture orchestration and proc inspection; "
            "this is not capability-empty controller C/H integration and provides no production-controller proof",
            flush=True,
        )
        suffix = uuid.uuid4().hex[:12]
        api_unit = f"fg-index-preflight-api-{suffix}.service"
        control_unit = f"fg-index-preflight-control-{suffix}.service"
        candidate_unit = f"fg-index-preflight-candidate-{suffix}.service"
        units = (candidate_unit, control_unit, api_unit)
        tempdir = tempfile.mkdtemp(prefix="fg-index-stage-zero-")
        os.chmod(tempdir, 0o755)
        executable = Path(tempdir) / "process_identity_preflight"
        pinned_api_fd = None
        design_failure = None
        cleanup_errors = []
        recorded_cgroups = {}
        started_units = set()

        try:
            run([
                "/usr/bin/gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                str(FIXTURE_SOURCE), "-o", str(executable),
            ])
            executable.chmod(0o755)
            print(f"NATIVE_COMPILE=PASS output={executable}", flush=True)

            def record_cgroup(unit, props):
                control_group = props.get("ControlGroup", "")
                if not control_group:
                    return
                previous = recorded_cgroups.setdefault(unit, control_group)
                if previous != control_group:
                    raise RuntimeError(
                        f"{unit} ControlGroup changed during invocation: {previous} -> {control_group}"
                    )

            def api_snapshot(label, expected=None):
                props = show(api_unit)
                snapshot = {
                    "MainPID": props.get("MainPID", "0"),
                    "InvocationID": props.get("InvocationID", ""),
                    "ControlGroup": props.get("ControlGroup", ""),
                    "ActiveState": props.get("ActiveState", ""),
                }
                if not snapshot["MainPID"].isdigit() or int(snapshot["MainPID"]) <= 0 \
                        or not snapshot["InvocationID"] or not snapshot["ControlGroup"]:
                    raise RuntimeError(f"API identity snapshot {label} incomplete: {snapshot}")
                if snapshot["ActiveState"] != "active":
                    raise RuntimeError(f"API is not active at {label}: {snapshot}")
                record_cgroup(api_unit, props)
                if expected is not None and any(
                    snapshot[key] != expected[key]
                    for key in ("MainPID", "InvocationID", "ControlGroup")
                ):
                    raise RuntimeError(f"API identity changed at {label}: {expected} -> {snapshot}")
                print(f"API_{label}={snapshot}", flush=True)
                return snapshot

            def start_api():
                started_units.add(api_unit)
                run([
                    SYSTEMD_RUN, "--quiet", "--unit", api_unit, "--property=Type=exec",
                    f"--property=User={ACCOUNT}", f"--property=Group={ACCOUNT}",
                    "--property=CapabilityBoundingSet=", "--property=AmbientCapabilities=",
                    "--property=NoNewPrivileges=yes", "--property=RuntimeMaxSec=30s",
                    "/usr/bin/sleep", "30",
                ])
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    props = show(api_unit)
                    pid = int(props.get("MainPID", "0"))
                    if props.get("LoadState") == "loaded" and pid > 0:
                        record_cgroup(api_unit, props)
                        return api_snapshot("S0")
                    time.sleep(0.02)
                raise RuntimeError(f"API fixture did not acquire a MainPID: {show(api_unit)}")

            def run_fixture(unit, api_expected, *, candidate=False, bind=None, api_pid=None, api_fd=None):
                argv = [
                    SYSTEMD_RUN, "--quiet", "--no-block", "--unit", unit,
                    "--property=Type=exec", f"--property=User={ACCOUNT}",
                    f"--property=Group={ACCOUNT}", "--property=CapabilityBoundingSet=",
                    "--property=AmbientCapabilities=", "--property=NoNewPrivileges=yes",
                    "--property=LimitCORE=0", "--property=RemainAfterExit=yes",
                    f"--property=WorkingDirectory={tempdir}",
                    "--property=StandardOutput=journal", "--property=StandardError=journal",
                ]
                if candidate:
                    if not bind:
                        raise RuntimeError("candidate requires its single pinned API proc bind")
                    argv += ["--property=TemporaryFileSystem=/proc:ro",
                             f"--property=BindReadOnlyPaths={bind}"]
                argv.append(str(executable))
                started_units.add(unit)
                run(argv)
                api_snapshot(f"S1_{unit}", api_expected)

                deadline = time.monotonic() + 8
                observed = None
                while time.monotonic() < deadline:
                    props = show(unit)
                    record_cgroup(unit, props)
                    pid = int(props.get("MainPID", "0"))
                    if props.get("LoadState") == "loaded" and pid > 0:
                        try:
                            process_status = status(pid)
                            mounts = proc_mounts(pid)
                            aa = apparmor(pid)
                            observed = (props, pid, process_status, mounts, aa)
                            break
                        except (FileNotFoundError, ProcessLookupError):
                            pass
                    time.sleep(0.01)
                if observed is None:
                    raise RuntimeError(f"could not inspect live H process in {unit}: {show(unit)}")

                props, pid, process_status, mounts, aa = observed
                invocation_id = props.get("InvocationID", "")
                if not invocation_id or recorded_cgroups.get(unit) != props.get("ControlGroup"):
                    raise RuntimeError(f"live H lacks recorded invocation/cgroup identity: {props}")
                print(
                    f"LOADED_UNIT unit={unit} pid={pid} invocation={invocation_id} "
                    f"uid={process_status['Uid']} gid={process_status['Gid']} "
                    f"nnp={process_status['NoNewPrivs']} cap_eff={process_status['CapEff']} "
                    f"cap_prm={process_status['CapPrm']} cap_bnd={process_status['CapBnd']} "
                    f"cap_amb={process_status['CapAmb']}", flush=True,
                )
                print(f"LOADED_UNIT_PROPERTIES[{unit}]={props}", flush=True)
                print(f"APPARMOR[{unit}]={aa}", flush=True)
                print(f"ACTUAL_H_MOUNTINFO_PROC_SUBTREE[{unit}]={mounts}", flush=True)

                if int(process_status["Uid"].split()[0]) != user.pw_uid \
                        or int(process_status["Gid"].split()[0]) != group.gr_gid:
                    raise RuntimeError(f"H identity mismatch: {process_status}")
                if process_status["NoNewPrivs"] != "1":
                    raise RuntimeError(f"H lacks NNP: {process_status}")
                for field in ("CapEff", "CapPrm", "CapBnd", "CapAmb"):
                    if process_status[field] != "0000000000000000":
                        raise RuntimeError(f"H has nonempty {field}: {process_status}")
                if not props.get("InvocationID") or props.get("User") != ACCOUNT \
                        or props.get("Group") != ACCOUNT or props.get("NoNewPrivileges") != "yes":
                    raise RuntimeError(f"loaded H identity/security properties mismatch: {props}")

                if candidate:
                    proc_root = [row for row in mounts if row["mountpoint"] == "/proc"]
                    children = [row for row in mounts if row["mountpoint"].startswith("/proc/")]
                    target = f"/proc/{api_pid}"
                    expected_mount_root = f"/{api_pid}"
                    if api_fd is None:
                        raise RuntimeError("candidate has no retained API proc directory fd")
                    pinned_stat = os.fstat(api_fd)
                    host_api_stat = os.stat(f"/proc/{api_pid}")
                    bound_root_stat = os.stat(f"/proc/{pid}/root{target}")
                    if filesystem_identity(pinned_stat) != filesystem_identity(host_api_stat):
                        raise RuntimeError(
                            "pinned API proc fd no longer matches /proc/<A>: "
                            f"fd={(pinned_stat.st_dev, pinned_stat.st_ino)} "
                            f"path={(host_api_stat.st_dev, host_api_stat.st_ino)}"
                        )
                    if filesystem_identity(bound_root_stat) != filesystem_identity(pinned_stat):
                        raise RuntimeError(
                            "H bind root does not resolve to the pinned API proc fd: "
                            f"bound={(bound_root_stat.st_dev, bound_root_stat.st_ino)} "
                            f"fd={(pinned_stat.st_dev, pinned_stat.st_ino)}"
                        )
                    expected_device = f"{os.major(pinned_stat.st_dev)}:{os.minor(pinned_stat.st_dev)}"
                    print(
                        f"API_PROC_BIND_IDENTITY fd_dev_inode={pinned_stat.st_dev}:{pinned_stat.st_ino} "
                        f"host_A_dev_inode={host_api_stat.st_dev}:{host_api_stat.st_ino} "
                        f"H_bound_A_dev_inode={bound_root_stat.st_dev}:{bound_root_stat.st_ino} "
                        f"expected_mount_root={expected_mount_root} "
                        f"mountinfo_root={children[0]['root'] if children else 'missing'} "
                        f"mountinfo_device={children[0]['device'] if children else 'missing'} "
                        f"expected_device={expected_device}", flush=True,
                    )
                    if len(proc_root) != 1 or proc_root[0]["filesystem"] != "tmpfs" \
                            or "ro" not in proc_root[0]["mount_options"]:
                        raise RuntimeError(f"H /proc is not the requested read-only tmpfs: {mounts}")
                    if len(children) != 1 or children[0]["mountpoint"] != target \
                            or children[0]["filesystem"] != "proc" \
                            or "ro" not in children[0]["mount_options"] \
                            or children[0]["root"] != expected_mount_root \
                            or children[0]["device"] != expected_device:
                        raise RuntimeError(f"H /proc subtree has extra or incorrect binds: {mounts}")
                    source, destination = bind.split(":", 1)
                    parsed_binds = parse_systemd_bind_paths(props.get("BindReadOnlyPaths", ""))
                    expected_bind = [{
                        "source": source,
                        "destination": destination,
                        "recursive": True,
                        "option": "rbind",
                        "ignore_missing": False,
                    }]
                    print(
                        f"BIND_PROPERTY_CANONICAL raw={props.get('BindReadOnlyPaths', '')!r} "
                        f"parsed={parsed_binds}", flush=True,
                    )
                    if parsed_binds != expected_bind:
                        raise RuntimeError(
                            "loaded BindReadOnlyPaths must contain exactly the requested source and "
                            f"destination with systemd's recursive rbind semantics: {props}"
                        )
                    if parse_systemd_array(props.get("TemporaryFileSystem", "")) != ["/proc:ro"]:
                        raise RuntimeError(f"loaded TemporaryFileSystem does not include /proc:ro: {props}")

                deadline = time.monotonic() + 8
                finished = {}
                while time.monotonic() < deadline:
                    finished = show(unit)
                    record_cgroup(unit, finished)
                    main_pid = finished.get("MainPID", "0")
                    if finished.get("ActiveState") == "failed" or (
                        finished.get("ActiveState") == "active"
                        and finished.get("SubState") == "exited"
                        and main_pid == "0"
                        and finished.get("ExecMainCode")
                    ):
                        break
                    time.sleep(0.02)
                else:
                    raise RuntimeError(f"H fixture did not finish: {unit}")

                api_snapshot(f"S2_{unit}", api_expected)
                logs = run([
                    JOURNALCTL, "--unit", unit, "--no-pager", "--output=cat",
                    f"_SYSTEMD_INVOCATION_ID={invocation_id}",
                ], check=False)
                print(f"FIXTURE_RAW_OUTPUT[{unit}]\n{logs.stdout}{logs.stderr}", flush=True)
                raw_status = int(finished.get("ExecMainStatus", "-1"))
                print(
                    f"RAW_FIXTURE_EXIT[{unit}] result={finished.get('Result')} "
                    f"code={finished.get('ExecMainCode')} status={raw_status} "
                    f"main_pid={finished.get('ExecMainPID') or pid} "
                    f"invocation={finished.get('InvocationID')}", flush=True,
                )
                if logs.returncode:
                    raise RuntimeError(f"cannot read raw fixture output: {logs.stderr.strip()}")
                if finished.get("ExecMainCode") != "1":
                    raise RuntimeError(f"fixture did not exit normally: {finished}")
                if str(finished.get("ExecMainPID")) != str(pid) \
                        or finished.get("InvocationID") != invocation_id:
                    raise RuntimeError(f"completed H identity differs from live H snapshot: {finished}")
                output = logs.stdout + logs.stderr
                common = re.findall(
                    r"^scope=self-proc-visibility-only uid=(\d+) gid=(\d+) "
                    r"dumpable=(\d+) native_caps=(\w+) post_entry_exec=(\w+)$",
                    output, re.MULTILINE,
                )
                if common != [(str(user.pw_uid), str(group.gr_gid), "0", "EMPTY", "DENIED")]:
                    raise RuntimeError(f"journal lacks one complete initial hardening record: {output}")
                pass_lines = [line for line in output.splitlines()
                              if line.startswith("self-proc-visibility=PASS ")]
                fail_lines = [line for line in output.splitlines()
                              if line.startswith("self-proc-visibility=FAIL ")]
                observation_failures = [line for line in output.splitlines()
                                        if line.startswith("self-observation=FAIL ")]
                if raw_status == 0:
                    if len(pass_lines) != 1 or fail_lines or observation_failures:
                        raise RuntimeError(f"exit zero lacks a unique complete self-only PASS record: {output}")
                    if not re.search(
                        r"^self-proc-visibility=PASS scope=self-only .*fdinfo_entries=[1-9][0-9]*; "
                        r"no cross-process identity or channel proof$",
                        pass_lines[0],
                    ):
                        raise RuntimeError(f"self-only PASS record is incomplete/truncated: {output}")
                    if not candidate:
                        print(f"STAGE_ZERO_CONTROL=PASS scope=self-only unit={unit}", flush=True)
                    else:
                        print(f"STAGE_ZERO_RESULT=PASS scope=self-only unit={unit}; no later matrix executed", flush=True)
                else:
                    if len(fail_lines) != 1 or pass_lines or not observation_failures:
                        raise RuntimeError(f"nonzero exit lacks complete self-observation failure evidence: {output}")
                    if not re.search(
                        r"^self-proc-visibility=FAIL failures=[1-9][0-9]*; "
                        r"no cross-process identity or channel proof$",
                        fail_lines[0],
                    ):
                        raise RuntimeError(f"self-observation failure record is incomplete/truncated: {output}")
                    if not candidate:
                        raise RuntimeError("normal-/proc positive control failed; candidate was not run")
                    print(
                        "DESIGN_GATE=FAIL: nonzero native fixture status is preserved; "
                        "the negative outcome is not counted as a passing test.", flush=True,
                    )
                    raise AssertionError(
                        "FAILED DESIGN GATE: exact sparse-/proc candidate failed self observation "
                        f"with raw fixture exit status {raw_status}."
                    )
                return finished

            try:
                api = start_api()
                api_pid = int(api["MainPID"])
                host_api_stat = os.stat(f"/proc/{api_pid}")
                api_fd = os.open(f"/proc/{api_pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                pinned_api_fd = api_fd
                pinned_api_stat = os.fstat(api_fd)
                if filesystem_identity(host_api_stat) != filesystem_identity(pinned_api_stat):
                    raise RuntimeError(
                        "opened API proc fd does not match initial path stat: "
                        f"path={(host_api_stat.st_dev, host_api_stat.st_ino)} "
                        f"fd={(pinned_api_stat.st_dev, pinned_api_stat.st_ino)}"
                    )
                api_snapshot("S0b", api)
                bind = f"/proc/{os.getpid()}/fd/{api_fd}:/proc/{api_pid}"
                print(
                    f"PINNED_API_TARGET unit={api_unit} pid={api_pid} "
                    f"invocation={api['InvocationID']} uid={user.pw_uid} gid={group.gr_gid} "
                    f"proc_fd={api_fd} bind={bind} "
                    f"dev_inode={pinned_api_stat.st_dev}:{pinned_api_stat.st_ino}", flush=True,
                )
                run_fixture(control_unit, api)
                run_fixture(
                    candidate_unit, api, candidate=True, bind=bind,
                    api_pid=api_pid, api_fd=api_fd,
                )
            except AssertionError as error:
                design_failure = error
            except Exception as error:
                cleanup_errors.append(f"infrastructure failure: {error}")
        finally:
            if pinned_api_fd is not None:
                try:
                    os.close(pinned_api_fd)
                except OSError as error:
                    cleanup_errors.append(f"close pinned API proc fd: {error}")
            deferred_reset_gc = {}
            for unit in units:
                try:
                    before = show(unit)
                    if before and before.get("ActiveState") not in ("inactive", "failed"):
                        stopped = run([SYSTEMCTL, "stop", unit], check=False, timeout=15)
                        if stopped.returncode:
                            cleanup_errors.append(f"stop {unit}: {stopped.stderr.strip()}")
                    state = show(unit)
                    if state:
                        if state.get("MainPID", "0") != "0":
                            cleanup_errors.append(f"unit still has MainPID after stop {unit}: {state}")
                        if state.get("LoadState") == "loaded" and state.get("ActiveState") == "failed":
                            reset = run([SYSTEMCTL, "reset-failed", unit], check=False)
                            if reset.returncode:
                                after_reset = show(unit)
                                not_loaded = any(
                                    marker in reset.stderr.lower()
                                    for marker in ("not loaded", "could not be found")
                                )
                                if after_reset.get("LoadState") == "loaded" or not not_loaded:
                                    cleanup_errors.append(
                                        f"reset-failed {unit}: {reset.stderr.strip()}"
                                    )
                                else:
                                    deferred_reset_gc[unit] = reset.stderr.strip()
                    original_cgroup = recorded_cgroups.get(unit)
                    if original_cgroup:
                        empty, path = cgroup_empty(original_cgroup)
                        print(
                            f"CGROUP_EMPTY[{unit}] original={original_cgroup} state={empty} path={path}",
                            flush=True,
                        )
                        if empty not in ("empty", "removed-by-systemd"):
                            cleanup_errors.append(
                                f"original cgroup is not empty {unit} {original_cgroup}: {empty}"
                            )
                        if unit in deferred_reset_gc:
                            if empty in ("empty", "removed-by-systemd"):
                                print(
                                    f"RESET_FAILED_UNIT_GC[{unit}] cgroup={empty} "
                                    f"detail={deferred_reset_gc[unit]}", flush=True,
                                )
                            else:
                                cleanup_errors.append(
                                    f"reset-failed {unit} raced unit GC before cgroup proof: "
                                    f"{deferred_reset_gc[unit]}"
                                )
                    elif unit in started_units:
                        cleanup_errors.append(f"no live ControlGroup was recorded for started unit {unit}")
                        if unit in deferred_reset_gc:
                            cleanup_errors.append(
                                f"reset-failed {unit} could not be verified after unit GC: "
                                f"{deferred_reset_gc[unit]}"
                            )
                    else:
                        print(f"CGROUP_EMPTY[{unit}] state=unit-never-started", flush=True)
                except Exception as error:
                    cleanup_errors.append(f"cleanup {unit}: {error}")
            try:
                shutil.rmtree(tempdir)
            except OSError as error:
                cleanup_errors.append(f"remove fixture tempdir: {error}")
            if user_created and not cleanup_errors:
                result = run(["/usr/sbin/userdel", ACCOUNT], check=False)
                if result.returncode:
                    cleanup_errors.append(f"userdel {ACCOUNT}: {result.stderr.strip()}")
                else:
                    try:
                        pwd.getpwnam(ACCOUNT)
                    except KeyError:
                        pass
                    else:
                        cleanup_errors.append(f"fixture-created user {ACCOUNT} still exists after userdel")
            if group_created and not cleanup_errors:
                try:
                    grp.getgrnam(ACCOUNT)
                except KeyError:
                    pass
                else:
                    result = run(["/usr/sbin/groupdel", ACCOUNT], check=False)
                    if result.returncode:
                        cleanup_errors.append(f"groupdel {ACCOUNT}: {result.stderr.strip()}")
                    else:
                        try:
                            grp.getgrnam(ACCOUNT)
                        except KeyError:
                            pass
                        else:
                            cleanup_errors.append(f"fixture-created group {ACCOUNT} still exists after groupdel")

        failures = []
        if design_failure is not None:
            failures.append(f"FAILED DESIGN GATE: {design_failure}")
        if cleanup_errors:
            failures.append("FAIL CLOSED: infrastructure/cleanup error(s):\n" + "\n".join(cleanup_errors))
        if failures:
            self.fail("\n\n".join(failures))


if __name__ == "__main__":
    unittest.main(verbosity=2)
