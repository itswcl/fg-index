#!/usr/bin/env python3
"""Poll public GitHub Releases and stage only the verified current-main API build."""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


OWNER = "itswcl"
REPOSITORY = "fg-index"
REPO = f"{OWNER}/{REPOSITORY}"
API_ROOT = f"https://api.github.com/repos/{REPO}"
WORKFLOW = f"{REPO}/.github/workflows/ci.yml"
PREDICATE = "https://slsa.dev/provenance/v1"
ARCHIVE_NAME = "api-release.tar.gz"
CHECKSUM_NAME = f"{ARCHIVE_NAME}.sha256"
ATTESTATION_BUNDLE_NAME = "attestation-bundle.jsonl"
MARKER_NAME = ".fg-index-verification.json"
MAX_ASSET_BYTES = 2 * 1024**3
MAX_CHECKSUM_BYTES = 1024
MAX_ATTESTATION_BUNDLE_BYTES = 16 * 1024**2
ATTESTATION_BUNDLE_DISK_MARGIN_BYTES = 64 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024**3
MAX_ARCHIVE_ENTRIES = 100_000
MIN_FREE_BYTES = 8 * 1024**3
MIN_FREE_INODES = 10_000
MAX_FINALIZED_CANDIDATES = 3
RETENTION_POLICY_PATH = Path("/etc/fg-index-release-poller/retention-policy.json")
TRUSTED_ROOT = Path("/etc/fg-index-release-promoter/trusted_root.jsonl")
MAX_ATTESTATION_RECORDS = 30
HTTP_TIMEOUT_SECONDS = 30
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ASSET_DIGEST_RE = re.compile(r"^sha256:([0-9a-f]{64})$")
CHECKSUM_RE = re.compile(r"^([0-9a-f]{64})[ \t]+\*?api-release\.tar\.gz\s*$")


class PollError(RuntimeError):
    """A release was present but failed a required verification check."""


class CapacityError(PollError):
    """The filesystem cannot satisfy the configured capacity reserve."""


@dataclass(frozen=True)
class PollResult:
    status: str
    source_sha: str
    message: str


@dataclass(frozen=True)
class StagedCandidate:
    source_sha: str
    path: Path
    verified_at: datetime


