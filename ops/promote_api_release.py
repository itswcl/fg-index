#!/usr/bin/env python3
"""Independently verify and copy one quarantined API release into the root-owned release tree."""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable


REPOSITORY = "itswcl/fg-index"
SIGNER_WORKFLOW = "itswcl/fg-index/.github/workflows/ci.yml"
PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
ARCHIVE_NAME = "api-release.tar.gz"
CHECKSUM_NAME = f"{ARCHIVE_NAME}.sha256"
BUNDLE_NAME = "attestation-bundle.jsonl"
MANIFEST_NAME = "RELEASE-MANIFEST.txt"
RESERVED_ROOT_NAMES = {".fg-index-verification.json", ARCHIVE_NAME, CHECKSUM_NAME, BUNDLE_NAME}
MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_CHECKSUM_BYTES = 1024
MAX_BUNDLE_BYTES = 16 * 1024**2
MAX_TRUSTED_ROOT_BYTES = 16 * 1024**2
MAX_EXTRACTED_BYTES = 4 * 1024**3
MAX_ARCHIVE_ENTRIES = 100_000
MAX_MANIFEST_BYTES = 64 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
CHECKSUM_RE = re.compile(r"^([0-9a-f]{64})[ \t]+\*?api-release\.tar\.gz\s*$")
REQUIRED_MANIFEST_FIELDS = {
    "api_entrypoint": "apps/api-server/dist/index.js",
    "start_command": "(cd apps/api-server && npm start)",
    "shared_types_runtime": "packages/shared-types/dist/index.js",
    "prisma_client": "apps/api-server/node_modules/.prisma/client",
    "scheduler_setting_before_cutover": "SCHEDULERS_ENABLED=false",
}

STAGING_ROOT = Path("/var/lib/fg-index-release-poller/staged")
RELEASES_ROOT = Path("/opt/fg-index/releases")
TRUSTED_ROOT = Path("/etc/fg-index-release-promoter/trusted_root.jsonl")


class PromotionError(RuntimeError):
    """A staged candidate is invalid or could not be safely promoted."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_regular_file(
    source_name: str,
    destination: Path,
    max_bytes: int,
    candidate_fd: int,
    expected_size: int,
) -> None:
    """Copy a no-follow regular file into private scratch, enforcing a hard byte cap."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(source_name, flags, dir_fd=candidate_fd)
    except OSError as error:
        raise PromotionError(f"cannot safely open candidate evidence {source_name}: {error}") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise PromotionError(f"candidate evidence is not a regular file: {source_name}")
        if before.st_mode & 0o077:
            raise PromotionError(f"candidate evidence is not private to its owner: {source_name}")
        if before.st_size <= 0 or before.st_size > max_bytes:
            raise PromotionError(f"candidate evidence has an invalid size: {source_name}")
        if before.st_size != expected_size:
            raise PromotionError(f"candidate evidence changed after capacity preflight: {source_name}")
        written = 0
        with os.fdopen(os.dup(descriptor), "rb") as reader, destination.open("xb") as writer:
            while True:
                chunk = reader.read(min(1024 * 1024, max_bytes - written + 1))
                if not chunk:
                    break
                written += len(chunk)
                if written > before.st_size or written > max_bytes:
                    raise PromotionError(f"candidate evidence changed or exceeds its size limit: {source_name}")
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) or written != before.st_size:
            raise PromotionError(f"candidate evidence changed while being snapshotted: {source_name}")
    finally:
        os.close(descriptor)


def _read_trusted_root(path: Path, owner_check: Callable[[Path], bool]) -> None:
    try:
        mode = path.lstat().st_mode
    except OSError as error:
        raise PromotionError(f"trusted root is unavailable at {path}: {error}") from error
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise PromotionError("trusted root must be a regular, non-symlink file")
    if not owner_check(path):
        raise PromotionError("trusted root must be owned by root")
    if mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise PromotionError("trusted root must not be group- or world-writable")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_TRUSTED_ROOT_BYTES:
        raise PromotionError("trusted root has an invalid size")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        objects = [json.loads(line) for line in lines if line.strip()]
        if not objects or any(not isinstance(item, dict) for item in objects):
            raise PromotionError("trusted root must contain JSON objects")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PromotionError(f"trusted root is not valid UTF-8 JSONL: {error}") from error


