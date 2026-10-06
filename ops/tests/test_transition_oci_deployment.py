"""The one-time transition executes against temporary host fixtures only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ops import transition_oci_deployment as transition
from ops.transition_oci_deployment import Host, TransitionError, release_inventory, require

CURRENT = "a" * 40
PREVIOUS = "b" * 40


class TransitionTest(unittest.TestCase):
    def test_receipts_can_come_from_an_interrupted_rollback_or_retention_ledger(self):
        held_state = {
            "schema_version": 1,
            "current": {"sha": CURRENT, "inventory": "current-inventory"},
            "rollback": None,
            "hold": "rollback incomplete; review before further action",
            "transaction": {
                "stage": "rolling-back",
                "previous": {"sha": CURRENT, "inventory": "current-inventory"},
                "next": {"sha": PREVIOUS, "inventory": "previous-inventory"},
            },
        }
        ledger = {"schema_version": 1, "images": {PREVIOUS: {"sha": PREVIOUS, "inventory": "previous-inventory"}}}
        receipts = Host.accepted_receipts(held_state, ledger)

        self.assertEqual("current-inventory", receipts[CURRENT]["inventory"])
        self.assertEqual("previous-inventory", receipts[PREVIOUS]["inventory"])
        self.assertEqual({CURRENT, PREVIOUS}, set(receipts))

    def test_current_can_be_seeded_without_a_previous_receipt(self):
        state = {"schema_version": 1, "current": {"sha": CURRENT, "inventory": "i"},
                 "rollback": None, "hold": "old hold", "transaction": {"stage": "rolling-back"}}
        self.assertEqual({CURRENT}, set(Host.accepted_receipts(state, {"images": {}})))

    def test_transition_source_contains_no_health_or_recovery_acceptance_calls(self):
        import inspect
        from ops import transition_oci_deployment

        source = inspect.getsource(transition_oci_deployment.Host)
        self.assertNotIn("/health", source)
        self.assertNotIn("--recover", source)
        self.assertNotIn("--watchdog", source)

    def test_release_inventory_rejects_unsupported_release_objects(self):
        # The pure inventory function is exercised on temporary fixtures by the
        # deployment tests; malformed input must fail closed before acceptance.
        with self.assertRaises((TransitionError, OSError)):
            release_inventory(__import__("pathlib").Path("/definitely/not/a/release"), 0)


class FakeTransitionHost(Host):
    def __init__(self, *args, verification_fails=False, **kwargs):
        self.commands = []
        self.verification_fails = verification_fails
        super().__init__(*args, command=self.command, **kwargs)

    def assert_old_units(self):
        pass

    def assert_old_helpers(self):
        pass

    def assert_source(self):
        require(self.source.is_dir(), "source missing")

    def command(self, argv, check=True, capture_output=True, timeout=None):
        self.commands.append(list(argv))
        if "--verify-only" in argv and self.verification_fails:
            raise subprocess.CalledProcessError(1, argv)
        if argv[:3] == ["/usr/bin/systemctl", "show", "--property=ActiveState"]:
            return subprocess.CompletedProcess(argv, 0, b"inactive\n", b"")
        if argv[:3] == ["/usr/bin/systemctl", "show", "--property=UnitFileState"]:
            unit = argv[-1]
            value = "enabled" if unit == "fg-index-api.service" else "disabled"
            return subprocess.CompletedProcess(argv, 0, (value + "\n").encode(), b"")
        if argv[:3] == ["/usr/bin/systemctl", "show", "--property=Requires"]:
            return subprocess.CompletedProcess(argv, 0, b"\n", b"")
        return subprocess.CompletedProcess(argv, 0, b"", b"")


class TransitionApplyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch_acl = patch.object(transition.os, "listxattr", lambda *_args, **_kwargs: [], create=True)
        self.patch_acl.start()
        self.root = Path(self.temp.name)
        self.uid, self.gid = os.geteuid(), os.getgid()
        self.current = "a" * 40
        self.previous = "b" * 40
        self.schema_bytes = b"datasource db {}\n"
        self.schema_sha = hashlib.sha256(self.schema_bytes).hexdigest()
        self.app = self.root / "opt/fg-index"
        self.releases = self.app / "releases"
        self.state = self.root / "var/lib/fg-index-deployment"
        self.systemd = self.root / "etc/systemd/system"
        self.config = self.root / "etc/fg-index"
        self.poller_config = self.root / "etc/fg-index-release-poller"
        self.node = self.root / "opt/nodejs"
        self.libexec = self.root / "usr/local/libexec/fg-index-deployment"
        self.promoter = self.root / "usr/local/libexec/fg-index-release-promoter/promote_api_release.py"
        self.poller_helper = self.root / "usr/local/libexec/fg-index-release-poller/poller.py"
        self.source = self.root / "reviewed-source"
        for path in (self.releases, self.state, self.systemd / "fg-index-api.service.d",
                     self.config, self.poller_config, self.node / "releases/node-v24.21.0/bin",
                     self.libexec, self.promoter.parent, self.poller_helper.parent,
                     self.source / "ops/deployment/systemd"):
            path.mkdir(parents=True, exist_ok=True)
        self._release(self.current)
        self._release(self.previous)
        current_link = self.app / "current"
        current_link.symlink_to(self.releases / self.current)
        node_dir = self.node / "releases/node-v24.21.0"
        node_binary = node_dir / "bin/node"
        node_binary.write_bytes(b"fixture node\n")
        node_binary.chmod(0o750)
        self._own(node_binary, 0o750)
        (self.node / "current").symlink_to(node_dir)
        self.node_sha = hashlib.sha256(node_binary.read_bytes()).hexdigest()

        self.scheduler_bytes = b"[Service]\nEnvironment=SCHEDULERS_ENABLED=true\n"
        self.guard_bytes = b"old boot guard\n"
        scheduler_path = self.systemd / "fg-index-api.service.d/10-scheduler-owner.conf"
        scheduler_path.write_bytes(self.scheduler_bytes)
        guard_path = self.systemd / "fg-index-api.service.d/20-deployment-boot-guard.conf"
        guard_path.write_bytes(self.guard_bytes)
        self._own(scheduler_path, 0o644)
        self._own(guard_path, 0o644)
        self.patch_boot_guard = patch("ops.transition_oci_deployment.BOOT_GUARD_DROPIN_SHA",
                                      hashlib.sha256(self.guard_bytes).hexdigest())
        self.patch_boot_guard.start()
        self.patch_scheduler = patch("ops.transition_oci_deployment.SCHEDULER_OWNER_DROPIN_SHA",
                                     hashlib.sha256(self.scheduler_bytes).hexdigest())
        self.patch_scheduler.start()

        api_env = self.config / "api.env"
        api_env.write_text("TEST_SECRET_SENTINEL=must-not-be-read\n")
        self._own(api_env, 0o640)
        self.api_env_bytes = api_env.read_bytes()

        self._legacy_units()
        current_receipt = self._receipt(self.current)
        previous_receipt = self._receipt(self.previous)
        legacy_state = {
            "schema_version": 1,
            "current": current_receipt,
            "rollback": None,
            "transaction": {"stage": "rolling-back", "previous": current_receipt,
                            "next": previous_receipt, "role": {"enabled": True, "generation": 1}},
            "hold": "rollback incomplete; review before further action",
            "failures": 1,
            "rejected": [],
        }
        self.legacy_state_bytes = (json.dumps(legacy_state) + "\n").encode()
        state_path = self.state / "state.json"
        state_path.write_bytes(self.legacy_state_bytes)
        self._own(state_path, 0o600)
        ledger = {"schema_version": 1, "generation": 1, "images": {
            self.current: current_receipt, self.previous: previous_receipt,
        }, "extra_protected_shas": [], "transaction": None, "policy_intent": None}
        retention_ledger = self.state / "retention.json"
        retention_ledger.write_text(json.dumps(ledger) + "\n")
        self._own(retention_ledger, 0o600)
        policy = {"schema_version": 1, "schema": self.schema_sha,
                  "nodes": {"v24.21.0": self.node_sha}}
        policy_path = self.config / "deployment-policy.json"
        policy_path.write_text(json.dumps(policy) + "\n")
        self._own(policy_path, 0o600)
        poller_policy_path = self.poller_config / "retention-policy.json"
        poller_policy_path.write_text(json.dumps({"schema_version": 1,
                                                   "protected_shas": [self.current, self.previous]}) + "\n")
        self._own(poller_policy_path, 0o644)
        self.poller_policy_bytes = poller_policy_path.read_bytes()

        self._copy_source("ops/deploy_api_release.py")
        self._copy_source("ops/promote_api_release.py")
        self._copy_source("ops/release-poller/poller.py")
        for relative in ("ops/deployment/systemd/fg-index-deployment.service",
                         "ops/deployment/systemd/fg-index-deployment.timer"):
            self._copy_source(relative)
        self.host = FakeTransitionHost(
            self.source, systemd=self.systemd, app=self.app, node=self.node, state=self.state,
            config=self.config, poller_config=self.poller_config, libexec=self.libexec,
            promoter=self.promoter, poller_helper=self.poller_helper,
            owner_uid=self.uid, group_id=self.gid,
        )

    def tearDown(self):
        self.patch_boot_guard.stop()
        self.patch_scheduler.stop()
        self.patch_acl.stop()
        self.temp.cleanup()

    def _own(self, path: Path, mode: int):
        os.chown(path, self.uid, self.gid)
        path.chmod(mode)

    def _release(self, sha: str):
        root = self.releases / sha
        entries = {
            "RELEASE-MANIFEST.txt": f"source_commit={sha}\nnode_version=v24.21.0\n".encode(),
            "apps/api-server/dist/index.js": b"// api\n",
            "apps/api-server/prisma/schema.prisma": self.schema_bytes,
        }
        for parent in (root, root / "apps", root / "apps/api-server", root / "apps/api-server/dist",
                       root / "apps/api-server/prisma"):
            parent.mkdir(exist_ok=True)
            self._own(parent, 0o750)
        for relative, data in entries.items():
            path = root / relative
            path.write_bytes(data)
            self._own(path, 0o640)

    def _receipt(self, sha: str) -> dict:
        root = self.releases / sha
        return {"sha": sha, "node": "v24.21.0", "inventory": release_inventory(root, self.gid, self.uid),
                "schema": self.schema_sha}

    def _legacy_units(self):
        for name in transition.OLD_UNIT_HASHES:
            path = self.systemd / name
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("legacy fixture\n")
                self._own(path, 0o644)
        api = self.systemd / "fg-index-api.service"
        api.write_text("[Unit]\n[Service]\nExecStart=fixture\n")
        self._own(api, 0o644)

    def _copy_source(self, relative: str):
        source = Path(__file__).parents[1].parent / relative
        target = self.source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        self._own(target, 0o755 if target.suffix == ".py" else 0o644)

    def test_apply_archives_held_state_and_preserves_runtime_secrets_and_scheduler_owner(self):
        args = (self.current, self.previous, set(), set())
        self.host.apply(*args, suppress={self.previous})

        new_state = json.loads((self.state / "state.json").read_text())
        self.assertEqual(self.current, new_state["selected_sha"])
        self.assertEqual(self.previous, new_state["previous_sha"])
        self.assertEqual([self.previous], new_state["suppressed_shas"])
        self.assertEqual("not-attempted", new_state["restart_status"])
        self.assertEqual(2, new_state["schema_version"])
        self.assertIsNone(new_state["promotion_intent_sha"])
        archived = self.state / "pre-simple-deployment/fg-index-deployment-state.json"
        self.assertEqual(self.legacy_state_bytes, archived.read_bytes())
        poller_policy = self.poller_config / "retention-policy.json"
        self.assertEqual(0o644, stat.S_IMODE(poller_policy.stat().st_mode))
        self.assertEqual(sorted([self.current, self.previous]), json.loads(poller_policy.read_text())["protected_shas"])
        self.assertEqual(self.api_env_bytes, (self.config / "api.env").read_bytes())
        self.assertEqual(self.scheduler_bytes,
                         (self.systemd / "fg-index-api.service.d/10-scheduler-owner.conf").read_bytes())
        self.assertEqual((self.source / "ops/release-poller/poller.py").read_bytes(),
                         self.poller_helper.read_bytes())
        self.assertEqual(0o755, stat.S_IMODE(self.poller_helper.stat().st_mode))
        self.assertFalse((self.systemd / "fg-index-api.service.d/20-deployment-boot-guard.conf").exists())
        self.assertFalse((self.systemd / "fg-index-api-boot-guard.service").exists())
        self.assertFalse((self.systemd / "fg-index-deployment-watchdog.service").exists())
        self.assertFalse((self.systemd / "fg-index-deployment-recovery.service").exists())
        self.assertEqual(str(self.releases / self.current), os.readlink(self.app / "current"))
        self.assertEqual(str(self.node / "releases/node-v24.21.0"), os.readlink(self.node / "current"))
        self.assertFalse(any("start" in call and "fg-index-api.service" in call for call in self.host.commands))
        self.assertFalse(any("enable" in call for call in self.host.commands))

    def test_transition_accepts_only_legacy_or_exact_reviewed_poller_helper(self):
        shutil.copyfile(self.source / "ops/release-poller/poller.py", self.poller_helper)
        self._own(self.poller_helper, 0o755)
        Host.assert_old_helpers(self.host)

        self.poller_helper.write_text("unexpected poller helper\n")
        with self.assertRaisesRegex(TransitionError, "poller helper drift"):
            Host.assert_old_helpers(self.host)

    def test_bad_retained_artifact_verification_fails_before_host_mutation(self):
        self.host.verification_fails = True
        with self.assertRaisesRegex(TransitionError, "python3.12 failed"):
            self.host.apply(self.current, self.previous, set(), set(), {self.previous})
        self.assertEqual(self.legacy_state_bytes, (self.state / "state.json").read_bytes())
        self.assertEqual(self.guard_bytes,
                         (self.systemd / "fg-index-api.service.d/20-deployment-boot-guard.conf").read_bytes())
        self.assertFalse(any("disable" in call for call in self.host.commands))

    def test_unknown_release_tree_must_be_explicitly_disposed(self):
        unknown = "c" * 40
        self._release(unknown)
        with self.assertRaisesRegex(TransitionError, "--discard-release"):
            self.host.preflight(self.current, self.previous, set(), set())
        self.assertTrue((self.releases / unknown).exists())

    def test_current_inventory_mismatch_stops_before_disabling_timers(self):
        changed = self.releases / self.current / "apps/api-server/dist/index.js"
        changed.write_text("tampered\n")
        with self.assertRaisesRegex(TransitionError, "inventory differs"):
            self.host.apply(self.current, self.previous, set(), set(), set())
        self.assertEqual(self.legacy_state_bytes, (self.state / "state.json").read_bytes())
        self.assertFalse(any("disable" in call for call in self.host.commands))


if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()