class GitHubClient:
    def __init__(self, timeout: int = HTTP_TIMEOUT_SECONDS):
        self.timeout = timeout

    def get_json(self, url: str) -> dict[str, Any] | None:
        request = Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "fg-index-release-poller/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                value = json.load(response)
        except HTTPError as error:
            if error.code == 404:
                return None
            raise PollError(f"GitHub API returned HTTP {error.code} for {url}") from error
        except (URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PollError(f"GitHub API request failed for {url}: {error}") from error
        if not isinstance(value, dict):
            raise PollError(f"GitHub API returned unexpected JSON for {url}")
        return value

    def download(self, url: str, output: Path, max_bytes: int) -> tuple[int, str]:
        request = Request(url, headers={"User-Agent": "fg-index-release-poller/1.0"})
        digest = hashlib.sha256()
        written = 0
        try:
            with urlopen(request, timeout=self.timeout) as response:
                final_url = urlparse(response.geturl())
                host = (final_url.hostname or "").lower()
                if final_url.scheme != "https" or not (
                    host == "github.com" or host.endswith(".githubusercontent.com")
                ):
                    raise PollError(f"release download redirected to an untrusted host: {host}")
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > max_bytes:
                    raise PollError(f"release asset exceeds the {max_bytes}-byte limit")
                with output.open("xb") as target:
                    while True:
                        remaining = max_bytes - written
                        chunk = response.read(min(1024 * 1024, remaining + 1))
                        if not chunk:
                            break
                        if len(chunk) > remaining:
                            raise PollError(f"release asset exceeds its declared {max_bytes}-byte size")
                        written += len(chunk)
                        digest.update(chunk)
                        target.write(chunk)
        except PollError:
            raise
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            raise PollError(f"release asset download failed: {error}") from error
        return written, digest.hexdigest()


class ReleasePoller:
    def __init__(
        self,
        root: Path,
        client: GitHubClient | Any | None = None,
        attestation_verifier: Callable[[Path, str], Path] | None = None,
        retention_policy: Path = RETENTION_POLICY_PATH,
    ):
        self.root = root
        self.staged = root / "staged"
        self.client = client or GitHubClient()
        self.attestation_verifier = attestation_verifier or verify_attestation
        self.retention_policy = retention_policy

    def current_main_sha(self) -> str:
        response = self.client.get_json(f"{API_ROOT}/branches/main")
        if response is None:
            raise PollError("GitHub did not return the public main branch")
        commit = response.get("commit")
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise PollError("GitHub returned an invalid main commit SHA")
        return sha

    def _already_staged(self, source_sha: str) -> bool:
        if self.staged.is_symlink():
            raise PollError(f"release directory must not be a symlink: {self.staged}")
        target = self.staged / source_sha
        if not target.exists():
            return False
        if target.is_symlink() or not target.is_dir():
            raise PollError(f"refusing to overwrite unexpected release path: {target}")
        marker = target / MARKER_NAME
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise PollError(f"release path exists without a valid verification marker: {target}") from error
        if not isinstance(metadata, dict) or metadata.get("source_sha") != source_sha or metadata.get("repository") != REPO:
            raise PollError(f"release path marker does not match current main: {target}")
        manifest = target / "RELEASE-MANIFEST.txt"
        if manifest.is_symlink() or not manifest.is_file():
            raise PollError(f"staged release has no regular build manifest: {target}")
        if f"source_commit={source_sha}" not in manifest.read_text(encoding="utf-8").splitlines():
            raise PollError(f"staged release manifest does not match current main: {target}")
        return True

    @staticmethod
    def _policy_file_is_root_owned(path: Path) -> bool:
        try:
            return path.lstat().st_uid == 0
        except OSError as error:
            raise PollError(f"could not inspect retention policy owner at {path}: {error}") from error

    def _load_retention_policy(self) -> dict[str, Any]:
        path = self.retention_policy
        try:
            mode = path.lstat().st_mode
        except OSError as error:
            raise PollError(f"root-maintained retention policy is unavailable at {path}: {error}") from error
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise PollError(f"retention policy must be a regular non-symlink file: {path}")
        if not self._policy_file_is_root_owned(path):
            raise PollError(f"retention policy must be owned by root: {path}")
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise PollError(f"retention policy must not be group- or world-writable: {path}")
        if path.stat().st_size > 65536:
            raise PollError("retention policy exceeds its byte budget")
        if hasattr(os, "listxattr") and any(name.startswith("system.posix_acl") for name in os.listxattr(path, follow_symlinks=False)):
            raise PollError("retention policy has unexpected ACL grants")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PollError(f"retention policy is not valid UTF-8 JSON: {path}") from error
        if (
            not isinstance(data, dict)
            or type(data.get("schema_version")) is not int
            or data.get("schema_version") not in (1, 2)
        ):
            raise PollError("retention policy schema_version must be 1 or 2")
        protected = data.get("protected_shas")
        if not isinstance(protected, list) or any(
            not isinstance(sha, str) or not SHA_RE.fullmatch(sha) for sha in protected
        ):
            raise PollError("retention policy protected_shas must contain full lowercase commit SHAs")
        if len(protected) != len(set(protected)):
            raise PollError("retention policy contains duplicate protected SHAs")
        if data["schema_version"] == 1:
            if set(data) != {"schema_version", "protected_shas"}:
                raise PollError("version1 retention policy has unknown fields")
        else:
            if set(data) != {"schema_version", "generation", "protected_shas", "retire_rejected"} or type(data["generation"]) is not int or data["generation"] <= 0:
                raise PollError("invalid retirement policy generation/fields")
            requests = data["retire_rejected"]
            if not isinstance(requests, list) or len(requests) > MAX_FINALIZED_CANDIDATES:
                raise PollError("invalid retirement request budget")
            seen = set()
            for request in requests:
                if not isinstance(request, dict) or set(request) != {"sha", "marker_sha256", "archive_sha256", "attestation_bundle_sha256"}:
                    raise PollError("invalid retirement request")
                sha = request["sha"]
                if not isinstance(sha, str) or not SHA_RE.fullmatch(sha) or sha in seen or sha in protected:
                    raise PollError("retirement cannot target a duplicate/protected/current/rollback SHA")
                seen.add(sha)
                if any(not isinstance(request[k], str) or not re.fullmatch(r"[0-9a-f]{64}", request[k]) for k in ("marker_sha256", "archive_sha256", "attestation_bundle_sha256")):
                    raise PollError("invalid retirement fingerprints")
        return data

    def _load_protected_shas(self) -> set[str]:
        return set(self._load_retention_policy()["protected_shas"])

    def _validate_retirement_tree(self, candidate: StagedCandidate) -> None:
        count = 0
        total = 0
        if not getattr(shutil.rmtree, "avoids_symlink_attacks", False):
            raise PollError("safe fd-based quarantine removal is unavailable")
        for directory, dirs, files in os.walk(candidate.path, followlinks=False):
            for path in [Path(directory), *[Path(directory) / name for name in dirs + files]]:
                info = path.lstat()
                count += 1
                total += info.st_size if stat.S_ISREG(info.st_mode) else 0
                if count > MAX_ARCHIVE_ENTRIES or total > MAX_EXTRACTED_BYTES + MAX_ASSET_BYTES or time.monotonic() >= self._retirement_deadline:
                    raise PollError("retirement inspection entry/byte/deadline budget exhausted")
                if info.st_uid != os.geteuid():
                    raise PollError("retirement tree has unexpected ownership")
                if stat.S_ISLNK(info.st_mode):
                    if not path.resolve().is_relative_to(candidate.path.resolve()):
                        raise PollError("retirement tree symlink escapes quarantine candidate")
                elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_mode & 0o077:
                    raise PollError("retirement tree is not private regular content")
                if hasattr(os, "listxattr") and any(name.startswith("system.posix_acl") for name in os.listxattr(path, follow_symlinks=False)):
                    raise PollError("retirement tree has unexpected ACL grants")

    def retire_rejected(self, generation: int) -> list[str]:
        if type(generation) is not int or generation <= 0:
            raise PollError("retirement requires a positive exact generation")
        self._retirement_deadline = time.monotonic() + 90
        self._retirement_hashed_bytes = 0
        lock_path = self.staged / ".release-poller.lock"
        fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(fd, "r+") as lock:
            if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode) or os.fstat(lock.fileno()).st_uid != os.geteuid() or os.fstat(lock.fileno()).st_mode & 0o077:
                raise PollError("retirement lock is not private and owned by the poller")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise PollError("quarantine is already in use") from error
            policy = self._load_retention_policy()
            if policy["schema_version"] != 2 or policy["generation"] != generation:
                raise PollError("stale or unapproved retirement generation")
            if len(list(self.staged.iterdir())) > MAX_FINALIZED_CANDIDATES + 1:
                raise PollError("retirement candidate-count budget exhausted")
            candidates = {c.source_sha: c for c in self._list_staged_candidates(None)}
            selected = []
            # Validate the full plan before deleting any candidate.
            for request in policy["retire_rejected"]:
                candidate = candidates.get(request["sha"])
                if candidate is None:
                    raise PollError("retirement candidate missing; operator review required")
                self._validate_retirement_tree(candidate)
                if self._evidence_sha256(candidate.path / MARKER_NAME) != request["marker_sha256"] or self._evidence_sha256(candidate.path / ARCHIVE_NAME) != request["archive_sha256"] or self._evidence_sha256(candidate.path / ATTESTATION_BUNDLE_NAME) != request["attestation_bundle_sha256"]:
                    raise PollError("retirement evidence changed from root verdict")
                identities = {name: self._retirement_identity(candidate.path / name) for name in (MARKER_NAME, ARCHIVE_NAME, CHECKSUM_NAME, ATTESTATION_BUNDLE_NAME, "RELEASE-MANIFEST.txt")}
                selected.append((candidate, identities))
            for candidate, identities in selected:
                if self._load_retention_policy() != policy:
                    raise PollError("retirement policy generation changed before deletion")
                self._validate_retirement_tree(candidate)
                if any(self._retirement_identity(candidate.path / name) != identity for name, identity in identities.items()):
                    raise PollError("retirement evidence raced before deletion")
                # Full-plan hashes were bounded and completed before the first
                # deletion. Rechecks use exact unchanged inode/size/mtime/ctime;
                # no repeated multi-GiB hashing consumes the deletion reserve.
                shutil.rmtree(candidate.path)
            return [candidate.source_sha for candidate, identities in selected]

    @staticmethod
    def _retirement_identity(path: Path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise PollError("retirement evidence type changed")
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _evidence_sha256(self, path: Path) -> str:
        deadline = getattr(self, "_retirement_deadline", None)
        if deadline is None:
            return self._sha256(path)
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                self._retirement_hashed_bytes += len(chunk)
                if self._retirement_hashed_bytes > 8 * 1024**3 or time.monotonic() >= deadline:
                    raise PollError("retirement hashing byte/deadline budget exhausted")
                digest.update(chunk)
        return digest.hexdigest()

    def _read_staged_candidate(self, path: Path) -> StagedCandidate:
        source_sha = path.name
        if not SHA_RE.fullmatch(source_sha) or path.parent != self.staged:
            raise PollError(f"unexpected staged candidate path: {path}")
        try:
            path_mode = path.lstat().st_mode
        except OSError as error:
            raise PollError(f"could not inspect staged candidate {path}: {error}") from error
        if stat.S_ISLNK(path_mode) or not stat.S_ISDIR(path_mode):
            raise PollError(f"staged candidate must be a real directory: {path}")

        marker = path / MARKER_NAME
        manifest = path / "RELEASE-MANIFEST.txt"
        archive = path / ARCHIVE_NAME
        checksum = path / CHECKSUM_NAME
        attestation_bundle = path / ATTESTATION_BUNDLE_NAME
        try:
            marker_mode = marker.lstat().st_mode
            manifest_mode = manifest.lstat().st_mode
            archive_mode = archive.lstat().st_mode
            checksum_mode = checksum.lstat().st_mode
            bundle_mode = attestation_bundle.lstat().st_mode
        except OSError as error:
            raise PollError(f"staged candidate is not a complete verified release: {path}") from error
        for label, file_path, mode in (
            ("verification marker", marker, marker_mode),
            ("manifest", manifest, manifest_mode),
            ("release archive", archive, archive_mode),
            ("checksum sidecar", checksum, checksum_mode),
            ("attestation bundle", attestation_bundle, bundle_mode),
        ):
            if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                raise PollError(f"staged candidate {label} is not a regular file: {file_path}")
        if archive.stat().st_size <= 0 or archive.stat().st_size > MAX_ASSET_BYTES:
            raise PollError(f"staged candidate archive has an invalid size: {archive}")
        if checksum.stat().st_size <= 0 or checksum.stat().st_size > MAX_CHECKSUM_BYTES:
            raise PollError(f"staged candidate checksum has an invalid size: {checksum}")
        if (
            attestation_bundle.stat().st_size <= 0
            or attestation_bundle.stat().st_size > MAX_ATTESTATION_BUNDLE_BYTES
        ):
            raise PollError(f"staged candidate attestation bundle has an invalid size: {attestation_bundle}")
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            manifest_lines = manifest.read_text(encoding="utf-8").splitlines()
            bundle_lines = attestation_bundle.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PollError(f"staged candidate is not a complete verified release: {path}") from error
        if (
            not isinstance(metadata, dict)
            or metadata.get("source_sha") != source_sha
            or metadata.get("repository") != REPO
            or metadata.get("source_ref") != "refs/heads/main"
            or metadata.get("tag") != f"api-{source_sha}"
            or metadata.get("attestation_workflow") != WORKFLOW
            or metadata.get("attestation_predicate") != PREDICATE
            or type(metadata.get("release_id")) is not int
            or metadata["release_id"] <= 0
            or not re.fullmatch(r"[0-9a-f]{64}", str(metadata.get("archive_sha256", "")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(metadata.get("checksum_asset_sha256", "")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(metadata.get("attestation_bundle_sha256", "")))
            or f"source_commit={source_sha}" not in manifest_lines
            or not bundle_lines
            or any(not self._is_json_object(line) for line in bundle_lines)
            or self._evidence_sha256(archive) != metadata.get("archive_sha256")
            or self._evidence_sha256(checksum) != metadata.get("checksum_asset_sha256")
            or self._evidence_sha256(attestation_bundle) != metadata.get("attestation_bundle_sha256")
        ):
            raise PollError(f"staged candidate marker or manifest does not verify its source SHA: {path}")
        self._validate_checksum(checksum, str(metadata.get("archive_sha256", "")))
        try:
            verified_at = datetime.fromisoformat(str(metadata.get("verified_at", "")).replace("Z", "+00:00"))
        except ValueError as error:
            raise PollError(f"staged candidate has an invalid verification time: {path}") from error
        if verified_at.tzinfo is None:
            raise PollError(f"staged candidate verification time must include a timezone: {path}")
        return StagedCandidate(source_sha, path, verified_at)

    @staticmethod
    def _is_json_object(line: str) -> bool:
        try:
            return isinstance(json.loads(line), dict)
        except json.JSONDecodeError:
            return False

    def _list_staged_candidates(self, in_progress_path: Path | None) -> list[StagedCandidate]:
        candidates: list[StagedCandidate] = []
        in_progress: list[Path] = []
        for path in self.staged.iterdir():
            if path.name == ".release-poller.lock":
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                    raise PollError(f"release poller lock must be a regular file: {path}")
                continue
            if path.name.startswith(".poller-"):
                if in_progress_path is None or path != in_progress_path:
                    raise PollError(
                        f"unexpected in-progress quarantine tree requires operator review: {path}"
                    )
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                    raise PollError(f"in-progress quarantine path must be a real directory: {path}")
                in_progress.append(path)
                continue
            candidates.append(self._read_staged_candidate(path))
        if len(in_progress) > 1:
            raise PollError("more than one in-progress quarantine tree exists")
        if in_progress_path is not None and in_progress_path not in in_progress:
            raise PollError(f"expected in-progress quarantine tree is missing: {in_progress_path}")
        return candidates

    def _delete_staged_candidate(self, candidate: StagedCandidate) -> None:
        if candidate.path.parent != self.staged or candidate.path.name != candidate.source_sha:
            raise PollError(f"refusing to delete a path outside the staged SHA tree: {candidate.path}")
        current = self._read_staged_candidate(candidate.path)
        if current.source_sha != candidate.source_sha:
            raise PollError(f"staged candidate changed during retention review: {candidate.path}")
        try:
            shutil.rmtree(candidate.path)
        except OSError as error:
            raise PollError(f"could not prune verified staged candidate {candidate.source_sha}: {error}") from error
        print(f"release-poller: pruned old verified quarantine candidate {candidate.source_sha}")

    def _enforce_retention(
        self,
        current_main_sha: str,
        *,
        incoming_candidate: bool,
        in_progress_path: Path | None = None,
    ) -> None:
        protected_shas = self._load_protected_shas()
        candidates = self._list_staged_candidates(in_progress_path)
        by_sha = {candidate.source_sha: candidate for candidate in candidates}
        protected_shas.add(current_main_sha)
        if candidates and (not incoming_candidate or current_main_sha in by_sha):
            newest = max(candidates, key=lambda candidate: (candidate.verified_at, candidate.source_sha))
            protected_shas.add(newest.source_sha)

        finalized_limit = MAX_FINALIZED_CANDIDATES
        if incoming_candidate and current_main_sha not in by_sha:
            finalized_limit -= 1
        protected_candidates = [candidate for candidate in candidates if candidate.source_sha in protected_shas]
        if len(protected_candidates) > finalized_limit:
            raise PollError(
                f"retention is blocked: {len(protected_candidates)} finalized candidates are protected, "
                f"but the {finalized_limit}-candidate limit leaves no safe pruning plan"
            )

        candidates.sort(key=lambda candidate: (candidate.verified_at, candidate.source_sha))
        while len(candidates) > finalized_limit:
            victim = next(
                (candidate for candidate in candidates if candidate.source_sha not in protected_shas),
                None,
            )
            if victim is None:
                raise PollError("retention is blocked: no finalized verified unprotected candidate can be pruned")
            self._delete_staged_candidate(victim)
            candidates.remove(victim)

    def poll_once(self) -> PollResult:
        self.staged.mkdir(parents=True, exist_ok=True)
        lock_path = self.staged / ".release-poller.lock"
        with lock_path.open("a", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise PollError("another release poll is already running") from error
            return self._poll_locked()

    def _poll_locked(self) -> PollResult:
        source_sha = self.current_main_sha()
        if self._already_staged(source_sha):
            self._enforce_retention(source_sha, incoming_candidate=False)
            return PollResult("already-staged", source_sha, "current main is already staged")

        tag = f"api-{source_sha}"
        release = self.client.get_json(f"{API_ROOT}/releases/tags/{tag}")
        if release is None:
            return PollResult("waiting", source_sha, f"release {tag} is not published yet")
        self._validate_release(release, tag)

        ref = self.client.get_json(f"{API_ROOT}/git/ref/tags/{tag}")
        if ref is None:
            return PollResult("waiting", source_sha, f"tag {tag} is not available yet")
        tag_object = ref.get("object", {})
        if tag_object.get("type") != "commit" or tag_object.get("sha") != source_sha:
            raise PollError(f"tag {tag} does not point directly to current main {source_sha}")

        asset_metadata = {asset["name"]: asset for asset in release["assets"]}
        expected_archive_digest = self._asset_digest(asset_metadata[ARCHIVE_NAME])
        expected_checksum_digest = self._asset_digest(asset_metadata[CHECKSUM_NAME])
        required_before_download = (
            asset_metadata[ARCHIVE_NAME]["size"]
            + asset_metadata[CHECKSUM_NAME]["size"]
            + MAX_ATTESTATION_BUNDLE_BYTES
            + ATTESTATION_BUNDLE_DISK_MARGIN_BYTES
            + MIN_FREE_BYTES
        )
        try:
            self._ensure_free_space(self.staged, required_before_download)
        except CapacityError as capacity_error:
            # Reclaim only eligible verified candidates when the compressed
            # input itself would otherwise breach the reserve.
            self._enforce_retention(source_sha, incoming_candidate=True)
            try:
                self._ensure_free_space(self.staged, required_before_download)
            except CapacityError:
                raise capacity_error

        with tempfile.TemporaryDirectory(prefix=".poller-", dir=self.staged) as temp_name:
            work = Path(temp_name)
            archive = work / ARCHIVE_NAME
            checksum_file = work / CHECKSUM_NAME
            self._download_asset(tag, ARCHIVE_NAME, asset_metadata[ARCHIVE_NAME], archive)
            self._download_asset(tag, CHECKSUM_NAME, asset_metadata[CHECKSUM_NAME], checksum_file)

            archive_sha = self._sha256(archive)
            checksum_asset_sha = self._sha256(checksum_file)
            if archive_sha != expected_archive_digest:
                raise PollError("downloaded archive digest does not match GitHub release metadata")
            if checksum_asset_sha != expected_checksum_digest:
                raise PollError("downloaded checksum digest does not match GitHub release metadata")
            self._validate_checksum(checksum_file, archive_sha)
            self._ensure_free_space(
                self.staged,
                MAX_ATTESTATION_BUNDLE_BYTES + ATTESTATION_BUNDLE_DISK_MARGIN_BYTES + MIN_FREE_BYTES,
            )
            attestation_bundle = self.attestation_verifier(archive, source_sha)
            if (
                not isinstance(attestation_bundle, Path)
                or attestation_bundle.parent != work
                or attestation_bundle.is_symlink()
                or not attestation_bundle.is_file()
            ):
                raise PollError("attestation verifier did not preserve a regular bundle in the work directory")
            bundle_size = attestation_bundle.stat().st_size
            if bundle_size <= 0 or bundle_size > MAX_ATTESTATION_BUNDLE_BYTES:
                raise PollError("downloaded attestation bundle has an invalid size")
            attestation_bundle_sha = self._sha256(attestation_bundle)
            self._enforce_retention(source_sha, incoming_candidate=True, in_progress_path=work)

            payload = work / "payload"
            payload.mkdir()
            self._extract_archive(archive, payload)
            manifest = payload / "RELEASE-MANIFEST.txt"
            if manifest.is_symlink() or not manifest.is_file():
                raise PollError("verified release does not contain a regular RELEASE-MANIFEST.txt")
            manifest_text = manifest.read_text(encoding="utf-8")
            if f"source_commit={source_sha}" not in manifest_text.splitlines():
                raise PollError("release manifest source_commit does not match current main")
            for reserved_name in (
                MARKER_NAME,
                ARCHIVE_NAME,
                CHECKSUM_NAME,
                ATTESTATION_BUNDLE_NAME,
            ):
                reserved_path = payload / reserved_name
                if reserved_path.exists() or reserved_path.is_symlink():
                    raise PollError(f"release archive contains reserved path {reserved_name}")

            metadata = {
                "repository": REPO,
                "source_sha": source_sha,
                "source_ref": "refs/heads/main",
                "tag": tag,
                "release_id": release.get("id"),
                "archive_sha256": archive_sha,
                "checksum_asset_sha256": checksum_asset_sha,
                "attestation_bundle_sha256": attestation_bundle_sha,
                "attestation_workflow": WORKFLOW,
                "attestation_predicate": PREDICATE,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            }
            (payload / MARKER_NAME).write_text(
                json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )
            archive.rename(payload / ARCHIVE_NAME)
            checksum_file.rename(payload / CHECKSUM_NAME)
            attestation_bundle.rename(payload / ATTESTATION_BUNDLE_NAME)
            self._set_private_staging_permissions(payload)
            target = self.staged / source_sha
            if target.exists() or target.is_symlink():
                raise PollError(f"release destination appeared during verification: {target}")
            if self.current_main_sha() != source_sha:
                return PollResult("main-moved", source_sha, "main advanced during verification; retrying next poll")
            payload.rename(target)
        return PollResult("staged", source_sha, f"verified release staged at {target}; current was not changed")

    @staticmethod
    def _validate_release(release: dict[str, Any], tag: str) -> None:
        if release.get("tag_name") != tag:
            raise PollError("release tag_name does not match the exact current-main tag")
        if release.get("draft") is not False or release.get("prerelease") is not False:
            raise PollError("release is not a published stable release")
        if not release.get("published_at"):
            raise PollError("release has no published_at timestamp")
        if release.get("immutable") is not True:
            raise PollError("release is not marked immutable by GitHub")
        assets = release.get("assets")
        if not isinstance(assets, list):
            raise PollError("release assets field is invalid")
        names = [asset.get("name") for asset in assets if isinstance(asset, dict)]
        if len(names) != len(assets) or sorted(names) != sorted([ARCHIVE_NAME, CHECKSUM_NAME]):
            raise PollError("release does not contain exactly the expected archive and checksum assets")
        for asset in assets:
            if asset.get("state") != "uploaded":
                raise PollError(f"release asset {asset['name']} is not fully uploaded")

    @staticmethod
    def _asset_digest(asset: dict[str, Any]) -> str:
        match = ASSET_DIGEST_RE.fullmatch(str(asset.get("digest", "")))
        if not match:
            raise PollError(f"release asset {asset.get('name')} has no valid SHA-256 digest")
        size = asset.get("size")
        max_size = MAX_CHECKSUM_BYTES if asset.get("name") == CHECKSUM_NAME else MAX_ASSET_BYTES
        if type(size) is not int or size <= 0 or size > max_size:
            raise PollError(f"release asset {asset.get('name')} has an invalid size")
        return match.group(1)

    def _download_asset(self, tag: str, name: str, asset: dict[str, Any], output: Path) -> None:
        expected_url = f"https://github.com/{REPO}/releases/download/{tag}/{name}"
        if asset.get("browser_download_url") != expected_url:
            raise PollError(f"release asset {name} has an unexpected download URL")
        declared_size = asset.get("size")
        if type(declared_size) is not int or declared_size <= 0:
            raise PollError(f"release asset {name} has an invalid declared size")
        size, digest = self.client.download(expected_url, output, declared_size)
        if size != asset.get("size"):
            raise PollError(f"downloaded size of {name} does not match GitHub release metadata")
        if digest != self._asset_digest(asset):
            raise PollError(f"downloaded digest of {name} does not match GitHub release metadata")

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _validate_checksum(path: Path, archive_sha: str) -> None:
        try:
            content = path.read_text(encoding="ascii").strip()
        except (OSError, UnicodeDecodeError) as error:
            raise PollError("release checksum sidecar is not valid ASCII text") from error
        match = CHECKSUM_RE.fullmatch(content)
        if not match or match.group(1) != archive_sha:
            raise PollError("release checksum sidecar does not verify the API archive")

    @staticmethod
    def _ensure_free_space(path: Path, required_bytes: int) -> None:
        try:
            free_bytes = shutil.disk_usage(path).free
        except OSError as error:
            raise PollError(f"could not check free space at {path}: {error}") from error
        if free_bytes < required_bytes:
            raise CapacityError(
                f"insufficient free space at {path}: need {required_bytes} bytes, have {free_bytes}; "
                f"requires an {MIN_FREE_BYTES}-byte reserve"
            )

    @staticmethod
    def _set_private_staging_permissions(root: Path) -> None:
        """Restrict staged files to the poller identity; the API cannot read this quarantine."""
        for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            for name in (*dirnames, *filenames):
                path = Path(directory) / name
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    continue
                if stat.S_ISDIR(mode):
                    path.chmod(0o700)
                elif stat.S_ISREG(mode):
                    permissions = 0o600
                    if mode & stat.S_IXUSR:
                        permissions |= 0o100
                    path.chmod(permissions)
                else:
                    raise PollError(f"staged archive contains an unsupported filesystem entry: {path}")
        root.chmod(0o700)

    @staticmethod
    def _extract_archive(archive: Path, destination: Path) -> None:
        try:
            filesystem = os.statvfs(destination)
        except OSError as error:
            raise PollError(f"could not inspect filesystem capacity at {destination}: {error}") from error
        block_size = filesystem.f_frsize or filesystem.f_bsize
        available_inodes = filesystem.f_favail
        if type(block_size) is not int or block_size <= 0 or type(available_inodes) is not int:
            raise PollError(f"filesystem capacity data is invalid at {destination}")

        total_size = 0
        allocated_data_size = 0
        seen: set[str] = set()
        required_paths: set[str] = set()
        members: list[tarfile.TarInfo] = []
        try:
            with tarfile.open(archive, mode="r:gz") as bundle:
                for member in bundle:
                    members.append(member)
                    if len(members) > MAX_ARCHIVE_ENTRIES:
                        raise PollError(f"archive contains more than {MAX_ARCHIVE_ENTRIES} entries")
                    raw_name = member.name
                    path = PurePosixPath(raw_name)
                    normalized = str(path)
                    if path.is_absolute() or ".." in path.parts:
                        raise PollError(f"archive contains unsafe path: {raw_name}")
                    if normalized in seen:
                        raise PollError(f"archive contains duplicate path: {raw_name}")
                    seen.add(normalized)
                    if not (member.isfile() or member.isdir() or member.issym()):
                        raise PollError(f"archive contains unsupported entry type: {raw_name}")
                    if member.size < 0:
                        raise PollError(f"archive contains an invalid size: {raw_name}")
                    if member.issym():
                        link = PurePosixPath(member.linkname)
                        resolved = posixpath.normpath(
                            posixpath.join(posixpath.dirname(normalized), member.linkname)
                        )
                        if link.is_absolute() or resolved == ".." or resolved.startswith("../"):
                            raise PollError(f"archive contains unsafe symlink: {raw_name}")

                    for part_count in range(1, len(path.parts) + 1):
                        required_paths.add("/".join(path.parts[:part_count]))
                        if len(required_paths) > MAX_ARCHIVE_ENTRIES:
                            raise PollError(f"archive expands to more than {MAX_ARCHIVE_ENTRIES} filesystem entries")

                    total_size += member.size
                    if total_size > MAX_EXTRACTED_BYTES:
                        raise PollError("archive expands beyond the extraction size limit")
                    if member.isfile():
                        allocated_data_size += (
                            (member.size + block_size - 1) // block_size
                        ) * block_size

                required_inodes = len(required_paths) + MIN_FREE_INODES
                if available_inodes < required_inodes:
                    raise CapacityError(
                        f"insufficient free inodes at {destination}: "
                        f"need {required_inodes}, have {available_inodes}; "
                        f"requires a {MIN_FREE_INODES}-inode reserve"
                    )

                # Budget one filesystem block for each extracted path, including
                # directory entries and filesystem metadata, plus rounded file data.
                required_bytes = allocated_data_size + len(required_paths) * block_size
                ReleasePoller._ensure_free_space(destination, required_bytes + MIN_FREE_BYTES)
                try:
                    bundle.extractall(path=destination, members=members, filter="data")
                except TypeError as error:
                    raise PollError("Python 3.12 or newer is required for safe tar extraction") from error
        except (tarfile.TarError, OSError) as error:
            raise PollError(f"could not safely extract API archive: {error}") from error


def download_attestation_bundle(archive: Path, archive_sha: str) -> Path:
    """Select one original SLSA bundle from one bounded public REST page.

    Selection examines untrusted payloads; only the offline verifier authenticates
    them. Missing evidence on this page fails closed; this is not a full inventory.
    """
    if not ASSET_DIGEST_RE.fullmatch(f"sha256:{archive_sha}"):
        raise PollError("invalid archive digest for attestation lookup")
    url = f"{API_ROOT}/attestations/sha256:{archive_sha}?per_page={MAX_ATTESTATION_RECORDS}"
    request = Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "fg-index-release-poller/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            if response.geturl() != url:
                raise PollError("attestation lookup redirected from the exact repository/digest endpoint")
            length = response.headers.get("Content-Length")
            if length is not None and int(length) > MAX_ATTESTATION_BUNDLE_BYTES:
                raise PollError("attestation response exceeds its byte limit")
            body = response.read(MAX_ATTESTATION_BUNDLE_BYTES + 1)
            if len(body) > MAX_ATTESTATION_BUNDLE_BYTES:
                raise PollError("attestation response exceeds its byte limit")
        data = json.loads(body.decode("utf-8"))
    except PollError:
        raise
    except (HTTPError, URLError, TimeoutError, ValueError, OSError, RecursionError) as error:
        raise PollError(f"public attestation bundle download failed: {error}") from error
    records = data.get("attestations") if isinstance(data, dict) else None
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_ATTESTATION_RECORDS:
        raise PollError("attestation response must contain a bounded nonempty record list")
    selected = None
    for record in records:
        bundle = record.get("bundle") if isinstance(record, dict) else None
        if not isinstance(bundle, dict):
            raise PollError("attestation record has no bundle object")
        envelope = bundle.get("dsseEnvelope")
        material = bundle.get("verificationMaterial")
        if (not isinstance(bundle.get("mediaType"), str)
            or not isinstance(material, dict) or not isinstance(envelope, dict)
            or envelope.get("payloadType") != "application/vnd.in-toto+json"
            or not isinstance(envelope.get("payload"), str)
            or not isinstance(envelope.get("signatures"), list) or not envelope["signatures"]
            or any(not isinstance(signature, dict) or not isinstance(signature.get("sig"), str)
                   for signature in envelope["signatures"])):
            raise PollError("attestation bundle has an invalid signed-envelope shape")
        try:
            statement = json.loads(base64.b64decode(envelope["payload"], validate=True).decode("utf-8"))
        except (ValueError, binascii.Error, RecursionError) as error:
            raise PollError("attestation bundle contains an invalid statement") from error
        if not isinstance(statement, dict) or not isinstance(statement.get("subject"), list):
            raise PollError("attestation statement has an invalid subject list")
        if any(not isinstance(subject, dict) or not isinstance(subject.get("digest"), dict)
               for subject in statement["subject"]):
            raise PollError("attestation statement has an invalid subject")
        if (statement.get("predicateType") == PREDICATE
            and any(subject["digest"].get("sha256") == archive_sha for subject in statement["subject"])
            and selected is None):
            selected = bundle
    if selected is None:
        raise PollError("no matching SLSA build attestation in the bounded public lookup")
    # Preserve every signed field, including the original encoded payload/signatures.
    encoded = (json.dumps(selected, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > MAX_ATTESTATION_BUNDLE_BYTES:
        raise PollError("retained attestation bundle exceeds its byte limit")
    output = archive.parent / ATTESTATION_BUNDLE_NAME
    try:
        with output.open("xb") as target:
            target.write(encoded)
    except OSError as error:
        raise PollError(f"could not retain attestation bundle: {error}") from error
    return output


def validate_trusted_root(path: Path) -> None:
    for item in (path.parent, path):
        try:
            metadata = item.lstat()
        except OSError as error:
            raise PollError(f"trusted root is unavailable: {error}") from error
        expected_type = stat.S_ISDIR if item == path.parent else stat.S_ISREG
        if not expected_type(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise PollError("trusted root and its directory must be root-owned and not group/world-writable")
    if not 0 < path.stat().st_size <= MAX_ATTESTATION_BUNDLE_BYTES:
        raise PollError("trusted root has an invalid size")


def verify_attestation(archive: Path, source_sha: str) -> Path:
    """Download and verify a GitHub Sigstore bundle without using saved credentials."""
    gh = shutil.which("gh")
    if gh is None:
        raise PollError("GitHub CLI (gh) is required to verify build attestations")
    validate_trusted_root(TRUSTED_ROOT)
    archive_sha = ReleasePoller._sha256(archive)
    bundle = download_attestation_bundle(archive, archive_sha)
    with tempfile.TemporaryDirectory(prefix="fg-index-gh-") as isolated_home:
        gh_config = Path(isolated_home) / "gh-config"
        gh_config.mkdir()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": isolated_home,
            "GH_CONFIG_DIR": str(gh_config),
            "GH_PROMPT_DISABLED": "1",
            "GH_NO_UPDATE_NOTIFIER": "1",
        }
        command = [
            gh,
            "attestation",
            "verify",
            str(archive),
            "--repo",
            REPO,
            "--source-digest",
            source_sha,
            "--source-ref",
            "refs/heads/main",
            "--signer-workflow",
            WORKFLOW,
            "--predicate-type",
            PREDICATE,
            "--bundle",
            str(bundle),
            "--custom-trusted-root",
            str(TRUSTED_ROOT),
            "--deny-self-hosted-runners",
        ]
        try:
            result = subprocess.run(
                command, check=False, capture_output=True, text=True, timeout=180, env=env
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PollError(f"attestation verification could not run: {error}") from error
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "gh returned a failure"
            raise PollError(f"GitHub build attestation verification failed: {detail}")
        return bundle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("/var/lib/fg-index-release-poller"),
        help="private poller state directory",
    )
    parser.add_argument("--retire-rejected", action="store_true")
    parser.add_argument("--generation", type=int)
    args = parser.parse_args()
    try:
        if args.retire_rejected:
            retired = ReleasePoller(args.root).retire_rejected(args.generation)
            print(f"release-poller: retired {len(retired)} root-declared rejected candidate(s)")
            return 0
        if args.generation is not None:
            raise PollError("generation is only valid with retirement")
        result = ReleasePoller(args.root).poll_once()
    except PollError as error:
        print(f"release-poller: ERROR: {error}", file=sys.stderr)
        return 1
    print(f"release-poller: {result.status}: {result.source_sha}: {result.message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
