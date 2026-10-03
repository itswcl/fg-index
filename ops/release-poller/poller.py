#!/usr/bin/env python3
"""Poll public GitHub Releases and stage only the verified current-main API build."""

from __future__ import annotations

import argparse
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
MARKER_NAME = ".fg-index-verification.json"
MAX_ASSET_BYTES = 2 * 1024**3
MAX_CHECKSUM_BYTES = 1024
MAX_EXTRACTED_BYTES = 4 * 1024**3
MAX_ARCHIVE_ENTRIES = 100_000
MIN_FREE_BYTES = 8 * 1024**3
MIN_FREE_INODES = 10_000
HTTP_TIMEOUT_SECONDS = 30
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ASSET_DIGEST_RE = re.compile(r"^sha256:([0-9a-f]{64})$")
CHECKSUM_RE = re.compile(r"^([0-9a-f]{64})[ \t]+\*?api-release\.tar\.gz\s*$")


class PollError(RuntimeError):
    """A release was present but failed a required verification check."""


@dataclass(frozen=True)
class PollResult:
    status: str
    source_sha: str
    message: str


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
        attestation_verifier: Callable[[Path, str], None] | None = None,
    ):
        self.root = root
        self.staged = root / "staged"
        self.client = client or GitHubClient()
        self.attestation_verifier = attestation_verifier or verify_attestation

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
            + MIN_FREE_BYTES
        )
        self._ensure_free_space(self.staged, required_before_download)

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
            self.attestation_verifier(archive, source_sha)

            payload = work / "payload"
            payload.mkdir()
            self._extract_archive(archive, payload)
            manifest = payload / "RELEASE-MANIFEST.txt"
            if manifest.is_symlink() or not manifest.is_file():
                raise PollError("verified release does not contain a regular RELEASE-MANIFEST.txt")
            manifest_text = manifest.read_text(encoding="utf-8")
            if f"source_commit={source_sha}" not in manifest_text.splitlines():
                raise PollError("release manifest source_commit does not match current main")
            reserved_marker = payload / MARKER_NAME
            if reserved_marker.exists() or reserved_marker.is_symlink():
                raise PollError(f"release archive contains reserved path {MARKER_NAME}")

            metadata = {
                "repository": REPO,
                "source_sha": source_sha,
                "source_ref": "refs/heads/main",
                "tag": tag,
                "release_id": release.get("id"),
                "archive_sha256": archive_sha,
                "checksum_asset_sha256": checksum_asset_sha,
                "attestation_workflow": WORKFLOW,
                "attestation_predicate": PREDICATE,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            }
            (payload / MARKER_NAME).write_text(
                json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8"
            )
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
            raise PollError(
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
                    raise PollError(
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


def verify_attestation(archive: Path, source_sha: str) -> None:
    """Verify GitHub's public Sigstore attestation without using saved credentials."""
    gh = shutil.which("gh")
    if gh is None:
        raise PollError("GitHub CLI (gh) is required to verify build attestations")
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("/var/lib/fg-index-release-poller"),
        help="private poller state directory",
    )
    args = parser.parse_args()
    try:
        result = ReleasePoller(args.root).poll_once()
    except PollError as error:
        print(f"release-poller: ERROR: {error}", file=sys.stderr)
        return 1
    print(f"release-poller: {result.status}: {result.source_sha}: {result.message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
