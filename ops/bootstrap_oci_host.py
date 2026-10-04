#!/usr/bin/env python3
"""Safely prepare the fg-index OCI host without activating the application."""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence


GROUP = "fg-index"
USER = "fg-index"
SERVICE = "fg-index-api.service"
SERVICE_SOURCE = Path("ops/oci/fg-index-api.service")
PROMOTER_SOURCE = Path("ops/promote_api_release.py")
SERVICE_TARGET = Path("/etc/systemd/system/fg-index-api.service")
PROMOTER_TARGET = Path("/usr/local/libexec/fg-index-release-promoter/promote_api_release.py")
MANAGED_DIRS = {
    Path("/var/lib/fg-index"): (USER, GROUP, 0o750),
    Path("/opt/fg-index"): ("root", GROUP, 0o750),
    Path("/opt/fg-index/releases"): ("root", GROUP, 0o750),
    Path("/etc/fg-index"): ("root", GROUP, 0o750),
    Path("/usr/local/libexec/fg-index-release-promoter"): ("root", "root", 0o755),
}
RESERVED_CURRENT = Path("/opt/fg-index/current")
ENV_FILE = Path("/etc/fg-index/api.env")
BOOTSTRAP_SOURCE = Path("ops/bootstrap_oci_host.py")
SOURCE_HASHES = {
    SERVICE_SOURCE: "9cb776ed9cf94d692ec9afbe44b92a6de92320a645034e9778712df2200d4dcd",
    PROMOTER_SOURCE: "41ad26d7a79978feda663f9e0a5b08dc0a8608599223de082345fd65ba03c3d0",
}
COMMANDS = {
    "systemctl": "/usr/bin/systemctl",
    "groupadd": "/usr/sbin/groupadd",
    "useradd": "/usr/sbin/useradd",
}
FORWARD_RELATIONS = ("Triggers", "Wants", "Requires", "BindsTo", "Upholds", "Requisite", "PartOf", "OnFailure", "OnSuccess")
REVERSE_RELATIONS = ("TriggeredBy", "RequiredBy", "WantedBy", "BoundBy", "UpheldBy", "RequisiteOf", "ConsistsOf", "OnFailureOf", "OnSuccessOf")
UNIT_NAME = re.compile(r"^[A-Za-z0-9_.:@\\-]+\.[a-z]+$")
MAX_UNITS = 2048


class BootstrapError(RuntimeError):
    """A prerequisite is missing or existing host state is unsafe to change."""


@dataclass(frozen=True)
class Identity:
    uid: int
    gid: int
    members: tuple[str, ...] = ()


