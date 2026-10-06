#!/usr/bin/env python3
"""Select a verified API release, restart the fixed service, and support manual rollback."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

SHA = re.compile(r"^[0-9a-f]{40}$")
API_SERVICE = "fg-index-api.service"
POLLER_SERVICE = "fg-index-release-poller.service"


class DeploymentError(RuntimeError):
    """A bounded deployment operation could not safely complete."""


@dataclass(frozen=True)
class Paths:
    releases: Path = Path("/opt/fg-index/releases")
    current: Path = Path("/opt/fg-index/current")
    state_dir: Path = Path("/var/lib/fg-index-deployment")
    staged: Path = Path("/var/lib/fg-index-release-poller/staged")
    promoter: Path = Path("/usr/local/libexec/fg-index-release-promoter/promote_api_release.py")
    retention_policy: Path = Path("/etc/fg-index-release-poller/retention-policy.json")

    @property
    def state(self) -> Path:
        return self.state_dir / "state.json"

    @property
    def lock(self) -> Path:
        return self.state_dir / "deployment.lock"


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DeploymentError(message)


def _atomic_json(path: Path, value: dict) -> None:
    temporary = None
    try:
        fd, name = tempfile.mkstemp(prefix=".write-", dir=path.parent)
        temporary = Path(name)
        os.fchmod(fd, 0o600 if path.name == "state.json" else 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, sort_keys=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        _fsync_dir(path.parent)
    except OSError as error:
        raise DeploymentError(f"could not persist {path.name}") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _validate_state(value: object) -> dict:
    _require(isinstance(value, dict), "deployment state is not an object")
    _require(set(value) == {"schema_version", "selected_sha", "previous_sha", "suppressed_shas", "restart_status"},
             "deployment state fields do not match this version")
    _require(value["schema_version"] == 1, "unsupported deployment state version")
    _require(isinstance(value["selected_sha"], str) and SHA.fullmatch(value["selected_sha"]), "invalid selected SHA")
    previous = value["previous_sha"]
    _require(previous is None or (isinstance(previous, str) and SHA.fullmatch(previous)), "invalid previous SHA")
    suppressed = value["suppressed_shas"]
    _require(isinstance(suppressed, list) and len(suppressed) <= 32 and
             all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in suppressed) and
             len(suppressed) == len(set(suppressed)), "invalid suppressed SHA set")
    _require(value["restart_status"] in {"not-attempted", "pending", "attempting", "succeeded", "failed"}, "invalid restart status")
    return value


class Host:
    """Small adapter around the trusted poller, promoter, filesystem and systemd."""

    def __init__(self, paths: Paths = Paths(), command=subprocess.run, owner_uid: int = 0):
        self.paths = paths
        self.command = command
        self.owner_uid = owner_uid

    def run(self, argv: list[str], timeout: int) -> subprocess.CompletedProcess:
        try:
            return self.command(argv, check=True, capture_output=True, timeout=timeout)
        except subprocess.CalledProcessError as error:
            raise DeploymentError(f"{Path(argv[0]).name} failed with status {error.returncode}") from None
        except (OSError, subprocess.TimeoutExpired) as error:
            raise DeploymentError(f"{Path(argv[0]).name} could not complete within {timeout}s") from error

    def current_main_sha(self) -> str:
        request = Request(
            "https://api.github.com/repos/itswcl/fg-index/commits/main",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "fg-index-deployment/1.0"},
        )
        try:
            with urlopen(request, timeout=10) as response:
                value = json.load(response)
        except Exception as error:
            raise DeploymentError("could not read the current repository main SHA") from error
        sha = value.get("sha") if isinstance(value, dict) else None
        _require(isinstance(sha, str) and bool(SHA.fullmatch(sha)), "GitHub main response has an invalid commit SHA")
        return sha

    def poll(self) -> str | None:
        expected_sha = self.current_main_sha()
        self.run(["/usr/bin/systemctl", "start", POLLER_SERVICE], 190)
        if self.current_main_sha() != expected_sha:
            return None
        entry = self.paths.staged / expected_sha
        if entry.is_symlink() or not entry.is_dir():
            return None
        marker = entry / ".fg-index-verification.json"
        try:
            info = marker.lstat()
            _require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_size <= 65536,
                     "staged verification marker is invalid")
            metadata = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise DeploymentError("staged verification marker cannot be read") from error
        _require(metadata.get("source_sha") == expected_sha, "staged marker/source SHA mismatch")
        return expected_sha

    def promote(self, sha: str) -> None:
        self.run(["/usr/bin/python3.12", str(self.paths.promoter), sha], 240)

    def restart(self) -> None:
        self.run(["/usr/bin/systemctl", "restart", API_SERVICE], 180)


class Deployment:
    def __init__(self, host: Host):
        self.host = host
        self.paths = host.paths

    @contextmanager
    def lock(self):
        root = self.paths.state_dir
        _require(root.is_dir() and not root.is_symlink(), "deployment state directory is unavailable")
        info = root.lstat()
        _require(info.st_uid == self.host.owner_uid and not info.st_mode & 0o022, "deployment state directory is writable by others")
        fd = os.open(self.paths.lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise DeploymentError("another install or rollback holds the deployment lock") from error
            yield
        finally:
            os.close(fd)

    def load(self) -> dict:
        path = self.paths.state
        try:
            info = path.lstat()
            _require(stat.S_ISREG(info.st_mode) and info.st_uid == self.host.owner_uid and not info.st_mode & 0o077,
                     "deployment state permissions or type are unsafe")
            _require(info.st_size <= 65536, "deployment state exceeds its byte budget")
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise DeploymentError("run the reviewed host transition before deployment") from error
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise DeploymentError("deployment state cannot be read") from error
        return _validate_state(value)

    def save(self, state: dict) -> None:
        _atomic_json(self.paths.state, _validate_state(state))

    def selected_link(self) -> str:
        try:
            info = self.paths.current.lstat()
            _require(stat.S_ISLNK(info.st_mode) and info.st_uid == self.host.owner_uid, "current selection is not a root-owned symlink")
            target = os.readlink(self.paths.current)
        except OSError as error:
            raise DeploymentError("current release selection is unavailable") from error
        prefix = str(self.paths.releases) + "/"
        _require(target.startswith(prefix), "current link leaves the release directory")
        sha = target[len(prefix):]
        _require(bool(SHA.fullmatch(sha)), "current link does not name a release SHA")
        return sha

    def validate_known_release(self, sha: str) -> Path:
        _require(bool(SHA.fullmatch(sha)), "release SHA must be full lowercase hex")
        path = self.paths.releases / sha
        try:
            info = path.lstat()
            _require(stat.S_ISDIR(info.st_mode) and info.st_uid == self.host.owner_uid, "release is not a root-owned directory")
            manifest = path / "RELEASE-MANIFEST.txt"
            manifest_info = manifest.lstat()
            _require(stat.S_ISREG(manifest_info.st_mode) and manifest_info.st_uid == self.host.owner_uid and manifest_info.st_size <= 65536,
                     "release manifest is not a bounded root-owned file")
            rows = dict(line.split("=", 1) for line in manifest.read_text(encoding="utf-8").splitlines() if "=" in line)
        except (OSError, UnicodeError, ValueError) as error:
            raise DeploymentError("release manifest cannot be validated") from error
        _require(rows.get("source_commit") == sha, "release manifest source_commit does not match its directory")
        _require((path / "apps/api-server/dist/index.js").is_file(), "release is missing the API entry point")
        return path

    def set_current(self, sha: str) -> None:
        path = self.validate_known_release(sha)
        temporary = self.paths.current.with_name("current.next")
        _require(not temporary.exists() and not temporary.is_symlink(), "unknown current.next path blocks selection")
        os.symlink(str(path), temporary)
        os.replace(temporary, self.paths.current)
        _fsync_dir(self.paths.current.parent)

    def check_release_set(self, allowed: set[str]) -> None:
        entries = set()
        lock_path = self.paths.releases / ".promotion.lock"
        if lock_path.exists():
            lock_info = lock_path.lstat()
            _require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == self.host.owner_uid and
                     stat.S_IMODE(lock_info.st_mode) == 0o600, "promotion lock is not root-private")
        for entry in self.paths.releases.iterdir():
            if entry.name == ".promotion.lock":
                continue
            _require(bool(SHA.fullmatch(entry.name)) and not entry.is_symlink() and entry.is_dir(),
                     "unknown entry blocks bounded release retention")
            entries.add(entry.name)
        _require(entries <= allowed, "unknown legacy release tree requires explicit operator disposition")

    def sync_poller_retention(self, state: dict) -> None:
        protected = sorted({state["selected_sha"], *([state["previous_sha"]] if state["previous_sha"] else [])})
        _atomic_json(self.paths.retention_policy, {"schema_version": 1, "protected_shas": protected})

    def finish_restart(self, state: dict) -> dict:
        state["restart_status"] = "attempting"
        self.save(state)
        try:
            self.host.restart()
        except DeploymentError:
            state["restart_status"] = "failed"
            self.save(state)
            raise
        state["restart_status"] = "succeeded"
        self.save(state)
        return state

    def align_selection(self, state: dict) -> None:
        current = self.selected_link()
        if current != state["selected_sha"]:
            # Complete an interrupted selection from its durable state record.
            self.set_current(state["selected_sha"])
        self.sync_poller_retention(state)

    def reconcile(self, state: dict) -> dict:
        self.align_selection(state)
        if state["restart_status"] == "pending":
            return self.finish_restart(state)
        if state["restart_status"] == "attempting":
            raise DeploymentError("restart outcome is unknown; operator review is required before another restart")
        return state

    def once(self) -> str:
        with self.lock():
            state = self.load()
            self.reconcile(state)
            self.sync_poller_retention(state)
            candidate = self.host.poll()
            if candidate is None:
                return "no verified candidate is staged"
            _require(bool(SHA.fullmatch(candidate)), "poller returned an invalid source SHA")
            if candidate in state["suppressed_shas"]:
                return f"suppressed release {candidate} remains ineligible"
            if candidate == state["selected_sha"]:
                return f"{candidate} is already selected"
            known = {state["selected_sha"], state["previous_sha"]}
            if candidate not in known:
                self.check_release_set({sha for sha in known if sha} | {candidate})
                self.host.promote(candidate)
            self.validate_known_release(candidate)
            try:
                latest = self.host.current_main_sha()
            except Exception:
                if candidate not in known:
                    self.prune(previous=state["selected_sha"], older=candidate)
                raise
            if latest != candidate:
                if candidate not in known:
                    self.prune(previous=state["selected_sha"], older=candidate)
                return f"main advanced to {latest}; verified {candidate} was not selected"
            previous = state["selected_sha"]
            next_state = dict(state)
            next_state.update(selected_sha=candidate, previous_sha=previous, restart_status="pending")
            self.save(next_state)
            self.sync_poller_retention(next_state)
            self.set_current(candidate)
            self.prune(previous=previous, older=state["previous_sha"])
            self.finish_restart(next_state)
            return f"selected {candidate}; fixed API restart attempted"

    def rollback(self, requested_sha: str) -> str:
        with self.lock():
            state = self.load()
            self.align_selection(state)
            _require(state["previous_sha"] is not None, "no previously selected release is available")
            _require(requested_sha == state["previous_sha"], "manual rollback target must equal the recorded previous release")
            current = state["selected_sha"]
            self.validate_known_release(requested_sha)
            rejected = sorted(set(state["suppressed_shas"]) | {current})
            _require(len(rejected) <= 32, "suppressed release list is full; review it before adding another SHA")
            next_state = dict(state)
            next_state.update(selected_sha=requested_sha, previous_sha=current, suppressed_shas=rejected,
                              restart_status="pending")
            self.save(next_state)
            self.sync_poller_retention(next_state)
            self.set_current(requested_sha)
            self.finish_restart(next_state)
            return f"selected previous release {requested_sha}; suppressed {current}; fixed API restart attempted"

    def restart_selected(self) -> str:
        with self.lock():
            state = self.load()
            self.align_selection(state)
            self.finish_restart(state)
            return f"fixed API restart attempted for selected {state['selected_sha']}"

    def prune(self, *, previous: str | None, older: str | None) -> None:
        if not older or older in {previous, self.selected_link()}:
            return
        path = self.paths.releases / older
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == self.host.owner_uid, "managed old release changed type or ownership")
        _require(getattr(shutil.rmtree, "avoids_symlink_attacks", False), "safe release pruning is unavailable")
        shutil.rmtree(path)
        _fsync_dir(self.paths.releases)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--once", action="store_true", help="poll, select the newest verified main release and restart API")
    actions.add_argument("--rollback", metavar="SHA", help="select the recorded previous release and suppress the current SHA")
    actions.add_argument("--restart-selected", action="store_true", help="operator-requested retry of the fixed API restart")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print("deployment must run as root", file=sys.stderr)
        return 1
    try:
        deploy = Deployment(Host())
        result = deploy.once() if args.once else deploy.rollback(args.rollback) if args.rollback else deploy.restart_selected()
        print("deployment: " + result)
        return 0
    except Exception as error:
        print(f"deployment: ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
