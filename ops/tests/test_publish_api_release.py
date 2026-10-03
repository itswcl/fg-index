import hashlib
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from ops.publish_api_release import GitHubError, main, publish_or_verify

SOURCE_SHA = "a" * 40
TAG = f"api-{SOURCE_SHA}"


class FakeApi:
    def __init__(self, ref=None, release=None):
        self.ref = ref
        self.release = release
        self.created_tags = []

    def get_tag_ref(self, tag):
        return self.ref

    def get_release(self, tag):
        return self.release

    def create_tag(self, tag, source_sha):
        self.created_tags.append((tag, source_sha))
        self.ref = {"object": {"sha": source_sha, "type": "commit"}}

    def request(self, method, path, body=None):
        raise AssertionError(f"Unexpected API request: {method} {path}")


def write_artifacts(directory):
    paths = {
        "api-release.tar.gz": directory / "api-release.tar.gz",
        "api-release.tar.gz.sha256": directory / "api-release.tar.gz.sha256",
    }
    paths["api-release.tar.gz"].write_bytes(b"archive bytes")
    paths["api-release.tar.gz.sha256"].write_text("checksum bytes\n")
    return paths


def matching_release(paths):
    assets = []
    for name, path in paths.items():
        assets.append({
            "name": name,
            "state": "uploaded",
            "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
        })
    return {"tag_name": TAG, "draft": False, "immutable": True, "assets": assets}


class PublishApiReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.artifact_dir = Path(self.tempdir.name)
        self.paths = write_artifacts(self.artifact_dir)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_first_create_adds_exact_tag_then_publishes_and_verifies(self):
        api = FakeApi()
        calls = []

        def create(repository, tag, source_sha, artifact_dir):
            calls.append((repository, tag, source_sha))
            api.release = matching_release(self.paths)

        result = publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, create)

        self.assertEqual(result, "created-and-verified")
        self.assertEqual(api.created_tags, [(TAG, SOURCE_SHA)])
        self.assertEqual(calls, [("owner/repo", TAG, SOURCE_SHA)])

    def test_exact_retry_is_a_no_op(self):
        api = FakeApi(
            ref={"object": {"sha": SOURCE_SHA, "type": "commit"}},
            release=matching_release(self.paths),
        )
        calls = []

        result = publish_or_verify(
            api,
            "owner/repo",
            SOURCE_SHA,
            self.artifact_dir,
            lambda *args: calls.append(args),
        )

        self.assertEqual(result, "verified-existing")
        self.assertEqual(api.created_tags, [])
        self.assertEqual(calls, [])

    def test_mismatched_tag_target_fails_without_publishing(self):
        api = FakeApi(
            ref={"object": {"sha": "b" * 40, "type": "commit"}},
            release=matching_release(self.paths),
        )
        calls = []

        with self.assertRaisesRegex(GitHubError, "does not resolve"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: calls.append(args))

        self.assertEqual(calls, [])

    def test_mismatched_asset_digest_fails_without_publishing(self):
        release = matching_release(self.paths)
        release["assets"][0]["digest"] = "sha256:" + "0" * 64
        api = FakeApi(ref={"object": {"sha": SOURCE_SHA, "type": "commit"}}, release=release)

        with self.assertRaisesRegex(GitHubError, "SHA-256 does not match"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: self.fail("published"))

    def test_mismatched_checksum_asset_digest_fails_without_publishing(self):
        release = matching_release(self.paths)
        release["assets"][1]["digest"] = "sha256:" + "0" * 64
        api = FakeApi(ref={"object": {"sha": SOURCE_SHA, "type": "commit"}}, release=release)

        with self.assertRaisesRegex(GitHubError, "SHA-256 does not match"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: self.fail("published"))

    def test_partial_exact_tag_retries_release_creation(self):
        api = FakeApi(ref={"object": {"sha": SOURCE_SHA, "type": "commit"}})
        calls = []

        def create(repository, tag, source_sha, artifact_dir):
            calls.append((repository, tag, source_sha))
            api.release = matching_release(self.paths)

        result = publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, create)

        self.assertEqual(result, "created-and-verified")
        self.assertEqual(api.created_tags, [])
        self.assertEqual(calls, [("owner/repo", TAG, SOURCE_SHA)])

    def test_partial_tag_with_wrong_target_fails_without_publishing(self):
        api = FakeApi(ref={"object": {"sha": "b" * 40, "type": "commit"}})

        with self.assertRaisesRegex(GitHubError, "does not resolve"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: self.fail("published"))

    def test_release_without_tag_fails_closed(self):
        api = FakeApi(release=matching_release(self.paths))

        with self.assertRaisesRegex(GitHubError, "without its expected tag"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: self.fail("published"))

    def test_immutability_confirmation_missing_or_false_performs_no_api_writes(self):
        for confirmation in (None, "false"):
            with self.subTest(confirmation=confirmation):
                environment = {
                    "GITHUB_REPOSITORY": "owner/repo",
                    "SOURCE_SHA": SOURCE_SHA,
                    "ARTIFACT_DIR": str(self.artifact_dir),
                    "GH_TOKEN": "test-token",
                }
                if confirmation is not None:
                    environment["API_RELEASE_IMMUTABILITY_CONFIRMED"] = confirmation

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch("ops.publish_api_release.GitHubApi") as api_factory,
                    patch("ops.publish_api_release.subprocess.run") as run,
                ):
                    errors = io.StringIO()
                    with redirect_stderr(errors):
                        self.assertEqual(main(), 1)

                api_factory.assert_not_called()
                run.assert_not_called()
                self.assertIn("API_RELEASE_IMMUTABILITY_CONFIRMED=true", errors.getvalue())

    def test_existing_non_immutable_release_fails_without_publishing(self):
        release = matching_release(self.paths)
        release["immutable"] = False
        api = FakeApi(ref={"object": {"sha": SOURCE_SHA, "type": "commit"}}, release=release)

        with self.assertRaisesRegex(GitHubError, "not immutable"):
            publish_or_verify(api, "owner/repo", SOURCE_SHA, self.artifact_dir, lambda *args: self.fail("published"))


if __name__ == "__main__":
    unittest.main()