class HostBootstrap:
    """Two-phase preflight and apply for the non-secret, inactive host setup."""

    def __init__(
        self,
        repo_root: Path,
        *,
        root: Path = Path("/"),
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        uid: int | None = None,
        group_lookup: Callable[[str], Identity | None] | None = None,
        user_lookup: Callable[[str], tuple[int, int, str, str] | None] | None = None,
        metadata: Callable = Path.lstat,
        source_hashes: dict[Path, str] | None = None,
        memberships: Callable[[str, int], list[int]] = os.getgrouplist,
        passwd_lookup: Callable = pwd.getpwall,
        groups_lookup: Callable = grp.getgrall,
        xattrs: Callable | None = None,
    ) -> None:
        self.repo_root = repo_root
        self.root = root
        self.runner = runner
        self.uid = os.geteuid() if uid is None else uid
        self.group_lookup = group_lookup or self._lookup_group
        self.user_lookup = user_lookup or self._lookup_user
        self.metadata = metadata
        self.source_hashes = SOURCE_HASHES if source_hashes is None else source_hashes
        self.memberships = memberships
        self.passwd_lookup = passwd_lookup
        self.groups_lookup = groups_lookup
        self.xattrs = xattrs or getattr(os, "listxattr", None)

    def _path(self, absolute: Path) -> Path:
        return self.root / absolute.relative_to("/")

    @staticmethod
    def _lookup_group(name: str) -> Identity | None:
        try:
            record = grp.getgrnam(name)
        except KeyError:
            return None
        return Identity(uid=-1, gid=record.gr_gid, members=tuple(record.gr_mem))

    @staticmethod
    def _lookup_user(name: str) -> tuple[int, int, str, str] | None:
        try:
            record = pwd.getpwnam(name)
        except KeyError:
            return None
        return record.pw_uid, record.pw_gid, record.pw_dir, record.pw_shell

    def _run(self, args: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        try:
            result = self.runner(
                [COMMANDS[args[0]], *args[1:]],
                check=False,
                capture_output=True,
                text=True,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BootstrapError(f"could not run {args[0]}: {error}") from error
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
            raise BootstrapError(f"{args[0]} failed: {detail}")
        return result

    def _safe_existing_directory(self, path: Path, *, owner: int, group: int | None) -> None:
        try:
            metadata = self.metadata(path)
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(metadata.st_mode):
            raise BootstrapError(f"expected a real directory, refusing to replace: {path}")
        if metadata.st_uid != owner:
            raise BootstrapError(f"directory is not owned by the expected account: {path}")
        if group is not None and metadata.st_gid != group:
            raise BootstrapError(f"directory has an unexpected group: {path}")
        if metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise BootstrapError(f"directory is group- or world-writable: {path}")
        self._reject_acl(path)

    def _reject_acl(self, path: Path) -> None:
        if self.xattrs is None:
            raise BootstrapError("POSIX ACL metadata inspection is unavailable on this platform")
        try:
            names = self.xattrs(path, follow_symlinks=False)
        except OSError as error:
            raise BootstrapError(f"cannot inspect POSIX ACL metadata: {path}") from error
        if {"system.posix_acl_access", "system.posix_acl_default"} & set(names):
            raise BootstrapError(f"extended POSIX ACL is not allowed on bootstrap paths: {path}")

    def _safe_existing_file(self, path: Path, expected: bytes, *, owner: int, group: int) -> None:
        try:
            metadata = self.metadata(path)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(metadata.st_mode):
            raise BootstrapError(f"expected a regular file, refusing to replace: {path}")
        if metadata.st_uid != owner or metadata.st_gid != group:
            raise BootstrapError(f"file has unexpected ownership: {path}")
        if metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise BootstrapError(f"file is group- or world-writable: {path}")
        self._reject_acl(path)
        if metadata.st_size != len(expected):
            raise BootstrapError(f"existing file differs from reviewed source; refusing to overwrite: {path}")
        if path.read_bytes() != expected:
            raise BootstrapError(f"existing file differs from reviewed source; refusing to overwrite: {path}")

    def _preflight_ancestors(self, absolute: Path) -> None:
        for parent in reversed(absolute.parents):
            if parent == Path("/"):
                continue
            path = self._path(parent)
            if not path.exists() and not path.is_symlink():
                continue
            # Managed ancestors are checked for their exact group later. System
            # parents need root ownership and no group/other write permissions.
            self._safe_existing_directory(path, owner=0, group=None)

    def _read_sources(self) -> tuple[bytes, bytes]:
        for relative in (BOOTSTRAP_SOURCE, SERVICE_SOURCE, PROMOTER_SOURCE):
            path = self.repo_root / relative
            for parent in reversed(path.parents):
                if parent == self.root or self.root in parent.parents:
                    self._safe_existing_directory(parent, owner=0, group=None)
            metadata = self.metadata(path)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
                raise BootstrapError(f"source must be a root-owned non-writable regular file: {path}")
            self._reject_acl(path)
        contents = []
        for relative in (SERVICE_SOURCE, PROMOTER_SOURCE):
            digest = self.source_hashes[relative]
            path = self.repo_root / relative
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as source:
                content = source.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024 or hashlib.sha256(content).hexdigest() != digest:
                raise BootstrapError(f"source SHA-256 does not match reviewed code: {relative}")
            contents.append(content)
        return contents[0], contents[1]

    def _service_state(self, *, installed: bool, allow_unloaded: bool = False) -> None:
        active = self._run(("systemctl", "is-active", SERVICE), check=False)
        enabled = self._run(("systemctl", "is-enabled", SERVICE), check=False)
        if installed and not allow_unloaded:
            valid = (
                active.returncode == 3 and active.stdout.strip() == "inactive"
                and enabled.returncode == 1 and enabled.stdout.strip() == "disabled"
            )
        else:
            valid = (
                active.returncode in (3, 4) and active.stdout.strip() in ("inactive", "unknown")
                and enabled.returncode in (1, 4) and enabled.stdout.strip() in ("disabled", "not-found", "")
            )
        if not valid:
            raise BootstrapError(f"API service must be disabled and inactive (active={active.stdout.strip()}, enabled={enabled.stdout.strip()})")
        shown = self._run((
            "systemctl", "show", SERVICE, "--all", "--property=LoadState",
            "--property=FragmentPath", "--property=DropInPaths",
            *(f"--property={name}" for name in REVERSE_RELATIONS),
        ))
        fields = dict(line.split("=", 1) for line in shown.stdout.splitlines() if "=" in line)
        expected_states = [("loaded", str(SERVICE_TARGET))] if installed else [("not-found", "")]
        if installed and allow_unloaded:
            expected_states.append(("not-found", ""))
        if (fields.get("LoadState"), fields.get("FragmentPath")) not in expected_states or fields.get("DropInPaths") != "":
            raise BootstrapError("API unit is supplied elsewhere, has drop-ins, or cannot be reliably inspected")
        if any(fields.get(name) != "" for name in REVERSE_RELATIONS):
            raise BootstrapError("API service has activation relationships or unsupported inspection properties")

    def _activation_safety(self) -> None:
        """Refuse existing activators, including unloaded installed definitions."""
        # Cached DropInPaths can lag disk changes until daemon-reload. Inspect
        # every manager search path, including dash prefixes and type defaults.
        unit_paths = self._run(("systemctl", "show", "--property=UnitPath", "--value")).stdout.split()
        if not unit_paths or len(unit_paths) > 64 or any(not Path(path).is_absolute() for path in unit_paths):
            raise BootstrapError("systemd unit search paths cannot be reliably inspected")
        dropins = ("fg-index-api.service.d", "fg-index-.service.d", "fg-.service.d", "service.d")
        for unit_path in unit_paths:
            for name in dropins:
                path = self._path(Path(unit_path) / name)
                if path.exists() or path.is_symlink():
                    raise BootstrapError(f"on-disk API drop-in directory requires separate review: {path}")
        names: set[str] = set()
        for verb in ("list-unit-files", "list-units"):
            args = ["systemctl", verb, "--no-legend", "--no-pager", "--plain"]
            if verb == "list-units":
                args.append("--all")
            for line in self._run(args).stdout.splitlines():
                if line.strip():
                    names.add(line.split()[0])
        jobs = self._run(("systemctl", "list-jobs", "--no-legend", "--no-pager"))
        for line in jobs.stdout.splitlines():
            if not line.strip():
                continue
            fields = line.split()
            if len(fields) < 3 or not fields[0].isdigit():
                raise BootstrapError("cannot reliably inspect pending systemd jobs")
            if fields[1] == SERVICE:
                raise BootstrapError("API service has a pending systemd job")
            names.add(fields[1])
        if len(names) > MAX_UNITS or any(not UNIT_NAME.fullmatch(name) for name in names):
            raise BootstrapError("systemd unit inventory is invalid or exceeds its inspection bound")
        if names & {"fg-index-api.timer", "fg-index-api.socket", "fg-index-api.path"}:
            raise BootstrapError("matching API timer/socket/path unit exists")
        # Uninstantiated templates cannot run. Installed instances and loaded
        # transient units are inspected; future administrator changes are not.
        units = sorted(name for name in names if "@." not in name)
        properties = ("Id", *FORWARD_RELATIONS)
        for offset in range(0, len(units), 64):
            batch = units[offset:offset + 64]
            shown = self._run((
                "systemctl", "show", "--all",
                *(f"--property={name}" for name in properties), "--", *batch,
            ))
            blocks = [block for block in shown.stdout.strip().split("\n\n") if block.strip()]
            if len(blocks) != len(batch):
                raise BootstrapError("cannot reliably inspect systemd activation inventory")
            for block in blocks:
                fields = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
                if any(name not in fields for name in properties):
                    raise BootstrapError("systemd activation inspection properties are unavailable")
                if any(SERVICE in fields[name].split() for name in FORWARD_RELATIONS):
                    raise BootstrapError(f"external unit can activate or control API service: {fields['Id']}")

    def _validate_group(self, group: Identity) -> None:
        if not 0 < group.gid < 1000 or group.members:
            raise BootstrapError("existing fg-index group must be a dedicated system group without explicit members")
        primary_users = {
            entry.pw_name for entry in self.passwd_lookup() if entry.pw_gid == group.gid
        }
        if primary_users - {USER}:
            raise BootstrapError("fg-index group is the primary group of another account")
        aliases = {
            entry.gr_name for entry in self.groups_lookup()
            if entry.gr_gid == group.gid and entry.gr_name != GROUP
        }
        if aliases:
            raise BootstrapError("fg-index group GID is shared with another group name")

    def _validate_user(self, user: tuple[int, int, str, str], group: Identity) -> None:
        uid, gid, home, shell = user
        if gid != group.gid or home != "/var/lib/fg-index" or shell != "/usr/sbin/nologin":
            raise BootstrapError("existing fg-index account does not match the reviewed system identity")
        if not 0 < uid < 1000:
            raise BootstrapError("existing fg-index account is not a system account")
        if set(self.memberships(USER, gid)) != {gid}:
            raise BootstrapError("fg-index account must not have supplementary groups")
        if any(entry.pw_uid == uid and entry.pw_name != USER for entry in self.passwd_lookup()):
            raise BootstrapError("fg-index UID is shared with another account name")

    def _preflight(self) -> tuple[Identity | None, tuple[int, int, str, str] | None, bytes, bytes]:
        if sys.platform != "linux":
            raise BootstrapError("host bootstrap requires Linux")
        if sys.version_info < (3, 12):
            raise BootstrapError("host bootstrap requires Python 3.12 or newer")
        if not (self.root / "run/systemd/system").is_dir():
            raise BootstrapError("systemd is not running on this host")
        for command, path in COMMANDS.items():
            if not os.access(self._path(Path(path)), os.X_OK):
                raise BootstrapError(f"required host command is unavailable: {command}")
        service_source, promoter_source = self._read_sources()
        if b"[Install]" not in service_source or b"WantedBy=multi-user.target" not in service_source:
            raise BootstrapError("reviewed service unit must be installable for a later explicit enable")

        group = self.group_lookup(GROUP)
        user = self.user_lookup(USER)
        if group is not None:
            self._validate_group(group)
        if group is not None and user is not None:
            self._validate_user(user, group)
        elif user is not None:
            raise BootstrapError("fg-index user exists without its dedicated group")

        if self._path(RESERVED_CURRENT).exists() or self._path(RESERVED_CURRENT).is_symlink():
            raise BootstrapError("/opt/fg-index/current already exists; refusing to alter release activation state")

        group_gid = group.gid if group is not None else None
        for absolute, (_owner_name, _group_name, _mode) in MANAGED_DIRS.items():
            self._preflight_ancestors(absolute)
            path = self._path(absolute)
            expected_gid = group_gid if _group_name == GROUP else 0
            if path.exists() or path.is_symlink():
                if _group_name == GROUP and group_gid is None:
                    raise BootstrapError(f"{absolute} exists before its dedicated group; refusing uncertain ownership")
                expected_uid = 0
                if _owner_name == USER:
                    if user is None:
                        raise BootstrapError(f"{absolute} exists before its dedicated user; refusing uncertain ownership")
                    expected_uid = user[0]
                self._safe_existing_directory(path, owner=expected_uid, group=expected_gid)

        self._preflight_ancestors(SERVICE_TARGET)
        if not self._path(SERVICE_TARGET.parent).is_dir():
            raise BootstrapError("systemd unit directory /etc/systemd/system is unavailable")

        self._safe_existing_file(
            self._path(SERVICE_TARGET),
            service_source,
            owner=0,
            group=0,
        )
        for target, mode in ((SERVICE_TARGET, 0o644), (PROMOTER_TARGET, 0o755)):
            path = self._path(target)
            if path.exists() and stat.S_IMODE(self.metadata(path).st_mode) != mode:
                raise BootstrapError(f"existing file has unexpected mode: {target}")
        self._safe_existing_file(
            self._path(PROMOTER_TARGET),
            promoter_source,
            owner=0,
            group=0,
        )

        env_path = self._path(ENV_FILE)
        if env_path.exists() or env_path.is_symlink():
            if group_gid is None:
                raise BootstrapError("api.env exists before the dedicated group; refusing uncertain access controls")
            metadata = self.metadata(env_path)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0:
                raise BootstrapError("existing api.env must be a root-owned regular file")
            if stat.S_IMODE(metadata.st_mode) != 0o640:
                raise BootstrapError("existing api.env must be group-read-only and inaccessible to other users")
            if metadata.st_gid != group_gid:
                raise BootstrapError("existing api.env must belong to group fg-index")
            self._reject_acl(env_path)

        self._activation_safety()
        self._service_state(installed=self._path(SERVICE_TARGET).exists(), allow_unloaded=True)

        return group, user, service_source, promoter_source

    def plan(self) -> list[str]:
        group, user, _service, _promoter = self._preflight()
        actions = []
        if group is None:
            actions.append("create system group fg-index")
        if user is None:
            actions.append("create system user fg-index with /var/lib/fg-index home and nologin shell")
        actions.extend(
            f"ensure {path} {owner_name}:{group_name} mode {mode:04o}"
            for path, (owner_name, group_name, mode) in MANAGED_DIRS.items()
        )
        actions.append("install reviewed fg-index-api.service and reload systemd without enabling or starting it")
        actions.append("install reviewed promoter helper under /usr/local/libexec without running it")
        actions.append("verify the API unit remains disabled and inactive")
        actions.append("leave api.env, releases, current, Caddy, firewall, timers, schedulers, and OCI settings untouched")
        return actions

    def apply(self) -> None:
        if self.uid != 0:
            raise BootstrapError("--apply requires root")
        self._preflight()
        lock_path = self._path(Path("/run/fg-index-host-bootstrap.lock"))
        self._preflight_ancestors(lock_path)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            metadata = os.fstat(lock.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise BootstrapError("bootstrap lock must be a private root-owned regular file")
            self._reject_acl(lock_path)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            self._apply_locked()

    def _apply_locked(self) -> None:
        group, user, service_source, promoter_source = self._preflight()
        if group is None:
            self._run(("groupadd", "--system", GROUP))
            group = self.group_lookup(GROUP)
            if group is None:
                raise BootstrapError("groupadd succeeded but fg-index group cannot be resolved")
        if user is None:
            self._run(
                (
                    "useradd",
                    "--system",
                    "--no-create-home",
                    "--home-dir",
                    "/var/lib/fg-index",
                    "--shell",
                    "/usr/sbin/nologin",
                    "--gid",
                    GROUP,
                    USER,
                )
            )
        resolved_user = self.user_lookup(USER)
        group = self.group_lookup(GROUP)
        if resolved_user is None or group is None:
            raise BootstrapError("fg-index user was not created with the dedicated primary group")
        self._validate_group(group)
        self._validate_user(resolved_user, group)
        for absolute, (owner_name, group_name, mode) in MANAGED_DIRS.items():
            path = self._path(absolute)
            path.mkdir(mode=mode, parents=True, exist_ok=True)
            uid = 0 if owner_name == "root" else resolved_user[0]
            gid = group.gid if group_name == GROUP else 0
            os.chown(path, uid, gid)
            os.chmod(path, mode)

        service_path = self._path(SERVICE_TARGET)
        promoter_path = self._path(PROMOTER_TARGET)
        self._install_file(service_path, service_source, 0o644)
        self._install_file(promoter_path, promoter_source, 0o755)
        self._run(("systemctl", "daemon-reload"))
        self._activation_safety()
        self._service_state(installed=True)

    @staticmethod
    def _install_file(path: Path, content: bytes, mode: int) -> None:
        if path.exists():
            return
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.bootstrap-", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.chown(temporary, 0, 0)
            os.chmod(temporary, mode)
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply the reviewed bootstrap; default is dry-run")
    args = parser.parse_args()
    bootstrap = HostBootstrap(Path(__file__).resolve().parents[1])
    try:
        if args.apply:
            bootstrap.apply()
            print("Bootstrap complete. The API unit remains disabled and inactive.")
        else:
            print("Dry run; no changes made:")
            for action in bootstrap.plan():
                print(f"- {action}")
    except (BootstrapError, OSError) as error:
        print(f"bootstrap: ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
