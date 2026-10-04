#!/usr/bin/env python3
"""Generation-bound quarantine retirement and receipt-bound root image retention."""
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import time

if __package__:
    from .deploy_api_release import (RELEASES, RETENTION, SHA, STAGED, atomic_json, digest_file,
                                    read_json, require, sync_directory, trusted, validate_receipt)
else:
    from deploy_api_release import (RELEASES, RETENTION, SHA, STAGED, atomic_json, digest_file,
                                   read_json, require, sync_directory, trusted, validate_receipt)

RETIRE_UNIT = 'fg-index-release-retire@{}.service'
RETIRE_TEMPLATE = Path('/etc/systemd/system/fg-index-release-retire@.service')


class Retention:
    """Invoked only while the accepted shared role/deployment lock is held."""
    def __init__(self, host, store):
        self.host, self.store = host, store
        self.path = store.root / 'retention.json'

    def load(self, allow_transaction=False):
        data = read_json(self.path, self.store.uid, max_bytes=16 * 1024**2)
        require(set(data) == {'schema_version', 'generation', 'images', 'extra_protected_shas', 'transaction', 'policy_intent'}, 'unknown retention ledger fields')
        require(data['schema_version'] == 1 and type(data['generation']) is int and data['generation'] >= 0, 'invalid retention ledger generation')
        require(isinstance(data['images'], dict) and len(data['images']) <= 100, 'invalid image ledger')
        for sha, receipt in data['images'].items():
            validate_receipt(receipt)
            require(sha == receipt['sha'], 'image ledger key mismatch')
        extra = data['extra_protected_shas']
        require(isinstance(extra, list) and len(extra) == len(set(extra)) and all(isinstance(s, str) and SHA.fullmatch(s) for s in extra), 'invalid operator protected set')
        tx = data['transaction']
        if tx is not None:
            require(isinstance(tx, dict) and set(tx) == {'sha', 'inventory', 'device', 'inode', 'phase', 'entries'} and isinstance(tx['sha'], str) and SHA.fullmatch(tx['sha']) and data['images'].get(tx['sha'], {}).get('inventory') == tx['inventory'] and type(tx['device']) is int and type(tx['inode']) is int and tx['inode'] > 0 and tx['phase'] in ('intent', 'deleting') and isinstance(tx['entries'], list), 'invalid root pruning intent')
            require(self.entries_digest(tx['entries']) == tx['inventory'], 'root pruning snapshot does not bind inventory')
        intent = data['policy_intent']
        if intent is not None:
            require(isinstance(intent, dict) and intent.get('schema_version') == 2 and intent.get('generation') == data['generation'] + 1 and set(intent) == {'schema_version', 'generation', 'protected_shas', 'retire_rejected'}, 'invalid protected policy intent')
        require(allow_transaction or (tx is None and intent is None), 'interrupted root pruning requires reviewed operator recovery')
        return data

    def save(self, data):
        require(len(json.dumps(data).encode()) <= 16 * 1024**2, 'retention ledger exceeds its private byte budget')
        atomic_json(self.path, data)

    def adopt(self, state):
        require(not self.path.exists() and not self.path.is_symlink(), 'retention ledger already exists')
        require(state['transaction'] is None and state['hold'] is None, 'cannot adopt incomplete deployment')
        receipts = [r for r in (state['current'], state['rollback']) if r]
        require(receipts, 'accepted image required')
        for receipt in receipts:
            self.host.verify(receipt)
        policy = self.read_policy()
        require(policy['schema_version'] == 1, 'initial adoption requires existing version1 policy')
        known = {r['sha'] for r in receipts}
        # Existing operator protections are never silently discarded on upgrade.
        extra = sorted(set(policy['protected_shas']) - known)
        self.save({'schema_version': 1, 'generation': 0, 'images': {r['sha']: r for r in receipts},
                   'extra_protected_shas': extra, 'transaction': None, 'policy_intent': None})

    @staticmethod
    def read_policy():
        trusted(RETENTION)
        require(RETENTION.stat().st_size <= 65536, 'oversized retention policy')
        data = json.loads(RETENTION.read_text())
        require(isinstance(data, dict) and type(data.get('schema_version')) is int and data.get('schema_version') in (1, 2), 'unknown protected policy schema')
        values = data.get('protected_shas')
        require(isinstance(values, list) and len(values) == len(set(values)) and all(isinstance(s, str) and SHA.fullmatch(s) for s in values), 'invalid protected policy')
        if data['schema_version'] == 1:
            require(set(data) == {'schema_version', 'protected_shas'}, 'unexpected initial policy fields')
        else:
            require(set(data) == {'schema_version', 'generation', 'protected_shas', 'retire_rejected'} and type(data['generation']) is int and data['generation'] > 0 and isinstance(data['retire_rejected'], list), 'unexpected policy fields/generation')
        return data

    def record(self, receipt):
        data = self.load()
        validate_receipt(receipt)
        require(receipt['sha'] not in data['images'], 'image already recorded')
        self.host.verify(receipt)
        data['images'][receipt['sha']] = receipt
        self.save(data)

    def root_plan(self, data, state, incoming, protected):
        entries = list(RELEASES.iterdir())
        images = {}
        for path in entries:
            if path.name == '.promotion.lock':
                trusted(path, private=True)
                continue
            require(SHA.fullmatch(path.name) and path.name in data['images'], 'unknown root image/temporary entry is retained; operator review required')
            trusted(path, directory=True)
            images[path.name] = path
        require(set(images) == set(data['images']), 'root ledger/tree mismatch')
        for sha, receipt in data['images'].items():
            self.host.verify(receipt)
        limit = 3 if incoming in images else 2
        victims = sorted(set(images) - protected)
        needed = max(0, len(images) - limit)
        require(len(victims) >= needed, 'protected root images exceed incoming capacity')
        return victims[:needed]

    def requests(self, data, state, protected):
        requests = []
        lock = STAGED / '.release-poller.lock'
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'r') as handle:
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode) and not os.fstat(handle.fileno()).st_mode & 0o077, 'untrusted quarantine lock')
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            for sha in sorted(set(state['rejected']) & set(data['images']) - protected):
                path = STAGED / sha
                if not path.exists() and not path.is_symlink():
                    continue
                require(stat.S_ISDIR(path.lstat().st_mode) and not path.is_symlink(), 'rejected quarantine path is not a directory')
                marker = path / '.fg-index-verification.json'
                fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as reader:
                    raw = reader.read(65537)
                require(len(raw) <= 65536, 'oversized rejected marker')
                metadata = json.loads(raw)
                require(metadata.get('source_sha') == sha, 'rejected marker source mismatch')
                requests.append({'sha': sha, 'marker_sha256': hashlib.sha256(raw).hexdigest(),
                                 'archive_sha256': metadata.get('archive_sha256'),
                                 'attestation_bundle_sha256': metadata.get('attestation_bundle_sha256')})
        return requests

    def prepare(self, state, incoming):
        require(state['transaction'] is None and state['hold'] is None, 'retention requires a complete accepted deployment')
        require(SHA.fullmatch(incoming), 'invalid incoming SHA')
        for path in (RELEASES, self.store.root):
            require(shutil.disk_usage(path).free >= 8 * 1024**3 + 16 * 1024**2 + 65536 and os.statvfs(path).f_favail >= 10010, 'retention cannot preserve capacity reserves')
        data = self.load()
        for receipt in (state['current'], state['rollback']):
            if receipt:
                require(data['images'].get(receipt['sha']) == receipt, 'current/rollback receipt missing from retention ledger')
        require(self.host.links() == self.host.targets(state['current']), 'current links drift during retention')
        protected = set(data['extra_protected_shas']) | {r['sha'] for r in (state['current'], state['rollback']) if r} | {incoming}
        require(len(protected) <= 3, 'operator/current/rollback protections exceed three-candidate capacity')
        victims = self.root_plan(data, state, incoming, protected)
        requests = self.requests(data, state, protected)
        prior = self.read_policy()
        require((prior['schema_version'] == 1 and data['generation'] == 0) or
                (prior['schema_version'] == 2 and prior.get('generation') == data['generation']), 'stale policy generation')
        generation = data['generation'] + 1
        policy = {'schema_version': 2, 'generation': generation, 'protected_shas': sorted(protected), 'retire_rejected': requests}
        # Persist the exact transition before either file can advance.
        data['policy_intent'] = policy
        self.save(data)
        atomic_json(RETENTION, policy, 0o644)
        committed = copy.deepcopy(data)
        committed.update(generation=generation, policy_intent=None)
        self.save(committed)
        data = committed
        if requests:
            self.host.retire_quarantine(generation)
            require(all(not (STAGED / r['sha']).exists() and not (STAGED / r['sha']).is_symlink() for r in requests), 'retirement did not finish')
        for sha in victims:
            self.prune(data, sha)
        require(len(data['images']) <= (3 if incoming in data['images'] else 2), 'root capacity still blocked')

    @staticmethod
    def entries_digest(entries):
        require(len(entries) <= 100000, 'root snapshot entry budget exceeded')
        h = hashlib.sha256()
        seen = set()
        for entry in entries:
            require(isinstance(entry, list) and len(entry) == 3 and isinstance(entry[0], str) and entry[0] not in seen and not Path(entry[0]).is_absolute() and '..' not in Path(entry[0]).parts and type(entry[1]) is int and isinstance(entry[2], str), 'invalid root snapshot entry')
            seen.add(entry[0])
            h.update(json.dumps(entry, separators=(',', ':')).encode() + b'\n')
        return h.hexdigest()

    def snapshot(self, root):
        trusted(root, directory=True)
        require(root.lstat().st_gid == self.host.gid, 'root snapshot directory group drift')
        entries = []
        deadline = time.monotonic() + 90
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs.sort()
            for name in sorted(dirs + files):
                path = Path(directory) / name
                info = path.lstat()
                require(info.st_uid == self.store.uid and info.st_gid == self.host.gid, 'root snapshot ownership drift')
                if stat.S_ISLNK(info.st_mode):
                    require(path.resolve().is_relative_to(root), 'root snapshot link escapes')
                    value = 'link:' + os.readlink(path)
                elif stat.S_ISDIR(info.st_mode):
                    trusted(path, directory=True)
                    value = 'directory'
                else:
                    trusted(path)
                    value = digest_file(path, deadline)
                entries.append([str(path.relative_to(root)), stat.S_IMODE(info.st_mode), value])
                require(len(entries) <= 100000 and time.monotonic() < deadline, 'root snapshot budget exceeded')
        return entries

    def validate_remaining(self, root, entries):
        expected = {entry[0]: entry for entry in entries}
        for entry in self.snapshot(root):
            require(expected.get(entry[0]) == entry, 'remaining partial root tree changed or contains unknown content')

    def recover(self, state):
        require(state['transaction'] is None and state['hold'] is None, 'deployment recovery takes priority')
        data = self.load(allow_transaction=True)
        tx = data['transaction']
        intent = data['policy_intent']
        if intent is not None:
            require(tx is None, 'overlapping retention recovery intents')
            prior = self.read_policy()
            require(prior == intent or (prior['schema_version'] == 1 and data['generation'] == 0) or (prior['schema_version'] == 2 and prior['generation'] == data['generation']), 'unknown protected policy during recovery')
            protected = set(data['extra_protected_shas']) | {r['sha'] for r in (state['current'], state['rollback']) if r}
            require(protected <= set(intent['protected_shas']), 'policy recovery loses current/rollback/operator protection')
            require(all(r['sha'] in state['rejected'] and r['sha'] in data['images'] and r['sha'] not in protected for r in intent['retire_rejected']), 'policy recovery retirement verdict changed')
            atomic_json(RETENTION, intent, 0o644)
            data.update(generation=intent['generation'], policy_intent=None)
            self.save(data)
            return
        require(tx is not None, 'no registered root pruning intent')
        protected = set(data['extra_protected_shas']) | {r['sha'] for r in (state['current'], state['rollback']) if r}
        require(tx['sha'] not in protected, 'pruning intent conflicts with current/rollback/operator protection')
        source = RELEASES / tx['sha']
        temporary = RELEASES / ('.retire-' + tx['sha'] + '-' + str(data['generation']))
        require(not source.is_symlink() and not temporary.is_symlink(), 'pruning recovery path is a symlink')
        require(not (source.exists() and temporary.exists()), 'ambiguous pruning recovery paths')
        receipt = data['images'][tx['sha']]
        if source.exists():
            info = source.lstat()
            require((info.st_dev, info.st_ino) == (tx['device'], tx['inode']), 'original root inode changed')
            self.host.verify(receipt)
            data['transaction'] = None  # Rename never happened; keep accepted image.
            self.save(data)
            return
        if temporary.exists():
            info = temporary.lstat()
            require((info.st_dev, info.st_ino) == (tx['device'], tx['inode']), 'registered retired inode changed')
            if tx['phase'] == 'intent':
                require(self.host.image(tx['sha'], root=temporary) == receipt, 'registered retired inventory changed')
                tx['phase'] = 'deleting'
                self.save(data)
            else:
                self.validate_remaining(temporary, tx['entries'])
            require(shutil.rmtree.avoids_symlink_attacks, 'safe fd-based removal unavailable')
            shutil.rmtree(temporary)
            sync_directory(RELEASES)
        del data['images'][tx['sha']]
        data['transaction'] = None
        self.save(data)

    def prune(self, data, sha):
        receipt = data['images'][sha]
        self.host.verify(receipt)
        source = RELEASES / sha
        info = source.lstat()
        temporary = RELEASES / ('.retire-' + sha + '-' + str(data['generation']))
        require(not temporary.exists() and not temporary.is_symlink(), 'unknown root retirement destination')
        entries = self.snapshot(source)
        require(self.entries_digest(entries) == receipt['inventory'], 'root snapshot does not match accepted inventory')
        data['transaction'] = {'sha': sha, 'inventory': receipt['inventory'], 'device': info.st_dev, 'inode': info.st_ino, 'phase': 'intent', 'entries': entries}
        self.save(data)  # No deletion unless intent is durable.
        os.rename(source, temporary)
        sync_directory(RELEASES)
        moved = temporary.lstat()
        require((moved.st_dev, moved.st_ino) == (info.st_dev, info.st_ino), 'root image changed during retirement')
        require(self.host.image(sha, root=temporary) == receipt, 'renamed root inventory drift')
        data['transaction']['phase'] = 'deleting'
        self.save(data)
        require(shutil.rmtree.avoids_symlink_attacks, 'safe fd-based root removal is unavailable')
        shutil.rmtree(temporary)
        sync_directory(RELEASES)
        committed = copy.deepcopy(data)
        del committed['images'][sha]
        committed['transaction'] = None
        self.save(committed)
        data.clear()
        data.update(committed)
