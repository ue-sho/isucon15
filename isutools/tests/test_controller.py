import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from isutools.lib.config import ToolError
from isutools.lib import controller
from isutools.lib.render import render_all, write
from support import Sandbox


class PreflightTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.seed_origin()
        self.feature()

    def test_equal_and_branch_with_slash(self):
        branch, sha = controller.preflight(self.config())
        self.assertEqual(branch, 'feature/index-rides')
        self.assertEqual(sha, self.git(self.work, 'rev-parse', 'HEAD'))

    def test_unpushed_branch(self):
        self.git(self.work, 'switch', '-q', '-c', 'feature/new')
        with self.assertRaisesRegex(ToolError, 'git push -u origin feature/new'):
            controller.preflight(self.config(), 'feature/new')

    def test_ahead(self):
        for _ in range(2):
            self.git(self.work, 'commit', '-q', '--allow-empty', '-m', 'mine')
        with self.assertRaisesRegex(ToolError, '未 push のコミットが 2 件'):
            controller.preflight(self.config())

    def test_behind(self):
        self.push_other()
        with self.assertRaisesRegex(ToolError, 'origin が 1 コミット先行'):
            controller.preflight(self.config())

    def test_diverged(self):
        self.push_other()
        self.git(self.work, 'commit', '-q', '--allow-empty', '-m', 'mine')
        with self.assertRaisesRegex(ToolError, '分岐'):
            controller.preflight(self.config())

    def test_dirty_warns_but_passes(self):
        write(self.work / 'dirty', 'x')
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            controller.preflight(self.config())
        self.assertIn('未コミット', output.getvalue())

    def test_origin_only_branch(self):
        self.git(self.work, 'branch', '-q', '-D', 'main')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(controller.preflight(self.config(), 'main')[0], 'main')
        self.assertIn('origin/main を反映', output.getvalue())

    def test_detached_head(self):
        self.git(self.work, 'switch', '-q', '--detach', 'HEAD')
        with self.assertRaisesRegex(ToolError, 'detached HEAD'):
            controller.preflight(self.config())


class LockTests(Sandbox):
    def test_acquire_and_release_all_idempotently(self):
        config = self.config(self.tmp)
        controller.lock_all(config, 'Alice A', config.hosts)
        for host in config.hosts:
            self.assertIn('Alice A ', (self.lockdir(host) / 'owner').read_text())
        self.assertIn('Alice A ', controller.lock_owner(config, 's1'))
        controller.unlock_all(config, config.hosts)
        controller.unlock_all(config, config.hosts)
        self.assertTrue(all(not self.lockdir(host).exists() for host in config.hosts))

    def config(self, root=None, **values):
        return super().config(root or self.tmp, HOSTS='s1 s2 s3', **values)

    def test_partial_acquisition_rolls_back_preserving_existing_owner(self):
        write(self.lockdir('s2') / 'owner', 'Bob B 1700000000\n')
        with self.assertRaisesRegex(ToolError, 'Bob B が実行中'):
            controller.lock_all(self.config(), 'alice', ['s1', 's2', 's3'])
        self.assertFalse(self.lockdir('s1').exists())
        self.assertFalse(self.lockdir('s3').exists())
        self.assertIn('Bob B', (self.lockdir('s2') / 'owner').read_text())

    def test_unreachable_host_rolls_back(self):
        with self.assertRaisesRegex(ToolError, 's3'):
            controller.lock_all(self.config(FAKE_UNREACHABLE='s3'), 'alice', ['s1', 's2', 's3'])
        self.assertFalse(self.lockdir('s1').exists())
        self.assertFalse(self.lockdir('s2').exists())