def _validate_checksum(path: Path, archive_digest: str) -> None:
    try:
        content = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError) as error:
        raise PromotionError("archive checksum is not valid ASCII text") from error
    match = CHECKSUM_RE.fullmatch(content)
    if match is None or match.group(1) != archive_digest:
        raise PromotionError("archive checksum does not match the candidate archive")


def _validate_bundle(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        objects = [json.loads(line) for line in lines if line.strip()]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PromotionError(f"attestation bundle is not valid UTF-8 JSONL: {error}") from error
    if not objects or any(not isinstance(item, dict) for item in objects):
        raise PromotionError("attestation bundle must contain at least one JSON object")


def _archive_members(archive: Path) -> tuple[list[tarfile.TarInfo], set[str]]:
    members: list[tarfile.TarInfo] = []
    kinds: dict[str, str] = {}
    total_size = 0
    try:
        with tarfile.open(archive, mode="r:gz") as tar:
            for member in tar:
                if len(members) >= MAX_ARCHIVE_ENTRIES:
                    raise PromotionError(f"archive contains more than {MAX_ARCHIVE_ENTRIES} entries")
                raw = member.name
                path = PurePosixPath(raw)
                if path.is_absolute() or ".." in path.parts:
                    raise PromotionError(f"archive contains an unsafe path: {raw}")
                normalized = str(path)
                if normalized in kinds:
                    raise PromotionError(f"archive contains a duplicate path: {raw}")
                if len(path.parts) == 1 and normalized in RESERVED_ROOT_NAMES:
                    raise PromotionError(f"archive contains a reserved root path: {normalized}")
                if not (member.isfile() or member.isdir() or member.issym()):
                    raise PromotionError(f"archive contains an unsupported entry type: {raw}")
                if member.size < 0:
                    raise PromotionError(f"archive contains an invalid member size: {raw}")
                total_size += member.size
                if total_size > MAX_EXTRACTED_BYTES:
                    raise PromotionError("archive expands beyond the extraction size limit")
                kinds[normalized] = "file" if member.isfile() else "dir" if member.isdir() else "symlink"
                members.append(member)
    except (tarfile.TarError, OSError) as error:
        raise PromotionError(f"could not read API archive: {error}") from error

    # A file or symlink cannot be an ancestor of another member. Directories
    # may be omitted from the tar and are created as needed.
    for name in kinds:
        parts = PurePosixPath(name).parts
        for index in range(1, len(parts)):
            ancestor = "/".join(parts[:index])
            if kinds.get(ancestor) in {"file", "symlink"}:
                raise PromotionError(f"archive path traverses a non-directory member: {name}")

    member_paths = set(kinds)
    paths: set[str] = set()
    for name in member_paths:
        parts = PurePosixPath(name).parts
        for count in range(1, len(parts) + 1):
            paths.add("/".join(parts[:count]))
            if len(paths) > MAX_ARCHIVE_ENTRIES:
                raise PromotionError(
                    f"archive expands to more than {MAX_ARCHIVE_ENTRIES} filesystem paths"
                )

    for name, kind in kinds.items():
        if kind != "symlink":
            continue
        member = next(item for item in members if str(PurePosixPath(item.name)) == name)
        link = PurePosixPath(member.linkname)
        resolved = PurePosixPath(os.path.normpath(str(PurePosixPath(name).parent / link)))
        if link.is_absolute() or ".." in resolved.parts or str(resolved) in {"", "."}:
            raise PromotionError(f"archive contains an unsafe symlink: {name}")
        if str(resolved) not in paths:
            raise PromotionError(f"archive symlink target is absent from the archive: {name}")
        if kinds.get(str(resolved)) == "symlink":
            raise PromotionError(f"archive symlink may not target another symlink: {name}")
    return members, paths


def _extract_safely(archive: Path, destination: Path, expected_sha: str) -> None:
    members, paths = _archive_members(archive)
    try:
        with tarfile.open(archive, mode="r:gz") as tar:
            # Make directories and regular files before links. This prevents a
            # link entry from becoming an extraction path component.
            directories = [m for m in members if m.isdir()]
            files = [m for m in members if m.isfile()]
            links = [m for m in members if m.issym()]
            for member in directories:
                name = str(PurePosixPath(member.name))
                if name != ".":
                    (destination / name).mkdir(parents=True, exist_ok=True)
            for member in files:
                name = str(PurePosixPath(member.name))
                if name == ".":
                    raise PromotionError("archive contains a regular file at its root")
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    raise PromotionError(f"archive member has no file payload: {name}")
                remaining = member.size
                with source, target.open("xb") as output:
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise PromotionError(f"archive member ended early: {name}")
                        output.write(chunk)
                        remaining -= len(chunk)
                target.chmod(0o600 | (member.mode & 0o111))
            for member in links:
                name = str(PurePosixPath(member.name))
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                resolved = os.path.normpath(str(PurePosixPath(name).parent / member.linkname))
                if resolved not in paths or (destination / resolved).is_symlink():
                    raise PromotionError(f"archive symlink target is unsafe: {name}")
                target.symlink_to(member.linkname)
    except (tarfile.TarError, OSError) as error:
        raise PromotionError(f"could not safely extract API archive: {error}") from error

    manifest = destination / MANIFEST_NAME
    try:
        mode = manifest.lstat().st_mode
    except OSError as error:
        raise PromotionError("archive does not contain a regular root RELEASE-MANIFEST.txt") from error
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode) or manifest.stat().st_size > MAX_MANIFEST_BYTES:
        raise PromotionError("archive manifest is not a bounded regular file")
    try:
        lines = manifest.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise PromotionError("archive manifest is not valid UTF-8") from error
    manifest_fields: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            raise PromotionError("archive manifest contains a malformed field")
        key, value = line.split("=", 1)
        if not key or key in manifest_fields:
            raise PromotionError("archive manifest contains a duplicate or empty field")
        manifest_fields[key] = value
    if manifest_fields.get("source_commit") != expected_sha:
        raise PromotionError("archive manifest source_commit does not match the requested SHA")
    if any(manifest_fields.get(key) != value for key, value in REQUIRED_MANIFEST_FIELDS.items()):
        raise PromotionError("archive manifest does not match the production API runtime contract")
    if re.fullmatch(r"v24\.\d+\.\d+", manifest_fields.get("node_version", "")) is None:
        raise PromotionError("archive manifest node_version must identify a Node 24 release")

    required_files = (
        "apps/api-server/package.json",
        "apps/api-server/package-lock.json",
        "apps/api-server/dist/index.js",
        "apps/api-server/prisma/schema.prisma",
        "apps/api-server/node_modules/@prisma/client/package.json",
        "apps/api-server/node_modules/.prisma/client/default.js",
        "packages/shared-types/package.json",
        "packages/shared-types/package-lock.json",
        "packages/shared-types/dist/index.js",
    )
    for relative in required_files:
        path = destination / relative
        try:
            mode = path.lstat().st_mode
        except OSError as error:
            raise PromotionError(f"release archive is missing a required runtime file: {relative}") from error
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise PromotionError(f"required runtime path must be a regular file: {relative}")
    shared_types_link = destination / "apps/api-server/node_modules/@shared/types"
    if not shared_types_link.is_symlink():
        raise PromotionError("release is missing the shared-types runtime symlink")
    try:
        if shared_types_link.resolve(strict=True) != (destination / "packages/shared-types").resolve(strict=True):
            raise PromotionError("shared-types runtime symlink does not resolve to the packaged shared types")
    except OSError as error:
        raise PromotionError("shared-types runtime symlink is broken") from error


