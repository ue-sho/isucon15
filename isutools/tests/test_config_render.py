import json
import os
from pathlib import Path
import tempfile
import unittest

from isutools.lib.config import Config, ToolError, read_env
from isutools.lib.render import disable_original_access_log, find_large_files, render_all, write

ROOT = Path(__file__).resolve().parents[2]


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_literals_quotes_comments_and_empty_values(self):
        path = self.root / 'config.env'
        path.write_text('A=one # comment\nB="two words"\nC=\nexport D=three\nE=\'x$y`z`\'\n')
        self.assertEqual(read_env(path), {'A': 'one', 'B': 'two words', 'C': '', 'D': 'three', 'E': 'x$y`z`'})

    def test_hashes_and_quoted_comments_remain_literal(self):
        path = self.root / 'config.env'
        path.write_text('A=token#fragment # comment\nB="# quoted value"\nC=\\#literal\n')
        self.assertEqual(read_env(path), {'A': 'token#fragment', 'B': '# quoted value', 'C': '#literal'})

    def test_invalid_lines_report_location_without_exposing_value(self):
        for value in ['BAD LINE secret', 'KEY=secret words', 'KEY="secret']:
            with self.subTest(value=value):
                path = self.root / 'config.env'
                path.write_text(value)
                with self.assertRaises(ToolError) as error:
                    read_env(path)
                self.assertIn('config.env:1:', str(error.exception))
                self.assertNotIn('secret', str(error.exception))

    def test_precedence_and_environment_override(self):
        write(self.root / 'isutools/config.env', 'A=base\nHOSTS="s1 s2"\n')
        write(self.root / 'isutools/hosts.env', 'A=hosts\nS1_IP=10.0.0.1\n')
        write(self.root / '.env.isutools', 'A=local\n')
        self.assertEqual(Config(self.root, {}).get('A'), 'local')
        config = Config(self.root, {'A': 'environment'})
        self.assertEqual(config.get('A'), 'environment')
        self.assertEqual(config.get('S1_IP'), '10.0.0.1')
        self.assertEqual(config.hosts, ['s1', 's2'])
        self.assertEqual(config.get('REPO_ROOT'), str(self.root))

    def test_missing_optional_files_and_required_values(self):
        self.assertEqual(read_env(self.root / 'missing'), {})
        with self.assertRaisesRegex(ToolError, 'HOSTS'):
            _ = Config(self.root, {}).hosts

    def test_hosts_reject_unsafe_names_and_deduplicate(self):
        self.assertEqual(Config(self.root, {'HOSTS': 's1 s1 s2'}).hosts, ['s1', 's2'])
        for value in ['', '-s1', '.', '..', 's1;touch', 's1/../s2']:
            with self.subTest(value=value), self.assertRaises(ToolError):
                _ = Config(self.root, {'HOSTS': value}).hosts


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        import shutil
        shutil.copytree(ROOT / 'isutools/templates', self.root / 'isutools/templates')
        values = read_env(ROOT / 'isutools/config.env')
        values.update(APP_SERVICE='isuapp-node.service', S1_IP='10.0.0.1', S2_IP='10.0.0.2', S3_IP='10.0.0.3')
        self.config = Config(self.root, values)

    def text(self, path):
        return (self.root / path).read_text()

    def test_render_initial_profiling_settings_for_each_host(self):
        render_all(self.config)
        for host in self.config.hosts:
            with self.subTest(host=host):
                cnf = self.text(f'{host}/etc/mysql/conf.d/zz-isutools-slowlog.cnf')
                self.assertIn('[mysqld]', cnf)
                self.assertIn('slow_query_log=1', cnf)
                self.assertIn('long_query_time=0', cnf)
                self.assertIn('slow_query_log_file=/var/log/mysql/mysql-slow.log', cnf)
                self.assertIn('access_log /var/log/nginx/access.log isutools_ltsv;', self.text(f'{host}/etc/nginx/conf.d/isutools-log.conf'))
                dropin = self.text(f'{host}/etc/systemd/system/isuapp-node.service.d/isutools.conf')
                self.assertIn('PPROTEIN_ENABLED=1', dropin)
                self.assertIn('PPROTEIN_URL=http://10.0.0.3:9000', dropin)
                self.assertIn('NODE_OPTIONS=--require /home/isucon/isutools/profiler/profiler.cjs', dropin)
                agent = self.text(f'{host}/etc/systemd/system/pprotein-agent.service')
                self.assertIn('PPROTEIN_HTTPLOG=/var/log/nginx/access.log', agent)
                self.assertIn('SupplementaryGroups=adm mysql', agent)

    def test_pprotein_service_moves_to_selected_host(self):
        render_all(self.config)
        service = 'etc/systemd/system/pprotein.service'
        self.assertTrue((self.root / 's3' / service).exists())
        self.assertFalse((self.root / 's1' / service).exists())
        self.config.values['PPROTEIN_HOST'] = 's2'
        render_all(self.config)
        self.assertTrue((self.root / 's2' / service).exists())
        self.assertFalse((self.root / 's3' / service).exists())

    def test_targets_single_and_split(self):
        render_all(self.config)
        single = json.loads(self.text('isutools/pprotein/targets.single.json'))
        split = json.loads(self.text('isutools/pprotein/targets.split.json'))
        self.assertEqual(len(single), 3)
        self.assertEqual(len(split), 9)
        self.assertEqual(single[0], {'Type': 'httplog', 'Label': 's1-httplog', 'URL': 'http://10.0.0.1:19000/debug/log/httplog', 'Duration': 70})
        self.assertEqual(single[1]['Duration'], 70)
        self.assertEqual(single[2]['URL'], 'http://10.0.0.1:6060/debug/pprof/profile')
        self.assertEqual(single[2]['Duration'], 60)
        self.assertIn('s3-slowlog', [item['Label'] for item in split])

    def test_missing_private_ip_fails_before_writing(self):
        del self.config.values['S3_IP']
        with self.assertRaisesRegex(ToolError, 'hosts.env'):
            render_all(self.config)
        self.assertFalse((self.root / 's1').exists())

    def test_slowlog_uses_last_included_directory_and_removes_stale_config(self):
        render_all(self.config)
        (self.root / 's1/etc/mysql/mysql.conf.d').mkdir()
        (self.root / 's2/etc/mysql/mariadb.conf.d').mkdir()
        render_all(self.config)
        self.assertTrue((self.root / 's1/etc/mysql/mysql.conf.d/zz-isutools-slowlog.cnf').exists())
        self.assertTrue((self.root / 's2/etc/mysql/mariadb.conf.d/zz-isutools-slowlog.cnf').exists())
        self.assertFalse((self.root / 's1/etc/mysql/conf.d/zz-isutools-slowlog.cnf').exists())

    def test_disable_access_logs_idempotently_preserves_symlinks_and_own_config(self):
        directory = self.root / 'nginx'
        write(directory / 'nginx.conf', 'http {\n  access_log /x.log;\n  error_log /err.log;\n  include /etc/nginx/conf.d/*.conf;\n}\n')
        for name in ['sites-available/app', 'sites-enabled/real', 'conf.d/app.conf']:
            write(directory / name, '  access_log /app.log;\n  # access_log /old.log;\n')
        write(directory / 'conf.d/isutools-log.conf', 'access_log /managed.log;\n')
        (directory / 'sites-enabled/app').symlink_to('../sites-available/app')
        disable_original_access_log(directory)
        once = (directory / 'nginx.conf').read_text()
        disable_original_access_log(directory)
        self.assertEqual((directory / 'nginx.conf').read_text(), once)
        self.assertIn('  # access_log /x.log; # disabled by isutools', once)
        self.assertIn('error_log /err.log;', once)
        for name in ['sites-available/app', 'sites-enabled/real', 'conf.d/app.conf']:
            self.assertIn('# access_log /app.log; # disabled by isutools', (directory / name).read_text())
            self.assertIn('  # access_log /old.log;', (directory / name).read_text())
        self.assertEqual((directory / 'conf.d/isutools-log.conf').read_text(), 'access_log /managed.log;\n')
        self.assertTrue((directory / 'sites-enabled/app').is_symlink())

    def test_disable_logs_requires_conf_d_include(self):
        write(self.root / 'nginx/nginx.conf', 'http {}\n')
        with self.assertRaisesRegex(ToolError, 'conf.d'):
            disable_original_access_log(self.root / 'nginx')

    def test_large_files_exclude_node_modules(self):
        for name, size in [('sql/big.sql', 51), ('sql/small.sql', 49), ('node_modules/dep', 60)]:
            path = self.root / 'webapp' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('wb') as stream:
                stream.truncate(size * 1024 * 1024)
        self.assertEqual(find_large_files(self.root / 'webapp', 50), [Path('sql/big.sql')])