class NotificationTests(Sandbox):
    def test_noop_without_webhook(self):
        with patch.object(controller.urllib.request, 'urlopen') as opener:
            controller.notify(self.config(self.tmp), 'hello')
        opener.assert_not_called()

    def test_json_escapes_and_unicode_truncation(self):
        with patch.object(controller.urllib.request, 'urlopen') as opener:
            for text in ['line1 "quoted"\nline2\\x', '日本語' * 1000]:
                with self.subTest(text=text[:20]):
                    controller.notify(self.config(self.tmp, DISCORD_WEBHOOK_URL='https://discord.invalid/hook'), text)
                    request = opener.call_args.args[0]
                    content = json.loads(request.data)['content']
                    self.assertLessEqual(len(content), 2000)
                    self.assertNotIn('\ufffd', content)
                    self.assertEqual(request.full_url, 'https://discord.invalid/hook')
                    if len(text) < 100:
                        self.assertIn(text, content)
                    else:
                        self.assertIn('truncated', content)

    def test_invalid_webhook_is_nonfatal(self):
        with contextlib.redirect_stderr(io.StringIO()):
            controller.notify(self.config(self.tmp, DISCORD_WEBHOOK_URL='invalid-url'), 'hello')

    def test_failure_is_nonfatal(self):
        with patch.object(controller.urllib.request, 'urlopen', side_effect=OSError('failure')):
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                controller.notify(self.config(self.tmp, DISCORD_WEBHOOK_URL='https://discord.invalid'), 'hello')
        self.assertIn('Discord', output.getvalue())

    def test_summary_reports_steps_missing_results_and_mismatched_commits(self):
        summary, failed = controller.format_summary('main', 'abc1234', {
            's1': 'ISUTOOLS_RESULT status=ok build=3 step=done commit=abc1234\n',
            's2': 'nginx: unknown directive\nISUTOOLS_RESULT status=ng build=3 step=nginx-test commit=abc1234\n',
            's3': 'ssh: Connection refused\n'})
        self.assertTrue(failed)
        for expected in ['s1 ✔ abc1234', 's2 ✖ failed at nginx-test', 'unknown directive', 's3 ✖ 接続', 'Connection refused', 'failed on: s2 s3']:
            self.assertIn(expected, summary)
        summary, failed = controller.format_summary('main', 'abc1234', {'s1': 'ISUTOOLS_RESULT status=ok commit=fffffff'})
        self.assertTrue(failed)
        self.assertIn('commit fffffff (expected abc1234)', summary)


class DeployTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.seed_origin()
        for host in ['s1', 's2', 's3']:
            self.host_root(host).rmdir()
            self.command(['git', 'clone', '-q', self.origin, self.host_root(host)])
        self.feature()

    def host_sha(self, host):
        return self.git(self.host_root(host), 'rev-parse', '--short=7', 'HEAD')

    def assert_unlocked(self):
        for host in ['s1', 's2', 's3']:
            self.assertFalse(self.lockdir(host).exists(), host)

    def test_current_branch_deploy_and_summary(self):
        result = self.cli('deploy')
        self.assertIn(f'branch: feature/index-rides  ({self.new_sha} "add index to rides")', result.stdout)
        self.assertIn('previous deploy: (none)', result.stdout)
        for host in ['s1', 's2', 's3']:
            self.assertEqual(self.host_sha(host), self.new_sha)
            self.assertIn(f'{host} ✔ {self.new_sha}', result.stdout)
        self.assert_unlocked()

    def test_explicit_branch(self):
        result = self.cli('deploy', '--branch', 'main')
        self.assertIn(f'done: main @ {self.base_sha}', result.stdout)
        self.assertEqual(self.host_sha('s1'), self.base_sha)

    def test_preflight_failure_does_not_reset_hosts(self):
        self.git(self.work, 'commit', '-q', '--allow-empty', '-m', 'unpushed')
        result = self.cli('deploy', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未 push', result.stdout)
        self.assertTrue(all(self.host_sha(host) == self.base_sha for host in ['s1', 's2', 's3']))

    def test_unreachable_host_aborts_before_reset(self):
        result = self.cli('deploy', env={'FAKE_UNREACHABLE': 's2'}, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.host_sha('s1'), self.base_sha)
        self.assertEqual(self.host_sha('s3'), self.base_sha)
        self.assert_unlocked()

    def test_remote_failure_prints_log_and_unlocks(self):
        write(self.hosts / 's2/enabled', 'nginx\n')
        (self.hosts / 's2/fail-nginx').touch()
        result = self.cli('deploy', check=False)
        self.assertEqual(result.returncode, 1)
        for expected in ['s1 ✔', 's2 ✖ failed at nginx-test', 'injected failure', 'failed on: s2']:
            self.assertIn(expected, result.stdout)
        self.assert_unlocked()

    def test_notification_failure_does_not_change_deployment(self):
        result = self.cli('deploy', env={'DISCORD_WEBHOOK_URL': 'invalid-url'})
        self.assertIn('Discord への通知に失敗', result.stdout)
        self.assertIn('done: feature/index-rides', result.stdout)
        self.assert_unlocked()

    def test_previous_deployer(self):
        self.git(self.work, 'config', 'user.name', 'Alice A')
        self.cli('deploy')
        self.git(self.work, 'config', 'user.name', 'Bob')
        result = self.cli('deploy')
        self.assertIn('deployer: Bob', result.stdout)
        self.assertIn(f'previous deploy: Alice A / feature/index-rides @ {self.new_sha}', result.stdout)

    def test_pins_revision_if_branch_advances_after_preflight(self):
        config = self.config()
        original = config.ssh
        def advance(host, command, **kwargs):
            if 'last-deploy' in command:
                self.push_other()
            return original(host, command, **kwargs)
        with patch.object(config, 'ssh', side_effect=advance):
            self.assertEqual(controller.deploy(config), 0)
        self.assertNotEqual(self.git(self.origin, 'rev-parse', '--short=7', 'feature/index-rides'), self.new_sha)
        for host in config.hosts:
            self.assertEqual(self.host_sha(host), self.new_sha)

    def benchmark(self, outcome, *, local_config=False):
        binary = self.tmp / 'bin/ansible-playbook'
        write(binary, '''#!/usr/bin/env python3
import os, pathlib, subprocess, sys
base = pathlib.Path(os.environ['FAKE_HOSTS'])
assert all((base / host / 'home/isucon/.isutools/deploy.lock').is_dir() for host in ['s1', 's2', 's3'])
result = subprocess.run([sys.executable, '-m', 'isutools', 'deploy'], cwd=os.environ['REPO_ROOT'], capture_output=True, text=True)
assert result.returncode != 0 and 'デプロイ中' in result.stdout + result.stderr
state = pathlib.Path(os.environ['ISUTOOLS_BENCH_STATE'])
print('mock benchmark executed with locks held')
if os.environ['BENCH_TEST_RESULT'] == 'unknown':
    state.write_text('{"job_id":123,"status":"active"}')
sys.exit(0 if os.environ['BENCH_TEST_RESULT'] == 'success' else 1)
''')
        binary.chmod(0o755)
        env = {'PATH': str(binary.parent) + ':' + self.env['PATH'], 'BENCH_TEST_RESULT': outcome}
        credentials = {'PORTAL_TARGET_ID': '1', 'PORTAL_COOKIE': 'dummy', 'PORTAL_CSRF_TOKEN': 'dummy'}
        if local_config:
            write(self.work / '.env.isutools', '\n'.join(f'{key}={value}' for key, value in credentials.items()) + '\n')
        else:
            env.update(credentials)
        return self.cli('bench', env=env, check=False)

    def test_benchmark_holds_locks_and_releases_confirmed_outcomes(self):
        for outcome in ['success', 'failed']:
            with self.subTest(outcome=outcome):
                result = self.benchmark(outcome)
                self.assertEqual(result.returncode, 0 if outcome == 'success' else 1, result.stdout)
                self.assertIn('mock benchmark executed with locks held', result.stdout)
                self.assert_unlocked()

    def test_unknown_benchmark_retains_locks_and_blocks_next_deploy(self):
        result = self.benchmark('unknown')
        self.assertEqual(result.returncode, 1)
        self.assertIn('デプロイロックを保持します', result.stdout)
        for host in ['s1', 's2', 's3']:
            self.assertTrue(self.lockdir(host).exists())
        self.assertIn('デプロイ中', self.cli('deploy', check=False).stdout)
        # Remove the retained controller logs only after asserting recovery information.
        import shutil
        for line in result.stdout.splitlines():
            if 'デプロイロックを保持します: ' in line:
                shutil.rmtree(Path(line.split(': ', 1)[1]).parent)

    def test_failed_deploy_never_starts_benchmark(self):
        (self.hosts / 's1/fail-nginx').touch()
        write(self.hosts / 's1/enabled', 'nginx\n')
        result = self.benchmark('success')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('mock benchmark executed', result.stdout)
        self.assert_unlocked()

    def test_benchmark_reads_credentials_from_local_config(self):
        result = self.benchmark('success', local_config=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('mock benchmark executed', result.stdout)

    def test_task_entry_uses_branch_and_root_from_nested_directory(self):
        import shutil
        task = shutil.which('task')
        if not task:
            self.skipTest('Task is not installed')
        result = self.command([task, 'deploy', 'BRANCH=main'], cwd=self.work / 'isutools')
        self.assertIn(f'done: main @ {self.base_sha}', result.stdout)
        self.assertEqual(self.host_sha('s1'), self.base_sha)

    def test_invalid_benchmark_config_aborts_before_deploy(self):
        for target in ['', 'not-a-number', '-1']:
            result = self.cli('bench', env={'PORTAL_TARGET_ID': target, 'PORTAL_COOKIE': 'dummy', 'PORTAL_CSRF_TOKEN': 'dummy'}, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.host_sha('s1'), self.base_sha)


class StatusTargetsTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.work = self.tmp / 'work'
        self.make_repo(self.work)
        render_all(self.config())
        for host in ['s1', 's2', 's3']:
            root = self.host_root(host)
            self.git(root, 'init', '-q')
            self.git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
            import time
            write(root / '.isutools/last-deploy', f'deployer=Alice A\nbranch=feature/x\ncommit=abc1234\nat={int(time.time()) - 180}\n')
        write(self.hosts / 's1/enabled', 'nginx\nisuapp-node.service\npprotein-agent.service\n')

    def test_inspect_help_through_shared_cli(self):
        result = self.cli('inspect', '--help')
        self.assertIn('--exact-counts', result.stdout)
        self.assertIn('--output', result.stdout)

    def test_status_reports_services_commit_and_deployer(self):
        result = self.cli('status')
        sha = self.git(self.host_root('s1'), 'rev-parse', '--short=7', 'HEAD')
        self.assertIn(f's1  feature/x @ {sha}  last: Alice A 3 min ago', result.stdout)
        self.assertIn('app=active nginx=active db=inactive agent=active lock=-', result.stdout)
        self.assertIn('s3  feature/x', result.stdout)

    def test_status_unreachable_host(self):
        result = self.cli('status', env={'FAKE_UNREACHABLE': 's2'})
        self.assertIn('s2  ✖ unreachable', result.stdout)
        self.assertIn('s1  feature/x', result.stdout)

    def test_status_lock_owner_and_before_first_deploy(self):
        write(self.lockdir('s1') / 'owner', 'Bob 1700000000\n')
        (self.host_root('s1') / '.isutools/last-deploy').unlink()
        result = self.cli('status')
        self.assertIn('s1  (未デプロイ)', result.stdout)
        self.assertIn('lock=Bob', result.stdout)

    def test_unlock_yes(self):
        for host in ['s1', 's2', 's3']:
            write(self.lockdir(host) / 'owner', 'Bob 1700000000\n')
        self.cli('unlock', '-y')
        self.assertTrue(all(not self.lockdir(host).exists() for host in ['s1', 's2', 's3']))

    def test_targets_posts_json_and_checks_connection(self):
        self.cli('targets', 'split')
        self.assertIn('http://localhost:9000/api/group/targets', self.calls('s3'))
        self.assertEqual((self.hosts / 's3/curl.stdin').read_text(), (self.work / 'isutools/pprotein/targets.split.json').read_text())
        self.assertIn('http://10.0.0.3:9000/api/group/targets', self.calls('s1'))

    def test_targets_invalid_mode_and_unreachable_hosts(self):
        self.assertNotEqual(self.cli('targets', 'triple', check=False).returncode, 0)
        (self.hosts / 's1/fail-curl').touch()
        self.assertIn('s1 から pprotein', self.cli('targets', 'single', check=False).stdout)
        (self.hosts / 's3/fail-curl').touch()
        self.assertIn('targets 登録に失敗', self.cli('targets', 'single', check=False).stdout)
