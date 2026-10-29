"""Initial import and orchestration; server provisioning stays in Ansible."""
import json
import shlex
import shutil
import tempfile
from pathlib import Path
from .config import Config, ToolError
from .render import disable_original_access_log, find_large_files, render_all, write
from .controller import deploy, targets


def bootstrap_branch(config, branch=None):
    branch = branch or config.get('BOOTSTRAP_BRANCH', 'main')
    current = config.git('symbolic-ref', '--quiet', '--short', 'HEAD', check=False).stdout.strip()
    if current != branch:
        raise ToolError(f'bootstrap は {branch} ブランチで実行してください')
    config.values['BOOTSTRAP_BRANCH'] = branch
    return branch


def bootstrap_import(config):
    branch = bootstrap_branch(config)
    marker = config.tools / 'initial-state.json'
    tracked = config.git('show', 'HEAD:isutools/initial-state.json', check=False)
    metadata = json.loads(tracked.stdout) if tracked.returncode == 0 else {}
    imported = config.git('ls-tree', '-d', '--name-only', 'HEAD', 'webapp').stdout.strip() == 'webapp'
    if imported and metadata.get('phase') != 'imported':
        # Retry a failed push of our final commit, without changing an existing import.
        if metadata.get('phase') == 'configured' and config.git('log', '-1', '--format=%s').stdout.strip() == 'chore: configure initial profiling':
            config.git('push', '-q', 'origin', branch)
        print('▶ 初期取り込みは済んでいます（変更なし）')
        return 0

    hosts = config.hosts
    if not imported:
        base = config.tools / '.bootstrap'
        for host in hosts:
            ip = base / host / 'ip'
            if not (base / host / 'etc').is_dir() or not ip.is_file() or not ip.read_text().strip():
                raise ToolError(f'{host} の収集データがありません: {base / host}')
        if not (base / hosts[0] / 'webapp').is_dir():
            raise ToolError(f'{hosts[0]} の webapp が収集されていません')

        ignore = config.root / '.gitignore'
        patterns = ignore.read_text().splitlines() if ignore.exists() else []

        def add_ignore(pattern):
            if pattern not in patterns:
                patterns.append(pattern)

        config.run(['rsync', '-a', '--exclude=node_modules', str(base / hosts[0] / 'webapp') + '/',
                    str(config.root / 'webapp') + '/'])
        ips = []
        for host in hosts:
            destination = config.root / host
            (destination / 'etc').mkdir(parents=True, exist_ok=True)
            config.run(['rsync', '-a', '--exclude=debian.cnf', str(base / host / 'etc') + '/', str(destination / 'etc') + '/'])
            env_files = base / host / 'home/isucon'
            if env_files.is_dir() and any(env_files.iterdir()):
                (destination / 'home/isucon').mkdir(parents=True, exist_ok=True)
                config.run(['rsync', '-a', str(env_files) + '/', str(destination / 'home/isucon') + '/'])
                for path in env_files.iterdir():
                    add_ignore('/' + path.name)
            ip = ''.join((base / host / 'ip').read_text().split())
            ips.append(f'{host.upper()}_IP={shlex.quote(ip)}')
        write(config.tools / 'hosts.env', '\n'.join(ips) + '\n')
        add_ignore('debian.cnf')
        for path in find_large_files(config.root / 'webapp', int(config.require('LARGE_FILE_MB'))):
            print(f'⚠ 大きいファイルをコミット対象から除外: webapp/{path}')
            add_ignore('/webapp/' + str(path))
        write(ignore, '\n'.join(patterns) + '\n')
        write(marker, json.dumps({'phase': 'imported'}, indent=2) + '\n')
        config.git('add', '-A', '--', '.gitignore', 'webapp', *hosts, 'isutools/hosts.env', 'isutools/initial-state.json')
        if any(path.endswith('debian.cnf') for path in config.git('diff', '--cached', '--name-only').stdout.splitlines()):
            raise ToolError('debian.cnf がステージされています。中断します')
        config.git('commit', '-q', '-m', 'chore: import initial server state')

    # The first commit preserves the collected source and config before instrumentation.
    initial_commit = config.git('log', '-1', '--diff-filter=A', '--format=%H', '--', 'isutools/initial-state.json').stdout.strip()
    for host in hosts:
        nginx = config.root / host / 'etc/nginx'
        if nginx.is_dir():
            disable_original_access_log(nginx)
    render_all(Config(config.root))
    write(marker, json.dumps({'phase': 'configured', 'commit': initial_commit}, indent=2) + '\n')
    config.git('add', '-A', '--', *hosts, 'isutools/pprotein', 'isutools/initial-state.json')
    config.git('commit', '-q', '-m', 'chore: configure initial profiling')
    config.git('push', '-q', 'origin', branch)
    print(f'▶ 初期状態: {initial_commit}（isutools/initial-state.json に記録）')
    print(f'▶ 初期状態と計測設定を分けてコミットして push しました（{config.git("rev-parse", "--short=7", "HEAD").stdout.strip()}）')
    return 0


def bootstrap(config, branch=None):
    branch = bootstrap_branch(config, branch)
    if not shutil.which('ansible-playbook', path=config.get('PATH')):
        raise ToolError('ansible-playbook がありません。uv tool install ansible-core で準備してください')
    if config.require('APP_SERVICE') == 'isuxxx-node.service':
        raise ToolError('isutools/config.env の APP_SERVICE が初期値のままです')
    config.run(['ansible-galaxy', 'collection', 'install', '-r', config.tools / 'ansible/requirements.yml'])
    with tempfile.TemporaryDirectory(prefix='isutools-inventory-') as temporary:
        inventory = Path(temporary) / 'inventory.ini'
        write(inventory, '[isucon]\n' + '\n'.join(config.hosts) + '\n')
        config.run(['ansible-playbook', '-i', inventory, 'bootstrap.yml'], cwd=config.tools / 'ansible')
    if deploy(Config(config.root), branch):
        return 1
    for host in config.hosts:
        config.ssh(host, 'sudo systemctl enable --now pprotein-agent.service')
    config.ssh(config.require('PPROTEIN_HOST'), 'sudo systemctl enable --now pprotein.service')
    targets(Config(config.root), 'single')
    print('▶ bootstrap 完了。/initialize に isutools/snippets/pprotein-collect.ts を組み込んでください')
    return 0
