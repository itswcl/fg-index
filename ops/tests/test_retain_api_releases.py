"""Receipt-ledger root retention using real temporary files and injected host operations."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from ops import retain_api_releases as retention
from ops.deploy_api_release import Hold, PersistenceError, Store, trusted
from ops.tests.test_deploy_api_release import A, B, C, image as sample_image

D = 'd' * 40

def image(sha):
    receipt = sample_image(sha)
    entry = ['data', 0o640, hashlib.sha256(sha.encode()).hexdigest()]
    receipt['inventory'] = hashlib.sha256(json.dumps(entry, separators=(',', ':')).encode() + b'\n').hexdigest()
    return receipt


class RetentionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = self.root / 'releases'
        self.releases.mkdir(mode=0o700)
        self.staged = self.root / 'staged'
        self.staged.mkdir(mode=0o700)
        (self.staged / '.release-poller.lock').write_text('')
        (self.staged / '.release-poller.lock').chmod(0o600)
        self.policy = self.root / 'policy.json'
        self.policy.write_text(json.dumps({'schema_version': 1, 'protected_shas': []}))
        self.policy.chmod(0o600)
        state_root = self.root / 'state'
        state_root.mkdir(mode=0o700)
        self.store = Store(state_root, os.getuid(), state_root / 'lock')
        self.host = Mock()
        self.host.gid = os.getgid()
        self.host.targets.side_effect = lambda receipt: ('/current/' + receipt['sha'], '/node')
        self.host.links.return_value = ('/current/' + A, '/node')
        self.host.image.side_effect = lambda sha, root=None: image(sha)
        self.state = {'current': image(A), 'rollback': image(B), 'transaction': None, 'hold': None, 'rejected': [C]}
        for sha in (A, B, C):
            path = self.releases / sha
            path.mkdir(mode=0o700)
            (path / 'data').write_text(sha)
            (path / 'data').chmod(0o640)
        patches = [patch.object(retention, 'RELEASES', self.releases), patch.object(retention, 'STAGED', self.staged),
                   patch.object(retention, 'RETENTION', self.policy),
                   patch.object(retention, 'trusted', side_effect=lambda path, **kw: trusted(path, uid=os.getuid(), **kw)),
                   patch.object(retention.shutil, 'disk_usage', return_value=Mock(free=40 * 1024**3)),
                   patch.object(retention.os, 'statvfs', return_value=Mock(f_favail=100000))]
        if not hasattr(os, 'listxattr'):
            patches.append(patch('ops.deploy_api_release.os.listxattr', return_value=[], create=True))
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.instance = retention.Retention(self.host, self.store)
        self.instance.adopt(self.state)
        self.instance.record(image(C))

    def test_explicit_adoption_and_unknown_extra_protections(self):
        with self.assertRaises(Hold):
            self.instance.adopt(self.state)
        self.assertEqual({A, B, C}, set(self.instance.load()['images']))

    def test_known_rejected_root_pruned_to_reserve_incoming_slot(self):
        self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / A).exists() and (self.releases / B).exists())
        self.assertFalse((self.releases / C).exists())
        self.assertEqual({A, B}, set(self.instance.load()['images']))
        data = json.loads(self.policy.read_text())
        self.assertEqual(2, data['schema_version'])
        self.assertEqual(1, data['generation'])
        self.assertEqual({A, B, D}, set(data['protected_shas']))
        self.assertEqual([], data['retire_rejected'])

    def test_unknown_root_image_blocks_without_pruning(self):
        (self.releases / D).mkdir()
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, 'e' * 40)
        self.assertTrue((self.releases / C).exists())
        self.assertEqual(1, json.loads(self.policy.read_text())['schema_version'])

    def test_operator_protected_root_is_not_pruned(self):
        data = self.instance.load()
        data['extra_protected_shas'] = [C]
        self.instance.save(data)
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / C).exists())

    def test_inflight_deployment_blocks_all_retention(self):
        self.state['transaction'] = {'stage': 'started'}
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / C).exists())

    def test_low_bytes_and_inodes_do_not_delete(self):
        for free, inodes in ((1024, 100000), (40 * 1024**3, 5)):
            with patch.object(retention.shutil, 'disk_usage', return_value=Mock(free=free)), patch.object(retention.os, 'statvfs', return_value=Mock(f_favail=inodes)):
                with self.assertRaises(Hold):
                    self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / C).exists())

    def test_stale_policy_generation_holds_without_deletion(self):
        self.policy.write_text(json.dumps({'schema_version': 2, 'generation': 3, 'protected_shas': [A, B], 'retire_rejected': []}))
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / C).exists())

    def test_prune_intent_persistence_failure_never_renames(self):
        with patch.object(self.instance, 'save', side_effect=PersistenceError('disk full')):
            with self.assertRaises(PersistenceError):
                self.instance.prune(self.instance.load(), C)
        self.assertTrue((self.releases / C).exists())

    def test_interruption_after_rename_requires_explicit_receipt_recovery(self):
        original = retention.sync_directory
        with patch.object(retention, 'sync_directory', side_effect=OSError('directory fsync failed')):
            with self.assertRaises(OSError):
                self.instance.prune(self.instance.load(), C)
        self.assertFalse((self.releases / C).exists())
        with self.assertRaises(Hold):
            self.instance.load()
        self.instance.recover(self.state)
        self.assertEqual({A, B}, set(self.instance.load()['images']))
        self.assertFalse(list(self.releases.glob('.retire-*')))

    def test_recovery_before_rename_preserves_image(self):
        data = self.instance.load()
        info = (self.releases / C).stat()
        data['transaction'] = {'sha': C, 'inventory': image(C)['inventory'], 'device': info.st_dev, 'inode': info.st_ino, 'phase': 'intent', 'entries': self.instance.snapshot(self.releases / C)}
        self.instance.save(data)
        self.instance.recover(self.state)
        self.assertTrue((self.releases / C).exists())
        self.assertIsNone(self.instance.load()['transaction'])

    def test_recovery_refuses_current_or_rollback(self):
        data = self.instance.load()
        info = (self.releases / B).stat()
        data['transaction'] = {'sha': B, 'inventory': image(B)['inventory'], 'device': info.st_dev, 'inode': info.st_ino, 'phase': 'intent', 'entries': self.instance.snapshot(self.releases / B)}
        self.instance.save(data)
        with self.assertRaises(Hold):
            self.instance.recover(self.state)
        self.assertTrue((self.releases / B).exists())

    def test_root_symlink_never_traversed_or_deleted(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        (self.releases / D).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, 'e' * 40)
        self.assertTrue((outside / 'keep').exists() and (self.releases / C).exists())

    def test_root_inventory_drift_holds_before_pruning(self):
        self.host.verify.side_effect = Hold('changed root image')
        with self.assertRaises(Hold):
            self.instance.prepare(self.state, D)
        self.assertTrue((self.releases / C).exists())

    def test_registered_only_record_refuses_duplicates(self):
        with self.assertRaises(Hold):
            self.instance.record(image(C))

    def test_mid_deletion_recovery_validates_remaining_snapshot_entries(self):
        extra = self.releases / C / 'extra'
        extra.write_text('extra')
        extra.chmod(0o640)
        receipt = image(C)
        receipt['inventory'] = self.instance.entries_digest(self.instance.snapshot(self.releases / C))
        data = self.instance.load()
        data['images'][C] = receipt
        self.instance.save(data)
        self.host.image.side_effect = lambda sha, root=None: receipt if sha == C else image(sha)
        def partial(path):
            (path / 'data').unlink()
            raise OSError('mid-rmtree interruption')
        with patch.object(retention.shutil, 'rmtree', side_effect=partial):
            with self.assertRaises(OSError):
                self.instance.prune(self.instance.load(), C)
        tx = self.instance.load(allow_transaction=True)['transaction']
        self.assertEqual('deleting', tx['phase'])
        self.instance.recover(self.state)
        self.assertEqual({A, B}, set(self.instance.load()['images']))
        self.assertFalse(list(self.releases.glob('.retire-*')))

    def test_policy_write_failure_has_exact_explicit_recovery_intent(self):
        original = retention.atomic_json
        def fail_policy(path, value, *args):
            if path == self.policy:
                raise PersistenceError('policy fsync failed')
            return original(path, value, *args)
        with patch.object(retention, 'atomic_json', side_effect=fail_policy):
            with self.assertRaises(PersistenceError):
                self.instance.prepare(self.state, D)
        with self.assertRaises(Hold):
            self.instance.load()
        self.instance.recover(self.state)
        self.assertEqual(1, self.instance.load()['generation'])
        self.assertEqual(1, json.loads(self.policy.read_text())['generation'])
        self.assertTrue((self.releases / C).exists())


if __name__ == '__main__':
    unittest.main()
