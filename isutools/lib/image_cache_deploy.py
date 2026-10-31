"""Coordinated Redis deployment. Secrets travel over SSH stdin, never argv/logs."""
import ipaddress
import json
import re
import shlex
import shutil
import sys

from .config import ToolError

MANIFEST = 'isutools/image-cache-deploy.json'
SERVICE = 'isureal-image-redis.service'


def validate(plan, hosts):
    if set(plan['services']) != set(hosts) or plan['redis_host'] not in hosts:
        raise ToolError('画像キャッシュの対象とHOSTSが一致しません')
    ipaddress.ip_address(plan['redis_address'])
    if not isinstance(plan['redis_port'], int) or not 1024 <= plan['redis_port'] <= 65535:
        raise ToolError('画像Redisのポートが不正です')
    for services in plan['services'].values():
        if not services or any(not re.fullmatch(r'isureal-nodejs(?:-[a-z]+)?\.service', name) for name in services):
            raise ToolError('画像キャッシュのAPIサービス指定が不正です')
        for service in services:
            port = plan['ports'].get(service)
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                raise ToolError('画像キャッシュのAPIポート指定が不正です')
    if not isinstance(plan['cache_reads'], bool):
        raise ToolError('画像キャッシュのcache_readsにはJSONのbooleanを指定してください')
    return plan


def target_plan(config, revision):
    result = config.git('show', f'{revision}:{MANIFEST}', check=False)
    return validate(json.loads(result.stdout), config.hosts) if result.returncode == 0 else None


def deploy(config, plan, revision, branch, owner, directory):
    """Called with all deployment locks held. Never starts APIs after a failure."""
    def remote(host, phase, *, payload=None, check=True):
        command = ('cd "${ISUTOOLS_ROOT:-/home/isucon}" && '
                   f'DEPLOYER={shlex.quote(owner)} DEPLOY_BRANCH={shlex.quote(branch)} '
                   f'python3 -m isutools image-cache-phase {shlex.quote(host)} {phase}')
        result = config.ssh(host, command, input=payload, check=False)
        if check and result.returncode:
            raise ToolError(f'{host}: 画像キャッシュの {phase} に失敗。APIを停止したまま確認してください')
        return result

    try:
        # Check out exactly the selected revision everywhere before stopping APIs.
        for host in config.hosts:
            command = ('cd "${ISUTOOLS_ROOT:-/home/isucon}" && '
                       f'git fetch --quiet origin {revision} && git reset --quiet --hard {revision}')
            if config.ssh(host, command, check=False).returncode:
                raise ToolError(f'{host}: checkout失敗。画像キャッシュの適用を中断しました')
        for host in config.hosts:
            remote(host, 'stop')
        provider = plan['redis_host']
        remote(provider, 'install')
        # Only this captured result contains a secret; do not persist or print it.
        password = remote(provider, 'secret').stdout.strip()
        if not re.fullmatch(r'[0-9a-f]{64}', password):
            raise ToolError('Redis認証情報を取得できませんでした（内容は非表示）')
        for host in config.hosts:
            remote(host, 'credentials', payload=json.dumps({'password': password}))
        logs = {}
        for host in config.hosts:
            command = ('cd "${ISUTOOLS_ROOT:-/home/isucon}" && '
                       f'DEPLOYER={shlex.quote(owner)} DEPLOY_BRANCH={shlex.quote(branch)} '
                       f'ISUTOOLS_IMAGE_CACHE_COORDINATED=1 python3 -m isutools remote-deploy {shlex.quote(host)}')
            result = config.ssh(host, command, check=False)
            (directory / f'{host}.log').write_text(result.stdout)
            if result.returncode:
                raise ToolError(f'{host}: 設定反映に失敗。ログ: {directory / (host + ".log")}')
            logs[host] = result.stdout
        remote(provider, 'prepare')
        for host in config.hosts:
            remote(host, 'check')
        for host in config.hosts:
            remote(host, 'start')
        for host in config.hosts:
            remote(host, 'record')
        return logs
    except BaseException:
        (directory / 'image-cache-failed').write_text('API restart was not completed; inspect sanitized host logs.\n')
        # A partial start must not leave a mixed cluster accepting writes.
        for host in config.hosts:
            remote(host, 'stop', check=False)
        raise


# Runs as root on a target. Protected files are atomically replaced, not echoed.
WRITE_CREDENTIALS = r'''
import grp,json,os,pathlib,tempfile,sys
base=pathlib.Path(sys.argv[1]); provider=sys.argv[2]=='1'
payload=json.load(sys.stdin)
base.mkdir(parents=True,exist_ok=True); os.chmod(base,0o755)
def write(name,text,group):
    fd,path=tempfile.mkstemp(dir=base)
    try:
        os.fchmod(fd,0o640); os.fchown(fd,0,grp.getgrnam(group).gr_gid)
        with os.fdopen(fd,'w') as f: f.write(text); f.flush(); os.fsync(f.fileno())
        os.replace(path,base/name)
        directory=os.open(base,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(path): os.unlink(path)
write('client.env',payload['client'],'isucon')
if provider: write('auth.conf','requirepass '+payload['password']+'\n','redis')
'''

