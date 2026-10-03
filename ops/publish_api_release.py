#!/usr/bin/env python3
"""Publish a verified API artifact as one immutable, per-commit GitHub release."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

API_BASE = "https://api.github.com"
EXPECTED_ASSETS = ("api-release.tar.gz", "api-release.tar.gz.sha256")


class GitHubError(RuntimeError):
    pass


class GitHubApi:
    def __init__(self, repository: str, token: str) -> None:
        self.repository = repository
        self.token = token

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{API_BASE}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "fg-index-api-release-publisher",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            details = error.read().decode(errors="replace")
            raise GitHubError(f"GitHub API {method} {path} returned {error.code}: {details}") from error
        except urllib.error.URLError as error:
            raise GitHubError(f"GitHub API {method} {path} failed: {error}") from error

    def get_tag_ref(self, tag: str) -> dict[str, Any] | None:
        encoded = urllib.parse.quote(tag, safe="")
        return self.request("GET", f"/repos/{self.repository}/git/ref/tags/{encoded}")

    def get_release(self, tag: str) -> dict[str, Any] | None:
        encoded = urllib.parse.quote(tag, safe="")
        return self.request("GET", f"/repos/{self.repository}/releases/tags/{encoded}")

    def create_tag(self, tag: str, source_sha: str) -> None:
        self.request(
            "POST",
            f"/repos/{self.repository}/git/refs",
            {"ref": f"refs/tags/{tag}", "sha": source_sha},
        )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_tag_commit(api: GitHubApi, ref: dict[str, Any]) -> str:
    """Resolve a lightweight or annotated ref to its commit, rejecting odd chains."""
    target = ref.get("object")
    seen: set[str] = set()
    for _ in range(8):
        if not isinstance(target, dict) or not isinstance(target.get("sha"), str):
            raise GitHubError("Tag ref has no valid target object")
        object_sha = target["sha"]
        object_type = target.get("type")
        if object_type == "commit":
            return object_sha
        if object_type != "tag" or object_sha in seen:
            raise GitHubError("Tag does not resolve to a commit")
        seen.add(object_sha)
        annotated = api.request("GET", f"/repos/{api.repository}/git/tags/{object_sha}")
        if not isinstance(annotated, dict):
            raise GitHubError(f"Annotated tag object {object_sha} could not be read")
        target = annotated.get("object")
    raise GitHubError("Tag object chain exceeded the resolution limit")


def asset_digests(artifact_dir: Path) -> dict[str, str]:
    return {name: f"sha256:{sha256(artifact_dir / name)}" for name in EXPECTED_ASSETS}


def validate_release(
    api: GitHubApi,
    tag: str,
    source_sha: str,
    ref: dict[str, Any] | None,
    release: dict[str, Any] | None,
    expected_digests: dict[str, str],
) -> None:
    if ref is None or release is None:
        raise GitHubError("The tag and release must both exist for a retry to be a no-op")
    if resolve_tag_commit(api, ref) != source_sha:
        raise GitHubError(f"Tag {tag} does not resolve to source commit {source_sha}")
    if release.get("tag_name") != tag:
        raise GitHubError(f"Release is attached to an unexpected tag: {release.get('tag_name')!r}")
    if release.get("draft") is not False:
        raise GitHubError("Existing release is still a draft")
    if release.get("immutable") is not True:
        raise GitHubError("Existing release is not immutable; enable repository release immutability")

    assets = release.get("assets")
    if not isinstance(assets, list):
        raise GitHubError("Release assets are missing or malformed")
    actual: dict[str, dict[str, Any]] = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            raise GitHubError("Release contains a malformed asset entry")
        name = asset["name"]
        if name in actual:
            raise GitHubError(f"Release contains duplicate asset {name}")
        actual[name] = asset
    if set(actual) != set(EXPECTED_ASSETS):
        raise GitHubError(f"Release asset set mismatch: found {sorted(actual)}")
    for name, expected_digest in expected_digests.items():
        asset = actual[name]
        if asset.get("state") != "uploaded":
            raise GitHubError(f"Release asset {name} is not fully uploaded")
        if asset.get("digest") != expected_digest:
            raise GitHubError(f"Release asset {name} SHA-256 does not match the local artifact")


def create_release_with_gh(repository: str, tag: str, source_sha: str, artifact_dir: Path) -> None:
    subprocess.run(
        [
            "gh", "release", "create", tag,
            str(artifact_dir / EXPECTED_ASSETS[0]),
            str(artifact_dir / EXPECTED_ASSETS[1]),
            "--repo", repository,
            "--verify-tag",
            "--title", f"API release {source_sha}",
            "--notes", (
                f"Production API archive built by the successful CI run for commit {source_sha}. "
                "Verify the archive with the accompanying SHA-256 file and the GitHub build "
                "attestation before deployment."
            ),
            "--latest=false",
        ],
        check=True,
    )


def publish_or_verify(
    api: GitHubApi,
    repository: str,
    source_sha: str,
    artifact_dir: Path,
    create_release: Callable[[str, str, str, Path], None] = create_release_with_gh,
) -> str:
    if len(source_sha) != 40 or any(character not in "0123456789abcdef" for character in source_sha):
        raise GitHubError("SOURCE_SHA must be a full lowercase 40-character commit SHA")
    for name in EXPECTED_ASSETS:
        if not (artifact_dir / name).is_file():
            raise GitHubError(f"Required artifact is missing: {name}")

    tag = f"api-{source_sha}"
    expected_digests = asset_digests(artifact_dir)
    ref = api.get_tag_ref(tag)
    release = api.get_release(tag)

    if ref is not None:
        # A prior run may have created the exact tag and then failed before
        # the GitHub release finished. Reuse only a tag that resolves to this
        # source commit; never move or accept a different target.
        if resolve_tag_commit(api, ref) != source_sha:
            raise GitHubError(f"Tag {tag} does not resolve to source commit {source_sha}")
    elif release is not None:
        raise GitHubError("A release exists without its expected tag ref")
    else:
        # Create the exact commit ref ourselves. A retry after an ambiguous
        # network result will find and validate the ref on its next attempt.
        api.create_tag(tag, source_sha)
        ref = api.get_tag_ref(tag)
        if ref is None or resolve_tag_commit(api, ref) != source_sha:
            raise GitHubError(f"New tag {tag} did not resolve to source commit {source_sha}")

    if release is not None:
        validate_release(api, tag, source_sha, ref, release, expected_digests)
        return "verified-existing"

    # If release creation failed after tag creation, a subsequent run reaches
    # this path and safely retries the release against the verified exact tag.
    create_release(repository, tag, source_sha, artifact_dir)
    release = api.get_release(tag)
    ref = api.get_tag_ref(tag)
    validate_release(api, tag, source_sha, ref, release, expected_digests)
    return "created-and-verified"


def main() -> int:
    # GITHUB_TOKEN cannot read the repository's Administration setting. This
    # repo variable is an owner-controlled, fail-closed confirmation that the
    # setting was enabled and checked before this publisher is allowed to run.
    if os.environ.get("API_RELEASE_IMMUTABILITY_CONFIRMED") != "true":
        print(
            "::error::Set repository Actions variable API_RELEASE_IMMUTABILITY_CONFIRMED=true "
            "only after enabling Settings > Releases > Enable release immutability.",
            file=sys.stderr,
        )
        return 1

    try:
        repository = os.environ["GITHUB_REPOSITORY"]
        source_sha = os.environ["SOURCE_SHA"]
        artifact_dir = Path(os.environ["ARTIFACT_DIR"])
        token = os.environ["GH_TOKEN"]
        api = GitHubApi(repository, token)
        result = publish_or_verify(api, repository, source_sha, artifact_dir)
        print(result)
        return 0
    except (KeyError, GitHubError, OSError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