class ReleasePromoter:
    def __init__(
        self,
        staging_root: Path = STAGING_ROOT,
        releases_root: Path = RELEASES_ROOT,
        trusted_root: Path = TRUSTED_ROOT,
        *,
        owner_check: Callable[[Path], bool] | None = None,
        directory_owner_check: Callable[[Path], bool] | None = None,
        lock_owner_check: Callable[[os.stat_result], bool] | None = None,
        group_id: int | None = None,
        gh_path: str | None = None,
        run: Callable[..., Any] = subprocess.run,
    ) -> None:
        self.staging_root = staging_root
        self.releases_root = releases_root
        self.trusted_root = trusted_root
        self.owner_check = owner_check or (lambda path: path.lstat().st_uid == 0)
        self.directory_owner_check = directory_owner_check or (lambda path: path.lstat().st_uid == 0)
        self.lock_owner_check = lock_owner_check or (lambda item: item.st_uid == 0)
        self.group_id = group_id
        self.gh_path = gh_path
        self.run = run

    def _verify(self, archive: Path, bundle: Path, scratch: Path, source_sha: str) -> None:
        self._trusted_directory(self.trusted_root.parent, "trusted-root directory")
        _read_trusted_root(self.trusted_root, self.owner_check)
        gh = self.gh_path or shutil.which("gh")
        if gh is None:
            raise PromotionError("GitHub CLI (gh) with offline attestation verification is required")
        command = [
            gh,
            "attestation",
            "verify",
            str(archive),
            "--repo",
            REPOSITORY,
            "--source-digest",
            source_sha,
            "--source-ref",
            "refs/heads/main",
            "--signer-workflow",
            SIGNER_WORKFLOW,
            "--predicate-type",
            PREDICATE_TYPE,
            "--bundle",
            str(bundle),
            "--custom-trusted-root",
            str(self.trusted_root),
            "--deny-self-hosted-runners",
        ]
        gh_config = scratch / "gh-config"
        gh_config.mkdir(mode=0o700)
        env = {
            "HOME": str(scratch),
            "GH_CONFIG_DIR": str(gh_config),
            "GH_PROMPT_DISABLED": "1",
            "GH_NO_UPDATE_NOTIFIER": "1",
            "PATH": f"{Path(gh).parent}:/usr/bin:/bin",
        }
        try:
            result = self.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=180,
                env=env,
            )
        except (OSError, subprocess.SubprocessError, subprocess.TimeoutExpired) as error:
            raise PromotionError(f"offline attestation verification could not run: {error}") from error
        if result.returncode != 0:
            detail = (result.stderr or "").strip() or (result.stdout or "").strip() or "gh returned failure"
            raise PromotionError(f"offline attestation verification failed: {detail}")

    def _trusted_directory(self, path: Path, label: str) -> None:
        try:
            mode = path.lstat().st_mode
        except OSError as error:
            raise PromotionError(f"{label} is unavailable at {path}: {error}") from error
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or not self.directory_owner_check(path):
            raise PromotionError(f"{label} must be a root-owned real directory")
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise PromotionError(f"{label} must not be group- or world-writable")

    @staticmethod
    def _private_staging_directory(path: Path) -> None:
        try:
            mode = path.lstat().st_mode
        except OSError as error:
            raise PromotionError(f"poller staging directory is unavailable at {path}: {error}") from error
        # The poller creates and owns its StateDirectory. Its ownership is
        # deliberately not elevated; only root's independent checks establish
        # trust in bytes copied out of it.
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise PromotionError("poller staging path must be a real directory")
        if mode & 0o077:
            raise PromotionError("poller staging directory must be private to its owner")

    @staticmethod
    def _snapshot_capacity_preflight(
        path: Path,
        candidate_fd: int,
        evidence: tuple[tuple[str, int], ...],
    ) -> dict[str, int]:
        filesystem = os.statvfs(path)
        free_bytes = shutil.disk_usage(path).free
        block_size = filesystem.f_frsize or filesystem.f_bsize
        free_inodes = filesystem.f_favail
        sizes: dict[str, int] = {}
        for name, limit in evidence:
            try:
                descriptor = os.open(
                    name,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                    dir_fd=candidate_fd,
                )
            except OSError as error:
                raise PromotionError(f"cannot safely inspect candidate evidence {name}: {error}") from error
            try:
                item = os.fstat(descriptor)
                if not stat.S_ISREG(item.st_mode) or item.st_mode & 0o077:
                    raise PromotionError(f"candidate evidence must be a private regular file: {name}")
                if item.st_size <= 0 or item.st_size > limit:
                    raise PromotionError(f"candidate evidence has an invalid size: {name}")
                sizes[name] = item.st_size
            finally:
                os.close(descriptor)
        if block_size <= 0:
            raise PromotionError("release filesystem block size is invalid")
        snapshot_allocation = sum(
            ((size + block_size - 1) // block_size) * block_size for size in sizes.values()
        )
        required_bytes = snapshot_allocation + 4 * block_size + 8 * 1024**3
        required_inodes = len(evidence) + 4 + 10_000
        if free_bytes < required_bytes:
            raise PromotionError(
                f"insufficient free space for the private snapshot: need {required_bytes} bytes including the 8 GiB reserve, "
                f"have {free_bytes}"
            )
        if free_inodes < required_inodes:
            raise PromotionError(
                f"insufficient free inodes for the private snapshot: need {required_inodes} including the "
                f"10,000-inode reserve, have {free_inodes}"
            )
        return sizes

    @staticmethod
    def _capacity_preflight(destination: Path, members: list[tarfile.TarInfo], paths: set[str]) -> None:
        try:
            filesystem = os.statvfs(destination)
            free_bytes = shutil.disk_usage(destination).free
        except OSError as error:
            raise PromotionError(f"could not inspect release-tree capacity: {error}") from error
        block_size = filesystem.f_frsize or filesystem.f_bsize
        free_inodes = filesystem.f_favail
        if not isinstance(block_size, int) or block_size <= 0 or not isinstance(free_inodes, int):
            raise PromotionError("release-tree capacity data is invalid")
        allocated = 0
        for member in members:
            if member.isfile():
                allocated += ((member.size + block_size - 1) // block_size) * block_size
        needed_bytes = allocated + len(paths) * block_size + 8 * 1024**3
        needed_inodes = len(paths) + 10_000
        if free_bytes < needed_bytes:
            raise PromotionError(
                f"insufficient release-tree free space: need {needed_bytes} bytes including the 8 GiB reserve, "
                f"have {free_bytes}"
            )
        if free_inodes < needed_inodes:
            raise PromotionError(
                f"insufficient release-tree free inodes: need {needed_inodes} including the 10,000-inode reserve, "
                f"have {free_inodes}"
            )

    @staticmethod
    def _set_release_permissions(root: Path, group_id: int) -> None:
        for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            for name in (*dirnames, *filenames):
                path = Path(directory) / name
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    os.chown(path, 0, group_id, follow_symlinks=False)
                elif stat.S_ISDIR(mode):
                    os.chown(path, 0, group_id)
                    path.chmod(0o750)
                elif stat.S_ISREG(mode):
                    os.chown(path, 0, group_id)
                    path.chmod(0o640 | (stat.S_IMODE(mode) & 0o111))
                else:
                    raise PromotionError(f"release contains an unsupported filesystem entry: {path}")
        os.chown(root, 0, group_id)
        root.chmod(0o750)

    def promote(self, source_sha: str) -> Path:
        if not SHA_RE.fullmatch(source_sha):
            raise PromotionError("SHA must be a full lowercase 40-character commit SHA")
        candidate = self.staging_root / source_sha
        self._private_staging_directory(self.staging_root)

        archive_source = candidate / ARCHIVE_NAME
        checksum_source = candidate / CHECKSUM_NAME
        bundle_source = candidate / BUNDLE_NAME
        evidence = (
            (archive_source, MAX_ARCHIVE_BYTES),
            (checksum_source, MAX_CHECKSUM_BYTES),
            (bundle_source, MAX_BUNDLE_BYTES),
        )

        self._trusted_directory(self.releases_root.parent, "release-tree parent")
        self._trusted_directory(self.releases_root, "release tree")
        destination = self.releases_root / source_sha
        if destination.exists() or destination.is_symlink():
            raise PromotionError(f"release already exists; refusing to overwrite: {destination}")
        try:
            group_id = self.group_id if self.group_id is not None else grp.getgrnam("fg-index").gr_gid
        except KeyError as error:
            raise PromotionError("required fg-index group does not exist") from error

        lock_path = self.releases_root / ".promotion.lock"
        try:
            lock_fd = os.open(
                lock_path,
                os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                0o600,
            )
        except OSError as error:
            raise PromotionError(f"could not open promotion lock: {error}") from error
        with os.fdopen(lock_fd, "r+") as lock:
            lock_stat = os.fstat(lock.fileno())
            if (
                not stat.S_ISREG(lock_stat.st_mode)
                or not self.lock_owner_check(lock_stat)
                or lock_stat.st_mode & 0o077
            ):
                raise PromotionError("promotion lock must be a private root-owned regular file")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            if destination.exists() or destination.is_symlink():
                raise PromotionError(f"release already exists; refusing to overwrite: {destination}")

            try:
                staging_fd = os.open(
                    self.staging_root,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
                )
            except OSError as error:
                raise PromotionError(f"cannot safely open poller staging directory: {error}") from error
            try:
                staging_stat = os.fstat(staging_fd)
                if not stat.S_ISDIR(staging_stat.st_mode) or staging_stat.st_mode & 0o077:
                    raise PromotionError("poller staging directory changed or is not private")
                candidate_fd = os.open(
                    source_sha,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=staging_fd,
                )
            except OSError as error:
                raise PromotionError(f"staged candidate must be a real directory and safe: {candidate}") from error
            finally:
                os.close(staging_fd)
            if os.fstat(candidate_fd).st_mode & 0o077:
                os.close(candidate_fd)
                raise PromotionError("staged candidate directory must remain private to the poller")

            try:
                candidate_stat = os.fstat(candidate_fd)
                if not stat.S_ISDIR(candidate_stat.st_mode) or candidate_stat.st_mode & 0o077:
                    raise PromotionError("staged candidate changed or is not private")
                snapshot_sizes = self._snapshot_capacity_preflight(
                    self.releases_root,
                    candidate_fd,
                    tuple((path.name, limit) for path, limit in evidence),
                )
            except (OSError, PromotionError) as error:
                os.close(candidate_fd)
                if isinstance(error, PromotionError):
                    raise
                raise PromotionError(f"could not preflight the private candidate snapshot: {error}") from error

            with tempfile.TemporaryDirectory(prefix=f".promote-{source_sha}-", dir=self.releases_root) as scratch_name:
                scratch = Path(scratch_name)
                snapshot = scratch / "candidate"
                snapshot.mkdir(mode=0o700)
                try:
                    for source, limit in evidence:
                        _copy_regular_file(
                            source.name,
                            snapshot / source.name,
                            limit,
                            candidate_fd,
                            snapshot_sizes[source.name],
                        )
                finally:
                    os.close(candidate_fd)
                archive = snapshot / ARCHIVE_NAME
                checksum = snapshot / CHECKSUM_NAME
                bundle = snapshot / BUNDLE_NAME
                archive_digest = sha256_file(archive)
                _validate_checksum(checksum, archive_digest)
                _validate_bundle(bundle)
                self._verify(archive, bundle, scratch, source_sha)

                temporary_release = Path(
                    tempfile.mkdtemp(prefix=f".promote-{source_sha}-", dir=self.releases_root)
                )
                try:
                    members, paths = _archive_members(archive)
                    self._capacity_preflight(temporary_release, members, paths)
                    _extract_safely(archive, temporary_release, source_sha)
                    self._set_release_permissions(temporary_release, group_id)
                    if destination.exists() or destination.is_symlink():
                        raise PromotionError(f"release appeared during promotion; refusing to overwrite: {destination}")
                    os.rename(temporary_release, destination)
                    directory_fd = os.open(self.releases_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except (OSError, PromotionError) as error:
                    if isinstance(error, PromotionError):
                        raise
                    raise PromotionError(f"could not atomically install verified release: {error}") from error
                finally:
                    if temporary_release.exists():
                        shutil.rmtree(temporary_release)
        return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha", help="full lowercase commit SHA to promote from private quarantine")
    args = parser.parse_args()
    if os.geteuid() != 0:
        print("promotion must run as root", file=sys.stderr)
        return 1
    try:
        path = ReleasePromoter().promote(args.sha)
    except PromotionError as error:
        print(f"promotion: ERROR: {error}", file=sys.stderr)
        return 1
    print(f"promotion: installed verified inactive release at {path}; current was not changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
