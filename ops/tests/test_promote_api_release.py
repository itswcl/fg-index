from __future__ import annotations

import hashlib
import io
import os
import stat
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ops.promote_api_release import (
    ARCHIVE_NAME,
    BUNDLE_NAME,
    CHECKSUM_NAME,
    MANIFEST_NAME,
    MAX_BUNDLE_BYTES,
    MAX_TRUSTED_ROOT_BYTES,
    PREDICATE_TYPE,
    REPOSITORY,
    SIGNER_WORKFLOW,
    PromotionError,
    ReleasePromoter,
    _archive_members,
)


SOURCE_SHA = "a" * 40


def build_archive(
    source_sha: str = SOURCE_SHA,
    extra: list[tuple[str, bytes]] | None = None,
    *,
    include_runtime: bool = True,
    node_version: str = "v24.0.0",
) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        manifest = (
            f"source_commit={source_sha}\n"
            f"node_version={node_version}\n"
            "api_entrypoint=apps/api-server/dist/index.js\n"
            "start_command=(cd apps/api-server && npm start)\n"
            "shared_types_runtime=packages/shared-types/dist/index.js\n"
            "prisma_client=apps/api-server/node_modules/.prisma/client\n"
            "scheduler_setting_before_cutover=SCHEDULERS_ENABLED=false\n"
        )
        files = {MANIFEST_NAME: manifest.encode()}
        if include_runtime:
            files.update(
                {
                    "apps/api-server/package.json": b"{}\n",
                    "apps/api-server/package-lock.json": b"{}\n",
                    "apps/api-server/dist/index.js": b"export {};\n",
                    "apps/api-server/prisma/schema.prisma": b"datasource db {}\n",
                    "apps/api-server/node_modules/@prisma/client/package.json": b"{}\n",
                    "apps/api-server/node_modules/.prisma/client/default.js": b"export {};\n",
                    "packages/shared-types/package.json": b"{}\n",
                    "packages/shared-types/package-lock.json": b"{}\n",
                    "packages/shared-types/dist/index.js": b"export {};\n",
                    "apps/api-server/bin/runner.sh": b"#!/bin/sh\nexit 0\n",
                }
            )
        files.update(dict(extra or []))
        dirs = [
            "apps",
            "apps/api-server",
            "apps/api-server/dist",
            "apps/api-server/prisma",
            "apps/api-server/node_modules",
            "apps/api-server/node_modules/@shared",
            "apps/api-server/node_modules/@prisma",
            "apps/api-server/node_modules/.prisma",
            "apps/api-server/node_modules/.prisma/client",
            "apps/api-server/bin",
            "packages",
            "packages/shared-types",
            "packages/shared-types/dist",
        ]
        for name in dirs:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            if name.endswith("runner.sh"):
                info.mode = 0o755
            archive.addfile(info, io.BytesIO(content))
        link = tarfile.TarInfo("apps/api-server/node_modules/@shared/types")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../../packages/shared-types"
        archive.addfile(link)
    return buffer.getvalue()


class PromoteApiReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.staging = self.root / "staged"
        self.releases = self.root / "releases"
        self.trusted_root = self.root / "trusted_root.jsonl"
        self.staging.mkdir(mode=0o700)
        self.releases.mkdir(mode=0o755)
        self.trusted_root.write_text('{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1"}\n')
        self.trusted_root.chmod(0o644)
        self.candidate = self.staging / SOURCE_SHA
        self.candidate.mkdir(mode=0o700)
        self.archive = build_archive()
        (self.candidate / ARCHIVE_NAME).write_bytes(self.archive)
        digest = hashlib.sha256(self.archive).hexdigest()
        (self.candidate / CHECKSUM_NAME).write_text(f"{digest}  {ARCHIVE_NAME}\n")
        (self.candidate / BUNDLE_NAME).write_text('{"dsseEnvelope":{}}\n')
        for path in self.candidate.iterdir():
            path.chmod(0o600)
        (self.candidate / ARCHIVE_NAME).chmod(0o600)
        self.commands: list[tuple[list[str], dict]] = []
        self.empty_gh_config = False

        def run(command, **kwargs):
            self.commands.append((command, kwargs))
            self.empty_gh_config = list(Path(kwargs["env"]["GH_CONFIG_DIR"]).iterdir()) == []
            return SimpleNamespace(returncode=0, stdout="verified", stderr="")

        self.chown_calls: list[tuple[Path, int, int, dict]] = []

        def fake_chown(path, uid, gid, **kwargs):
            self.chown_calls.append((Path(path), uid, gid, kwargs))

        self.chown_patch = patch("ops.promote_api_release.os.chown", side_effect=fake_chown)
        self.chown_patch.start()
        self.promoter = ReleasePromoter(
            self.staging,
            self.releases,
            self.trusted_root,
            owner_check=lambda _path: True,
            directory_owner_check=lambda _path: True,
            lock_owner_check=lambda _item: True,
            group_id=4242,
            gh_path="/usr/bin/gh",
            run=run,
        )
        # These tests exercise source and archive validation. Capacity checks
        # are covered directly below so results do not depend on host disk.
        def snapshot_sizes(_path, candidate_fd, evidence):
            sizes = {}
            for name, _limit in evidence:
                descriptor = os.open(
                    name,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=candidate_fd,
                )
                try:
                    sizes[name] = os.fstat(descriptor).st_size
                finally:
                    os.close(descriptor)
            return sizes

        self.promoter._snapshot_capacity_preflight = snapshot_sizes
        self.promoter._capacity_preflight = lambda *_args: None

    def tearDown(self) -> None:
        self.chown_patch.stop()
        self.temp.cleanup()

    def test_promotes_exact_source_to_inactive_root_owned_release(self) -> None:
        current = self.root / "current"
        current.symlink_to("releases/old-sha")

        result = self.promoter.promote(SOURCE_SHA)

        self.assertEqual(result, self.releases / SOURCE_SHA)
        self.assertTrue((result / "apps/api-server/dist/index.js").is_file())
        self.assertEqual(os.readlink(current), "releases/old-sha")
        self.assertFalse((result / ARCHIVE_NAME).exists())
        self.assertFalse((self.releases / ".promotion.lock").is_symlink())
        self.assertEqual(stat.S_IMODE(result.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE((result / "apps/api-server/dist/index.js").stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE((result / "apps/api-server/bin/runner.sh").stat().st_mode), 0o751)
        self.assertTrue((result / "apps/api-server/node_modules/@shared/types").is_symlink())
        self.assertTrue(self.chown_calls)
        self.assertTrue(all(uid == 0 and gid == 4242 for _, uid, gid, _ in self.chown_calls))

    def test_verify_only_authenticates_retained_candidate_without_installing(self) -> None:
        result = self.promoter.promote(SOURCE_SHA, verify_only=True)
        self.assertEqual(result, self.releases / SOURCE_SHA)
        self.assertFalse(result.exists())
        self.assertFalse(any(path.name.startswith(".promote-") for path in self.releases.iterdir()))
        self.assertEqual(1, len(self.commands))

    def test_verify_existing_compares_full_release_tree_to_authenticated_archive(self) -> None:
        destination = self.promoter.promote(SOURCE_SHA)
        verified = self.promoter.promote(SOURCE_SHA, verify_only=True, verify_existing=True)
        self.assertEqual(destination, verified)
        self.assertEqual(2, len(self.commands))

        (destination / "apps/api-server/dist/index.js").write_text("tampered\n")
        with self.assertRaisesRegex(PromotionError, "does not match the authenticated staged archive"):
            self.promoter.promote(SOURCE_SHA, verify_only=True, verify_existing=True)

    def test_verify_existing_requires_an_installed_directory(self) -> None:
        with self.assertRaisesRegex(PromotionError, "existing release does not exist"):
            self.promoter.promote(SOURCE_SHA, verify_only=True, verify_existing=True)

    def test_verify_existing_preserves_release_capacity_reserves(self) -> None:
        self.promoter.promote(SOURCE_SHA)
        self.promoter._capacity_preflight = lambda *_args: (_ for _ in ()).throw(
            PromotionError("insufficient release-tree free space including reserve")
        )
        with self.assertRaisesRegex(PromotionError, "insufficient release-tree free space"):
            self.promoter.promote(SOURCE_SHA, verify_only=True, verify_existing=True)
        self.assertTrue((self.releases / SOURCE_SHA / MANIFEST_NAME).is_file())

    def test_gh_verification_is_pinned_and_offline_without_credentials(self) -> None:
        self.promoter.promote(SOURCE_SHA)
        command, kwargs = self.commands[0]
        pairs = list(zip(command, command[1:]))
        self.assertIn(("--repo", REPOSITORY), pairs)
        self.assertIn(("--source-digest", SOURCE_SHA), pairs)
        self.assertIn(("--source-ref", "refs/heads/main"), pairs)
        self.assertIn(("--signer-workflow", SIGNER_WORKFLOW), pairs)
        self.assertIn(("--predicate-type", PREDICATE_TYPE), pairs)
        self.assertIn("--bundle", command)
        self.assertIn("--custom-trusted-root", command)
        self.assertIn("--deny-self-hosted-runners", command)
        self.assertNotIn("GH_TOKEN", kwargs["env"])
        self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
        self.assertTrue(self.empty_gh_config)

    def test_rejects_invalid_sha_before_touching_candidate(self) -> None:
        for invalid in ("../" + SOURCE_SHA, SOURCE_SHA.upper(), "a" * 39, "a" * 41):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(PromotionError, "full lowercase"):
                self.promoter.promote(invalid)
        self.assertEqual(self.commands, [])

    def test_rejects_candidate_directory_symlink(self) -> None:
        moved = self.staging / "candidate-real"
        self.candidate.rename(moved)
        self.candidate.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(PromotionError, "real directory"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_symlink_evidence_and_missing_evidence(self) -> None:
        archive = self.candidate / ARCHIVE_NAME
        archive.unlink()
        archive.symlink_to(self.root / "outside")
        with self.assertRaisesRegex(PromotionError, "preflight the private candidate snapshot"):
            self.promoter.promote(SOURCE_SHA)
        archive.unlink()
        with self.assertRaisesRegex(PromotionError, "preflight the private candidate snapshot"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_mismatched_checksum_before_verification(self) -> None:
        (self.candidate / CHECKSUM_NAME).write_text("0" * 64 + f"  {ARCHIVE_NAME}\n")
        with self.assertRaisesRegex(PromotionError, "checksum does not match"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_invalid_or_oversized_bundle(self) -> None:
        bundle = self.candidate / BUNDLE_NAME
        bundle.write_text("not-json\n")
        with self.assertRaisesRegex(PromotionError, "JSONL"):
            self.promoter.promote(SOURCE_SHA)
        bundle.write_bytes(b"x" * (MAX_BUNDLE_BYTES + 1))
        with self.assertRaisesRegex(PromotionError, "invalid size"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_oversized_trusted_root(self) -> None:
        self.trusted_root.write_bytes(b"x" * (MAX_TRUSTED_ROOT_BYTES + 1))
        with self.assertRaisesRegex(PromotionError, "invalid size"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_untrusted_trusted_root(self) -> None:
        self.trusted_root.chmod(0o666)
        with self.assertRaisesRegex(PromotionError, "not be group- or world-writable"):
            self.promoter.promote(SOURCE_SHA)
        self.trusted_root.chmod(0o644)
        self.promoter.owner_check = lambda _path: False
        with self.assertRaisesRegex(PromotionError, "owned by root"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_symlinked_or_empty_trusted_root(self) -> None:
        actual = self.root / "trusted-root-real.jsonl"
        actual.write_text('{"trusted":true}\n')
        self.trusted_root.unlink()
        self.trusted_root.symlink_to(actual)
        with self.assertRaisesRegex(PromotionError, "regular, non-symlink"):
            self.promoter.promote(SOURCE_SHA)
        self.trusted_root.unlink()
        self.trusted_root.write_text("\n")
        with self.assertRaisesRegex(PromotionError, "JSON objects"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(self.commands, [])

    def test_rejects_existing_destination_without_overwrite(self) -> None:
        destination = self.releases / SOURCE_SHA
        destination.mkdir()
        sentinel = destination / "keep"
        sentinel.write_text("untouched")
        with self.assertRaisesRegex(PromotionError, "refusing to overwrite"):
            self.promoter.promote(SOURCE_SHA)
        self.assertEqual(sentinel.read_text(), "untouched")
        self.assertEqual(self.commands, [])

    def test_verifier_failure_leaves_no_release_tree_or_current_change(self) -> None:
        self.promoter.run = lambda *_args, **_kwargs: SimpleNamespace(
            returncode=1, stdout="", stderr="attestation invalid"
        )
        current = self.root / "current"
        current.symlink_to("releases/old-sha")
        with self.assertRaisesRegex(PromotionError, "attestation invalid"):
            self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual(os.readlink(current), "releases/old-sha")

    def test_snapshot_failure_cleans_private_scratch_without_installing(self) -> None:
        import ops.promote_api_release as promoter_module

        original = promoter_module._copy_regular_file
        calls = 0

        def interrupted_copy(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise PromotionError("simulated interrupted snapshot")
            return original(*args, **kwargs)

        current = self.root / "current"
        current.symlink_to("releases/old-sha")
        with patch("ops.promote_api_release._copy_regular_file", side_effect=interrupted_copy):
            with self.assertRaisesRegex(PromotionError, "interrupted snapshot"):
                self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual(os.readlink(current), "releases/old-sha")
        self.assertEqual([path.name for path in self.releases.iterdir()], [".promotion.lock"])

    def test_partial_extraction_and_rename_failures_clean_up(self) -> None:
        current = self.root / "current"
        current.symlink_to("releases/old-sha")

        def interrupted_extract(_archive, destination, _expected_sha):
            (destination / "partial-file").write_text("partial")
            raise PromotionError("simulated extraction interruption")

        with patch("ops.promote_api_release._extract_safely", side_effect=interrupted_extract):
            with self.assertRaisesRegex(PromotionError, "extraction interruption"):
                self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual([path.name for path in self.releases.iterdir()], [".promotion.lock"])
        self.assertEqual(os.readlink(current), "releases/old-sha")

        def interrupted_by_operator(_archive, destination, _expected_sha):
            (destination / "partial-file").write_text("partial")
            raise KeyboardInterrupt

        with patch("ops.promote_api_release._extract_safely", side_effect=interrupted_by_operator):
            with self.assertRaises(KeyboardInterrupt):
                self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual([path.name for path in self.releases.iterdir()], [".promotion.lock"])
        self.assertEqual(os.readlink(current), "releases/old-sha")

        with patch("ops.promote_api_release.os.rename", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual([path.name for path in self.releases.iterdir()], [".promotion.lock"])
        self.assertEqual(os.readlink(current), "releases/old-sha")

        with patch("ops.promote_api_release.os.rename", side_effect=OSError("simulated rename interruption")):
            with self.assertRaisesRegex(PromotionError, "rename interruption"):
                self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual([path.name for path in self.releases.iterdir()], [".promotion.lock"])
        self.assertEqual(os.readlink(current), "releases/old-sha")

    def test_concurrent_promotions_serialize_and_leave_no_partial_release(self) -> None:
        entered_verifier = threading.Event()
        second_entered_verifier = threading.Event()
        allow_verifier = threading.Event()
        second_started = threading.Event()
        verifier_calls = 0
        verifier_calls_lock = threading.Lock()

        def blocked_run(_command, **_kwargs):
            nonlocal verifier_calls
            with verifier_calls_lock:
                verifier_calls += 1
                call_number = verifier_calls
            if call_number == 1:
                entered_verifier.set()
                if not allow_verifier.wait(timeout=5):
                    raise AssertionError("test did not release the first verifier")
            else:
                second_entered_verifier.set()
            return SimpleNamespace(returncode=0, stdout="verified", stderr="")

        self.promoter.run = blocked_run
        current = self.root / "current"
        current.symlink_to("releases/old-sha")
        successes: list[Path] = []
        failures: list[Exception] = []

        def promote_first() -> None:
            try:
                successes.append(self.promoter.promote(SOURCE_SHA))
            except Exception as error:  # surfaced in assertions below
                failures.append(error)

        def promote_second() -> None:
            second_started.set()
            try:
                successes.append(self.promoter.promote(SOURCE_SHA))
            except Exception as error:  # serialized second call refuses the installed SHA
                failures.append(error)

        first = threading.Thread(target=promote_first)
        second = threading.Thread(target=promote_second)
        first.start()
        self.assertTrue(entered_verifier.wait(timeout=5))
        second.start()
        self.assertTrue(second_started.wait(timeout=5))
        # Keep the first call blocked in verification while giving the second
        # call time to reach its verifier. It must remain behind the file lock.
        second_entered_early = second_entered_verifier.wait(timeout=1)
        allow_verifier.set()
        first.join(timeout=5)
        second.join(timeout=5)

        self.assertFalse(second_entered_early, "second promotion reached verification before the first completed")
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(verifier_calls, 1)
        self.assertEqual(successes, [self.releases / SOURCE_SHA])
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], PromotionError)
        self.assertIn("refusing to overwrite", str(failures[0]))
        self.assertTrue((self.releases / SOURCE_SHA / MANIFEST_NAME).is_file())
        self.assertEqual(sorted(path.name for path in self.releases.iterdir()), [".promotion.lock", SOURCE_SHA])
        self.assertEqual(os.readlink(current), "releases/old-sha")

    def test_rejects_unsafe_tar_paths_and_link_targets(self) -> None:
        fixtures = [
            [("../../outside", b"bad")],
            [("/absolute", b"bad")],
        ]
        for extra in fixtures:
            with self.subTest(extra=extra):
                archive_path = self.root / "unsafe.tar.gz"
                archive_path.write_bytes(build_archive(extra=extra))
                with self.assertRaises(PromotionError):
                    _archive_members(archive_path)

        archive_path = self.root / "unsafe-link.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            info = tarfile.TarInfo("escape")
            info.type = tarfile.SYMTYPE
            info.linkname = "../../outside"
            archive.addfile(info)
        with self.assertRaisesRegex(PromotionError, "unsafe symlink"):
            _archive_members(archive_path)

    def test_rejects_duplicate_special_and_oversized_archive_members(self) -> None:
        duplicate_path = self.root / "duplicate.tar.gz"
        with tarfile.open(duplicate_path, "w:gz") as archive:
            for _ in range(2):
                info = tarfile.TarInfo("same")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(PromotionError, "duplicate path"):
            _archive_members(duplicate_path)

        special_path = self.root / "special.tar.gz"
        with tarfile.open(special_path, "w:gz") as archive:
            info = tarfile.TarInfo("device")
            info.type = tarfile.CHRTYPE
            archive.addfile(info)
        with self.assertRaisesRegex(PromotionError, "unsupported entry type"):
            _archive_members(special_path)

        large_path = self.root / "large.tar.gz"
        with tarfile.open(large_path, "w:gz") as archive:
            info = tarfile.TarInfo("large")
            info.size = 3
            archive.addfile(info, io.BytesIO(b"xxx"))
        with patch("ops.promote_api_release.MAX_EXTRACTED_BYTES", 2):
            with self.assertRaisesRegex(PromotionError, "extraction size limit"):
                _archive_members(large_path)

        implicit_path = self.root / "implicit-paths.tar.gz"
        with tarfile.open(implicit_path, "w:gz") as archive:
            info = tarfile.TarInfo("one/two/file.txt")
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        with patch("ops.promote_api_release.MAX_ARCHIVE_ENTRIES", 2):
            with self.assertRaisesRegex(PromotionError, "filesystem paths"):
                _archive_members(implicit_path)

        reserved_path = self.root / "reserved.tar.gz"
        with tarfile.open(reserved_path, "w:gz") as archive:
            info = tarfile.TarInfo(BUNDLE_NAME)
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(PromotionError, "reserved root path"):
            _archive_members(reserved_path)

    def test_capacity_preflights_preserve_space_and_inode_reserves(self) -> None:
        filesystem = SimpleNamespace(f_frsize=4096, f_bsize=4096, f_favail=20_000)
        with patch("ops.promote_api_release.os.statvfs", return_value=filesystem), patch(
            "ops.promote_api_release.shutil.disk_usage", return_value=SimpleNamespace(free=1024)
        ):
            with self.assertRaisesRegex(PromotionError, "8 GiB reserve"):
                ReleasePromoter._capacity_preflight(
                    self.releases,
                    [tarfile.TarInfo("file")],
                    {"file"},
                )
        filesystem.f_favail = 1
        with patch("ops.promote_api_release.os.statvfs", return_value=filesystem), patch(
            "ops.promote_api_release.shutil.disk_usage",
            return_value=SimpleNamespace(free=20 * 1024**3),
        ):
            with self.assertRaisesRegex(PromotionError, "10,000-inode reserve"):
                ReleasePromoter._capacity_preflight(
                    self.releases,
                    [tarfile.TarInfo("file")],
                    {"file"},
                )

    def test_snapshot_preflight_preserves_reserves_for_real_evidence_files(self) -> None:
        candidate_fd = os.open(self.candidate, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        evidence = ((ARCHIVE_NAME, 2 * 1024**3), (CHECKSUM_NAME, 1024), (BUNDLE_NAME, MAX_BUNDLE_BYTES))
        try:
            filesystem = SimpleNamespace(f_frsize=4096, f_bsize=4096, f_favail=20_000)
            with patch("ops.promote_api_release.os.statvfs", return_value=filesystem), patch(
                "ops.promote_api_release.shutil.disk_usage", return_value=SimpleNamespace(free=1)
            ):
                with self.assertRaisesRegex(PromotionError, "8 GiB reserve"):
                    ReleasePromoter._snapshot_capacity_preflight(
                        self.releases, candidate_fd, evidence
                    )

            filesystem.f_favail = 10_006
            with patch("ops.promote_api_release.os.statvfs", return_value=filesystem), patch(
                "ops.promote_api_release.shutil.disk_usage",
                return_value=SimpleNamespace(free=20 * 1024**3),
            ):
                with self.assertRaisesRegex(PromotionError, "10,000-inode reserve"):
                    ReleasePromoter._snapshot_capacity_preflight(
                        self.releases, candidate_fd, evidence
                    )
        finally:
            os.close(candidate_fd)

    def test_rejects_manifest_for_another_commit_and_cleans_temporary_tree(self) -> None:
        archive = build_archive("b" * 40)
        (self.candidate / ARCHIVE_NAME).write_bytes(archive)
        (self.candidate / CHECKSUM_NAME).write_text(
            f"{hashlib.sha256(archive).hexdigest()}  {ARCHIVE_NAME}\n"
        )
        with self.assertRaisesRegex(PromotionError, "manifest source_commit"):
            self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())
        self.assertEqual(
            [path.name for path in self.releases.iterdir()], [".promotion.lock"]
        )

    def test_rejects_manifest_only_archive_and_wrong_runtime_version(self) -> None:
        archive = build_archive(include_runtime=False)
        (self.candidate / ARCHIVE_NAME).write_bytes(archive)
        (self.candidate / CHECKSUM_NAME).write_text(
            f"{hashlib.sha256(archive).hexdigest()}  {ARCHIVE_NAME}\n"
        )
        with self.assertRaisesRegex(PromotionError, "missing a required runtime file"):
            self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())

        archive = build_archive(node_version="v22.0.0")
        (self.candidate / ARCHIVE_NAME).write_bytes(archive)
        (self.candidate / CHECKSUM_NAME).write_text(
            f"{hashlib.sha256(archive).hexdigest()}  {ARCHIVE_NAME}\n"
        )
        with self.assertRaisesRegex(PromotionError, "Node 24"):
            self.promoter.promote(SOURCE_SHA)
        self.assertFalse((self.releases / SOURCE_SHA).exists())

if __name__ == "__main__":
    unittest.main()
