import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from isutools.lib import image_cache_deploy as image
from isutools.lib.config import ToolError

ROOT = Path(__file__).resolve().parents[2]


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isu15-image-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.plan = json.loads((ROOT / image.MANIFEST).read_text())
        self.events = []
        self.password = 'ab' * 32
        self.failure = None
        self.config = SimpleNamespace(hosts=list(self.plan['services']), ssh=self.ssh)

    def ssh(self, host, command, *, input=None, check=False):
        phase = command.split()[-1]
        if 'image-cache-phase' not in command:
            phase = 'deploy' if 'remote-deploy' in command else 'checkout'
        self.events.append((host, phase, input))
        if self.failure == (host, phase):
            return SimpleNamespace(returncode=1, stdout='fixture failed\n')
        output = self.password + '\n' if phase == 'secret' else 'ISUTOOLS_RESULT status=ok step=done commit=abc1234\n'
        return SimpleNamespace(returncode=0, stdout=output)

    def deploy(self):
        return image.deploy(self.config, self.plan, 'a' * 40, 'feature/image', 'tester', self.directory)

    def test_all_writers_stop_before_credentials_or_redis_and_start_only_after_prepare(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            logs = self.deploy()
        phases = [event[1] for event in self.events]
        self.assertEqual(set(logs), set(self.config.hosts))
        self.assertEqual(phases[:4], ['checkout'] * 4)
        self.assertEqual(phases[4:8], ['stop'] * 4)
        self.assertLess(max(i for i, p in enumerate(phases) if p == 'deploy'), phases.index('prepare'))
        self.assertLess(phases.index('prepare'), phases.index('start'))
        self.assertEqual(sum(p == 'install' for p in phases), 1)
        self.assertEqual(sum(p == 'credentials' for p in phases), 4)
        self.assertNotIn(self.password, output.getvalue())
        for file in self.directory.iterdir():
            self.assertNotIn(self.password, file.read_text())

    def test_failure_at_any_mutating_phase_leaves_every_host_stopped(self):
        for failure in [('asia2', 'install'), ('europe1', 'credentials'), ('america1', 'deploy'), ('asia2', 'prepare'), ('europe1', 'check'), ('europe1', 'start')]:
            with self.subTest(failure=failure):
                self.events.clear()
                self.failure = failure
                with self.assertRaises(ToolError):
                    self.deploy()
                self.assertEqual([(h, p) for h, p, _ in self.events[-4:]], [(h, 'stop') for h in self.config.hosts])
                self.assertTrue((self.directory / 'image-cache-failed').exists())
                if failure[1] != 'start':
                    self.assertNotIn('start', [p for _, p, _ in self.events])

    def test_provider_and_service_inventory_are_validated(self):
        image.validate(self.plan, self.config.hosts)
        with self.assertRaises(ToolError):
            image.validate(self.plan, self.config.hosts[:-1])
        self.plan['services']['asia1'].append('ssh.service')
        with self.assertRaises(ToolError):
            image.validate(self.plan, self.config.hosts)


class HostPhaseTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.config = SimpleNamespace(root=ROOT, hosts=['asia1', 'europe1', 'america1', 'asia2'], etc=Path('/test/etc'),
                                      server_root=Path('/test/home'), sudo=self.sudo, run=self.run_command,
                                      require=lambda key: {'APP_SERVICE': 'isureal-nodejs.service', 'APP_DIR': 'webapp/nodejs'}[key],
                                      get=lambda key: '/usr/bin')

    def sudo(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout='')

    def run_command(self, args, **kwargs):
        self.calls.append((tuple(args), kwargs))
        return SimpleNamespace(returncode=0, stdout='401' if args[0] == 'curl' else '')

    def test_credentials_use_stdin_not_command_arguments_and_do_not_print(self):
        password = 'cd' * 32
        for host in self.config.hosts:
            self.calls.clear()
            output = io.StringIO()
            with patch.object(image.sys, 'stdin', io.StringIO(json.dumps({'password': password}))), contextlib.redirect_stdout(output):
                image.remote_phase(self.config, host, 'credentials')
            args, kwargs = self.calls[0]
            self.assertNotIn(password, str(args))
            self.assertNotIn(password, output.getvalue())
            payload = json.loads(kwargs['input'])
            self.assertIn(password, payload['client'])
            self.assertIn('127.0.0.1:6380' if host == 'asia2' else '192.168.4.10:6380', payload['client'])
            self.assertIn('ISUREAL_IMAGE_AUTH_CACHE_READS=1', payload['client'])

    def test_restart_does_not_provision_or_clear_redis_and_enables_autostart(self):
        image.apply_redis(self.config, 'asia2')
        args = [call[0] for call in self.calls]
        self.assertIn(('systemctl', 'enable', image.SERVICE), args)
        self.assertIn(('systemctl', 'restart', image.SERVICE), args)
        self.assertFalse(any('FLUSH' in str(item) or 'prepare_image' in str(item) for item in args))
        self.calls.clear()
        image.remote_phase(self.config, 'asia1', 'start')
        self.assertIn(('systemctl', 'enable', 'isureal-nodejs.service'), [call[0] for call in self.calls])
        for host, services in json.loads((ROOT / image.MANIFEST).read_text())['services'].items():
            for service in services:
                text = (ROOT / host / 'etc/systemd/system' / (service + '.d') / 'image-authorization.conf').read_text()
                self.assertIn('EnvironmentFile=/etc/isureal-image-redis/client.env', text)
                self.assertIn('ConditionPathExists=!/etc/isureal-image-redis/deploy-in-progress', text)
        provider = (ROOT / 'asia2/etc/systemd/system/isureal-nodejs.service.d/image-authorization.conf').read_text()
        self.assertIn('Wants=isureal-image-redis.service', provider)
        self.assertIn('After=isureal-image-redis.service', provider)

    def test_maintenance_marker_survives_failed_deploy_and_is_removed_only_for_start(self):
        image.remote_phase(self.config, 'asia1', 'stop')
        args = [call[0] for call in self.calls]
        marker = Path('/test/etc/isureal-image-redis/deploy-in-progress')
        self.assertLess(args.index(('touch', marker)), args.index(('systemctl', 'stop', 'isureal-nodejs.service', 'isureal-nodejs-europe.service', 'isureal-nodejs-america.service')))
        self.assertNotIn(('rm', '-f', marker), args)
        self.calls.clear()
        image.remote_phase(self.config, 'asia1', 'start')
        args = [call[0] for call in self.calls]
        self.assertLess(args.index(('rm', '-f', marker)), next(i for i, arg in enumerate(args) if arg[:2] == ('systemctl', 'start')))

    def test_existing_redis_installation_is_not_reinstalled_or_stopped(self):
        with patch.object(image.shutil, 'which', return_value='/usr/bin/redis-server'):
            image.remote_phase(self.config, 'asia2', 'install')
        self.assertEqual(self.calls, [])
        with patch.object(image.shutil, 'which', return_value=None):
            image.remote_phase(self.config, 'asia2', 'install')
        self.assertIn(('systemctl', 'disable', '--now', 'redis-server.service'), [call[0] for call in self.calls])


if __name__ == '__main__':
    unittest.main()
