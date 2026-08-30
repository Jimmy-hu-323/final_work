import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server


class FakeAdb:
    path = 'fake-adb'
    connected = True
    mode = 'default'
    other = ''
    location_on = True
    fail_send = False

    def __init__(self):
        self.commands = []
        self.provider_missing = False

    def devices(self):
        return [{'serial': 'TEST_PHONE', 'state': 'device', 'model': 'Test phone'}] if self.connected else []

    def shell(self, serial, *args):
        self.commands.append((serial, *args))
        if not self.connected:
            raise server.DemoError('device disconnected')
        if args[:3] == ('cmd', 'location', 'is-location-enabled'):
            return 'true' if self.location_on else 'false'
        if args[:2] == ('appops', 'set'):
            self.mode = args[-1]
            return ''
        if args[:2] == ('appops', 'get'):
            return 'MOCK_LOCATION: ' + self.mode
        if args[:2] == ('appops', 'query-op'):
            return self.other
        if 'set-test-provider-location' in args and self.fail_send:
            raise server.DemoError('test provider gone')
        if 'add-test-provider' in args:
            self.provider_missing = False
        if 'set-test-provider-location' in args and self.provider_missing:
            raise server.MockProviderMissing('手机模拟位置源已失效')
        return ''


class ControllerTests(unittest.TestCase):
    def test_expanded_presets_are_unique_valid_and_grouped(self):
        self.assertEqual(len(server.PRESETS), 25)
        self.assertEqual(len({p['id'] for p in server.PRESETS}), 25)
        self.assertEqual(sum(p['group'] == '酒店出发' for p in server.PRESETS), 5)
        for preset in server.PRESETS:
            target = server.target_from({'preset': preset['id']})
            self.assertTrue(22 < target['latitude'] < 23)
            self.assertTrue(113 < target['longitude'] < 114)
            self.assertIn(preset['group'], ('半岛', '酒店出发', '氹仔路氹', '路环'))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.adb = FakeAdb()
        self.now = 10000.0
        self.path = Path(self.temp.name) / 'session.json'
        self.controller = server.Controller(self.adb, self.path, lambda: self.now)

    def start(self):
        self.controller.start({'serial': 'TEST_PHONE', 'preset': 'outside'})

    def test_start_journals_and_streams_network_only(self):
        self.start()
        self.assertTrue(self.controller.active)
        self.assertTrue(self.path.exists())
        self.now += 6
        self.controller.tick()
        self.assertEqual(self.controller.status()['samples'], 2)
        self.assertNotIn('gps', str(self.adb.commands))
        self.assertNotIn('set-location-enabled', str(self.adb.commands))

    def test_switch_resets_dwell_and_does_not_reregister_provider(self):
        self.start()
        self.now += 25
        self.controller.point({'preset': 'stpaul'})
        self.assertEqual(self.controller.status()['elapsed'], 0)
        self.assertEqual(sum('add-test-provider' in c for c in self.adb.commands), 1)
        self.assertEqual(self.controller.status()['target']['name'], '大三巴牌坊')

    def test_restore_is_idempotent_and_restores_original_permission(self):
        self.adb.mode = 'deny'
        self.start()
        self.controller.restore()
        self.controller.restore()
        self.assertFalse(self.path.exists())
        self.assertIsNone(self.controller.session)
        self.assertEqual(self.adb.commands[-1][-1], 'deny')
        self.assertIn('remove-test-provider', self.adb.commands[-2])

    def test_browser_lease_expiry_restores(self):
        self.start()
        self.now += 91
        self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertIsNone(self.controller.session)

    def test_heartbeat_keeps_session_but_maximum_duration_is_bounded(self):
        self.start()
        self.now += 80
        self.controller.heartbeat()
        self.controller.tick()
        self.assertTrue(self.controller.active)
        self.now += 1800
        self.controller.heartbeat()
        self.controller.tick()
        self.assertIsNone(self.controller.session)

    def test_disconnect_preserves_journal_and_reconnect_recovers(self):
        self.start()
        self.adb.connected = False
        with self.assertRaises(server.DemoError):
            self.controller.restore()
        self.assertTrue(self.path.exists())
        recovered = server.Controller(self.adb, self.path, lambda: self.now)
        self.assertFalse(recovered.active)
        self.adb.connected = True
        recovered.tick()
        self.assertIsNone(recovered.session)

    def test_external_mock_owner_is_not_overwritten(self):
        for mode, other in [('allow', ''), ('default', 'other.mock.app')]:
            self.adb.mode, self.adb.other = mode, other
            with self.assertRaises(server.DemoError):
                self.start()
        self.assertFalse(self.path.exists())
        self.assertNotIn('add-test-provider', str(self.adb.commands))

    def test_invalid_coordinates_and_device_are_rejected_before_mutation(self):
        for data in [{'latitude': True, 'longitude': 113}, {'latitude': 91, 'longitude': 113}, {'latitude': 'nan', 'longitude': 113}, {'latitude': 22, 'longitude': 181}, {'preset': 'bad'}]:
            with self.assertRaises(server.DemoError):
                self.controller.start({'serial': 'TEST_PHONE', **data})
        with self.assertRaises(server.DemoError):
            self.controller.start({'serial': 'TEST_PHONE;cmd', 'preset': 'outside'})
        self.assertEqual(self.adb.commands, [])

    def test_disabled_system_location_not_modified(self):
        self.adb.location_on = False
        with self.assertRaises(server.DemoError):
            self.start()
        self.assertFalse(self.path.exists())

    def test_failed_first_sample_rolls_back(self):
        self.adb.fail_send = True
        with self.assertRaises(server.DemoError):
            self.start()
        self.assertFalse(self.path.exists())
        self.assertIsNone(self.controller.session)

    def test_gcj_round_trip_matches_existing_app(self):
        mapped = server.wgs_to_gcj(22.1977, 113.5408)
        self.assertAlmostEqual(mapped[0], 22.19476834660369, places=8)
        self.assertAlmostEqual(mapped[1], 113.54591190165479, places=8)
        target = server.target_from({'latitude': mapped[0], 'longitude': mapped[1], 'coordinate': 'gcj02'})
        self.assertAlmostEqual(target['latitude'], 22.1977, places=7)
        self.assertAlmostEqual(target['longitude'], 113.5408, places=7)

    def test_removed_provider_recovers_once_and_continues_same_target(self):
        self.start()
        self.adb.provider_missing = True
        self.now += 6
        self.controller.tick()
        state = self.controller.status()
        self.assertTrue(state['active'])
        self.assertEqual(state['samples'], 2)
        self.assertEqual(state['recoveries'], 1)
        self.assertEqual(state['elapsed'], 0)
        self.assertEqual(state['target']['preset'], 'outside')
        self.assertEqual(sum('add-test-provider' in c for c in self.adb.commands), 2)
        self.assertEqual(sum(c[1:3] == ('appops', 'set') for c in self.adb.commands), 1)
        self.now += 6
        self.controller.tick()
        self.assertEqual(self.controller.status()['samples'], 3)

    def test_revoked_permission_is_never_regranted(self):
        self.start()
        self.adb.mode = 'deny'
        self.adb.provider_missing = True
        before = len(self.adb.commands)
        self.now += 6
        self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertIn('授权已取消', self.controller.last_error)
        self.assertNotIn('add-test-provider', str(self.adb.commands[before:]))
        self.assertNotIn("'appops', 'set'", str(self.adb.commands[before:]))

    def test_new_mock_owner_prevents_recovery_and_sending(self):
        self.start()
        self.adb.other = 'other.mock.app'
        self.adb.provider_missing = True
        before = len(self.adb.commands)
        self.now += 6
        self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertNotIn('set-test-provider-location', str(self.adb.commands[before:]))
        self.assertNotIn('add-test-provider', str(self.adb.commands[before:]))
        with self.assertRaises(server.DemoError):
            self.controller.restore()
        self.assertNotIn('remove-test-provider', str(self.adb.commands[before:]))
        self.assertTrue(self.path.exists())

    def test_repeated_provider_loss_is_bounded_and_keeps_reason_after_restore(self):
        self.start()
        for _ in range(4):
            self.adb.provider_missing = True
            self.now += 6
            self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertEqual(self.controller.status()['recoveries'], 3)
        self.assertIn('反复失效', self.controller.last_error)
        self.now += 11
        self.controller.tick()
        self.assertIsNone(self.controller.session)
        events = str(self.controller.events)
        self.assertIn('反复失效', events)
        self.assertNotIn('手机已重新连接', events)

    def test_location_switch_off_prevents_recovery(self):
        self.start()
        self.adb.provider_missing = True
        self.adb.location_on = False
        self.now += 6
        self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertIn('系统定位已关闭', self.controller.last_error)
        self.assertNotIn('set-location-enabled', str(self.adb.commands))

    def test_generic_transport_error_does_not_reregister_source(self):
        self.start()
        self.adb.fail_send = True
        self.now += 6
        self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertEqual(self.controller.status()['recoveries'], 0)
        self.assertEqual(sum('add-test-provider' in c for c in self.adb.commands), 1)

    def test_recovery_journal_error_stops_without_reregistering(self):
        self.start()
        self.adb.provider_missing = True
        self.now += 6
        with patch.object(self.controller, 'save', side_effect=OSError('private-path')):
            self.controller.tick()
        self.assertFalse(self.controller.active)
        self.assertIn('无法保存恢复记录', self.controller.last_error)
        self.assertNotIn('private-path', self.controller.last_error)
        self.assertEqual(sum('add-test-provider' in c for c in self.adb.commands), 1)


