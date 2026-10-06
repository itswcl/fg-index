#!/usr/bin/env python3
"""Replace the reviewed OCI deployment guard/watchdog layout with simple install/restart."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
BOOT_GUARD_DROPIN_SHA = "383944c2d514d749696c406d2947b1246dd357391887d9677b0ee340e7c493c2"
SCHEDULER_OWNER_DROPIN_SHA = "32452cac8814231866521e8e5af192f7aa4df9b12573309ac071e499b8bcef64"
INSTALLED_DEPLOY_SHA = "a3355366163acfcfb10bdd76b38254e194eac339a238d6416696b4a770dc4ad9"
INSTALLED_RETENTION_SHA = "7ac75bcbef9d9a4ae973c81481a3bdcc5e32894daff4c6ea93d4b25b81a66ec4"
INSTALLED_PROMOTER_SHA = "41ad26d7a79978feda663f9e0a5b08dc0a8608599223de082345fd65ba03c3d0"
INSTALLED_POLLER_SHA = "1a1bd8f161cdc7c4fce82ed5137aa1de9b0c4f8868bb82ffd9155e5d3c180700"
OLD_UNIT_HASHES = {
    "fg-index-api.service": "9cb776ed9cf94d692ec9afbe44b92a6de92320a645034e9778712df2200d4dcd",
    "fg-index-api.service.d/20-deployment-boot-guard.conf": BOOT_GUARD_DROPIN_SHA,
    "fg-index-api-boot-guard.service": "f3bbab2cc5bb102d23c4c8db0729401a4864d1d1d4213e30819a3e77fce108c0",
    "fg-index-deployment.service": "bcee51eb27bb4b34ebb60eb5888d059b13328046d54736448b204250aa798405",
    "fg-index-deployment.timer": "97cbee4a81acabbbe90c3b04fa62817c1215b4dae56985ca8dc85320d6cfd262",
    "fg-index-deployment-recovery.service": "0fbf68c84119f49b22abe690df9f0e7ea2ed9fbf4d0263e1175fda8b8e20a41d",
    "fg-index-deployment-watchdog.service": "def72d4208133eaba360ad9f89eda53e5d30baf203fda4fca33075d8b572cee4",
    "fg-index-deployment-watchdog.timer": "a44714588e371a1c5148ec28b014e84b827b5c9874c02521764e70d9b3c093bc",
    "fg-index-release-poller.service": "3cfe85df2b443acac6310b3c2aee4175f8ae8d4d58e8ec754334343665737fe1",
    "fg-index-release-poller.timer": "d6b7c0d13e41d9addc96767702598ad8de197bf6a5e7df532efa186d595be4ae",
    "fg-index-release-retire@.service": "fc4e633ca9501b5bd51e63ff29bc05797695086a94bd5a4891212d904909e24f",
}
LEGACY_TIMERS = ("fg-index-deployment.timer", "fg-index-deployment-watchdog.timer", "fg-index-release-poller.timer")
LEGACY_SERVICES = (
    "fg-index-deployment.service",
    "fg-index-deployment-watchdog.service",
    "fg-index-deployment-recovery.service",
    "fg-index-api-boot-guard.service",
    "fg-index-release-poller.service",
)


class TransitionError(RuntimeError):
    pass


def require(ok: bool, message: str) -> None:
    if not ok:
        raise TransitionError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def release_inventory(root: Path, group_id: int, owner_uid: int = 0) -> str:
    require(not root.is_symlink() and root.is_dir(), "accepted release is not a real directory")
    root_info = root.lstat()
    require(root_info.st_uid == owner_uid and root_info.st_gid == group_id and not root_info.st_mode & 0o022,
            "accepted release root ownership or permissions differ from policy")
    require(not any(item.startswith("system.posix_acl") for item in os.listxattr(root, follow_symlinks=False)),
            "accepted release root has an unexpected ACL")
    digest = hashlib.sha256()
    count = total = 0
    deadline = time.monotonic() + 90
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            count += 1
            require(count <= 100_000 and time.monotonic() < deadline, "release inventory exceeded its entry/time budget")
            require(info.st_uid == owner_uid and info.st_gid == group_id, "accepted release ownership differs from root:fg-index")
            require(not any(item.startswith("system.posix_acl") for item in os.listxattr(path, follow_symlinks=False)),
                    "accepted release has an unexpected ACL")
            relative = str(path.relative_to(root))
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
                require(total <= 4 * 1024**3, "accepted release exceeds its inventory byte budget")
                content = sha256_file(path)
            elif stat.S_ISDIR(info.st_mode):
                content = "directory"
            elif stat.S_ISLNK(info.st_mode):
                require(path.resolve().is_relative_to(root.resolve()), "accepted release symlink escapes its root")
                content = "link:" + os.readlink(path)
            else:
                raise TransitionError("accepted release contains an unsupported filesystem object")
            digest.update(json.dumps([relative, stat.S_IMODE(info.st_mode), content], separators=(",", ":")).encode() + b"\n")
    return digest.hexdigest()


@contextmanager
def exclusive_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise TransitionError("another OCI deployment transition is running") from error
        yield
    finally:
        os.close(fd)


class Host:
    def __init__(self, source: Path, command=subprocess.run, systemd=Path("/etc/systemd/system"),
                 app=Path("/opt/fg-index"), node=Path("/opt/nodejs"), state=Path("/var/lib/fg-index-deployment"),
                 config=Path("/etc/fg-index"), poller_config=Path("/etc/fg-index-release-poller"),
                 libexec=Path("/usr/local/libexec/fg-index-deployment"), promoter=Path("/usr/local/libexec/fg-index-release-promoter/promote_api_release.py"),
                 poller_helper=Path("/usr/local/libexec/fg-index-release-poller/poller.py"),
                 owner_uid: int = 0, group_id: int | None = None):
        self.source = source
        self.command = command
        self.systemd, self.app, self.node, self.state = systemd, app, node, state
        self.config, self.poller_config, self.libexec, self.promoter = config, poller_config, libexec, promoter
        self.poller_helper = poller_helper
        self.owner_uid = owner_uid
        self.group_id = grp.getgrnam("fg-index").gr_gid if group_id is None else group_id

    def run(self, argv: list[str], timeout=30, *, check=True):
        try:
            return self.command(argv, check=check, capture_output=True, timeout=timeout)
        except subprocess.CalledProcessError as error:
            raise TransitionError(f"{Path(argv[0]).name} failed with status {error.returncode}") from None
        except (OSError, subprocess.TimeoutExpired) as error:
            raise TransitionError(f"{Path(argv[0]).name} could not complete") from error

    def installed_hash(self, relative: str) -> str | None:
        path = self.systemd / relative
        if not path.exists() and not path.is_symlink():
            return None
        require(not path.is_symlink() and path.is_file(), f"unexpected non-file at {path}")
        return sha256_file(path)

    def assert_old_units(self) -> None:
        for relative, expected in OLD_UNIT_HASHES.items():
            found = self.installed_hash(relative)
            require(found in (None, expected), f"installed unit drift at {relative}; review it before transition")

    def assert_old_helpers(self) -> None:
        for name, expected in (("deploy_api_release.py", INSTALLED_DEPLOY_SHA),
                               ("retain_api_releases.py", INSTALLED_RETENTION_SHA)):
            path = self.libexec / name
            if path.exists() or path.is_symlink():
                require(not path.is_symlink() and path.is_file() and sha256_file(path) == expected,
                        f"installed helper drift at {path.name}; review it before transition")
        if self.poller_helper.exists() or self.poller_helper.is_symlink():
            reviewed_sha = sha256_file(self.source / "ops/release-poller/poller.py")
            require(not self.poller_helper.is_symlink() and self.poller_helper.is_file() and
                    sha256_file(self.poller_helper) in {INSTALLED_POLLER_SHA, reviewed_sha},
                    "installed poller helper drift; review it before transition")
        if self.promoter.exists() or self.promoter.is_symlink():
            require(not self.promoter.is_symlink() and self.promoter.is_file() and
                    sha256_file(self.promoter) == INSTALLED_PROMOTER_SHA,
                    "installed promoter drift; review it before transition")

    def assert_source(self) -> None:
        path = self.source
        require(path.is_dir() and not path.is_symlink(), "source tree must be a real directory")
        for ancestor in (path, *path.parents):
            info = ancestor.lstat()
            require(info.st_uid == self.owner_uid and not info.st_mode & 0o022,
                    f"reviewed source path is writable by another account: {ancestor}")

    def current_sha(self) -> str:
        current = self.app / "current"
        require(current.is_symlink() and current.lstat().st_uid == self.owner_uid, "current must be a root-owned release symlink")
        prefix = str(self.app / "releases") + "/"
        target = os.readlink(current)
        require(target.startswith(prefix) and bool(SHA.fullmatch(target[len(prefix):])), "current does not select a release SHA")
        return target[len(prefix):]

    def read_json(self, path: Path, *, private=True) -> dict:
        require(path.is_file() and not path.is_symlink(), f"required state file is missing or unsafe: {path.name}")
        info = path.lstat()
        forbidden = 0o077 if private else 0o022
        require(info.st_uid == self.owner_uid and not info.st_mode & forbidden and info.st_size <= 1024 * 1024,
                f"state file permissions or size are unsafe: {path.name}")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise TransitionError(f"could not read {path.name}") from error

    def verify_release(self, sha: str, receipt: dict, policy: dict, group_id: int) -> None:
        require(bool(SHA.fullmatch(sha)), "transition release SHA is invalid")
        root = self.app / "releases" / sha
        require(release_inventory(root, group_id, self.owner_uid) == receipt.get("inventory"), f"release inventory differs from accepted receipt: {sha}")
        manifest = root / "RELEASE-MANIFEST.txt"
        rows = dict(line.split("=", 1) for line in manifest.read_text(encoding="utf-8").splitlines() if "=" in line)
        require(rows.get("source_commit") == sha, f"release manifest source differs from selected SHA: {sha}")
        node_version = receipt.get("node")
        require(isinstance(node_version, str) and policy.get("nodes", {}).get(node_version), "legacy node receipt is not accepted")
        node_path = self.node / "releases" / f"node-{node_version}" / "bin/node"
        require(not node_path.is_symlink() and sha256_file(node_path) == policy["nodes"][node_version], "Node runtime differs from accepted receipt")
        node_current = self.node / "current"
        require(node_current.is_symlink() and os.readlink(node_current) == str(node_path.parents[1]),
                "Node current link differs from the accepted runtime")
        require(receipt.get("schema") == policy.get("schema"), "release schema differs from accepted policy")
        require(sha256_file(root / "apps/api-server/prisma/schema.prisma") == receipt.get("schema"), "release schema fingerprint changed")
        # The offline promoter authenticates the retained original archive and
        # SLSA bundle against GitHub main and the separately provisioned Sigstore root.
        source_promoter = self.source / "ops/promote_api_release.py"
        self.run(["/usr/bin/python3.12", str(source_promoter), sha, "--verify-only"], 240)

    @staticmethod
    def accepted_receipts(old_state: dict, old_retention: dict) -> dict[str, dict]:
        accepted: dict[str, dict] = {}

        def add(sha: str, receipt: dict) -> None:
            require(bool(SHA.fullmatch(sha)), "legacy receipt SHA is invalid")
            prior = accepted.get(sha)
            if prior is not None:
                require(all(prior.get(key) == receipt.get(key) for key in ("inventory", "node", "schema")),
                        "legacy receipts disagree for one release SHA")
            accepted[sha] = receipt

        for name in ("current", "rollback"):
            receipt = old_state.get(name)
            if isinstance(receipt, dict) and isinstance(receipt.get("sha"), str):
                add(receipt["sha"], receipt)
        transaction = old_state.get("transaction")
        if isinstance(transaction, dict):
            for name in ("previous", "next"):
                receipt = transaction.get(name)
                if isinstance(receipt, dict) and isinstance(receipt.get("sha"), str):
                    add(receipt["sha"], receipt)
        images = old_retention.get("images", {})
        if isinstance(images, dict):
            for sha, receipt in images.items():
                if isinstance(receipt, dict) and receipt.get("sha", sha) == sha:
                    add(sha, receipt)
        return accepted

    def service_value(self, unit: str, prop: str) -> str:
        result = self.run(["/usr/bin/systemctl", "show", "--property=" + prop, "--value", unit], 15)
        return result.stdout.decode().strip()

    def preflight(self, current_sha: str, previous_sha: str | None, discard: set[str], forget: set[str]) -> dict:
        require(self.current_sha() == current_sha, "current link changed since the operator's inventory")
        require(bool(SHA.fullmatch(current_sha)) and
                (previous_sha is None or (bool(SHA.fullmatch(previous_sha)) and current_sha != previous_sha)),
                "current/previous must be distinct full commit SHAs")
        require(self.service_value("fg-index-api.service", "ActiveState") in {"inactive", "failed"},
                "API must be inactive before replacing its boot guard")
        for service in LEGACY_SERVICES:
            require(self.service_value(service, "ActiveState") in {"inactive", "failed", "unknown"},
                    f"legacy service is active: {service}")
        for timer in LEGACY_TIMERS:
            unit_state = self.service_value(timer, "UnitFileState")
            active = self.service_value(timer, "ActiveState")
            require(active in {"inactive", "failed", "unknown"} and unit_state in {"disabled", "masked", "not-found", "static", "unknown"},
                    f"legacy timer is active or enabled: {timer}")
        scheduler_dropin = self.systemd / "fg-index-api.service.d/10-scheduler-owner.conf"
        require(scheduler_dropin.is_file() and not scheduler_dropin.is_symlink() and
                sha256_file(scheduler_dropin) == SCHEDULER_OWNER_DROPIN_SHA,
                "scheduler ownership drop-in differs from the accepted single-owner contract")
        api_env = self.config / "api.env"
        env_stat = api_env.lstat()
        require(stat.S_ISREG(env_stat.st_mode) and env_stat.st_uid == self.owner_uid and
                env_stat.st_gid == self.group_id and stat.S_IMODE(env_stat.st_mode) == 0o640,
                "protected API environment file owner or mode changed")

        old_state = self.read_json(self.state / "state.json")
        require(old_state.get("schema_version") == 1, "legacy controller state version is unsupported")
        old_retention = self.read_json(self.state / "retention.json")
        receipts = self.accepted_receipts(old_state, old_retention)
        require(current_sha in receipts, "current SHA has no accepted legacy inventory receipt")
        require(previous_sha is None or previous_sha in receipts, "previous SHA has no accepted legacy inventory receipt")
        policy = self.read_json(self.config / "deployment-policy.json")
        require(policy.get("schema_version") == 1, "legacy deployment policy version is unsupported")
        group_id = self.group_id
        self.verify_release(current_sha, receipts[current_sha], policy, group_id)
        if previous_sha is not None:
            self.verify_release(previous_sha, receipts[previous_sha], policy, group_id)

        releases = self.app / "releases"
        entries = {entry.name for entry in releases.iterdir()}
        promotion_lock = releases / ".promotion.lock"
        if promotion_lock.exists():
            lock_stat = promotion_lock.lstat()
            require(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_uid == 0 and
                    stat.S_IMODE(lock_stat.st_mode) == 0o600,
                    "promotion lock is not the expected root-private regular file")
            entries.remove(promotion_lock.name)
        expected_kept = {current_sha} | ({previous_sha} if previous_sha else set())
        extra = entries - expected_kept
        require(extra == discard, f"release disposition mismatch; explicit --discard-release required for: {', '.join(sorted(extra)) or '(none)'}")
        require(not (discard & expected_kept), "cannot discard current or previous release")
        for sha in discard:
            path = releases / sha
            require(bool(SHA.fullmatch(sha)) and not path.is_symlink() and path.is_dir() and path.lstat().st_uid == 0,
                    f"legacy release is not a root-owned SHA directory: {sha}")

        policy_path = self.poller_config / "retention-policy.json"
        forget_actual: set[str] = set()
        if policy_path.exists():
            old_poller_policy = self.read_json(policy_path, private=False)
            shas = old_poller_policy.get("protected_shas")
            require(isinstance(shas, list) and all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in shas),
                    "poller protected set is invalid")
            forget_actual = set(shas) - expected_kept
        require(forget == forget_actual, "every legacy protected SHA must be named with --forget-protected or kept as current/previous")
        return {"state": old_state, "retention": old_retention, "policy": policy,
                "group_id": group_id, "discard": sorted(discard)}

    def atomic_json(self, path: Path, value: dict, mode: int) -> None:
        fd, name = tempfile.mkstemp(prefix=".transition-", dir=path.parent)
        temp = Path(name)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(value, out, sort_keys=True)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, path)
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temp.unlink(missing_ok=True)

    def backup_legacy(self, old_state: dict) -> None:
        archive = self.state / "pre-simple-deployment"
        require(not archive.exists() and not archive.is_symlink(), "legacy state backup already exists; inspect it before retry")
        archive.mkdir(mode=0o700)
        files = [self.state / "state.json", self.state / "retention.json",
                 self.config / "deployment-policy.json", self.poller_config / "retention-policy.json"]
        for source in files:
            if not source.exists():
                continue
            require(not source.is_symlink() and source.is_file() and source.lstat().st_uid == self.owner_uid,
                    f"legacy state changed type or owner: {source.name}")
            destination = archive / (source.parent.name + "-" + source.name)
            shutil.copyfile(source, destination)
            os.chown(destination, self.owner_uid, self.group_id)
            os.chmod(destination, 0o600)
            with destination.open("rb") as copied:
                os.fsync(copied.fileno())
        directory = os.open(archive, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def install_sources(self) -> None:
        files = {
            self.source / "ops/deploy_api_release.py": self.libexec / "deploy_api_release.py",
            self.source / "ops/promote_api_release.py": self.promoter,
            self.source / "ops/release-poller/poller.py": self.poller_helper,
            self.source / "ops/deployment/systemd/fg-index-deployment.service": self.systemd / "fg-index-deployment.service",
            self.source / "ops/deployment/systemd/fg-index-deployment.timer": self.systemd / "fg-index-deployment.timer",
        }
        self.libexec.mkdir(parents=True, exist_ok=True)
        for source, target in files.items():
            require(source.is_file() and not source.is_symlink(), f"reviewed source file is missing: {source.name}")
            source_info = source.lstat()
            require(source_info.st_uid == self.owner_uid and not source_info.st_mode & 0o022,
                    f"reviewed source file is writable by another account: {source.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + ".migration-next")
            require(not temporary.exists() and not temporary.is_symlink(), f"unknown install temporary blocks {target.name}")
            shutil.copyfile(source, temporary)
            os.chown(temporary, self.owner_uid, self.group_id)
            os.chmod(temporary, 0o755 if target.suffix == ".py" else 0o644)
            with temporary.open("rb") as copied:
                os.fsync(copied.fileno())
            os.replace(temporary, target)
        for path in (self.systemd / "fg-index-deployment.service", self.systemd / "fg-index-deployment.timer"):
            os.chown(path, self.owner_uid, self.group_id)
            os.chmod(path, 0o644)

    def apply(self, current_sha: str, previous_sha: str | None, discard: set[str], forget: set[str], suppress: set[str]) -> None:
        require(os.geteuid() == self.owner_uid, "transition must run as the host's root owner")
        self.assert_source()
        self.assert_old_units()
        self.assert_old_helpers()
        plan = self.preflight(current_sha, previous_sha, discard, forget)
        allowed_suppressions = {current_sha} | ({previous_sha} if previous_sha else set())
        require(suppress <= allowed_suppressions and len(suppress) <= 32,
                "initial suppression must name only explicitly selected current/previous releases")
        for timer in LEGACY_TIMERS:
            self.run(["/usr/bin/systemctl", "disable", "--now", timer], 30)
        self.assert_old_units()
        self.assert_old_helpers()
        require(self.current_sha() == current_sha, "current link changed during transition")
        self.backup_legacy(plan["state"])

        # Only the explicit untrusted legacy trees named in the plan are removed.
        for sha in plan["discard"]:
            path = self.app / "releases" / sha
            require(getattr(shutil.rmtree, "avoids_symlink_attacks", False), "safe legacy tree removal is unavailable")
            shutil.rmtree(path)
        _fsync = os.open(self.app / "releases", os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(_fsync)
        finally:
            os.close(_fsync)

        # Preserve the scheduler-owner override and the protected API environment.
        guard_dropin = self.systemd / "fg-index-api.service.d/20-deployment-boot-guard.conf"
        if guard_dropin.exists():
            require(sha256_file(guard_dropin) == BOOT_GUARD_DROPIN_SHA, "boot guard drop-in changed since reviewed inventory")
            guard_dropin.unlink()
        self.install_sources()
        for unit in ("fg-index-api-boot-guard.service", "fg-index-deployment-watchdog.service",
                     "fg-index-deployment-watchdog.timer", "fg-index-deployment-recovery.service",
                     "fg-index-release-poller.timer", "fg-index-release-retire@.service"):
            path = self.systemd / unit
            if path.exists():
                path.unlink()
        retention_ledger = self.state / "retention.json"
        if retention_ledger.exists():
            retention_ledger.unlink()
        old_deployment_policy = self.config / "deployment-policy.json"
        if old_deployment_policy.exists():
            old_deployment_policy.unlink()
        old_retention_helper = self.libexec / "retain_api_releases.py"
        if old_retention_helper.exists():
            old_retention_helper.unlink()

        state = {"schema_version": 2, "selected_sha": current_sha, "previous_sha": previous_sha,
                 "suppressed_shas": sorted(suppress), "restart_status": "not-attempted",
                 "promotion_intent_sha": None}
        # Initialize from old verified receipts; no release is started here.
        self.atomic_json(self.state / "state.json", state, 0o600)
        self.atomic_json(self.poller_config / "retention-policy.json",
                         {"schema_version": 1, "protected_shas": sorted({current_sha} | ({previous_sha} if previous_sha else set()))}, 0o644)
        self.run(["/usr/bin/systemctl", "daemon-reload"], 30)
        require(self.service_value("fg-index-api.service", "ActiveState") in {"inactive", "failed"}, "API started during transition")
        require(self.service_value("fg-index-api.service", "UnitFileState") == "enabled", "API boot enablement changed")
        require(self.service_value("fg-index-deployment.timer", "UnitFileState") in {"disabled", "static", "not-found"},
                "new deployment timer must remain disabled")
        requires = self.service_value("fg-index-api.service", "Requires")
        require("fg-index-api-boot-guard.service" not in requires, "API still requires the removed boot guard")

    def plan_summary(self, current_sha: str, previous_sha: str | None, discard: set[str], forget: set[str], suppress: set[str]) -> str:
        plan = self.preflight(current_sha, previous_sha, discard, forget)
        allowed_suppressions = {current_sha} | ({previous_sha} if previous_sha else set())
        require(suppress <= allowed_suppressions and len(suppress) <= 32,
                "initial suppression must name only explicitly selected current/previous releases")
        return (f"verified current={current_sha} previous={previous_sha or '(none)'}; "
                f"explicitly discard={','.join(plan['discard']) or '(none)'}; "
                f"initially suppress={','.join(sorted(suppress)) or '(none)'}; "
                "disable old timers; remove boot guard/recovery/watchdog; install new disabled deploy cadence")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="root-owned archive of the approved merged main source")
    parser.add_argument("--current-sha", required=True)
    parser.add_argument("--previous-sha", help="optional previously accepted release to retain for manual rollback")
    parser.add_argument("--discard-release", action="append", default=[], help="explicitly remove one unknown legacy release tree")
    parser.add_argument("--forget-protected", action="append", default=[], help="explicitly drop one old staged-release protection")
    parser.add_argument("--suppress-release", action="append", default=[], help="keep one selected SHA out of automatic reinstallation")
    parser.add_argument("--apply", action="store_true", help="apply the reviewed transition; otherwise perform a dry run")
    args = parser.parse_args(argv)
    if not SHA.fullmatch(args.current_sha) or (args.previous_sha and not SHA.fullmatch(args.previous_sha)):
        parser.error("current/previous SHA must be full lowercase commit IDs")
    try:
        host = Host(args.source.resolve(strict=True))
        with exclusive_lock(Path("/run/lock/fg-index-deployment-transition.lock")):
            if args.apply:
                host.apply(args.current_sha, args.previous_sha, set(args.discard_release),
                           set(args.forget_protected), set(args.suppress_release))
                print("transition: complete; deployment timer remains disabled and API was not started")
            else:
                print("transition: PLAN " + host.plan_summary(args.current_sha, args.previous_sha,
                                                                set(args.discard_release), set(args.forget_protected),
                                                                set(args.suppress_release)))
        return 0
    except Exception as error:
        print(f"transition: ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