READ_SECRET = r'''
import os,pathlib,secrets,stat,sys
base=pathlib.Path(sys.argv[1]); base.mkdir(parents=True,exist_ok=True); os.chmod(base,0o755)
path=base/'deploy.secret'
try:
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError: pass
else:
    with os.fdopen(fd,'w') as f: f.write(secrets.token_hex(32)+'\n'); f.flush(); os.fsync(f.fileno())
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd) as f:
    info=os.fstat(f.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077: raise RuntimeError('unsafe secret file')
    sys.stdout.write(f.read())
'''


def remote_phase(config, host, phase):
    plan = validate(json.loads((config.root / MANIFEST).read_text()), config.hosts)
    services = plan['services'][host]
    provider = host == plan['redis_host']
    base = config.etc / 'isureal-image-redis'
    if phase == 'stop':
        # Prevent a reboot or manual start from reviving a partially deployed API.
        config.sudo('install', '-d', '-m', '0755', base)
        config.sudo('touch', base / 'deploy-in-progress')
        config.sudo('systemctl', 'stop', *services)
    elif phase == 'install':
        if not provider:
            raise ToolError('Redisの導入対象が不正です')
        if not shutil.which('redis-server', path=config.get('PATH')):
            config.sudo('env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l', 'apt-get', 'update', capture=True)
            config.sudo('env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l', 'apt-get', 'install', '-y', '--no-install-recommends', 'redis-server', 'redis-tools', capture=True)
            # Only the default service just installed by us; never stop a pre-existing Redis.
            config.sudo('systemctl', 'disable', '--now', 'redis-server.service')
    elif phase == 'secret':
        if not provider:
            raise ToolError('Redis認証情報の取得対象が不正です')
        result = config.sudo('python3', '-c', READ_SECRET, base, capture=True, check=False)
        if result.returncode or not re.fullmatch(r'[0-9a-f]{64}\n?', result.stdout):
            raise ToolError('Redis認証情報の準備に失敗（内容は非表示）')
        sys.stdout.write(result.stdout)
    elif phase == 'credentials':
        password = json.loads(sys.stdin.read(4096))['password']
        if not re.fullmatch(r'[0-9a-f]{64}', password):
            raise ToolError('Redis認証情報が不正です（内容は非表示）')
        address = '127.0.0.1' if provider else plan['redis_address']
        client = (f'ISUREAL_IMAGE_AUTH_REDIS_URL=redis://:{password}@{address}:{plan["redis_port"]}/0\n'
                  f'ISUREAL_IMAGE_AUTH_CACHE_READS={int(bool(plan["cache_reads"]))}\n')
        result = config.sudo('python3', '-c', WRITE_CREDENTIALS, base, str(int(provider)),
                             input=json.dumps({'password': password, 'client': client}), capture=True, check=False)
        if result.returncode:
            raise ToolError('Redis環境設定の配置に失敗（内容は非表示）')
    elif phase in ('prepare', 'check'):
        if phase == 'prepare' and not provider:
            raise ToolError('Redis状態更新の対象が不正です')
        # Only trusted, existing application env.sh is sourced, as in init.sh.
        app = config.root / config.require('APP_DIR')
        source = ('set -a; . "$1"; . "$2"; set +a; exec "$3" "$4" "$5"')
        script = 'prepare_image_authorization_deployment.ts' if phase == 'prepare' else 'check_image_authorization_cache.ts'
        config.run(['bash', '-ec', source, 'image-cache-prepare', str(config.server_root / 'env.sh'),
                    str(base / 'client.env'), str(config.server_root / 'local/node/bin/node'),
                    str(app / 'src' / script), '--all-writers-stopped' if phase == 'prepare' else '--check'], cwd=app, capture=True)
    elif phase == 'start':
        # Regional units are pulled in by the main unit's existing Wants=.
        config.sudo('systemctl', 'enable', config.require('APP_SERVICE'))
        config.sudo('rm', '-f', base / 'deploy-in-progress')
        config.sudo('systemctl', 'start', *services)
        for service in services:
            if config.run(['systemctl', 'is-active', service], capture=True, check=False).returncode:
                raise ToolError(f'{host}: {service} が起動していません')
            port = plan['ports'][service]
            result = config.run(['curl', '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
                                 '--connect-timeout', '1', '--max-time', '3', '--retry', '15', '--retry-delay', '1',
                                 '--retry-max-time', '20', '--retry-connrefused', f'http://127.0.0.1:{port}/api/me'], capture=True, check=False)
            if result.returncode or result.stdout.strip() != '401':
                raise ToolError(f'{host}: {service} のHTTP起動確認に失敗しました')
    elif phase == 'record':
        from .remote import record_deploy
        record_deploy(config)
    return 0


def apply_redis(config, host):
    if host != json.loads((config.root / MANIFEST).read_text())['redis_host']:
        return
    config.sudo('systemctl', 'enable', SERVICE)
    config.sudo('systemctl', 'restart', SERVICE)
    if config.run(['systemctl', 'is-active', SERVICE], capture=True, check=False).returncode:
        raise ToolError('画像Redisが起動していません')