class AdbErrorTests(unittest.TestCase):
    def test_only_missing_test_provider_is_marked_recoverable(self):
        for stderr, expected in [
            ('java.lang.IllegalArgumentException: network is not a test provider', server.MockProviderMissing),
            ('SecurityException: secret-url', server.DemoError),
        ]:
            with patch('server.subprocess.run') as run:
                run.return_value.returncode = 1
                run.return_value.stdout = ''
                run.return_value.stderr = stderr
                with self.assertRaises(expected) as error:
                    server.Adb('fake-adb').run(['devices'])
                if 'SecurityException' in stderr:
                    self.assertNotIsInstance(error.exception, server.MockProviderMissing)
                self.assertNotIn('secret-url', str(error.exception))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.controller = server.Controller(FakeAdb(), Path(self.temp.name) / 'session.json')
        self.http = server.DemoServer(0, self.controller)
        self.port = self.http.server_port
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def headers(self):
        return {'Origin': f'http://127.0.0.1:{self.port}', 'X-Demo-CSRF': self.http.csrf, 'Content-Type': 'application/json'}

    def test_requires_origin_csrf_and_json(self):
        for headers in [{}, {'Origin': 'https://evil.example'}, {**self.headers(), 'X-Demo-CSRF': 'bad'}]:
            self.assertEqual(self.request('POST', '/api/start', '{}', headers)[0], 403)
        self.assertFalse(self.controller.adb.commands)

    def test_bad_host_and_path_traversal_are_rejected(self):
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/../server.py')[0], 404)
        self.assertEqual(self.request('GET', '/.runtime/session.json')[0], 404)

    def test_real_api_roundtrip_with_fake_phone(self):
        self.assertEqual(self.request('POST', '/api/start', json.dumps({'serial': 'TEST_PHONE', 'preset': 'outside'}), self.headers())[0], 200)
        status, content = self.request('GET', '/api/status')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(content)['active'])
        self.assertEqual(self.request('POST', '/api/restore', '{}', self.headers())[0], 200)
        self.assertFalse(self.controller.active)

    def test_preview_converts_without_phone_commands(self):
        self.assertEqual(self.request('POST', '/api/preview', json.dumps({'preset': 'senado'}), self.headers())[0], 200)
        self.assertFalse(self.controller.adb.commands)


if __name__ == '__main__':
    unittest.main()
