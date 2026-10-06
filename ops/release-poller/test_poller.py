import base64
import hashlib
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import poller

TRUSTED_ROOT_VALIDATOR = poller.validate_trusted_root


SOURCE_SHA = "a" * 40
NEXT_SHA = "b" * 40


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_archive(source_sha: str = SOURCE_SHA) -> bytes:
    with tempfile.TemporaryDirectory() as temp_name:
        source = Path(temp_name) / "payload"
        (source / "apps/api-server/dist").mkdir(parents=True)
        (source / "apps/api-server/node_modules/@shared").mkdir(parents=True)
        (source / "packages/shared-types/dist").mkdir(parents=True)
        (source / "apps/api-server/dist/index.js").write_text("export {};\n", encoding="utf-8")
        (source / "packages/shared-types/dist/index.js").write_text("export {};\n", encoding="utf-8")
        (source / "RELEASE-MANIFEST.txt").write_text(
            f"source_commit={source_sha}\napi_entrypoint=apps/api-server/dist/index.js\n",
            encoding="utf-8",
        )
        (source / "apps/api-server/node_modules/@shared/types").symlink_to(
            "../../../../packages/shared-types"
        )
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as bundle:
            bundle.add(source, arcname=".")
        return output.getvalue()


def make_tiny_files_archive(count: int) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as bundle:
        for index in range(count):
            info = tarfile.TarInfo(f"tiny-{index:05d}")
            info.size = 0
            bundle.addfile(info, io.BytesIO())
    return output.getvalue()


class FakeGitHub:
    def __init__(self, archive: bytes | None = None, checksum: bytes | None = None):
        self.archive = archive if archive is not None else make_archive()
        self.checksum = checksum if checksum is not None else f"{sha256(self.archive)}  {poller.ARCHIVE_NAME}\n".encode()
        tag = f"api-{SOURCE_SHA}"
        self.branch_shas = [SOURCE_SHA]
        self.branch_reads = 0
        self.downloads: list[str] = []
        self.ref_sha = SOURCE_SHA
        self.release: dict = {
            "id": 9876,
            "tag_name": tag,
            "draft": False,
            "prerelease": False,
            "published_at": "2026-10-01T12:00:00Z",
            "immutable": True,
            "assets": [
                self._asset(poller.ARCHIVE_NAME, self.archive),
                self._asset(poller.CHECKSUM_NAME, self.checksum),
            ],
        }

    @staticmethod
    def _asset(name: str, content: bytes) -> dict:
        return {
            "name": name,
            "state": "uploaded",
            "size": len(content),
            "digest": f"sha256:{sha256(content)}",
            "browser_download_url": (
                f"https://github.com/{poller.REPO}/releases/download/api-{SOURCE_SHA}/{name}"
            ),
        }

    def get_json(self, url: str) -> dict | None:
        if url.endswith("/branches/main"):
            index = min(self.branch_reads, len(self.branch_shas) - 1)
            self.branch_reads += 1
            return {"commit": {"sha": self.branch_shas[index]}}
        if "/releases/tags/" in url:
            return self.release
        if "/git/ref/tags/" in url:
            return {"object": {"type": "commit", "sha": self.ref_sha}}
        raise AssertionError(f"unexpected API URL: {url}")

    def download(self, url: str, output: Path, max_bytes: int) -> tuple[int, str]:
        self.downloads.append(url)
        content = self.archive if url.endswith(poller.ARCHIVE_NAME) else self.checksum
        if len(content) > max_bytes:
            raise AssertionError("test fixture exceeds configured asset cap")
        output.write_bytes(content)
        return len(content), sha256(content)


class ReleasePollerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "var" / "lib" / "fg-index-release-poller"
        self.policy = Path(self.temp.name) / "retention-policy.json"
        self.policy.write_text('{"schema_version": 1, "protected_shas": []}\n', encoding="utf-8")
        self.root_owner_check = patch.object(
            poller.ReleasePoller, "_policy_file_is_root_owned", return_value=True
        )
        self.root_owner_check.start()
        self.verified: list[tuple[Path, str]] = []

    def tearDown(self) -> None:
        self.root_owner_check.stop()
        self.temp.cleanup()

    def make_poller(self, client=None, verifier=None) -> poller.ReleasePoller:
        return poller.ReleasePoller(
            self.root, client, verifier or self.verifier, retention_policy=self.policy
        )

    def add_candidate(self, sha: str, verified_at: str) -> Path:
        path = self.root / "staged" / sha
        path.mkdir(parents=True)
        (path / "RELEASE-MANIFEST.txt").write_text(f"source_commit={sha}\n", encoding="utf-8")
        archive = b"verified archive fixture"
        checksum = f"{sha256(archive)}  {poller.ARCHIVE_NAME}\n".encode()
        attestation_bundle = b'{"dsseEnvelope": {}}\n'
        (path / poller.ARCHIVE_NAME).write_bytes(archive)
        (path / poller.CHECKSUM_NAME).write_bytes(checksum)
        (path / poller.ATTESTATION_BUNDLE_NAME).write_bytes(attestation_bundle)
        (path / poller.MARKER_NAME).write_text(
            json.dumps(
                {
                    "repository": poller.REPO,
                    "source_sha": sha,
                    "source_ref": "refs/heads/main",
                    "tag": f"api-{sha}",
                    "release_id": 1,
                    "archive_sha256": sha256(archive),
                    "checksum_asset_sha256": sha256(checksum),
                    "attestation_bundle_sha256": sha256(attestation_bundle),
                    "attestation_workflow": poller.WORKFLOW,
                    "attestation_predicate": poller.PREDICATE,
                    "verified_at": verified_at,
                }
            ),
            encoding="utf-8",
        )
        return path

    def verifier(self, archive: Path, source_sha: str) -> Path:
        self.verified.append((archive, source_sha))
        bundle = archive.parent / "fake-attestation-bundle.jsonl"
        bundle.write_text('{"dsseEnvelope": {}}\n', encoding="utf-8")
        return bundle

    def test_stages_only_verified_release_and_leaves_current_untouched(self) -> None:
        client = FakeGitHub()
        result = self.make_poller(client).poll_once()

        target = self.root / "staged" / SOURCE_SHA
        self.assertEqual(result.status, "staged")
        self.assertTrue((target / "apps/api-server/dist/index.js").is_file())
        self.assertTrue((target / "apps/api-server/node_modules/@shared/types").is_symlink())
        self.assertEqual((target / poller.ARCHIVE_NAME).read_bytes(), client.archive)
        self.assertEqual((target / poller.CHECKSUM_NAME).read_bytes(), client.checksum)
        self.assertEqual(
            (target / poller.ATTESTATION_BUNDLE_NAME).read_text(encoding="utf-8"),
            '{"dsseEnvelope": {}}\n',
        )
        self.assertFalse((self.root / "current").exists())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((target / "apps/api-server/dist/index.js").stat().st_mode), 0o600)
        for path in (target, target / "RELEASE-MANIFEST.txt", target / poller.MARKER_NAME):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
        marker = json.loads((target / poller.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["source_sha"], SOURCE_SHA)
        self.assertEqual(marker["archive_sha256"], sha256(client.archive))
        self.assertEqual(
            marker["attestation_bundle_sha256"],
            sha256((target / poller.ATTESTATION_BUNDLE_NAME).read_bytes()),
        )
        self.assertEqual(self.verified[0][1], SOURCE_SHA)
        self.assertEqual(len(client.downloads), 2)

    @patch("poller.urlopen")
    def test_download_reads_only_one_byte_past_declared_size_then_stops(self, mock_urlopen) -> None:
        class TrackingResponse(io.BytesIO):
            headers = {}

            def __init__(self, content: bytes):
                super().__init__(content)
                self.read_sizes: list[int] = []

            def geturl(self) -> str:
                return "https://github.com/itswcl/fg-index/releases/download/api-test/asset"

            def read(self, size: int = -1) -> bytes:
                self.read_sizes.append(size)
                return super().read(size)

        response = TrackingResponse(b"abcdef")
        mock_urlopen.return_value = response
        with tempfile.TemporaryDirectory() as temp_name:
            output = Path(temp_name) / "asset"
            with self.assertRaisesRegex(poller.PollError, "exceeds its declared"):
                poller.GitHubClient().download("https://github.com/itswcl/fg-index/releases/download/api-test/asset", output, 5)
            self.assertEqual(output.stat().st_size, 0)
        self.assertEqual(response.read_sizes, [6])

    def test_systemd_unit_bounds_poll_time_and_confines_private_state(self) -> None:
        unit = (Path(__file__).parent / "systemd" / "fg-index-release-poller.service").read_text(encoding="utf-8")
        self.assertRegex(unit, r"(?m)^TimeoutStartSec=180$")
        self.assertNotRegex(unit, r"(?m)^Restart=")
        self.assertRegex(unit, r"(?m)^User=fg-index-release-poller$")
        self.assertRegex(unit, r"(?m)^Group=fg-index-release-poller$")
        self.assertIn("StateDirectory=fg-index-release-poller", unit)
        self.assertIn("StateDirectoryMode=0700", unit)
        self.assertIn("ReadWritePaths=/var/lib/fg-index-release-poller", unit)
        self.assertNotIn("ReadWritePaths=/opt/fg-index", unit)
        self.assertNotRegex(unit, r"(?m)^SupplementaryGroups=.*\bfg-index\b")

    def test_preflight_counts_per_entry_block_allocation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            archive = Path(temp_name) / "many-empty-files.tar.gz"
            archive.write_bytes(make_tiny_files_archive(16))
            destination = Path(temp_name) / "payload"
            destination.mkdir()
            block_size = 4096
            filesystem = SimpleNamespace(
                f_frsize=block_size,
                f_bsize=block_size,
                f_favail=poller.MIN_FREE_INODES + 100,
            )
            free = SimpleNamespace(free=poller.MIN_FREE_BYTES + 4 * block_size)
            with patch("poller.os.statvfs", return_value=filesystem), patch(
                "poller.shutil.disk_usage", return_value=free
            ):
                with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                    poller.ReleasePoller._extract_archive(archive, destination)

    def test_preflight_reserves_free_inodes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            archive = Path(temp_name) / "two-files.tar.gz"
            archive.write_bytes(make_tiny_files_archive(2))
            destination = Path(temp_name) / "payload"
            destination.mkdir()
            filesystem = SimpleNamespace(
                f_frsize=4096,
                f_bsize=4096,
                f_favail=poller.MIN_FREE_INODES + 1,
            )
            with patch("poller.os.statvfs", return_value=filesystem):
                with self.assertRaisesRegex(poller.PollError, "insufficient free inodes"):
                    poller.ReleasePoller._extract_archive(archive, destination)

    def test_preflight_caps_archive_entry_count(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            archive = Path(temp_name) / "too-many-files.tar.gz"
            archive.write_bytes(make_tiny_files_archive(3))
            destination = Path(temp_name) / "payload"
            destination.mkdir()
            with patch.object(poller, "MAX_ARCHIVE_ENTRIES", 2):
                with self.assertRaisesRegex(poller.PollError, "more than 2 entries"):
                    poller.ReleasePoller._extract_archive(archive, destination)

    def test_waits_when_exact_release_has_not_been_published(self) -> None:
        client = FakeGitHub()
        client.get_json = lambda url: (
            {"commit": {"sha": SOURCE_SHA}} if url.endswith("/branches/main") else None
        )
        result = self.make_poller(client).poll_once()

        self.assertEqual(result.status, "waiting")
        self.assertEqual(client.downloads, [])
        self.assertEqual(self.verified, [])

    def test_rejects_wrong_tag_target_before_download(self) -> None:
        client = FakeGitHub()
        client.ref_sha = NEXT_SHA

        with self.assertRaisesRegex(poller.PollError, "does not point directly"):
            self.make_poller(client).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_release_that_is_not_immutable(self) -> None:
        client = FakeGitHub()
        client.release["immutable"] = False

        with self.assertRaisesRegex(poller.PollError, "not marked immutable"):
            self.make_poller(client).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_extra_release_asset(self) -> None:
        client = FakeGitHub()
        client.release["assets"].append(FakeGitHub._asset("unexpected.txt", b"x"))

        with self.assertRaisesRegex(poller.PollError, "exactly the expected"):
            self.make_poller(client).poll_once()

    def test_rejects_unexpected_asset_download_url(self) -> None:
        client = FakeGitHub()
        client.release["assets"][0]["browser_download_url"] = "https://attacker.example/release.tar.gz"

        with self.assertRaisesRegex(poller.PollError, "unexpected download URL"):
            self.make_poller(client).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_checksum_mismatch_before_attestation(self) -> None:
        bad_checksum = b"0" * 64 + b"  api-release.tar.gz\n"
        client = FakeGitHub(checksum=bad_checksum)

        with self.assertRaisesRegex(poller.PollError, "checksum sidecar does not verify"):
            self.make_poller(client).poll_once()
        self.assertEqual(self.verified, [])

    def test_rejects_failed_attestation_without_staging(self) -> None:
        client = FakeGitHub()

        def reject_attestation(_archive: Path, _source_sha: str) -> None:
            raise poller.PollError("bad provenance")

        with self.assertRaisesRegex(poller.PollError, "bad provenance"):
            self.make_poller(client, reject_attestation).poll_once()
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_rejects_manifest_for_a_different_source_sha(self) -> None:
        client = FakeGitHub(archive=make_archive(NEXT_SHA))

        with self.assertRaisesRegex(poller.PollError, "manifest source_commit"):
            self.make_poller(client).poll_once()
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_discards_verified_release_if_main_moves_during_verification(self) -> None:
        client = FakeGitHub()
        client.branch_shas = [SOURCE_SHA, NEXT_SHA]
        result = self.make_poller(client).poll_once()

        self.assertEqual(result.status, "main-moved")
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_refuses_before_download_when_free_space_reserve_would_be_breached(self) -> None:
        client = FakeGitHub()
        with patch("poller.shutil.disk_usage", return_value=SimpleNamespace(free=poller.MIN_FREE_BYTES)):
            with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                self.make_poller(client).poll_once()

        self.assertEqual(client.downloads, [])

    def test_preflight_reserves_bounded_attestation_bundle_space(self) -> None:
        client = FakeGitHub()
        free_bytes = (
            poller.MIN_FREE_BYTES
            + len(client.archive)
            + len(client.checksum)
            + poller.MAX_ATTESTATION_BUNDLE_BYTES
            + poller.ATTESTATION_BUNDLE_DISK_MARGIN_BYTES
            - 1
        )
        with patch("poller.shutil.disk_usage", return_value=SimpleNamespace(free=free_bytes)):
            with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                self.make_poller(client).poll_once()

        self.assertEqual(client.downloads, [])

    def test_cleans_temporary_release_when_expansion_would_breach_reserve(self) -> None:
        client = FakeGitHub()
        enough_for_download = (
            poller.MIN_FREE_BYTES
            + len(client.archive)
            + len(client.checksum)
            + poller.MAX_ATTESTATION_BUNDLE_BYTES
            + poller.ATTESTATION_BUNDLE_DISK_MARGIN_BYTES
            + 1024
        )
        free_space = [
            SimpleNamespace(free=enough_for_download),
            SimpleNamespace(free=poller.MIN_FREE_BYTES + 1),
        ]
        with patch("poller.shutil.disk_usage", side_effect=free_space):
            with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                self.make_poller(client).poll_once()

        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_already_staged_sha_does_not_redownload_release(self) -> None:
        first = FakeGitHub()
        self.make_poller(first).poll_once()
        second = FakeGitHub()
        result = self.make_poller(second).poll_once()

        self.assertEqual(result.status, "already-staged")
        self.assertEqual(second.branch_reads, 1)
        self.assertEqual(second.downloads, [])

    def test_retention_prunes_oldest_verified_candidate_to_reserve_incoming_slot(self) -> None:
        old = self.add_candidate("1" * 40, "2026-01-01T00:00:00+00:00")
        middle = self.add_candidate("2" * 40, "2026-02-01T00:00:00+00:00")
        newest = self.add_candidate("3" * 40, "2026-03-01T00:00:00+00:00")

        self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertFalse(old.exists())
        self.assertTrue(middle.exists())
        self.assertTrue(newest.exists())

    def test_retention_retires_superseded_newest_to_reserve_current_main_slot(self) -> None:
        active = self.add_candidate(SOURCE_SHA, "2026-01-01T00:00:00+00:00")
        rollback = self.add_candidate("2" * 40, "2026-02-01T00:00:00+00:00")
        interrupted_intent = self.add_candidate("3" * 40, "2026-03-01T00:00:00+00:00")
        self.policy.write_text(
            json.dumps({"schema_version": 1, "protected_shas": [active.name, rollback.name]}), encoding="utf-8"
        )

        self.make_poller()._enforce_retention("4" * 40, incoming_candidate=True)

        self.assertTrue(active.exists())
        self.assertTrue(rollback.exists())
        self.assertFalse(interrupted_intent.exists())

    def test_retention_preserves_active_rollback_and_newest_pending_candidates(self) -> None:
        active = self.add_candidate(SOURCE_SHA, "2026-01-01T00:00:00+00:00")
        rollback = self.add_candidate("2" * 40, "2026-02-01T00:00:00+00:00")
        newest = self.add_candidate("3" * 40, "2026-03-01T00:00:00+00:00")
        old = self.add_candidate("4" * 40, "2025-12-01T00:00:00+00:00")
        self.policy.write_text(
            json.dumps({"schema_version": 1, "protected_shas": [rollback.name]}), encoding="utf-8"
        )

        self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=False)

        self.assertTrue(active.exists())
        self.assertTrue(rollback.exists())
        self.assertTrue(newest.exists())
        self.assertFalse(old.exists())

    def test_retention_fails_without_deleting_when_protected_set_exceeds_limit(self) -> None:
        candidates = [
            self.add_candidate(sha, f"2026-0{index}-01T00:00:00+00:00")
            for index, sha in enumerate(("1" * 40, "2" * 40, "3" * 40), start=1)
        ]
        self.policy.write_text(
            json.dumps(
                {"schema_version": 1, "protected_shas": [candidate.name for candidate in candidates]}
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(poller.PollError, "retention is blocked"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertTrue(all(candidate.exists() for candidate in candidates))

    def test_retention_fails_closed_on_symlink_candidate_and_preserves_external_target(self) -> None:
        external = Path(self.temp.name) / "outside"
        external.mkdir()
        (external / "sentinel").write_text("keep", encoding="utf-8")
        staged = self.root / "staged"
        staged.mkdir(parents=True)
        (staged / ("1" * 40)).symlink_to(external, target_is_directory=True)

        with self.assertRaisesRegex(poller.PollError, "real directory"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertEqual((external / "sentinel").read_text(encoding="utf-8"), "keep")

    def test_retention_fails_closed_on_corrupt_marker_without_pruning(self) -> None:
        candidate = self.add_candidate("1" * 40, "2026-01-01T00:00:00+00:00")
        (candidate / poller.MARKER_NAME).write_text("{broken", encoding="utf-8")

        with self.assertRaisesRegex(poller.PollError, "complete verified release"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertTrue(candidate.exists())

    def test_retention_fails_closed_when_retained_archive_changes(self) -> None:
        candidate = self.add_candidate("1" * 40, "2026-01-01T00:00:00+00:00")
        (candidate / poller.ARCHIVE_NAME).write_bytes(b"modified after verification")

        with self.assertRaisesRegex(poller.PollError, "does not verify its source SHA"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertTrue(candidate.exists())

    def test_retention_fails_closed_when_attestation_bundle_is_missing(self) -> None:
        candidate = self.add_candidate("1" * 40, "2026-01-01T00:00:00+00:00")
        (candidate / poller.ATTESTATION_BUNDLE_NAME).unlink()

        with self.assertRaisesRegex(poller.PollError, "complete verified release"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.assertTrue(candidate.exists())

    def test_retention_fails_closed_on_unknown_or_stale_temporary_entries(self) -> None:
        staged = self.root / "staged"
        staged.mkdir(parents=True)
        unknown = staged / "unexpected-entry"
        unknown.mkdir()
        with self.assertRaisesRegex(poller.PollError, "unexpected staged candidate path"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)
        unknown.rmdir()
        stale = staged / ".poller-stale"
        stale.mkdir()
        with self.assertRaisesRegex(poller.PollError, "unexpected in-progress"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

    def test_retention_rejects_invalid_or_untrusted_policy_without_pruning(self) -> None:
        candidate = self.add_candidate("1" * 40, "2026-01-01T00:00:00+00:00")
        self.policy.write_text('{"schema_version": 3, "protected_shas": []}', encoding="utf-8")
        with self.assertRaisesRegex(poller.PollError, "schema_version"):
            self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)

        self.policy.write_text('{"schema_version": 1, "protected_shas": []}', encoding="utf-8")
        with patch.object(poller.ReleasePoller, "_policy_file_is_root_owned", return_value=False):
            with self.assertRaisesRegex(poller.PollError, "owned by root"):
                self.make_poller()._enforce_retention(SOURCE_SHA, incoming_candidate=True)
        self.assertTrue(candidate.exists())

    def retirement_fixture(self, targets=None):
        active = self.add_candidate(SOURCE_SHA, "2026-01-01T00:00:00+00:00")
        rollback = self.add_candidate("2" * 40, "2026-02-01T00:00:00+00:00")
        rejected = self.add_candidate("3" * 40, "2026-03-01T00:00:00+00:00")
        for path in [self.root / 'staged', *list((self.root / 'staged').rglob('*'))]:
            path.chmod(0o700 if path.is_dir() else 0o600)
        lock = self.root / 'staged/.release-poller.lock'
        lock.write_text('')
        lock.chmod(0o600)
        requests = []
        for path in targets or [rejected]:
            requests.append({'sha': path.name,
                             'marker_sha256': sha256((path / poller.MARKER_NAME).read_bytes()),
                             'archive_sha256': sha256((path / poller.ARCHIVE_NAME).read_bytes()),
                             'attestation_bundle_sha256': sha256((path / poller.ATTESTATION_BUNDLE_NAME).read_bytes())})
        policy = {'schema_version': 2, 'generation': 1, 'protected_shas': [active.name, rollback.name, NEXT_SHA], 'retire_rejected': requests}
        self.policy.write_text(json.dumps(policy))
        return active, rollback, rejected, policy

    def test_new_current_main_retires_superseded_newest_without_manual_retirement(self):
        active, rollback, rejected, _policy = self.retirement_fixture()
        self.policy.write_text(json.dumps({'schema_version': 1, 'protected_shas': [active.name, rollback.name]}))
        self.make_poller()._enforce_retention(NEXT_SHA, incoming_candidate=True)
        self.assertTrue(active.exists() and rollback.exists())
        self.assertFalse(rejected.exists())

    def test_retirement_rejects_stale_generation(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        with self.assertRaisesRegex(poller.PollError, 'generation'):
            self.make_poller().retire_rejected(2)
        self.assertTrue(rejected.exists())

    def test_retirement_refuses_current_rollback_protection(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        policy['protected_shas'].append(rejected.name)
        self.policy.write_text(json.dumps(policy))
        with self.assertRaisesRegex(poller.PollError, 'protected'):
            self.make_poller().retire_rejected(1)
        self.assertTrue(all(p.exists() for p in (active, rollback, rejected)))

    def test_retirement_evidence_change_preserves_candidate(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        marker = rejected / poller.MARKER_NAME
        marker.write_text(marker.read_text() + ' ')
        with self.assertRaisesRegex(poller.PollError, 'evidence changed'):
            self.make_poller().retire_rejected(1)
        self.assertTrue(rejected.exists())

    def test_retirement_refuses_symlink_escape_without_external_deletion(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        (rejected / 'escape').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(poller.PollError, 'escapes'):
            self.make_poller().retire_rejected(1)
        self.assertTrue((outside / 'keep').exists() and rejected.exists())

    def test_retirement_fails_closed_on_unknown_tree_entry(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        (self.root / 'staged/.unknown').write_text('unknown')
        with self.assertRaises(poller.PollError):
            self.make_poller().retire_rejected(1)
        self.assertTrue(rejected.exists())

    def test_retirement_rechecks_root_policy_before_deletion(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        instance = self.make_poller()
        changed = dict(policy, generation=2)
        with patch.object(instance, '_load_retention_policy', side_effect=[policy, changed]):
            with self.assertRaisesRegex(poller.PollError, 'generation changed'):
                instance.retire_rejected(1)
        self.assertTrue(rejected.exists())

    def test_retirement_rechecks_marker_race_before_deletion(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        instance = self.make_poller()
        original = instance._validate_retirement_tree
        calls = []
        def mutate(candidate):
            calls.append(1)
            original(candidate)
            if len(calls) == 2:
                marker = rejected / poller.MARKER_NAME
                marker.write_text(marker.read_text() + ' ')
        with patch.object(instance, '_validate_retirement_tree', side_effect=mutate):
            with self.assertRaisesRegex(poller.PollError, 'raced'):
                instance.retire_rejected(1)
        self.assertTrue(rejected.exists())

    def test_retirement_shared_lock_prevents_concurrent_poll(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        import fcntl
        with (self.root / 'staged/.release-poller.lock').open('r+') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(poller.PollError, 'already in use'):
                self.make_poller().retire_rejected(1)
        self.assertTrue(rejected.exists())


    def test_retirement_oversized_tree_budget_fails_before_any_deletion(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        with patch.object(poller, 'MAX_ARCHIVE_ENTRIES', 1):
            with self.assertRaisesRegex(poller.PollError, 'budget'):
                self.make_poller().retire_rejected(1)
        self.assertTrue(active.exists() and rollback.exists() and rejected.exists())

    def test_retirement_deadline_exhaustion_fails_before_deletion(self):
        active, rollback, rejected, policy = self.retirement_fixture()
        with patch.object(poller.time, 'monotonic', side_effect=[0, 91]):
            with self.assertRaisesRegex(poller.PollError, 'budget'):
                self.make_poller().retire_rejected(1)
        self.assertTrue(rejected.exists())

    def test_retention_fails_when_policy_is_missing(self) -> None:
        self.policy.unlink()
        with self.assertRaisesRegex(poller.PollError, "policy is unavailable"):
            self.make_poller()._load_protected_shas()

    def test_retention_rejects_writable_policy(self) -> None:
        self.policy.chmod(0o666)
        with self.assertRaisesRegex(poller.PollError, "must not be group- or world-writable"):
            self.make_poller()._load_protected_shas()

    def test_rejects_unsafe_tar_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            archive = Path(temp_name) / "unsafe.tar.gz"
            with tarfile.open(archive, mode="w:gz") as bundle:
                info = tarfile.TarInfo("../../outside")
                payload = b"no"
                info.size = len(payload)
                bundle.addfile(info, io.BytesIO(payload))

            destination = Path(temp_name) / "out"
            destination.mkdir()
            with self.assertRaisesRegex(poller.PollError, "unsafe path"):
                poller.ReleasePoller._extract_archive(archive, destination)



class PublicAttestationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "artifact.tar.gz"
        self.archive.write_bytes(b"artifact")
        self.digest = sha256(b"artifact")
        self.bundle = self.make_bundle()
        trusted = patch("poller.validate_trusted_root")
        trusted.start()
        self.addCleanup(trusted.stop)

    def make_bundle(self, predicate=poller.PREDICATE, digest=None):
        statement = {"_type": "https://in-toto.io/Statement/v1", "predicateType": predicate,
                     "subject": [{"name": poller.ARCHIVE_NAME, "digest": {"sha256": digest or self.digest}}]}
        return {"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
                "verificationMaterial": {"certificate": {}},
                "dsseEnvelope": {"payloadType": "application/vnd.in-toto+json",
                                 "payload": base64.b64encode(json.dumps(statement).encode()).decode(),
                                 "signatures": [{"sig": "signed-original"}]}}

    def response(self, records=None, raw=None, headers=None, url=None):
        body = raw if raw is not None else json.dumps({"attestations": records if records is not None else [{"bundle": self.bundle}]}).encode()
        response = io.BytesIO(body)
        response.headers = headers or {}
        response.geturl = lambda: url or f"{poller.API_ROOT}/attestations/sha256:{self.digest}?per_page=30"
        return response

    @patch("poller.urlopen")
    def test_public_lookup_skips_release_attestation_and_retains_original_signed_bundle(self, open_url):
        open_url.return_value = self.response(records=[{"bundle": self.make_bundle("https://in-toto.io/attestation/release/v0.2")}, {"bundle": self.bundle}])
        bundle = poller.download_attestation_bundle(self.archive, self.digest)
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, f"{poller.API_ROOT}/attestations/sha256:{self.digest}?per_page=30")
        self.assertNotIn("Authorization", dict(request.header_items()))
        self.assertEqual(json.loads(bundle.read_text()), self.bundle)

    @patch("poller.urlopen")
    def test_rejects_missing_malformed_or_wrong_subject_evidence(self, open_url):
        cases = [{}, {"attestations": {}}, {"attestations": []}, {"attestations": [None]},
                 {"attestations": [{"bundle": None}]},
                 {"attestations": [{"bundle": self.make_bundle(digest="f" * 64)}]},
                 {"attestations": [{"bundle": self.make_bundle("release")}]},
                 {"attestations": [{"bundle": {"dsseEnvelope": {"payload": "invalid"}}}]}]
        for value in cases:
            with self.subTest(value=value):
                open_url.return_value = self.response(raw=json.dumps(value).encode())
                with self.assertRaises(poller.PollError):
                    poller.download_attestation_bundle(self.archive, self.digest)
                self.assertFalse((self.root / poller.ATTESTATION_BUNDLE_NAME).exists())

    @patch("poller.urlopen")
    def test_response_stream_and_retained_bundle_are_bounded(self, open_url):
        with patch.object(poller, "MAX_ATTESTATION_BUNDLE_BYTES", 64):
            for headers in ({}, {"Content-Length": "65"}):
                with self.subTest(headers=headers):
                    open_url.return_value = self.response(raw=b"x" * 65, headers=headers)
                    with self.assertRaisesRegex(poller.PollError, "limit"):
                        poller.download_attestation_bundle(self.archive, self.digest)
            self.assertFalse((self.root / poller.ATTESTATION_BUNDLE_NAME).exists())

    @patch("poller.urlopen")
    def test_serialized_retained_bundle_cap_is_independent_of_response_cap(self, open_url):
        self.bundle["extra"] = "漢" * 1000
        raw = json.dumps({"attestations": [{"bundle": self.bundle}]}, ensure_ascii=False).encode()
        open_url.return_value = self.response(raw=raw)
        with patch.object(poller, "MAX_ATTESTATION_BUNDLE_BYTES", len(raw)):
            with self.assertRaisesRegex(poller.PollError, "retained.*limit"):
                poller.download_attestation_bundle(self.archive, self.digest)
        self.assertFalse((self.root / poller.ATTESTATION_BUNDLE_NAME).exists())

    @patch("poller.urlopen")
    def test_page_limit_and_missing_evidence_with_more_pages_fail_closed(self, open_url):
        for records in ([{"bundle": self.bundle}] * 31,
                        [{"bundle": self.make_bundle("release")}]):
            open_url.return_value = self.response(records=records, headers={"Link": '<next>; rel="next"'})
            with self.assertRaises(poller.PollError):
                poller.download_attestation_bundle(self.archive, self.digest)
        self.assertEqual(open_url.call_count, 2)

    def test_trusted_root_rejects_symlinks_writable_or_nonroot_files(self):
        root = self.root / "trusted_root.jsonl"
        root.write_text("{}")
        for mode, uid in ((stat.S_IFLNK | 0o644, 0), (stat.S_IFREG | 0o664, 0),
                          (stat.S_IFREG | 0o644, 501)):
            with self.subTest(mode=mode, uid=uid):
                metadata = [SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0),
                            SimpleNamespace(st_mode=mode, st_uid=uid)]
                with patch.object(Path, "lstat", side_effect=metadata):
                    with self.assertRaises(poller.PollError):
                        TRUSTED_ROOT_VALIDATOR(root)

    @patch("poller.urlopen")
    def test_rejects_redirect_and_http_failure(self, open_url):
        from urllib.error import HTTPError
        open_url.return_value = self.response(url="https://example.com/evidence")
        with self.assertRaises(poller.PollError):
            poller.download_attestation_bundle(self.archive, self.digest)
        error = HTTPError("url", 403, "rate limited", {}, io.BytesIO())
        self.addCleanup(error.close)
        open_url.side_effect = error
        with self.assertRaisesRegex(poller.PollError, "download failed"):
            poller.download_attestation_bundle(self.archive, self.digest)

    @patch("poller.urlopen")
    @patch("poller.subprocess.run")
    @patch("poller.shutil.which", return_value="/usr/bin/gh")
    def test_real_verifier_uses_public_download_and_offline_exact_policy(self, which, run, open_url):
        open_url.return_value = self.response()
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        bundle = poller.verify_attestation(self.archive, SOURCE_SHA)
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        self.assertEqual(command[1:3], ["attestation", "verify"])
        for flag, value in (("--repo", poller.REPO), ("--source-digest", SOURCE_SHA),
                            ("--source-ref", "refs/heads/main"), ("--signer-workflow", poller.WORKFLOW),
                            ("--predicate-type", poller.PREDICATE), ("--bundle", str(bundle)),
                            ("--custom-trusted-root", str(poller.TRUSTED_ROOT))):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--deny-self-hosted-runners", command)
        self.assertNotIn("GH_TOKEN", run.call_args.kwargs["env"])
        self.assertNotIn("GITHUB_TOKEN", run.call_args.kwargs["env"])
        self.assertEqual(json.loads(bundle.read_text()), self.bundle)

    @patch("poller.urlopen")
    @patch("poller.subprocess.run")
    @patch("poller.shutil.which", return_value="/usr/bin/gh")
    def test_failed_local_verification_does_not_report_success(self, which, run, open_url):
        open_url.return_value = self.response()
        run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="invalid signature")
        with self.assertRaisesRegex(poller.PollError, "verification failed"):
            poller.verify_attestation(self.archive, SOURCE_SHA)


if __name__ == "__main__":
    unittest.main()
