"""Native unittest fixtures for fake hosts and real temporary Git repositories."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from isutools.lib.config import Config
from isutools.lib.render import write

ROOT = Path(__file__).resolve().parents[2]
HELPERS = ROOT / 'isutools/tests/helpers'


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='isutools-test-')
        self.addCleanup(self.temporary.cleanup)
        self.tmp = Path(self.temporary.name)
        self.hosts = self.tmp / 'hosts'
        self.env = {key: value for key, value in os.environ.items()
                    if key in ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']}
        self.env.update(FAKE_HOSTS=str(self.hosts), ISUTOOLS_SSH=str(HELPERS / 'fake-ssh'),
                        ISUTOOLS_HEALTH_WAIT='0', GIT_CONFIG_GLOBAL=str(self.tmp / 'gitconfig'),
                        GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='tester', GIT_AUTHOR_EMAIL='tester@example.com',
                        GIT_COMMITTER_NAME='tester', GIT_COMMITTER_EMAIL='tester@example.com')
        for host in ['s1', 's2', 's3']:
            (self.hosts / host / 'home/isucon').mkdir(parents=True)
            (self.hosts / host / 'etc').mkdir()
            write(self.hosts / host / 'enabled', '')
        self.command(['git', 'config', '--global', 'init.defaultBranch', 'main'])

    def command(self, argv, *, cwd=None, check=True, env=None, input=None):
        result = subprocess.run([str(arg) for arg in argv], cwd=cwd or self.tmp,
                                env={**self.env, **(env or {})}, input=input, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if check and result.returncode:
            self.fail(f'{argv} exited {result.returncode}:\n{result.stdout}')
        return result

    def git(self, root, *args, check=True):
        return self.command(['git', '-C', root, *args], check=check).stdout.strip()

    def make_repo(self, root):
        shutil.copytree(ROOT / 'isutools', root / 'isutools', dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('tests', 'node_modules', '__pycache__', '.bootstrap', 'initial-state.json'))
        shutil.copy(ROOT / '.gitignore', root / '.gitignore')
        shutil.copy(ROOT / 'Taskfile.yml', root / 'Taskfile.yml')
        path = root / 'isutools/config.env'
        path.write_text(path.read_text() + '\nAPP_SERVICE=isuapp-node.service\nAPP_DIR=webapp/nodejs\n')
        write(root / 'isutools/hosts.env', 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n')

    def config(self, root=None, **values):
        return Config(root or self.work, {**self.env, **values})

    def cli(self, *args, root=None, env=None, check=True):
        return self.command([sys.executable, '-m', 'isutools', *args], cwd=root or self.work,
                            env=env, check=check)

    def host_root(self, host):
        return self.hosts / host / 'home/isucon'

    def lockdir(self, host):
        return self.host_root(host) / '.isutools/deploy.lock'

    def calls(self, host='s1'):
        path = self.hosts / host / 'calls.log'
        return path.read_text() if path.exists() else ''

    def seed_origin(self):
        self.origin = self.tmp / 'origin.git'
        self.command(['git', 'init', '-q', '--bare', self.origin])
        self.work = self.tmp / 'work'
        self.make_repo(self.work)
        self.git(self.work, 'init', '-q')
        self.git(self.work, 'remote', 'add', 'origin', str(self.origin))
        self.git(self.work, 'add', '-A')
        self.git(self.work, 'commit', '-q', '-m', 'initial')
        self.git(self.work, 'push', '-q', 'origin', 'main')

    def feature(self):
        self.git(self.work, 'switch', '-q', '-c', 'feature/index-rides')
        write(self.work / 'change.txt', 'change\n')
        self.git(self.work, 'add', 'change.txt')
        self.git(self.work, 'commit', '-q', '-m', 'add index to rides')
        self.git(self.work, 'push', '-q', '-u', 'origin', 'feature/index-rides')
        self.base_sha = self.git(self.work, 'rev-parse', '--short=7', 'main')
        self.new_sha = self.git(self.work, 'rev-parse', '--short=7', 'HEAD')

    def push_other(self, branch='feature/index-rides'):
        other = self.tmp / 'other'
        self.command(['git', 'clone', '-q', '--branch', branch, self.origin, other])
        self.git(other, 'commit', '-q', '--allow-empty', '-m', 'other')
        self.git(other, 'push', '-q', 'origin', branch)
        return other
