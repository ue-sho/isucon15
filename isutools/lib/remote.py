"""Operations executed on a competition server through the same Python CLI."""
import hashlib
import os
import time
from pathlib import Path
from .config import ToolError
from .render import write


def commit(config):
    result = config.git('rev-parse', '--short=7', 'HEAD', check=False)
    return result.stdout.strip() if result.returncode == 0 else 'unknown'


def remote_deploy(config, host):
    root = config.root
    state = config.server_root / '.isutools'
    state.mkdir(parents=True, exist_ok=True)
    paths = sorted(config.server_root.glob('local/*/bin'))
    for path in paths:
        config.values['PATH'] = str(path) + os.pathsep + config.get('PATH')
    if config.get('NODE_BIN_DIR'):
        config.values['PATH'] = config.get('NODE_BIN_DIR') + os.pathsep + config.get('PATH')
    step, seconds, success = 'start', 0, False

    def enabled(service):
        return config.run(['systemctl', 'is-enabled', service], capture=True, check=False).returncode == 0

    def npm(name, directory):
        lock = directory / 'package-lock.json'
        if not lock.is_file():
            return
        digest = hashlib.sha256(lock.read_bytes()).hexdigest()
        saved = state / ('lockhash.' + name)
        if saved.exists() and saved.read_text().strip() == digest:
            print(f'  {name}: package-lock 変更なし（npm ci をスキップ）')
            return
        config.run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=directory)
        write(saved, digest + '\n')

    try:
        step = 'copy-etc'
        print(f'[{host}] /etc に設定を配置', flush=True)
        etc = root / host / 'etc'
        if etc.is_dir():
            config.sudo('rsync', '-rl', '--exclude=debian.cnf', str(etc) + '/', str(config.etc) + '/')
        step = 'env-files'
        env_files = root / host / 'home/isucon'
        if env_files.is_dir():
            config.run(['rsync', '-r', str(env_files) + '/', str(config.server_root) + '/'])
        step = 'build'
        started = time.monotonic()
        npm('app', root / config.require('APP_DIR'))
        npm('profiler', config.tools / 'profiler')
        if config.get('BUILD_CMD'):
            config.run(['bash', '-c', config.get('BUILD_CMD')], cwd=root / config.require('APP_DIR'))
        seconds = int(time.monotonic() - started)
        step = 'nginx-test'
        if enabled('nginx'):
            config.sudo('nginx', '-t')
        step = 'restart'
        config.sudo('systemctl', 'daemon-reload')
        db_service = config.require('DB_SERVICE')
        if enabled(db_service):
            step = 'db-restart'
            config.sudo('systemctl', 'restart', db_service)
            step = 'db-health'
            if config.run(['systemctl', 'is-active', db_service], capture=True, check=False).returncode:
                config.sudo('journalctl', '-u', db_service, '-n', '20', '--no-pager', check=False)
                raise ToolError(f'{db_service} が起動していません')
        else:
            print(f'▶ {db_service} はこのホストで無効です（再起動していません）')
        step = 'restart'
        for service in ['nginx', config.require('APP_SERVICE')]:
            if enabled(service):
                config.sudo('systemctl', 'restart', service)
        step = 'app-health'
        service = config.require('APP_SERVICE')
        if enabled(service):
            time.sleep(float(config.get('ISUTOOLS_HEALTH_WAIT', '3')))
            if config.run(['systemctl', 'is-active', service], capture=True, check=False).returncode:
                config.sudo('journalctl', '-u', service, '-n', '20', '--no-pager', check=False)
                raise ToolError(f'{service} が起動していません')
        else:
            print(f'⚠ {service} はこのホストで無効です（再起動していません）')
        step = 'pprotein'
        for service in ['pprotein-agent.service', 'pprotein.service']:
            if enabled(service):
                config.sudo('systemctl', 'restart', service)
        if host == config.require('PPROTEIN_HOST') and enabled('pprotein.service'):
            # Type=simpleのrestart完了時点ではHTTP待受がまだ始まっていない場合がある。
            # 設定POSTは再送せず、読み取りAPIの起動待ちだけを上限付きで再試行する。
            step = 'pprotein-health'
            config.run(['curl', '-fsS', '--connect-timeout', '1', '--max-time', '2',
                        '--retry', '10', '--retry-delay', '1', '--retry-max-time', '15',
                        '--retry-connrefused', '-o', '/dev/null',
                        'http://127.0.0.1:9000/api/group/targets'], capture=True)
            step = 'pprotein-config'
            for name, endpoint in [('alp', 'httplog'), ('slp', 'slowlog')]:
                path = config.tools / 'pprotein' / (name + '.yml')
                if path.is_file():
                    config.run(['curl', '-fsS', '--max-time', '10', '-X', 'POST',
                                '-H', 'Content-Type: application/yaml', '--data-binary', '@' + str(path),
                                f'http://127.0.0.1:9000/api/{endpoint}/config'], capture=True)
        step = 'truncate'
        for key in ['NGINX_LOG', 'SLOW_LOG']:
            log = Path(config.require(key))
            if config.sudo('test', '-e', log, check=False).returncode == 0:
                # O_CREATを使うとstickyディレクトリでfs.protected_regularに拒否される。
                config.sudo('truncate', '--no-create', '-s', '0', log)
                # PostgreSQLログはpostgresグループ経由で読み、0640を維持する。
                if key == 'SLOW_LOG' and db_service.startswith('postgresql'):
                    continue
                config.sudo('chmod', '+r', log)
                config.sudo('chmod', '+rx', log.parent)
        step = 'record'
        write(state / 'last-deploy', f'deployer={config.get("DEPLOYER", "unknown")}\n'
              f'branch={config.get("DEPLOY_BRANCH", "unknown")}\ncommit={commit(config)}\nat={int(time.time())}\n')
        success = True
    finally:
        print(f'ISUTOOLS_RESULT status={"ok" if success else "ng"} build={seconds} '
              f'step={"done" if success else step} commit={commit(config)}', flush=True)
    return 0
