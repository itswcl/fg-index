"""Deployment operation tests with a temporary filesystem and fixed-command fake."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import subprocess

from ops.deploy_api_release import Deployment, DeploymentError, Host, Paths

CURRENT = "a" * 40
PREVIOUS = "b" * 40
INCOMING = "c" * 40
OLDER = "d" * 40
ADVANCED = "e" * 40


class FakeHost(Host):
    def __init__(self, paths: Paths, candidate=None, promote_error=None, restart_error=None):
        super().__init__(paths, owner_uid=os.geteuid())
        self.candidate = candidate
        self.promote_error = promote_error
        self.restart_error = restart_error
        self.promotions = []
        self.restarts = 0
        self.poll_error = None
        self.on_restart = None
        self.main_sha = None

    def current_main_sha(self):
        return self.main_sha or self.candidate or CURRENT

    def poll(self):
        if self.poll_error:
            raise self.poll_error
        return self.candidate

    def promote(self, sha):
        self.promotions.append(sha)
        if self.promote_error:
            raise self.promote_error
        _make_release(self.paths.releases / sha, sha)

    def restart(self):
        self.restarts += 1
        if self.on_restart:
            self.on_restart()
        if self.restart_error:
            raise self.restart_error


def _make_release(path: Path, sha: str):
    app = path / "apps/api-server/dist"
    app.mkdir(parents=True)
    (app / "index.js").write_text("// fixture\n")
    (path / "RELEASE-MANIFEST.txt").write_text(f"source_commit={sha}\n")


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.paths = Paths(
            releases=root / "opt/fg-index/releases",
            current=root / "opt/fg-index/current",
            state_dir=root / "var/lib/fg-index-deployment",
            staged=root / "var/lib/fg-index-release-poller/staged",
            promoter=root / "promote_api_release.py",
            retention_policy=root / "etc/fg-index-release-poller/retention-policy.json",
        )
        for directory in (self.paths.releases, self.paths.state_dir, self.paths.staged,
                          self.paths.retention_policy.parent):
            directory.mkdir(parents=True, exist_ok=True)
        _make_release(self.paths.releases / CURRENT, CURRENT)
        _make_release(self.paths.releases / PREVIOUS, PREVIOUS)
        self.paths.current.symlink_to(self.paths.releases / CURRENT)
        self.state = {
            "schema_version": 1,
            "selected_sha": CURRENT,
            "previous_sha": PREVIOUS,
            "suppressed_shas": [],
            "restart_status": "succeeded",
        }
        self.host = FakeHost(self.paths)
        self.deploy = Deployment(self.host)
        self.deploy.save(self.state)

    def tearDown(self):
        self.temp.cleanup()

    def read_state(self):
        return json.loads(self.paths.state.read_text())

    def test_download_or_poll_failure_preserves_selection_and_does_not_restart(self):
        self.host.poll_error = DeploymentError("network unavailable")
        with self.assertRaisesRegex(DeploymentError, "network unavailable"):
            self.deploy.once()
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(CURRENT, self.read_state()["selected_sha"])
        self.assertEqual(0, self.host.restarts)

    def test_main_waiting_for_release_does_not_select_an_older_staged_candidate(self):
        stale = self.paths.staged / PREVIOUS
        stale.mkdir()
        (stale / ".fg-index-verification.json").write_text(json.dumps({
            "source_sha": PREVIOUS, "verified_at": "9999-01-01T00:00:00Z"
        }))
        sequence = iter([INCOMING, INCOMING])
        runner_calls = []

        class PollHost(Host):
            def current_main_sha(inner_self):
                return next(sequence)

            def command(inner_self, argv, **kwargs):
                runner_calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, b"", b"")

        host = PollHost(self.paths, command=lambda argv, **kwargs:
                        runner_calls.append(argv) or subprocess.CompletedProcess(argv, 0, b"", b""),
                        owner_uid=os.geteuid())
        self.assertIsNone(host.poll())
        self.assertEqual([["/usr/bin/systemctl", "start", "fg-index-release-poller.service"]], runner_calls)

    def test_main_advance_during_poll_rejects_any_staged_candidate(self):
        staged = self.paths.staged / INCOMING
        staged.mkdir()
        (staged / ".fg-index-verification.json").write_text(json.dumps({"source_sha": INCOMING}))
        sequence = iter([INCOMING, ADVANCED])

        class PollHost(Host):
            def current_main_sha(inner_self):
                return next(sequence)

            def command(inner_self, argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, b"", b"")

        self.assertIsNone(PollHost(self.paths, command=lambda argv, **kwargs:
                                   subprocess.CompletedProcess(argv, 0, b"", b""),
                                   owner_uid=os.geteuid()).poll())

    def test_integrity_or_promotion_failure_leaves_current_and_service_untouched(self):
        self.host.candidate = INCOMING
        self.host.promote_error = DeploymentError("attestation verification failed")
        with self.assertRaisesRegex(DeploymentError, "attestation verification failed"):
            self.deploy.once()
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(CURRENT, self.read_state()["selected_sha"])
        self.assertEqual(0, self.host.restarts)

    def test_verified_release_is_durably_selected_before_fixed_restart(self):
        self.host.candidate = INCOMING

        def observe_selection():
            state = self.read_state()
            self.assertEqual(INCOMING, state["selected_sha"])
            self.assertEqual(CURRENT, state["previous_sha"])
            self.assertEqual(INCOMING, self.deploy.selected_link())

        self.host.on_restart = observe_selection
        self.assertIn("fixed API restart attempted", self.deploy.once())
        self.assertEqual(1, self.host.restarts)
        self.assertEqual("succeeded", self.read_state()["restart_status"])
        self.assertFalse((self.paths.releases / PREVIOUS).exists())
        self.assertEqual({"schema_version": 1, "protected_shas": sorted([INCOMING, CURRENT])},
                         json.loads(self.paths.retention_policy.read_text()))

    def test_unknown_legacy_root_release_blocks_automatic_mutation(self):
        _make_release(self.paths.releases / OLDER, OLDER)
        self.host.candidate = INCOMING
        with self.assertRaisesRegex(DeploymentError, "unknown legacy release tree"):
            self.deploy.once()
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(0, self.host.restarts)
        self.assertEqual([], self.host.promotions)

    def test_main_advance_during_promotion_does_not_select_stale_release(self):
        self.host.candidate = INCOMING
        self.host.main_sha = ADVANCED
        self.assertIn("was not selected", self.deploy.once())
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(CURRENT, self.read_state()["selected_sha"])
        self.assertFalse((self.paths.releases / INCOMING).exists())
        self.assertEqual(0, self.host.restarts)

    def test_restart_failure_is_reported_but_selection_stays_and_no_probe_or_rollback_runs(self):
        self.host.candidate = INCOMING
        self.host.restart_error = DeploymentError("systemctl failed")
        with self.assertRaisesRegex(DeploymentError, "systemctl failed"):
            self.deploy.once()
        state = self.read_state()
        self.assertEqual(INCOMING, state["selected_sha"])
        self.assertEqual(CURRENT, state["previous_sha"])
        self.assertEqual("failed", state["restart_status"])
        self.assertEqual(INCOMING, self.deploy.selected_link())
        self.assertEqual(1, self.host.restarts)
        self.assertEqual([INCOMING], self.host.promotions)

    def test_duplicate_poll_is_idempotent_and_does_not_repeat_restart(self):
        self.host.candidate = INCOMING
        self.deploy.once()
        self.assertIn("already selected", self.deploy.once())
        self.assertEqual(1, self.host.restarts)
        self.assertEqual([INCOMING], self.host.promotions)

    def test_manual_rollback_selects_recorded_previous_and_suppresses_failed_sha(self):
        _make_release(self.paths.releases / INCOMING, INCOMING)
        self.state.update(selected_sha=INCOMING, previous_sha=CURRENT)
        self.deploy.save(self.state)
        self.paths.current.unlink()
        self.paths.current.symlink_to(self.paths.releases / INCOMING)
        self.host.candidate = INCOMING

        self.assertIn("suppressed " + INCOMING, self.deploy.rollback(CURRENT))
        state = self.read_state()
        self.assertEqual(CURRENT, state["selected_sha"])
        self.assertEqual(INCOMING, state["previous_sha"])
        self.assertEqual([INCOMING], state["suppressed_shas"])
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(1, self.host.restarts)
        self.assertIn("suppressed release", self.deploy.once())
        self.assertEqual(1, self.host.restarts)

    def test_rollback_requires_operator_target_to_equal_recorded_previous(self):
        with self.assertRaisesRegex(DeploymentError, "must equal the recorded previous"):
            self.deploy.rollback(OLDER)
        self.assertEqual(CURRENT, self.deploy.selected_link())
        self.assertEqual(0, self.host.restarts)

    def test_restart_attempt_with_unknown_outcome_is_never_retried_automatically(self):
        self.state["restart_status"] = "attempting"
        self.deploy.save(self.state)
        with self.assertRaisesRegex(DeploymentError, "outcome is unknown"):
            self.deploy.once()
        self.assertEqual(0, self.host.restarts)
        self.assertIn(CURRENT, self.deploy.restart_selected())
        self.assertEqual(1, self.host.restarts)

    def test_explicit_restart_selected_is_operator_control(self):
        self.state["restart_status"] = "failed"
        self.deploy.save(self.state)
        self.assertIn(CURRENT, self.deploy.restart_selected())
        self.assertEqual(1, self.host.restarts)

    def test_concurrent_installer_or_rollback_fails_fast_on_shared_lock(self):
        with self.deploy.lock():
            with self.assertRaisesRegex(DeploymentError, "deployment lock"):
                with self.deploy.lock():
                    pass

    def test_current_link_escape_and_wrong_manifest_are_rejected(self):
        self.paths.current.unlink()
        self.paths.current.symlink_to(self.paths.state_dir)
        with self.assertRaisesRegex(DeploymentError, "leaves the release directory"):
            self.deploy.selected_link()
        self.paths.current.unlink()
        bad = self.paths.releases / INCOMING
        _make_release(bad, OLDER)
        with self.assertRaisesRegex(DeploymentError, "source_commit"):
            self.deploy.validate_known_release(INCOMING)

    def test_state_caps_suppressed_release_set(self):
        value = dict(self.state)
        value["suppressed_shas"] = [f"{number:040x}" for number in range(33)]
        with self.assertRaisesRegex(DeploymentError, "invalid suppressed"):
            self.deploy.save(value)


if __name__ == "__main__":
    unittest.main()
