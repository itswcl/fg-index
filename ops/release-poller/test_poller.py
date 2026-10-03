import hashlib
import io
import json
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
        self.verified: list[tuple[Path, str]] = []

    def tearDown(self) -> None:
        self.temp.cleanup()

    def verifier(self, archive: Path, source_sha: str) -> None:
        self.verified.append((archive, source_sha))

    def test_stages_only_verified_release_and_leaves_current_untouched(self) -> None:
        client = FakeGitHub()
        result = poller.ReleasePoller(self.root, client, self.verifier).poll_once()

        target = self.root / "staged" / SOURCE_SHA
        self.assertEqual(result.status, "staged")
        self.assertTrue((target / "apps/api-server/dist/index.js").is_file())
        self.assertTrue((target / "apps/api-server/node_modules/@shared/types").is_symlink())
        self.assertFalse((self.root / "current").exists())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((target / "apps/api-server/dist/index.js").stat().st_mode), 0o600)
        for path in (target, target / "RELEASE-MANIFEST.txt", target / poller.MARKER_NAME):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
        marker = json.loads((target / poller.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["source_sha"], SOURCE_SHA)
        self.assertEqual(marker["archive_sha256"], sha256(client.archive))
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

    def test_systemd_unit_confines_poller_to_private_state_directory(self) -> None:
        unit = (Path(__file__).parent / "systemd" / "fg-index-release-poller.service").read_text(encoding="utf-8")
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
        result = poller.ReleasePoller(self.root, client, self.verifier).poll_once()

        self.assertEqual(result.status, "waiting")
        self.assertEqual(client.downloads, [])
        self.assertEqual(self.verified, [])

    def test_rejects_wrong_tag_target_before_download(self) -> None:
        client = FakeGitHub()
        client.ref_sha = NEXT_SHA

        with self.assertRaisesRegex(poller.PollError, "does not point directly"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_release_that_is_not_immutable(self) -> None:
        client = FakeGitHub()
        client.release["immutable"] = False

        with self.assertRaisesRegex(poller.PollError, "not marked immutable"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_extra_release_asset(self) -> None:
        client = FakeGitHub()
        client.release["assets"].append(FakeGitHub._asset("unexpected.txt", b"x"))

        with self.assertRaisesRegex(poller.PollError, "exactly the expected"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()

    def test_rejects_unexpected_asset_download_url(self) -> None:
        client = FakeGitHub()
        client.release["assets"][0]["browser_download_url"] = "https://attacker.example/release.tar.gz"

        with self.assertRaisesRegex(poller.PollError, "unexpected download URL"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()
        self.assertEqual(client.downloads, [])

    def test_rejects_checksum_mismatch_before_attestation(self) -> None:
        bad_checksum = b"0" * 64 + b"  api-release.tar.gz\n"
        client = FakeGitHub(checksum=bad_checksum)

        with self.assertRaisesRegex(poller.PollError, "checksum sidecar does not verify"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()
        self.assertEqual(self.verified, [])

    def test_rejects_failed_attestation_without_staging(self) -> None:
        client = FakeGitHub()

        def reject_attestation(_archive: Path, _source_sha: str) -> None:
            raise poller.PollError("bad provenance")

        with self.assertRaisesRegex(poller.PollError, "bad provenance"):
            poller.ReleasePoller(self.root, client, reject_attestation).poll_once()
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_rejects_manifest_for_a_different_source_sha(self) -> None:
        client = FakeGitHub(archive=make_archive(NEXT_SHA))

        with self.assertRaisesRegex(poller.PollError, "manifest source_commit"):
            poller.ReleasePoller(self.root, client, self.verifier).poll_once()
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_discards_verified_release_if_main_moves_during_verification(self) -> None:
        client = FakeGitHub()
        client.branch_shas = [SOURCE_SHA, NEXT_SHA]
        result = poller.ReleasePoller(self.root, client, self.verifier).poll_once()

        self.assertEqual(result.status, "main-moved")
        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_refuses_before_download_when_free_space_reserve_would_be_breached(self) -> None:
        client = FakeGitHub()
        with patch("poller.shutil.disk_usage", return_value=SimpleNamespace(free=poller.MIN_FREE_BYTES)):
            with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                poller.ReleasePoller(self.root, client, self.verifier).poll_once()

        self.assertEqual(client.downloads, [])

    def test_cleans_temporary_release_when_expansion_would_breach_reserve(self) -> None:
        client = FakeGitHub()
        enough_for_download = (
            poller.MIN_FREE_BYTES + len(client.archive) + len(client.checksum) + 1024
        )
        free_space = [
            SimpleNamespace(free=enough_for_download),
            SimpleNamespace(free=poller.MIN_FREE_BYTES + 1),
        ]
        with patch("poller.shutil.disk_usage", side_effect=free_space):
            with self.assertRaisesRegex(poller.PollError, "insufficient free space"):
                poller.ReleasePoller(self.root, client, self.verifier).poll_once()

        self.assertFalse((self.root / "staged" / SOURCE_SHA).exists())

    def test_already_staged_sha_does_not_redownload_release(self) -> None:
        first = FakeGitHub()
        poller.ReleasePoller(self.root, first, self.verifier).poll_once()
        second = FakeGitHub()
        result = poller.ReleasePoller(self.root, second, self.verifier).poll_once()

        self.assertEqual(result.status, "already-staged")
        self.assertEqual(second.branch_reads, 1)
        self.assertEqual(second.downloads, [])

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

    @patch("poller.subprocess.run")
    @patch("poller.shutil.which", return_value="/usr/bin/gh")
    def test_attestation_cli_uses_empty_auth_config_and_exact_policy(self, which, run) -> None:
        captured_env: dict = {}

        def fake_run(_command, **kwargs):
            env = kwargs["env"]
            captured_env.update(env)
            self.assertTrue(Path(env["GH_CONFIG_DIR"]).is_dir())
            self.assertEqual(list(Path(env["GH_CONFIG_DIR"]).iterdir()), [])
            self.assertEqual(Path(env["GH_CONFIG_DIR"]).parent, Path(env["HOME"]))
            return SimpleNamespace(returncode=0, stdout="ok", stderr="")

        run.side_effect = fake_run
        archive = self.root / "artifact.tar.gz"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"artifact")

        poller.verify_attestation(archive, SOURCE_SHA)

        command = run.call_args.args[0]
        env = captured_env
        self.assertEqual(command[1:3], ["attestation", "verify"])
        self.assertIn(SOURCE_SHA, command)
        self.assertIn("refs/heads/main", command)
        self.assertIn(poller.WORKFLOW, command)
        self.assertIn(poller.PREDICATE, command)
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("GITHUB_TOKEN", env)


if __name__ == "__main__":
    unittest.main()
