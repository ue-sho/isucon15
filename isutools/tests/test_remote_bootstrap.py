from pathlib import Path
import shutil
import sys
import unittest

from isutools.lib.render import render_all, write
from support import Sandbox, ROOT


class RemoteDeployTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.work = self.host_root('s1')
        self.make_repo(self.work)
        self.logs = self.tmp / 'logs'
        config = self.work / 'isutools/config.env'
        config.write_text(config.read_text() + f'\nNGINX_LOG={self.logs}/nginx/access.log\nSLOW_LOG={self.logs}/mysql/slow.log\n')
        write(self.work / 'webapp/nodejs/package-lock.json', '{"lockfileVersion":3}')
        write(self.work / 'isutools/profiler/package-lock.json', '{"lockfileVersion":3,"name":"profiler"}')
        write(self.work / 's1/etc/mysql/debian.cnf', '[client]\n')
        write(self.work / 's1/etc/mysql/my.cnf', '[mysqld]\n')
        write(self.work / 's1/etc/nginx/nginx.conf', 'events {}\n')
        write(self.logs / 'nginx/access.log', 'access\n')
        write(self.logs / 'mysql/slow.log', 'slow\n')
        write(self.hosts / 's1/enabled', 'mysql\nnginx\nisuapp-node.service\n')
        render_all(self.config())

    def deploy(self, check=True):
        command = "DEPLOYER='Alice A' DEPLOY_BRANCH=feature/x python3 -m isutools remote-deploy s1"
        return self.command([self.env['ISUTOOLS_SSH'], 's1', command], check=check)

    def test_first_deploy_runs_npm_and_records_deployer(self):
        result = self.deploy()
        self.assertIn('ISUTOOLS_RESULT status=ok', result.stdout)
        self.assertIn('npm ci', self.calls())
        record = (self.work / '.isutools/last-deploy').read_text()
        self.assertIn('deployer=Alice A', record)
        self.assertIn('branch=feature/x', record)

    def test_unchanged_lock_skips_npm_but_changed_lock_reinstalls(self):
        self.deploy()
        self.deploy()
        self.assertEqual(self.calls().count('npm ci'), 2)
        write(self.work / 'webapp/nodejs/package-lock.json', '{"lockfileVersion":3,"changed":true}')
        self.deploy()
        self.assertEqual(self.calls().count('npm ci'), 3)

    def test_failed_npm_does_not_cache_hash(self):
        (self.hosts / 's1/fail-npm').touch()
        self.assertNotEqual(self.deploy(check=False).returncode, 0)
        self.assertFalse((self.work / '.isutools/lockhash.app').exists())

    def test_copies_config_without_debian_cnf(self):
        self.deploy()
        etc = self.hosts / 's1/etc'
        for path in ['mysql/my.cnf', 'nginx/conf.d/isutools-log.conf', 'systemd/system/isuapp-node.service.d/isutools.conf']:
            self.assertTrue((etc / path).is_file())
        self.assertFalse((etc / 'mysql/debian.cnf').exists())

    def test_restarts_only_enabled_services(self):
        write(self.hosts / 's1/enabled', 'nginx\nisuapp-node.service\n')
        self.deploy()
        self.assertIn('systemctl daemon-reload', self.calls())
        self.assertIn('systemctl restart nginx', self.calls())
        self.assertIn('systemctl restart isuapp-node.service', self.calls())
        self.assertNotIn('systemctl restart mysql', self.calls())

    def test_respects_manual_profiling_service_state(self):
        self.deploy()
        self.assertNotIn('systemctl restart pprotein', self.calls())
        with (self.hosts / 's1/enabled').open('a') as file:
            file.write('pprotein-agent.service\npprotein.service\n')
        self.deploy()
        self.assertIn('systemctl restart pprotein-agent.service', self.calls())
        self.assertIn('systemctl restart pprotein.service', self.calls())
        self.assertNotIn('systemctl enable', self.calls())
        self.assertNotIn('systemctl disable', self.calls())

    def test_truncates_logs(self):
        self.deploy()
        self.assertEqual((self.logs / 'nginx/access.log').stat().st_size, 0)
        self.assertEqual((self.logs / 'mysql/slow.log').stat().st_size, 0)

    def test_first_boot_without_logs_env_or_record(self):
        (self.logs / 'nginx/access.log').unlink()
        (self.logs / 'mysql/slow.log').unlink()
        self.assertIn('status=ok', self.deploy().stdout)

    def test_copies_env_files(self):
        write(self.work / 's1/home/isucon/env.sh', 'ISUCON_DB_HOST=127.0.0.1\n')
        self.deploy()
        self.assertEqual((self.work / 'env.sh').read_text(), 'ISUCON_DB_HOST=127.0.0.1\n')

    def test_nginx_failure_prevents_restart(self):
        (self.hosts / 's1/fail-nginx').touch()
        result = self.deploy(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('status=ng', result.stdout)
        self.assertIn('step=nginx-test', result.stdout)
        self.assertNotIn('systemctl restart', self.calls())

    def test_app_health_failure(self):
        write(self.hosts / 's1/inactive', 'isuapp-node.service\n')
        result = self.deploy(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('step=app-health', result.stdout)
        self.assertIn('isuapp-node.service が起動していません', result.stdout)

    def test_active_app_health(self):
        self.deploy()
        self.assertIn('systemctl is-active isuapp-node.service', self.calls())

    def test_disabled_app_warns(self):
        write(self.hosts / 's1/enabled', 'mysql\nnginx\n')
        self.assertIn('isuapp-node.service はこのホストで無効です', self.deploy().stdout)

    def install_npm(self, directory):
        write(directory / 'npm', '#!' + sys.executable + '\nfrom pathlib import Path\n'
              + f'with Path({str(self.tmp / "special-npm.log")!r}).open("a") as f: f.write("ci\\n")\n')
        (directory / 'npm').chmod(0o755)

    def test_local_runtime_path(self):
        self.install_npm(self.work / 'local/node/bin')
        self.deploy()
        self.assertIn('ci', (self.tmp / 'special-npm.log').read_text())

    def test_configured_runtime_path(self):
        self.install_npm(self.tmp / 'nodebin')
        with (self.work / 'isutools/config.env').open('a') as file:
            file.write(f'NODE_BIN_DIR={self.tmp}/nodebin\n')
        self.deploy()
        self.assertIn('ci', (self.tmp / 'special-npm.log').read_text())

    def test_build_command_runs_in_app_directory(self):
        with (self.work / 'isutools/config.env').open('a') as file:
            file.write('BUILD_CMD="pwd > build.cwd"\n')
        self.deploy()
        self.assertEqual((self.work / 'webapp/nodejs/build.cwd').read_text().strip(), str(self.work / 'webapp/nodejs'))


class RepoSyncTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.origin = self.tmp / 'origin.git'
        self.command(['git', 'init', '-q', '--bare', self.origin])
        self.seed = self.tmp / 'seed'
        self.command(['git', 'clone', '-q', self.origin, self.seed])
        write(self.seed / 'Taskfile.yml', "version: '3'\n")
        write(self.seed / 'webapp/app.js', 'console.log(1)\n')
        write(self.seed / 'isutools/x', 'x\n')
        self.git(self.seed, 'add', '-A')
        self.git(self.seed, 'commit', '-q', '-m', 'seed')
        self.git(self.seed, 'push', '-q', 'origin', 'main')
        self.work = self.host_root('s1')
        write(self.work / 'webapp/app.js', 'console.log(1)\n')
        write(self.work / 'local/bin/go', 'go binary\n')

    def sync(self, check=True):
        return self.command([sys.executable, ROOT / 'isutools/scripts/repo_sync.py', self.origin, 'main'],
                            env={'ISUTOOLS_ROOT': str(self.work)}, check=check)

    def test_imports_identical_files_and_keeps_untracked_files(self):
        self.sync()
        self.assertTrue((self.work / 'Taskfile.yml').exists())
        self.assertTrue((self.work / 'isutools/x').exists())
        self.assertTrue((self.work / 'local/bin/go').exists())
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), self.git(self.origin, 'rev-parse', 'main'))

    def test_conflicts_abort_without_overwriting_or_leaving_git(self):
        write(self.work / 'Taskfile.yml', 'server original\n')
        write(self.work / 'webapp/app.js', 'console.log(2)\n')
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Taskfile.yml', result.stdout)
        self.assertIn('webapp/app.js', result.stdout)
        self.assertEqual((self.work / 'Taskfile.yml').read_text(), 'server original\n')
        self.assertFalse((self.work / '.git').exists())

    def test_idempotent(self):
        self.sync()
        self.sync()
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), self.git(self.origin, 'rev-parse', 'main'))

    def test_managed_repo_can_switch_from_other_branch(self):
        self.sync()
        self.git(self.seed, 'switch', '-q', '-c', 'feature/x')
        write(self.seed / 'webapp/app.js', 'console.log(3)\n')
        self.git(self.seed, 'commit', '-qam', 'feature')
        self.git(self.seed, 'push', '-q', 'origin', 'feature/x')
        self.git(self.work, 'fetch', '-q', 'origin', 'feature/x')
        self.git(self.work, 'reset', '-q', '--hard', 'FETCH_HEAD')
        self.sync()
        self.assertEqual((self.work / 'webapp/app.js').read_text(), 'console.log(1)\n')

    def test_managed_repo_preserves_local_edits(self):
        self.sync()
        write(self.work / 'webapp/app.js', 'local edit\n')
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('webapp/app.js', result.stdout)
        self.assertEqual((self.work / 'webapp/app.js').read_text(), 'local edit\n')

    def test_wrong_remote_aborts(self):
        self.git(self.work, 'init', '-q')
        self.git(self.work, 'remote', 'add', 'origin', 'git@example.com:other/repo.git')
        self.assertIn('origin が想定と違います', self.sync(check=False).stdout)

    def test_parent_file_conflict_aborts_without_changing_server(self):
        shutil.rmtree(self.work / 'webapp')
        write(self.work / 'webapp', 'server original\n')
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('webapp', result.stdout)
        self.assertEqual((self.work / 'webapp').read_text(), 'server original\n')
        self.assertFalse((self.work / '.git').exists())

    def test_existing_matching_symlink_is_preserved(self):
        (self.seed / 'app-link').symlink_to('webapp/app.js')
        self.git(self.seed, 'add', 'app-link')
        self.git(self.seed, 'commit', '-qm', 'symlink')
        self.git(self.seed, 'push', '-q', 'origin', 'main')
        (self.work / 'app-link').symlink_to('webapp/app.js')
        self.sync()
        self.assertTrue((self.work / 'app-link').is_symlink())


class BootstrapImportTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.seed_origin()
        self.base = self.work / 'isutools/.bootstrap'
        for number, host in enumerate(['s1', 's2', 's3'], 1):
            write(self.base / host / 'etc/nginx/nginx.conf', 'http {\n    access_log /var/log/nginx/access.log;\n    include /etc/nginx/conf.d/*.conf;\n}\n')
            write(self.base / host / 'etc/mysql/my.cnf', '[mysqld]\n')
            write(self.base / host / 'etc/mysql/debian.cnf', '[client] password=secret\n')
            write(self.base / host / 'etc/systemd/system/isuapp-node.service', '[Service]\nEnvironmentFile=/home/isucon/env.sh\n')
            write(self.base / host / 'home/isucon/env.sh', 'ISUCON_DB_HOST=127.0.0.1\n')
            write(self.base / host / 'ip', f'10.0.0.{number}\n')
        write(self.base / 's1/webapp/nodejs/app.ts', 'app\n')
        write(self.base / 's1/webapp/nodejs/node_modules/dep/index.js', 'dep\n')
        path = self.base / 's1/webapp/sql/initial.sql'
        path.parent.mkdir(parents=True)
        with path.open('wb') as output:
            output.truncate(51 * 1024 * 1024)

    def files(self, branch='main'):
        return self.git(self.origin, 'ls-tree', '-r', '--name-only', branch)

    def test_imports_and_pushes_initial_state(self):
        self.cli('bootstrap-import')
        self.assertEqual(self.git(self.origin, 'log', '-1', '--format=%s', 'main'), 'chore: configure initial profiling')
        files = self.files()
        for name in ['webapp/nodejs/app.ts', 's2/etc/nginx/nginx.conf', 's3/etc/systemd/system/isuapp-node.service',
                     's3/etc/systemd/system/pprotein.service', 's1/home/isucon/env.sh', 'isutools/hosts.env', 'isutools/pprotein/targets.single.json']:
            self.assertIn(name, files)
        self.assertNotIn('node_modules', files)
        self.assertNotIn('debian.cnf', files)
        self.assertIn('S3_IP=10.0.0.3', (self.work / 'isutools/hosts.env').read_text())
        self.assertIn('# access_log /var/log/nginx/access.log; # disabled by isutools', (self.work / 's1/etc/nginx/nginx.conf').read_text())
        self.assertIn('PPROTEIN_URL=http://10.0.0.3:9000', (self.work / 's1/etc/systemd/system/isuapp-node.service.d/isutools.conf').read_text())

    def test_initial_commit_preserves_config_before_instrumentation(self):
        import json
        self.cli('bootstrap-import')
        metadata = json.loads((self.work / 'isutools/initial-state.json').read_text())
        initial = metadata['commit']
        self.assertEqual(metadata['phase'], 'configured')
        self.assertEqual(self.git(self.work, 'log', '-1', '--format=%s', initial), 'chore: import initial server state')
        for host in ['s1', 's2', 's3']:
            original = self.git(self.work, 'show', f'{initial}:{host}/etc/nginx/nginx.conf')
            self.assertNotIn('disabled by isutools', original)
            self.assertIn('    access_log /var/log/nginx/access.log;', original)
            self.assertEqual(self.git(self.work, 'show', f'{initial}:{host}/etc/mysql/my.cnf'), '[mysqld]')
        initial_files = self.git(self.work, 'ls-tree', '-r', '--name-only', initial)
        self.assertNotIn('isutools-log.conf', initial_files)
        self.assertNotIn('debian.cnf', initial_files)
        self.assertNotIn('node_modules', initial_files)
        self.assertNotIn('webapp/sql/initial.sql', initial_files)
        self.assertIn('webapp/nodejs/app.ts', initial_files)

    def test_resumes_after_instrumentation_failure(self):
        import json
        config = self.work / 'isutools/config.env'
        config.write_text(config.read_text() + '\nPPROTEIN_HOST=missing\n')
        result = self.cli('bootstrap-import', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git(self.work, 'log', '-1', '--format=%s'), 'chore: import initial server state')
        initial = self.git(self.work, 'rev-parse', 'HEAD')
        config.write_text(config.read_text().replace('PPROTEIN_HOST=missing\n', ''))
        self.cli('bootstrap-import')
        self.assertEqual(json.loads((self.work / 'isutools/initial-state.json').read_text())['commit'], initial)
        self.assertEqual(self.git(self.origin, 'rev-parse', 'main'), self.git(self.work, 'rev-parse', 'HEAD'))

    def test_retries_failed_push_without_creating_extra_commits(self):
        from unittest.mock import patch
        import subprocess
        from isutools.lib.bootstrap import bootstrap_import
        config = self.config()
        original = config.git
        def git(*args, **kwargs):
            if args[0] == 'push':
                raise subprocess.CalledProcessError(1, ['git', 'push'])
            return original(*args, **kwargs)
        with patch.object(config, 'git', side_effect=git):
            with self.assertRaises(subprocess.CalledProcessError):
                bootstrap_import(config)
        prepared = self.git(self.work, 'rev-parse', 'HEAD')
        self.assertNotEqual(self.git(self.origin, 'rev-parse', 'main'), prepared)
        self.cli('bootstrap-import')
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), prepared)
        self.assertEqual(self.git(self.origin, 'rev-parse', 'main'), prepared)

    def test_existing_import_without_metadata_is_left_unchanged(self):
        self.cli('bootstrap-import')
        self.git(self.work, 'rm', '-q', 'isutools/initial-state.json')
        self.git(self.work, 'commit', '-qm', 'legacy import without metadata')
        before = self.git(self.work, 'rev-parse', 'HEAD')
        self.assertIn('変更なし', self.cli('bootstrap-import').stdout)
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), before)
        self.assertFalse((self.work / 'isutools/initial-state.json').exists())

    def test_ignores_large_files_and_root_env(self):
        result = self.cli('bootstrap-import')
        self.assertIn('webapp/sql/initial.sql', result.stdout)
        ignore = (self.work / '.gitignore').read_text()
        self.assertIn('/webapp/sql/initial.sql', ignore)
        self.assertIn('/env.sh', ignore)
        self.assertNotIn('webapp/sql/initial.sql', self.files())

    def test_rerun_does_not_commit_or_duplicate_ignore(self):
        self.cli('bootstrap-import')
        before = self.git(self.origin, 'rev-parse', 'main')
        self.assertIn('変更なし', self.cli('bootstrap-import').stdout)
        self.assertEqual(before, self.git(self.origin, 'rev-parse', 'main'))
        self.assertEqual((self.work / '.gitignore').read_text().splitlines().count('/env.sh'), 1)

    def test_rejects_wrong_branch(self):
        self.git(self.work, 'switch', '-q', '-c', 'feature/x')
        result = self.cli('bootstrap-import', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('main ブランチ', result.stdout)

    def test_missing_collection_aborts(self):
        shutil.rmtree(self.base / 's2')
        result = self.cli('bootstrap-import', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('s2 の収集データがありません', result.stdout)

    def test_explicit_branch_does_not_change_main(self):
        before = self.git(self.origin, 'rev-parse', 'main')
        self.git(self.work, 'switch', '-q', '-c', 'test/bootstrap')
        self.cli('bootstrap-import', env={'BOOTSTRAP_BRANCH': 'test/bootstrap'})
        self.assertEqual(self.git(self.origin, 'rev-parse', 'main'), before)
        self.assertEqual(self.git(self.origin, 'log', '-1', '--format=%s', 'test/bootstrap'), 'chore: configure initial profiling')

    def test_explicit_branch_rejects_other_current_branch(self):
        result = self.cli('bootstrap-import', env={'BOOTSTRAP_BRANCH': 'test/bootstrap'}, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('test/bootstrap ブランチ', result.stdout)


class BootstrapOrchestrationTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.seed_origin()

    def test_uses_configured_hosts_for_ansible_and_service_start(self):
        from unittest.mock import patch
        from isutools.lib import bootstrap
        config = self.config(HOSTS='s1 s3')
        original = config.run
        seen_inventory = []
        seen_ssh = []
        def run(argv, **kwargs):
            if argv[0] == 'ansible-playbook':
                seen_inventory.append(Path(argv[2]).read_text())
                self.assertEqual(argv[-1], 'bootstrap.yml')
            elif argv[0] != 'ansible-galaxy':
                return original(argv, **kwargs)
        def ssh(host, command, **kwargs):
            seen_ssh.append((host, command))
        with patch.object(bootstrap.shutil, 'which', return_value='/bin/ansible-playbook'), \
             patch.object(config, 'run', side_effect=run), patch.object(config, 'ssh', side_effect=ssh), \
             patch.object(bootstrap, 'deploy', return_value=0) as deploy, \
             patch.object(bootstrap, 'targets', return_value=0) as targets:
            self.assertEqual(bootstrap.bootstrap(config), 0)
        self.assertEqual(seen_inventory, ['[isucon]\ns1\ns3\n'])
        self.assertEqual([host for host, _ in seen_ssh], ['s1', 's3', 's3'])
        deploy.assert_called_once()
        targets.assert_called_once()

    def test_invalid_app_service_aborts_before_ansible(self):
        from unittest.mock import patch
        from isutools.lib.bootstrap import bootstrap
        from isutools.lib.config import ToolError
        with patch('isutools.lib.bootstrap.shutil.which', return_value='/bin/ansible-playbook'):
            with self.assertRaisesRegex(ToolError, '初期値'):
                bootstrap(self.config(APP_SERVICE='isuxxx-node.service'))
