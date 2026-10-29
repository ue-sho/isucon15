"""Shared literal KEY=VALUE configuration; never execute configuration as shell code."""
import os
from pathlib import Path
import re
import shlex
import subprocess


class ToolError(RuntimeError):
    pass


def strip_comment(value):
    quote, escaped = None, False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == '#' and (index == 0 or value[index - 1].isspace()):
            return value[:index]
    return value


def read_env(path):
    values = {}
    if not path.exists():
        return values
    for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match:
            raise ToolError(f'{path}:{number}: KEY=VALUE で設定してください')
        key, value = match.groups()
        try:
            parts = shlex.split(strip_comment(value))
        except ValueError:
            raise ToolError(f'{path}:{number}: クォートが閉じていません') from None
        if len(parts) > 1:
            raise ToolError(f'{path}:{number}: 空白を含む値はクォートしてください')
        values[key] = parts[0] if parts else ''
    return values


class Config:
    def __init__(self, root=None, environ=None):
        environment = dict(os.environ if environ is None else environ)
        self.root = Path(root or environment.get('REPO_ROOT') or Path(__file__).resolve().parents[2]).resolve()
        self.tools = self.root / 'isutools'
        self.values = {}
        for path in (self.tools / 'config.env', self.tools / 'hosts.env', self.root / '.env.isutools'):
            self.values.update(read_env(path))
        self.values.update(environment)
        self.values['REPO_ROOT'] = str(self.root)
        self.values['ISUTOOLS_DIR'] = str(self.tools)
        self.server_root = Path(self.get('ISUTOOLS_ROOT', '/home/isucon'))
        self.etc = Path(self.get('ISUTOOLS_ETC', '/etc'))

    def get(self, key, default=''):
        return self.values.get(key, default)

    def require(self, key):
        if not self.get(key):
            raise ToolError(f'{key} を isutools/config.env、.env.isutools または環境変数に設定してください')
        return self.get(key)

    @property
    def hosts(self):
        hosts = shlex.split(self.require('HOSTS'))
        if not hosts or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', host) or host.startswith('-') or host in ('.', '..') for host in hosts):
            raise ToolError('HOSTS には SSH の Host 名を空白区切りで指定してください')
        return list(dict.fromkeys(hosts))

    def run(self, argv, *, cwd=None, check=True, capture=False, input=None, env=None):
        return subprocess.run([str(arg) for arg in argv], cwd=cwd or self.root,
                              env=self.values if env is None else env, text=True, input=input,
                              stdout=subprocess.PIPE if capture else None,
                              stderr=subprocess.STDOUT if capture else None, check=check)

    def git(self, *args, check=True):
        return self.run(['git', *args], capture=True, check=check)

    def ssh(self, host, command, *, input=None, check=True):
        return self.run([*shlex.split(self.get('ISUTOOLS_SSH', 'ssh -A')), host, command],
                        input=input, capture=True, check=check)

    def sudo(self, *argv, **kwargs):
        return self.run([*shlex.split(self.get('ISUTOOLS_SUDO', 'sudo')), *argv], **kwargs)
