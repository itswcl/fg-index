"""Transaction contract tests through the controller interface and durable files."""
import copy
import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

from ops.deploy_api_release import BootGate, Controller, DependencyDegraded, Hold, Host, PersistenceError, Store, atomic_json, node_target, validate_loaded_unit, validate_loaded_poller, validate_policy_shape

A, B, C = 'a' * 40, 'b' * 40, 'c' * 40


def image(sha):
    return {'sha': sha, 'node': 'v24.21.0', 'schema': 'd' * 64, 'inventory': sha[0] * 64}


class Crash(BaseException):
    pass


class TestHost:
    def __init__(self):
        self.policy = {'manual_adoption': {A: image(A)['inventory']}, 'boot_guard_enabled': True}
        self.role = {'enabled': False, 'generation': 1}
        self.main = B
        self.link = self.targets(image(A))
        self.events = []
        self.fail = set()
        self.crash = None
        self.images = {A: image(A)}
        self.bad = set()
        self.active = True
        self.pid = 101
        self.restart = 0
        self.move_after_promote = False
        self.stop_calls = 0
        self.protected = []

    def event(self, event):
        self.events.append(event)
        if event == self.crash:
            raise Crash(event)
        if event in self.fail:
            raise Hold(event)

    def preflight(self):
        self.event('preflight')

    def active_controller(self):
        return getattr(self, 'controller_context', None)

    def require_recovery_context(self):
        return None

    @property
    def boot_guard_enabled(self):
        return self.policy.get('boot_guard_enabled', False)

    def properties(self, unit, names):
        if unit == 'fg-index-api.service' and names == ['NRestarts']:
            return {'NRestarts': str(self.restart)}
        raise AssertionError('unexpected property request')

    def main_sha(self):
        self.event('main')
        return self.main

    def targets(self, receipt):
        return ('/releases/' + receipt['sha'], '/node/' + receipt['node'])

    def links(self):
        return self.link

    def verify(self, receipt):
        self.event('verify')
        if self.images.get(receipt['sha']) != receipt or receipt['sha'] in self.bad:
            raise Hold('inventory/schema/runtime drift')

    def image(self, sha):
        self.verify(self.images[sha])
        return copy.deepcopy(self.images[sha])

    def protect(self, receipts):
        self.event('protect')
        self.protected = [r['sha'] for r in receipts if r]

    def prepare_retention(self, store, state, incoming):
        self.event('prepare-retention')

    def record_image(self, store, receipt):
        self.event('record-image')

    def poll(self):
        self.event('poll')

    def promote(self, sha):
        self.event('promote')
        self.images[sha] = image(sha)
        if self.move_after_promote:
            self.main = C
        return self.image(sha)

    def stop_owned(self, previous, candidate):
        if any(v not in {a, b} for v, a, b in zip(self.link, self.targets(previous), self.targets(candidate))):
            raise Hold('unowned links')
        self.stop()

    def stop(self):
        self.stop_calls += 1
        self.event('stop')
        self.active = False

    def switch(self, old, new):
        self.event('switch')
        if self.active or self.link != self.targets(old):
            raise Hold('ambiguous process/links')
        self.link = self.targets(new)

    def restore(self, previous, candidate):
        self.event('restore')
        if self.active or any(v not in {a, b} for v, a, b in zip(self.link, self.targets(previous), self.targets(candidate))):
            raise Hold('unknown process/links')
        self.link = self.targets(previous)

    def start(self):
        self.event('start')
        self.active = True
        self.pid += 1

    def runtime(self, receipt):
        self.event('runtime')
        if not self.active or self.restart or self.pid <= 0 or self.link != self.targets(receipt):
            raise Hold('runtime identity/restart failure')
        return self.pid

    def probe(self, receipt):
        self.event('probe:' + receipt['sha'][0])
        self.runtime(receipt)
        return {'pid': self.pid, 'cold_cache': True}


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        # macOS Python lacks Linux xattr APIs; only the filesystem ACL seam is
        # supplied here. Linux CI exercises the real no-ACL path too.
        if not hasattr(os, 'listxattr'):
            acl = patch('ops.deploy_api_release.os.listxattr', return_value=[], create=True)
            acl.start()
            self.addCleanup(acl.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.root.mkdir(mode=0o700)
        self.store = Store(self.root, os.getuid(), self.root / 'lock')
        self.host = TestHost()
        self.controller = Controller(self.host, self.store)
        self.store.save({'schema_version': 1, 'current': image(A), 'rollback': None,
                         'transaction': None, 'rejected': [], 'hold': None, 'failures': 0})

    def state(self):
        return self.store.load()

    def test_check_is_read_only(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.controller.check()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.assertNotIn('probe:a', self.host.events)

    def test_explicit_adoption_only(self):
        self.host.policy['boot_guard_enabled'] = False
        (self.root / 'state.json').unlink()
        with self.assertRaises(Hold):
            self.controller.check()
        with self.assertRaises(Hold):
            self.controller.adopt(A, 'f' * 64)
        self.assertEqual('adopted', self.controller.adopt(A, image(A)['inventory']))
        self.assertEqual(image(A), self.state()['current'])
        with self.assertRaises(Hold):
            self.controller.adopt(A, image(A)['inventory'])

    def test_commit_cold_cache_and_preserve_role(self):
        self.host.role = {'generation': 7, 'enabled': True}
        self.assertEqual('committed', self.controller.once())
        self.assertEqual(image(B), self.state()['current'])
        self.assertEqual(image(A), self.state()['rollback'])
        self.assertEqual({'generation': 7, 'enabled': True}, self.host.role)
        self.assertLess(self.host.events.index('stop'), self.host.events.index('switch'))
        self.assertLess(self.host.events.index('switch'), self.host.events.index('start'))
        self.assertEqual([A, B], self.host.protected)

    def test_recheck_main_after_long_promotion(self):
        self.host.move_after_promote = True
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertEqual(self.host.targets(image(A)), self.host.link)
        self.assertNotIn('stop', self.host.events)
        self.assertIn(B, self.host.images)
        self.assertEqual('promoting', self.state()['transaction']['stage'])
        self.assertEqual('recovered-promotion', self.controller.recover())
        self.assertEqual(image(A), self.state()['current'])
        self.assertEqual([B], self.state()['rejected'])

    def test_boot_gate_requires_adopted_clean_committed_state(self):
        self.host.role = {'enabled': True, 'generation': 1}
        self.host.policy['boot_enabled'] = True
        self.host.policy['boot_guard_enabled'] = True
        gate = BootGate(self.host, self.store)
        self.assertEqual(image(A), gate.authorize_start())
        data = self.state()
        data['transaction'] = {'stage': 'intent', 'previous': image(A), 'next': image(B), 'role': self.host.role}
        self.store.save(data)
        with self.assertRaises(Hold):
            gate.authorize_start()
        data['transaction'] = None
        data['hold'] = 'operator review required'
        self.store.save(data)
        with self.assertRaises(Hold):
            gate.authorize_start()
        (self.root / 'state.json').unlink()
        with self.assertRaises(Hold):
            gate.authorize_start()

    def test_boot_gate_transaction_allows_only_exact_live_activation(self):
        self.host.role = {'enabled': True, 'generation': 1}
        self.host.policy['boot_enabled'] = True
        self.host.policy['boot_guard_enabled'] = True
        data = self.state()
        data['transaction'] = {'stage': 'switched', 'previous': image(A), 'next': image(B), 'role': self.host.role}
        self.store.save(data)
        self.host.images[B] = image(B)
        self.host.link = self.host.targets(image(B))
        self.host.controller_context = {'unit': 'fg-index-deployment.service', 'invocation': 'valid', 'restarts': 0}
        self.assertEqual(image(B), BootGate(self.host, self.store).authorize_start())
        self.host.controller_context = None
        with self.assertRaises(Hold):
            BootGate(self.host, self.store).authorize_start()
        self.host.controller_context = {'unit': 'fg-index-deployment.service', 'invocation': 'valid', 'restarts': 1}
        with self.assertRaises(Hold):
            BootGate(self.host, self.store).authorize_start()
        self.host.controller_context = {'unit': 'fg-index-deployment.service', 'invocation': 'valid', 'restarts': 0}
        self.host.restart = 1
        with self.assertRaises(Hold):
            BootGate(self.host, self.store).authorize_start()
        self.host.restart = 0
        self.host.controller_context = {'unit': 'fg-index-deployment.service', 'invocation': 'valid', 'restarts': 0}
        self.host.link = ('/unknown', self.host.targets(image(B))[1])
        with self.assertRaises(Hold):
            BootGate(self.host, self.store).authorize_start()

    def test_guard_off_phase_allows_no_deployment_watchdog_or_recovery_mutation(self):
        self.host.policy['boot_guard_enabled'] = False
        with self.assertRaises(Hold):
            self.controller.once()
        with self.assertRaises(Hold):
            self.controller.watchdog()
        data = self.state()
        data['transaction'] = {'stage': 'intent', 'previous': image(A), 'next': image(B), 'role': self.host.role}
        self.store.save(data)
        before_recovery = (self.root / 'state.json').read_bytes()
        with self.assertRaises(Hold):
            self.controller.recover()
        self.assertEqual(before_recovery, (self.root / 'state.json').read_bytes())

    def test_bad_provenance_never_stops(self):
        self.host.fail.add('promote')
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertNotIn('stop', self.host.events)
        self.assertIsNotNone(self.state()['hold'])

    def test_schema_runtime_inventory_rejection(self):
        self.host.bad.add(A)
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertNotIn('poll', self.host.events)

    def test_ambiguous_stop_holds_without_second_stop(self):
        self.host.fail.add('stop')
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertEqual(1, self.host.stop_calls)
        self.assertNotIn('switch', self.host.events)
        self.assertIsNotNone(self.state()['hold'])

    def test_failed_new_health_restores_once_and_rejects(self):
        self.host.fail.add('probe:b')
        self.assertEqual('rolled-back', self.controller.once())
        self.assertEqual(image(A), self.state()['current'])
        self.assertEqual([B], self.state()['rejected'])
        polls = self.host.events.count('poll')
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertEqual(polls, self.host.events.count('poll'))
        self.assertEqual(1, self.host.events.count('restore'))

    def test_start_failure_then_successful_rollback(self):
        original = self.host.start
        attempts = []
        def start():
            attempts.append(1)
            if len(attempts) == 1:
                raise Hold('new startup failed')
            original()
        self.host.start = start
        self.assertEqual('rolled-back', self.controller.once())
        self.assertEqual(2, len(attempts))

    def test_baseline_database_outage_never_polls(self):
        self.host.probe = lambda receipt: (_ for _ in ()).throw(DependencyDegraded())
        with self.assertRaises(DependencyDegraded):
            self.controller.once()
        self.assertNotIn('poll', self.host.events)

    def test_shared_database_outage_stops_after_one_rollback(self):
        original = self.host.probe
        probes = []
        def probe(receipt):
            probes.append(receipt['sha'])
            if len(probes) > 1:
                raise DependencyDegraded()
            return original(receipt)
        self.host.probe = probe
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertEqual([A, B, A], probes)
        self.assertEqual(1, self.host.events.count('restore'))
        self.assertIsNotNone(self.state()['hold'])
        with self.assertRaises(Hold):
            self.controller.recover()

    def test_duplicate_invocation(self):
        with self.store.lock():
            with self.assertRaises(Hold):
                self.controller.once()
        self.assertNotIn('poll', self.host.events)

    def test_restart_is_failure(self):
        self.host.restart = 1
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertNotIn('poll', self.host.events)

    def test_watchdog_provider_failure_does_not_roll_back(self):
        self.host.probe = lambda receipt: (_ for _ in ()).throw(DependencyDegraded())
        for _ in range(3):
            self.assertEqual('dependency-degraded', self.controller.watchdog())
        self.assertNotIn('stop', self.host.events)
        self.assertEqual(0, self.state()['failures'])

    def test_watchdog_hard_failure_rolls_back_after_two(self):
        self.controller.once()
        self.host.fail.add('probe:b')
        self.assertEqual('degraded', self.controller.watchdog())
        self.assertEqual('rolled-back', self.controller.watchdog())
        self.assertEqual([B], self.state()['rejected'])
        self.assertEqual(image(A), self.state()['current'])

    def test_watchdog_no_previous_image(self):
        self.host.fail.add('probe:a')
        self.assertEqual('degraded', self.controller.watchdog())
        with self.assertRaises(Hold):
            self.controller.watchdog()
        self.assertNotIn('stop', self.host.events)

    def test_interruption_recovery_at_each_activation_stage(self):
        for stage in ('intent', 'stopped', 'switching', 'switched', 'started'):
            with self.subTest(stage=stage):
                self.setUp()
                save = self.store.save
                def crash_at(data):
                    save(data)
                    if data['transaction'] and data['transaction']['stage'] == stage:
                        raise Crash(stage)
                self.store.save = crash_at
                with self.assertRaises(Crash):
                    self.controller.once()
                self.store.save = save
                self.assertEqual('rolled-back', Controller(self.host, self.store).recover())
                self.assertEqual(image(A), self.state()['current'])
                self.assertEqual([B], self.state()['rejected'])

    def test_partial_link_switch_can_restore_only_transaction_targets(self):
        self.host.crash = 'switch'
        with self.assertRaises(Crash):
            self.controller.once()
        self.host.crash = None
        self.host.link = (self.host.targets(image(B))[0], self.host.targets(image(A))[1])
        self.assertEqual('rolled-back', self.controller.recover())

    def test_unknown_link_blocks_restore(self):
        self.host.crash = 'switch'
        with self.assertRaises(Crash):
            self.controller.once()
        self.host.crash = None
        self.host.link = ('/unknown', '/node/v24.21.0')
        with self.assertRaises(Hold):
            self.controller.recover()
        self.assertIsNotNone(self.state()['hold'])

    def test_interrupted_rollback_never_retries(self):
        self.host.fail.add('probe:b')
        self.host.crash = 'restore'
        with self.assertRaises(Crash):
            self.controller.once()
        self.assertEqual('rolling-back', self.state()['transaction']['stage'])
        self.host.crash = None
        self.assertEqual('rolled-back', self.controller.recover())
        self.assertEqual(2, self.host.events.count('restore'))

    def test_role_generation_drift_blocks_recovery(self):
        self.host.crash = 'switch'
        with self.assertRaises(Crash):
            self.controller.once()
        self.host.crash = None
        self.host.role = {'enabled': False, 'generation': 2}
        with self.assertRaises(Hold):
            self.controller.recover()
        self.assertNotIn('restore', self.host.events)

    def test_invalid_state_permissions_and_unknown_stage(self):
        (self.root / 'state.json').chmod(0o644)
        with self.assertRaises(Hold):
            self.controller.check()
        (self.root / 'state.json').chmod(0o600)
        data = self.state()
        data['transaction'] = {'stage': 'unknown', 'previous': image(A), 'next': image(B), 'role': self.host.role}
        self.store.save(data)
        with self.assertRaises(Hold):
            self.controller.recover()

    def test_state_symlink_is_rejected(self):
        path = self.root / 'state.json'
        path.rename(self.root / 'other')
        path.symlink_to(self.root / 'other')
        with self.assertRaises(Hold):
            self.controller.check()

    def test_atomic_state_is_private(self):
        atomic_json(self.root / 'state.json', self.state())
        self.assertEqual(0o600, (self.root / 'state.json').stat().st_mode & 0o777)
        self.assertFalse(list(self.root.glob('.write-*')))

    def test_commit_failure_before_or_after_replace_stops_without_false_commit(self):
        for visible in (False, True):
            with self.subTest(visible=visible):
                self.setUp()
                save = self.store.save
                injected = []
                def fail_commit(data):
                    if data['transaction'] is None and data['current'] == image(B) and not injected:
                        injected.append(1)
                        if visible:
                            save(data)  # replace visible; durability still uncertain
                        raise PersistenceError('commit fsync failed')
                    save(data)
                self.store.save = fail_commit
                with self.assertRaises(Hold):
                    self.controller.once()
                self.assertFalse(self.host.active)
                state = self.state()
                self.assertEqual(image(A), state['current'])
                self.assertEqual('started', state['transaction']['stage'])
                self.assertIsNotNone(state['hold'])
                self.assertNotIn('restore', self.host.events)

    def test_rollback_intent_persistence_failure_still_stops_owned_candidate(self):
        save = self.store.save
        self.host.fail.add('probe:b')
        def fail_rollback(data):
            if data['transaction'] and data['transaction']['stage'] == 'rolling-back':
                raise PersistenceError('disk full')
            save(data)
        self.store.save = fail_rollback
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertFalse(self.host.active)
        self.assertNotIn('restore', self.host.events)
        self.assertEqual('started', self.state()['transaction']['stage'])

    def test_all_persistence_unavailable_after_new_start_does_not_leave_candidate_running(self):
        save = self.store.save
        def fail(data):
            if 'start' in self.host.events:
                raise PersistenceError('all writes fail')
            save(data)
        self.store.save = fail
        with self.assertRaises(Hold):
            self.controller.once()
        self.assertFalse(self.host.active)
        self.assertEqual('switched', self.state()['transaction']['stage'])

    def test_watchdog_mixed_hard_provider_hard_is_not_consecutive(self):
        self.controller.once()
        original = self.host.probe
        outcome = ['hard', 'provider', 'hard']
        def probe(receipt):
            event = outcome.pop(0)
            if event == 'hard':
                raise Hold('HTTP failure')
            raise DependencyDegraded()
        self.host.probe = probe
        self.assertEqual('degraded', self.controller.watchdog())
        self.assertEqual('dependency-degraded', self.controller.watchdog())
        self.assertEqual(0, self.state()['failures'])
        self.assertEqual('degraded', self.controller.watchdog())
        self.assertEqual(1, self.state()['failures'])
        self.assertNotIn('restore', self.host.events)

    def test_atomic_file_fsync_replace_and_directory_fsync_faults_preserve_valid_json(self):
        initial = self.state()
        for operation in ('file_fsync', 'replace', 'directory_fsync', 'create'):
            with self.subTest(operation=operation):
                self.store.save(initial)
                if operation == 'file_fsync':
                    fault = patch('ops.deploy_api_release.os.fsync', side_effect=OSError('disk failure'))
                elif operation == 'replace':
                    fault = patch('ops.deploy_api_release.os.replace', side_effect=OSError('replace failure'))
                elif operation == 'directory_fsync':
                    fault = patch('ops.deploy_api_release.sync_directory', side_effect=OSError('directory failure'))
                else:
                    fault = patch('ops.deploy_api_release.tempfile.mkstemp', side_effect=OSError('disk full'))
                changed = copy.deepcopy(initial)
                changed['failures'] = 1
                with fault, self.assertRaises(PersistenceError):
                    self.store.save(changed)
                actual = self.state()
                self.assertEqual(changed if operation == 'directory_fsync' else initial, actual)
                self.assertFalse(list(self.root.glob('.write-*')))


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.host = Host.__new__(Host)
        self.host.runtime = Mock(return_value='101')
        self.host.command = Mock(return_value='')
        self.response = io.BytesIO(json.dumps({'status': 'degraded', 'uptime': 1}).encode())
        self.response.code = 503

    def test_cold503_uses_only_anonymous_ws_and_select1_as_api_identity(self):
        with patch('ops.deploy_api_release.urlopen', return_value=self.response):
            result = self.host.probe(image(A))
        self.assertTrue(result['cold_cache'])
        self.assertEqual(2, self.host.command.call_count)
        ws, db = [call.args[0] for call in self.host.command.call_args_list]
        for argv in (ws, db):
            self.assertIn('--property=User=fg-index', argv)
            self.assertIn('--property=Group=fg-index', argv)
            self.assertIn('--property=RuntimeMaxSec=8', argv)
            self.assertIn('--property=EnvironmentFile=/etc/fg-index/api.env', argv)
        self.assertIn("new WebSocket('ws://127.0.0.1:8080')", ws[-1])
        self.assertNotIn('send(', ws[-1])
        self.assertIn("$queryRawUnsafe('SELECT 1')", db[-1])
        self.assertNotIn('upsert', db[-1])

    def test_provider_failure_is_distinct_from_ws_failure(self):
        self.host.command.side_effect = ['', Hold('child secret output must not leak')]
        with patch('ops.deploy_api_release.urlopen', return_value=self.response):
            with self.assertRaises(DependencyDegraded) as error:
                self.host.probe(image(A))
        self.assertNotIn('secret', str(error.exception))

    def test_ws_failure_is_hard_failure(self):
        self.host.command.side_effect = Hold('WS failed')
        with patch('ops.deploy_api_release.urlopen', return_value=self.response):
            with self.assertRaises(Hold):
                self.host.probe(image(A))
        self.assertEqual(1, self.host.command.call_count)

    def test_pid_drift_during_probe_fails(self):
        self.host.runtime.side_effect = ['101', '101', '101', '102']
        with patch('ops.deploy_api_release.urlopen', return_value=self.response):
            with self.assertRaises(Hold):
                self.host.probe(image(A))

    def test_invalid_health_contract_expires_without_db_probe(self):
        self.response = io.BytesIO(b'{}')
        self.response.code = 200
        with patch('ops.deploy_api_release.urlopen', return_value=self.response), patch('ops.deploy_api_release.time.monotonic', side_effect=[0, 61]):
            with self.assertRaises(Hold):
                self.host.probe(image(A))
        self.assertEqual(0, self.host.command.call_count)

    def test_runtime_rejects_restarts_and_nonloopback_listener(self):
        host = Host.__new__(Host)
        host.preflight = Mock()
        host.links = Mock(return_value=host.targets(image(A)))
        props = {'ActiveState': 'active', 'MainPID': '101', 'NRestarts': '1', 'ControlPID': '0'}
        host.properties = Mock(return_value=props)
        with self.assertRaises(Hold):
            host.runtime(image(A))
        props['NRestarts'] = '0'
        host.command = Mock(return_value='LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=101,fd=20))')
        expected = [host.targets(image(A))[1] + '/bin/node', host.targets(image(A))[0] + '/apps/api-server']
        with patch('ops.deploy_api_release.os.readlink', side_effect=expected):
            with self.assertRaises(Hold):
                host.runtime(image(A))

    def test_runtime_accepts_only_exact_process_and_loopback(self):
        host = Host.__new__(Host)
        host.preflight = Mock()
        host.links = Mock(return_value=host.targets(image(A)))
        host.properties = Mock(return_value={'ActiveState': 'active', 'MainPID': '101', 'NRestarts': '0', 'ControlPID': '0'})
        host.command = Mock(return_value='LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=101,fd=20))')
        expected = [host.targets(image(A))[1] + '/bin/node', host.targets(image(A))[0] + '/apps/api-server']
        with patch('ops.deploy_api_release.os.readlink', side_effect=expected):
            self.assertEqual('101', host.runtime(image(A)))

    def test_public_release_requires_immutable_direct_exact_main(self):
        host = Host.__new__(Host)
        def response(value):
            return io.BytesIO(json.dumps(value).encode())
        with patch('ops.deploy_api_release.urlopen', side_effect=[response({'object': {'sha': B}}), response({'immutable': True, 'draft': False, 'prerelease': False}), response({'object': {'type': 'commit', 'sha': B}})]):
            self.assertEqual(B, host.main_sha())
        with patch('ops.deploy_api_release.urlopen', side_effect=[response({'object': {'sha': B}}), response({'immutable': False, 'draft': False, 'prerelease': False})]):
            with self.assertRaises(Hold):
                host.main_sha()
        with patch('ops.deploy_api_release.urlopen', side_effect=[response({'object': {'sha': B}}), response({'immutable': True, 'draft': False, 'prerelease': False}), response({'object': {'type': 'tag', 'sha': B}})]):
            with self.assertRaises(Hold):
                host.main_sha()


class LoadedContractTest(unittest.TestCase):
    def props(self, enabled, guard=False):
        role = str(enabled).lower()
        argv = '/usr/bin/env NODE_ENV=production HOST=127.0.0.1 PORT=8080 SCHEDULERS_ENABLED=' + role + ' /opt/nodejs/current/bin/node /opt/fg-index/current/apps/api-server/dist/index.js'
        return {'User': 'fg-index', 'Group': 'fg-index', 'ControlPID': '0',
                'FragmentPath': '/etc/systemd/system/fg-index-api.service',
                'Requires': 'fg-index-api-boot-guard.service' if guard else '',
                'After': 'network-online.target fg-index-api-boot-guard.service' if guard else 'network-online.target',
                'WorkingDirectory': '/opt/fg-index/current/apps/api-server',
                'EnvironmentFiles': '/etc/fg-index/api.env (ignore_errors=no)',
                'DropInPaths': ' '.join(x for x, include in (
                    ('/etc/systemd/system/fg-index-api.service.d/10-scheduler-owner.conf', enabled),
                    ('/etc/systemd/system/fg-index-api.service.d/20-deployment-boot-guard.conf', guard)) if include),
                'ExecStart': '{ path=/usr/bin/env ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=n/a ; stop_time=n/a ; pid=0 ; code=(null) ; status=0/0 }'}

    def test_actual_node_release_layout_is_centralized(self):
        host = Host.__new__(Host)
        expected = '/opt/nodejs/releases/node-v24.21.0'
        self.assertEqual(expected, str(node_target('v24.21.0')))
        self.assertEqual(expected, host.targets(image(A))[1])
        with self.assertRaises(Hold):
            node_target('../../unknown')

    def test_exact_base_false_and_sole_reviewed_true_are_accepted(self):
        for enabled in (False, True):
            validate_loaded_unit(self.props(enabled), {'enabled': enabled, 'generation': 1})
            validate_loaded_unit(self.props(enabled, guard=True), {'enabled': enabled, 'generation': 1}, True)

    def test_partial_guard_policy_and_api_dropin_attachment_hold(self):
        base_role = {'enabled': True, 'generation': 1}
        with self.assertRaises(Hold):
            validate_loaded_unit(self.props(True), base_role, boot_guard_enabled=True)
        with self.assertRaises(Hold):
            validate_loaded_unit(self.props(True, guard=True), base_role, boot_guard_enabled=False)

    def test_loaded_path_count_argv_workdir_env_and_dropin_drift_are_rejected(self):
        modifications = [
            ('ExecStart', lambda v: v.replace('path=/usr/bin/env', 'path=/tmp/unknown')),
            ('ExecStart', lambda v: v + v),
            ('ExecStart', lambda v: v.replace('ignore_errors=no', 'ignore_errors=yes')),
            ('ExecStart', lambda v: v.replace('PORT=8080', 'PORT=8081')),
            ('WorkingDirectory', lambda v: '/tmp'),
            ('EnvironmentFiles', lambda v: v + ' /tmp/extra.env (ignore_errors=no)'),
            ('EnvironmentFiles', lambda v: v.replace('no', 'yes')),
            ('DropInPaths', lambda v: v + ' /etc/systemd/system/fg-index-api.service.d/20-unknown.conf'),
            ('DropInPaths', lambda v: v + ' ' + v),
            ('Requires', lambda v: v + ' fg-index-api-boot-guard.service'),
            ('After', lambda v: v.replace('network-online.target', 'unknown.service')),
        ]
        for field, change in modifications:
            with self.subTest(field=field):
                props = self.props(True)
                props[field] = change(props[field])
                with self.assertRaises(Hold):
                    validate_loaded_unit(props, {'enabled': True, 'generation': 1})


class PolicyPhaseTest(unittest.TestCase):
    def test_legacy_policy_is_guard_off_and_only_exact_extension_is_accepted(self):
        legacy = {'schema_version': 1, 'role': {}, 'boot_enabled': True, 'schema': 'a' * 64,
                  'nodes': {}, 'pins': {}, 'manual_adoption': {}}
        validate_policy_shape(legacy)
        for enabled in (False, True):
            validate_policy_shape({**legacy, 'boot_guard_enabled': enabled})
        with self.assertRaises(Hold):
            validate_policy_shape({**legacy, 'unknown': True})
        with self.assertRaises(Hold):
            validate_policy_shape({**legacy, 'boot_guard_enabled': 'true'})


class PollerContractTest(unittest.TestCase):
    def props(self):
        argv = '/usr/bin/python3.12 /usr/local/libexec/fg-index-release-poller/poller.py --root /var/lib/fg-index-release-poller'
        return {'User': 'fg-index-release-poller', 'Group': 'fg-index-release-poller',
                'FragmentPath': '/etc/systemd/system/fg-index-release-poller.service', 'DropInPaths': '',
                'EnvironmentFiles': '', 'WorkingDirectory': '', 'TimeoutStartUSec': '3min',
                'ExecStart': '{ path=/usr/bin/python3.12 ; argv[]=' + argv + ' ; ignore_errors=no ; pid=0 ; status=0/0 }'}

    def test_exact_loaded_poller_is_accepted(self):
        validate_loaded_poller(self.props())

    def test_properties_accepts_omitted_empty_environment_files_only_for_pinned_poller(self):
        host = Host.__new__(Host)
        fragment = Path('/etc/systemd/system/fg-index-release-poller.service')
        pin = 'e' * 64
        host.policy = {'pins': {str(fragment): pin}}
        host.command = Mock(return_value=(
            'User=fg-index-release-poller\nGroup=fg-index-release-poller\n'
            'FragmentPath=' + str(fragment) + '\nDropInPaths=\n'
            'WorkingDirectory=\nTimeoutStartUSec=3min\n'))
        with patch('ops.deploy_api_release.trusted'), \
             patch('ops.deploy_api_release.digest_file', return_value=pin), \
             patch.object(Path, 'read_text', return_value='[Service]\nUser=fg-index-release-poller\n'):
            props = host.properties('fg-index-release-poller.service',
                                    ['User', 'Group', 'FragmentPath', 'DropInPaths', 'EnvironmentFiles', 'WorkingDirectory', 'TimeoutStartUSec'],
                                    allow_missing_empty=('EnvironmentFiles',))
        self.assertEqual('', props['EnvironmentFiles'])
        validate_loaded_poller({**self.props(), **props})
        self.assertIn('--all', host.command.call_args.args[0])

    def test_omitted_empty_environment_files_requires_clean_pinned_source_and_fixed_paths(self):
        fragment = Path('/etc/systemd/system/fg-index-release-poller.service')
        pin = 'e' * 64
        output = ('FragmentPath=' + str(fragment) + '\nDropInPaths=\n')
        for source, loaded in (('[Service]\nEnvironmentFile=/tmp/secret\n', output),
                               ('[Service]\n', output.replace('DropInPaths=\n', 'DropInPaths=/run/override.conf\n'))):
            host = Host.__new__(Host)
            host.policy = {'pins': {str(fragment): pin}}
            host.command = Mock(return_value=loaded)
            with patch('ops.deploy_api_release.trusted'), \
                 patch('ops.deploy_api_release.digest_file', return_value=pin), \
                 patch.object(Path, 'read_text', return_value=source):
                with self.assertRaises(Hold):
                    host.properties('fg-index-release-poller.service', ['FragmentPath', 'DropInPaths', 'EnvironmentFiles'], allow_missing_empty=('EnvironmentFiles',))

    def test_missing_nonallowlisted_property_stays_a_hold(self):
        host = Host.__new__(Host)
        host.command = Mock(return_value='ActiveState=inactive\n')
        with self.assertRaises(Hold):
            host.properties('fg-index-release-poller.service', ['ActiveState', 'EnvironmentFiles'])
        host.command.return_value = 'ActiveState=inactive\nUnexpected=yes\n'
        with self.assertRaises(Hold):
            host.properties('fg-index-release-poller.service', ['ActiveState'])

    def test_nonempty_environment_files_remain_rejected(self):
        props = self.props()
        props['EnvironmentFiles'] = '/tmp/unexpected.env (ignore_errors=no)'
        with self.assertRaises(Hold):
            validate_loaded_poller(props)

    def test_loaded_poller_drift_is_rejected(self):
        changes = [('User', 'root'), ('Group', 'root'), ('FragmentPath', '/run/systemd/system/fg-index-release-poller.service'),
                   ('DropInPaths', '/run/systemd/system/fg-index-release-poller.service.d/override.conf'),
                   ('EnvironmentFiles', '/tmp/unknown.env (ignore_errors=no)'), ('WorkingDirectory', '/tmp'),
                   ('TimeoutStartUSec', 'infinity')]
        for field, value in changes:
            with self.subTest(field=field):
                props = self.props()
                props[field] = value
                with self.assertRaises(Hold):
                    validate_loaded_poller(props)
        for change in (lambda v: v + v, lambda v: v.replace('path=/usr/bin/python3.12', 'path=/tmp/other'),
                       lambda v: v.replace('--root /var/lib/fg-index-release-poller', '--root /tmp'),
                       lambda v: v.replace('ignore_errors=no', 'ignore_errors=yes')):
            props = self.props()
            props['ExecStart'] = change(props['ExecStart'])
            with self.assertRaises(Hold):
                validate_loaded_poller(props)

    def test_actual_poll_adapter_rechecks_contract_before_start(self):
        host = Host.__new__(Host)
        host.properties = Mock(return_value={**self.props(), 'User': 'root'})
        host.command = Mock()
        with self.assertRaises(Hold):
            host.poll()
        host.command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
