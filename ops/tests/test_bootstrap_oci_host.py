from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ops.bootstrap_oci_host import (
    BOOTSTRAP_SOURCE, COMMANDS, ENV_FILE, LEGACY_POLLER_SHA, MANAGED_DIRS, POLLER_SOURCE,
    POLLER_TARGET, PROMOTER_SOURCE, PROMOTER_TARGET, SERVICE_SOURCE, SERVICE_TARGET, SOURCE_HASHES,
    FORWARD_RELATIONS, REVERSE_RELATIONS,
    BootstrapError, HostBootstrap, Identity,
)


class BootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "root/stage"
        for relative in (BOOTSTRAP_SOURCE, SERVICE_SOURCE, PROMOTER_SOURCE, POLLER_SOURCE):
            source = self.repo / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes((Path(__file__).parents[2] / relative).read_bytes())
        for directory in ("run/systemd/system", "etc/systemd/system", "var/lib", "opt", "usr/local/libexec"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        for command in COMMANDS.values():
            path = self.path(Path(command))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
            path.chmod(0o755)
        self.owners: dict[Path, tuple[int, int]] = {}
        self.group = None
        self.user = None
        self.commands: list[list[str]] = []
        self.active_override = None
        self.enabled_override = None
        self.fragment_override = None
        self.dropins = ""
        self.loaded = False
        self.other_passwd = []
        self.other_groups = []
        self.unit_inventory = {"unrelated.service": {}}
        self.reverse_relations = {}
        self.pending_jobs = ""
        self.acls = {}

        def metadata(path):
            actual = path.lstat()
            uid, gid = self.owners.get(path, (0, 0))
            return SimpleNamespace(st_mode=actual.st_mode, st_size=actual.st_size, st_uid=uid, st_gid=gid)

        self.bootstrap = HostBootstrap(
            self.repo, root=self.root, uid=0, runner=self.run_command,
            metadata=metadata, group_lookup=lambda _: self.group,
            user_lookup=lambda _: self.user,
            memberships=lambda _, gid: [gid],
            passwd_lookup=lambda: self.other_passwd + ([SimpleNamespace(pw_name="fg-index", pw_uid=self.user[0], pw_gid=self.user[1])] if self.user else []),
            groups_lookup=lambda: self.other_groups + ([SimpleNamespace(gr_name="fg-index", gr_gid=self.group.gid)] if self.group else []),
            xattrs=lambda path, **_: self.acls.get(path, []),
        )
        self.addCleanup(patch.stopall)
        patch("ops.bootstrap_oci_host.sys.platform", "linux").start()
        patch("ops.bootstrap_oci_host.os.chown", side_effect=self.chown).start()
        real_fstat = os.fstat

        def fstat(fd):
            result = real_fstat(fd)
            return SimpleNamespace(st_mode=result.st_mode, st_uid=0)

        patch("ops.bootstrap_oci_host.os.fstat", side_effect=fstat).start()

    def path(self, absolute):
        return self.root / absolute.relative_to("/")

    def chown(self, path, uid, gid):
        self.owners[Path(path)] = (uid, gid)

    def run_command(self, args, **kwargs):
        self.assertEqual(kwargs["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
        self.assertEqual(kwargs["timeout"], 30)
        self.commands.append(args)
        command = Path(args[0]).name
        installed = self.path(SERVICE_TARGET).exists()
        if command == "groupadd":
            self.group = Identity(uid=-1, gid=321)
        if command == "useradd":
            self.user = (999, 321, "/var/lib/fg-index", "/usr/sbin/nologin")
        output = ""
        code = 0
        if command == "systemctl":
            if args[1] == "is-active":
                code, output = self.active_override or (3, "inactive\n")
            elif args[1] == "is-enabled":
                code, output = self.enabled_override or ((1, "disabled\n") if installed else (4, "not-found\n"))
            elif args[1] == "show":
                if "--property=UnitPath" in args:
                    return subprocess.CompletedProcess(args, 0, "/etc/systemd/system /run/systemd/system /usr/lib/systemd/system\n", "")
                if "--" in args:
                    blocks = []
                    for name in args[args.index("--") + 1:]:
                        fields = self.unit_inventory.get(name, {})
                        blocks.append("\n".join([f"Id={name}"] + [f"{prop}={fields.get(prop, '')}" for prop in FORWARD_RELATIONS]))
                    return subprocess.CompletedProcess(args, 0, "\n\n".join(blocks) + "\n", "")
                fragment = self.fragment_override if self.fragment_override is not None else (str(SERVICE_TARGET) if self.loaded else "")
                output = f"LoadState={'loaded' if self.loaded or fragment else 'not-found'}\nFragmentPath={fragment}\nDropInPaths={self.dropins}\n"
                output += "".join(f"{name}={self.reverse_relations.get(name, '')}\n" for name in REVERSE_RELATIONS)
            elif args[1] == "daemon-reload":
                self.loaded = True
            elif args[1] in ("list-unit-files", "list-units"):
                output = "".join(f"{name} disabled\n" for name in self.unit_inventory)
            elif args[1] == "list-jobs":
                output = self.pending_jobs
        return subprocess.CompletedProcess(args, code, output, "")

    def test_dry_run_does_not_mutate_host(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        actions = self.bootstrap.plan()
        self.assertTrue(any("disabled and inactive" in action for action in actions))
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")))
        self.assertTrue(all(Path(c[0]).name == "systemctl" for c in self.commands))

    def test_apply_and_rerun_preserve_files_and_inactive_state(self):
        self.bootstrap.apply()
        targets = (self.path(SERVICE_TARGET), self.path(PROMOTER_TARGET), self.path(POLLER_TARGET))
        before = [(p.read_bytes(), p.stat().st_ino) for p in targets]
        self.commands.clear()
        self.bootstrap.apply()
        self.assertEqual(before, [(p.read_bytes(), p.stat().st_ino) for p in targets])
        self.assertTrue(all(Path(c[0]).name == "systemctl" for c in self.commands))
        for absolute, (owner, group, mode) in MANAGED_DIRS.items():
            path = self.path(absolute)
            self.assertEqual(self.owners[path], (999 if owner == "fg-index" else 0, 321 if group == "fg-index" else 0))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
        self.assertEqual(stat.S_IMODE(targets[0].stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(targets[1].stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(targets[2].stat().st_mode), 0o755)
        self.assertFalse(self.path(ENV_FILE).exists())
        self.assertFalse(self.path(Path("/opt/fg-index/current")).exists())
        self.assertFalse(any(c[1] in ("start", "enable", "restart", "stop") for c in self.commands))

    def test_current_symlink_blocks_before_account_changes(self):
        current = self.path(Path("/opt/fg-index/current"))
        current.parent.mkdir(parents=True)
        current.symlink_to("releases/old")
        with self.assertRaisesRegex(BootstrapError, "current already exists"):
            self.bootstrap.apply()
        self.assertFalse(self.commands)
        self.assertIsNone(self.group)

    def test_conflicting_service_or_promoter_is_not_overwritten(self):
        for target in (SERVICE_TARGET, PROMOTER_TARGET, POLLER_TARGET):
            with self.subTest(target=target):
                file = self.path(target)
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("unexpected")
                file.chmod(0o644 if target == SERVICE_TARGET else 0o755)
                with self.assertRaisesRegex(BootstrapError, "differs from reviewed source"):
                    self.bootstrap.apply()
                self.assertEqual(file.read_text(), "unexpected")
                file.unlink()
        self.assertIsNone(self.group)

    def test_source_pinned_legacy_poller_is_preserved_for_transition(self):
        target = self.path(POLLER_TARGET)
        target.parent.mkdir(parents=True, exist_ok=True)
        legacy = b"legacy poller source fixture\n"
        target.write_bytes(legacy)
        target.chmod(0o755)
        self.owners[target] = (0, 0)
        with patch("ops.bootstrap_oci_host.LEGACY_POLLER_SHA", hashlib.sha256(legacy).hexdigest()):
            self.bootstrap.plan()
            self.bootstrap.apply()
        self.assertEqual(legacy, target.read_bytes())

    def test_global_service_active_enabled_vendor_and_dropins_block(self):
        cases = [
            ("active_override", (0, "active\n")),
            ("enabled_override", (0, "enabled\n")),
            ("fragment_override", "/usr/lib/systemd/system/fg-index-api.service"),
            ("dropins", "/etc/systemd/system/fg-index-api.service.d/override.conf"),
        ]
        for field, value in cases:
            with self.subTest(field=field):
                previous = getattr(self, field)
                setattr(self, field, value)
                with self.assertRaises(BootstrapError):
                    self.bootstrap.apply()
                self.assertIsNone(self.group)
                setattr(self, field, previous)

    def test_env_exact_0640_is_accepted_without_reading_values(self):
        self.bootstrap.apply()
        env = self.path(ENV_FILE)
        env.write_text("fixture must never be read")
        env.chmod(0o640)
        self.owners[env] = (0, 321)
        original_read = Path.read_bytes

        def read(path):
            self.assertNotEqual(path, env)
            return original_read(path)

        with patch.object(Path, "read_bytes", read):
            self.bootstrap.apply()
        for mode in (0o600, 0o644, 0o660, 0o640):
            env.chmod(mode)
            self.owners[env] = (0 if mode != 0o640 else 999, 321)
            with self.assertRaises(BootstrapError):
                self.bootstrap.plan()

    def test_source_digest_owner_mode_and_symlink_are_checked(self):
        source = self.repo / SERVICE_SOURCE
        reviewed = source.read_bytes()
        source.write_bytes(reviewed + b"tampered\n")
        with self.assertRaisesRegex(BootstrapError, "SHA-256"):
            self.bootstrap.apply()
        source.write_bytes(reviewed)
        self.owners[source] = (999, 0)
        with self.assertRaisesRegex(BootstrapError, "source must"):
            self.bootstrap.apply()
        self.owners[source] = (0, 0)
        source.chmod(0o666)
        with self.assertRaisesRegex(BootstrapError, "source must"):
            self.bootstrap.apply()
        source.unlink()
        source.symlink_to(self.repo / PROMOTER_SOURCE)
        with self.assertRaisesRegex(BootstrapError, "source must"):
            self.bootstrap.apply()
        self.assertIsNone(self.group)

    def test_bootstrap_source_and_its_ancestors_are_protected(self):
        script = self.repo / BOOTSTRAP_SOURCE
        self.owners[script] = (999, 0)
        with self.assertRaises(BootstrapError):
            self.bootstrap.plan()
        self.owners[script] = (0, 0)
        self.repo.chmod(0o777)
        with self.assertRaisesRegex(BootstrapError, "writable"):
            self.bootstrap.plan()

    def test_target_ancestors_reject_dangling_symlinks_and_writable_dirs(self):
        for target in (SERVICE_TARGET.parent, PROMOTER_TARGET.parent, POLLER_TARGET.parent):
            path = self.path(target)
            with self.subTest(target=target):
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(0o777)
                with self.assertRaisesRegex(BootstrapError, "writable"):
                    self.bootstrap.apply()
                path.chmod(0o755)
                path.rmdir()
                path.symlink_to("/missing-fixture-target")
                with self.assertRaisesRegex(BootstrapError, "real directory"):
                    self.bootstrap.apply()
                path.unlink()
                path.mkdir()
        self.assertIsNone(self.group)

    def test_conflicting_accounts_are_not_changed(self):
        self.group = Identity(uid=-1, gid=0)
        with self.assertRaisesRegex(BootstrapError, "dedicated system group"):
            self.bootstrap.apply()
        self.group = Identity(uid=-1, gid=321)
        for user in ((0, 321, "/var/lib/fg-index", "/usr/sbin/nologin"), (999, 322, "/var/lib/fg-index", "/usr/sbin/nologin"), (999, 321, "/home/fg-index", "/bin/bash")):
            self.user = user
            with self.assertRaises(BootstrapError):
                self.bootstrap.apply()
        self.assertFalse(self.commands)

    def test_supplementary_groups_are_rejected(self):
        self.group = Identity(uid=-1, gid=321)
        self.user = (999, 321, "/var/lib/fg-index", "/usr/sbin/nologin")
        self.bootstrap.memberships = lambda _, gid: [gid, 27]
        with self.assertRaisesRegex(BootstrapError, "supplementary groups"):
            self.bootstrap.apply()

    def test_other_primary_gid_users_block_group_only_and_full_identity(self):
        self.group = Identity(uid=-1, gid=321)
        self.other_passwd = [SimpleNamespace(pw_name="other-account", pw_uid=1001, pw_gid=321)]
        for user in (None, (999, 321, "/var/lib/fg-index", "/usr/sbin/nologin")):
            self.user = user
            with self.assertRaisesRegex(BootstrapError, "primary group of another account"):
                self.bootstrap.apply()
        self.assertFalse(self.commands)
        self.assertFalse(self.path(ENV_FILE.parent).exists())

    def test_primary_gid_exclusivity_is_rechecked_after_account_creation(self):
        original = self.bootstrap.runner

        def changed(args, **kwargs):
            result = original(args, **kwargs)
            if Path(args[0]).name == "useradd":
                self.other_passwd = [SimpleNamespace(pw_name="other-account", pw_uid=1001, pw_gid=321)]
            return result

        self.bootstrap.runner = changed
        with self.assertRaisesRegex(BootstrapError, "primary group of another account"):
            self.bootstrap.apply()
        self.assertFalse(self.path(Path("/opt/fg-index")).exists())
        self.assertFalse(self.path(ENV_FILE.parent).exists())
        self.assertFalse(self.path(SERVICE_TARGET).exists())

    def test_gid_and_uid_aliases_are_rejected(self):
        self.group = Identity(uid=-1, gid=321)
        self.user = (999, 321, "/var/lib/fg-index", "/usr/sbin/nologin")
        self.other_groups = [SimpleNamespace(gr_name="alias-group", gr_gid=321)]
        with self.assertRaisesRegex(BootstrapError, "another group name"):
            self.bootstrap.apply()
        self.other_groups = []
        self.other_passwd = [SimpleNamespace(pw_name="alias-user", pw_uid=999, pw_gid=1001)]
        with self.assertRaisesRegex(BootstrapError, "another account name"):
            self.bootstrap.apply()
        self.assertFalse(self.commands)

    def test_existing_matching_timer_socket_path_refuse_before_mutation(self):
        for kind in ("timer", "socket", "path"):
            name = f"fg-index-api.{kind}"
            self.unit_inventory[name] = {"Triggers": "fg-index-api.service"}
            with self.assertRaisesRegex(BootstrapError, "timer/socket/path"):
                self.bootstrap.apply()
            self.assertIsNone(self.group)
            self.assertFalse(self.path(SERVICE_TARGET).exists())
            del self.unit_inventory[name]

    def test_arbitrary_activators_reverse_relationships_and_jobs_refuse(self):
        for relation in FORWARD_RELATIONS:
            self.unit_inventory["different-name.timer"] = {relation: "fg-index-api.service"}
            with self.assertRaisesRegex(BootstrapError, "external unit"):
                self.bootstrap.apply()
        del self.unit_inventory["different-name.timer"]
        for relation in REVERSE_RELATIONS:
            self.reverse_relations = {relation: "different-name.target"}
            with self.assertRaisesRegex(BootstrapError, "activation relationships"):
                self.bootstrap.apply()
        self.reverse_relations = {}
        self.pending_jobs = "10 fg-index-api.service start waiting\n"
        with self.assertRaisesRegex(BootstrapError, "pending systemd job"):
            self.bootstrap.apply()
        self.assertIsNone(self.group)
        self.assertFalse(self.path(SERVICE_TARGET).exists())

    def test_pending_disk_dropins_reject_exact_prefix_and_type_directories(self):
        for name in ("fg-index-api.service.d", "fg-index-.service.d", "fg-.service.d", "service.d"):
            directory = self.path(Path("/etc/systemd/system")) / name
            directory.mkdir()
            (directory / "pending.conf").write_text("[Service]\n")
            with self.assertRaisesRegex(BootstrapError, "on-disk API drop-in"):
                self.bootstrap.apply()
            self.assertIsNone(self.group)
            (directory / "pending.conf").unlink()
            directory.rmdir()

    def test_access_and_default_acls_reject_without_reading_env_values(self):
        self.bootstrap.apply()
        env = self.path(ENV_FILE)
        env.write_text("fixture must not be read")
        env.chmod(0o640)
        self.owners[env] = (0, 321)
        for path, attribute in ((env, "system.posix_acl_access"), (env.parent, "system.posix_acl_default"), (self.repo, "system.posix_acl_access")):
            self.acls[path] = [attribute]
            self.commands.clear()
            with self.assertRaisesRegex(BootstrapError, "extended POSIX ACL"):
                self.bootstrap.apply()
            self.assertFalse(self.commands)
            del self.acls[path]

    def test_failed_reload_can_be_retried_without_overwriting_files(self):
        original = self.bootstrap.runner

        def interrupted(args, **kwargs):
            if args[1] == "daemon-reload":
                raise OSError("injected reload failure")
            return original(args, **kwargs)

        self.bootstrap.runner = interrupted
        with self.assertRaisesRegex(BootstrapError, "injected reload failure"):
            self.bootstrap.apply()
        unit = self.path(SERVICE_TARGET)
        before = unit.stat().st_ino
        self.assertFalse(self.loaded)
        self.bootstrap.runner = original
        self.bootstrap.apply()
        self.assertEqual(unit.stat().st_ino, before)
        self.assertTrue(self.loaded)

    def test_concurrent_applies_serialize_account_creation(self):
        first_entered = threading.Event()
        release_first = threading.Event()
        second_entered = threading.Event()
        original = self.bootstrap.runner
        errors = []

        def blocked(args, **kwargs):
            if Path(args[0]).name == "groupadd":
                if first_entered.is_set():
                    second_entered.set()
                first_entered.set()
                if not release_first.wait(5):
                    raise OSError("fixture timed out")
            return original(args, **kwargs)

        def apply():
            try:
                self.bootstrap.apply()
            except BaseException as error:
                errors.append(error)

        self.bootstrap.runner = blocked
        first = threading.Thread(target=apply)
        second = threading.Thread(target=apply)
        first.start()
        try:
            self.assertTrue(first_entered.wait(5))
            second.start()
            self.assertFalse(second_entered.wait(0.2), "second apply entered account mutation before the first released its lock")
        finally:
            release_first.set()
            first.join(5)
            if second.ident is not None:
                second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertFalse(errors)
        self.assertEqual(sum(Path(c[0]).name == "groupadd" for c in self.commands), 1)
        self.assertEqual(sum(Path(c[0]).name == "useradd" for c in self.commands), 1)

    def test_missing_prerequisites_and_nonroot_apply_fail(self):
        self.path(Path(COMMANDS["useradd"])).unlink()
        with self.assertRaisesRegex(BootstrapError, "unavailable"):
            self.bootstrap.plan()
        self.bootstrap.uid = 1000
        with self.assertRaisesRegex(BootstrapError, "requires root"):
            self.bootstrap.apply()

    def test_installed_file_collision_never_clobbers_and_temp_is_cleaned(self):
        target = self.root / "collision"
        real_link = os.link

        def race(source, destination, **kwargs):
            Path(destination).write_text("competing writer")
            return real_link(source, destination, **kwargs)

        with patch("ops.bootstrap_oci_host.os.link", side_effect=race):
            with self.assertRaises(FileExistsError):
                self.bootstrap._install_file(target, b"reviewed", 0o644)
        self.assertEqual(target.read_text(), "competing writer")
        self.assertFalse(list(self.root.glob(".collision.bootstrap-*")))

    def test_reviewed_dependency_hashes_match_repository(self):
        for relative, digest in SOURCE_HASHES.items():
            self.assertEqual(hashlib.sha256((self.repo / relative).read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
