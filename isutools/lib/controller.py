"""Local deployment, locking, notification, and profiling commands."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser

from .config import ToolError

LOCK = '"${ISUTOOLS_ROOT:-/home/isucon}/.isutools/deploy.lock"'


def preflight(config, branch=None):
    if not branch:
        result = config.git('symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
        if result.returncode:
            raise ToolError('detached HEAD です。ブランチに切り替えてからデプロイしてください')
        branch = result.stdout.strip()
    result = config.git('fetch', '--quiet', 'origin', f'refs/heads/{branch}:refs/remotes/origin/{branch}', check=False)
    if result.returncode:
        raise ToolError(f'{branch} が origin にありません。git push -u origin {branch} してください')
    if config.git('show-ref', '--verify', '--quiet', f'refs/heads/{branch}', check=False).returncode == 0:
        ahead, behind = map(int, config.git('rev-list', '--left-right', '--count',
                                          f'refs/heads/{branch}...refs/remotes/origin/{branch}').stdout.split())
        if ahead and behind:
            raise ToolError(f'ローカルと origin が分岐しています（ローカル +{ahead} / origin +{behind}）')
        if ahead:
            raise ToolError(f'未 push のコミットが {ahead} 件あります。git push してください')
        if behind:
            raise ToolError(f'origin が {behind} コミット先行しています。pull してください')
    else:
        print(f'▶ {branch} は手元に無いため origin/{branch} を反映します')
    if config.git('status', '--porcelain').stdout:
        print('⚠ 未コミットの変更があります（反映するのは push 済みの内容だけです）', file=sys.stderr)
    revision = config.git('rev-parse', f'refs/remotes/origin/{branch}').stdout.strip()
    return branch, revision


def lock_owner(config, host):
    result = config.ssh(host, f'cat {LOCK}/owner 2>/dev/null || true', check=False)
    return result.stdout.strip() if result.returncode == 0 else ''


def unlock_all(config, hosts):
    for host in hosts:
        if config.ssh(host, f'rm -rf {LOCK}', check=False).returncode:
            print(f'⚠ {host} のロック解除に失敗しました', file=sys.stderr)


def lock_all(config, owner, hosts):
    acquired = []
    try:
        for host in hosts:
            quoted = shlex.quote(f'{owner} {int(time.time())}')
            command = f'mkdir -p "$(dirname {LOCK})" && mkdir {LOCK} 2>/dev/null && echo {quoted} > {LOCK}/owner'
            if config.ssh(host, command, check=False).returncode:
                who = lock_owner(config, host)
                if who:
                    raise ToolError(f'{host} はデプロイ中です（{who.rsplit(" ", 1)[0]} が実行中）。task unlock で解除してください')
                raise ToolError(f'{host} のロックを取れませんでした（ssh できない可能性があります）')
            acquired.append(host)
    except BaseException:
        unlock_all(config, acquired)
        raise


def format_summary(branch, sha, logs):
    lines, failed = [], []
    for host, log in logs.items():
        records = [line for line in log.splitlines() if line.startswith('ISUTOOLS_RESULT ')]
        result = dict(part.split('=', 1) for part in records[-1].split()[1:] if '=' in part) if records else {}
        if not result:
            lines.append(f'  {host} ✖ 接続またはスクリプト起動に失敗')
        elif result.get('status') != 'ok':
            lines.append(f'  {host} ✖ failed at {result.get("step", "unknown")}')
        elif result.get('commit') != sha:
            lines.append(f'  {host} ✖ commit {result.get("commit")} (expected {sha})')
        else:
            lines.append(f'  {host} ✔ {sha}  build {result.get("build", "0")}s  restart ok')
            continue
        failed.append(host)
        lines.extend('      | ' + line for line in [line for line in log.splitlines()
                                                   if not line.startswith('ISUTOOLS_RESULT ')][-20:])
    lines.append('✖ failed on: ' + ' '.join(failed) if failed else f'▶ done: {branch} @ {sha} on all hosts')
    return '\n'.join(lines), bool(failed)


def notify(config, text):
    url = config.get('DISCORD_WEBHOOK_URL')
    if not url:
        return
    # Byte budget also stays below Discord's character limit; never split UTF-8.
    encoded = text.encode('utf-8')
    content = encoded[:1800].decode('utf-8', errors='ignore')
    if len(encoded) > 1800:
        content += '\n...(truncated)'
    try:
        request = urllib.request.Request(url, data=json.dumps({'content': '```\n' + content + '\n```'}).encode(),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=5):
            pass
    except (OSError, ValueError):
        print('⚠ Discord への通知に失敗しました（処理の成否には影響しません）', file=sys.stderr)


def deploy(config, branch=None, benchmark=False):
    if benchmark:
        if not shutil.which('ansible-playbook', path=config.get('PATH')):
            raise ToolError('ansible-playbook がありません。isutools/README.md の準備手順を確認してください')
        for key in ['PORTAL_TARGET_ID', 'PORTAL_COOKIE', 'PORTAL_CSRF_TOKEN']:
            config.require(key)
        try:
            valid_target = 0 < int(config.get('PORTAL_TARGET_ID')) < 2**63
        except ValueError:
            valid_target = False
        if not valid_target:
            raise ToolError('PORTAL_TARGET_ID は正の整数IDを指定してください')
    branch, revision = preflight(config, branch)
    sha = config.git('rev-parse', '--short=7', revision).stdout.strip()
    subject = config.git('log', '-1', '--format=%s', revision).stdout.strip()
    owner = config.git('config', 'user.name', check=False).stdout.strip() or config.get('USER', 'unknown')
    hosts = config.hosts
    previous = config.ssh(hosts[0], 'cat "${ISUTOOLS_ROOT:-/home/isucon}/.isutools/last-deploy" 2>/dev/null || true', check=False)
    fields = dict(line.split('=', 1) for line in previous.stdout.splitlines() if '=' in line)
    record = '(none)'
    if fields:
        ago = (int(time.time()) - int(fields.get('at', '0'))) // 60
        record = f'{fields.get("deployer")} / {fields.get("branch")} @ {fields.get("commit")} ({ago} min ago)'
    header = f'▶ branch: {branch}  ({sha} "{subject}")\n▶ deployer: {owner}\n▶ previous deploy: {record}'
    print(header, flush=True)
    lock_all(config, owner, hosts)
    directory = None
    state = None
    try:
        directory = Path(tempfile.mkdtemp(prefix='isutools-deploy-'))
        state = directory / 'benchmark-state.json'

        def one(host):
            command = ('cd "${ISUTOOLS_ROOT:-/home/isucon}" && '
                       f'git fetch --quiet origin {revision} && git reset --quiet --hard {revision} && '
                       f'DEPLOYER={shlex.quote(owner)} DEPLOY_BRANCH={shlex.quote(branch)} '
                       f'python3 -m isutools remote-deploy {shlex.quote(host)}')
            result = config.ssh(host, command, check=False)
            (directory / f'{host}.log').write_text(result.stdout)
            return result.stdout

        with ThreadPoolExecutor(max_workers=len(hosts)) as pool:
            logs = dict(zip(hosts, pool.map(one, hosts)))
        summary, failed = format_summary(branch, sha, logs)
        print(summary, flush=True)
        notify(config, header + '\n' + summary)
        if failed:
            return 1
        if benchmark:
            env = {**config.values, 'ISUTOOLS_BENCH_STATE': str(state),
                   'ISUTOOLS_BENCH_BRANCH': branch, 'ISUTOOLS_BENCH_REV': sha}
            return config.run(['ansible-playbook', '-i', 'localhost,', 'benchmark.yml'], cwd=config.tools / 'ansible',
                              env=env, check=False).returncode
        return 0
    finally:
        if state is not None and state.exists():
            print(f'⚠ ベンチの終了を確認できないため、デプロイロックを保持します: {state}', file=sys.stderr)
            print('⚠ ポータルで終了を確認した後、task unlock で解除してください', file=sys.stderr)
        else:
            unlock_all(config, hosts)
            if directory is not None:
                shutil.rmtree(directory)


def status(config):
    # Send standalone, read-only Python so this also works before bootstrap.
    source = '''import os, pathlib, subprocess, time
root = pathlib.Path(os.environ.get('ISUTOOLS_ROOT', '/home/isucon'))
os.chdir(root)
def run(*args):
    return subprocess.run(args, capture_output=True, text=True)
def active(service):
    return 'active' if run('systemctl', 'is-active', service).returncode == 0 else 'inactive'
result = run('git', 'rev-parse', '--short=7', 'HEAD')
commit = result.stdout.strip() if result.returncode == 0 else '-'
state = root / '.isutools'
lock = state / 'deploy.lock/owner'
owner = lock.read_text().strip().rsplit(' ', 1)[0] if lock.exists() else '-'
services = f'app={active(APP)} nginx={active("nginx")} db={active(DB)} agent={active("pprotein-agent.service")} lock={owner}'
record = state / 'last-deploy'
if record.exists():
    fields = dict(line.split('=', 1) for line in record.read_text().splitlines() if '=' in line)
    ago = (int(time.time()) - int(fields.get('at', '0'))) // 60
    print(f'{fields.get("branch")} @ {commit}  last: {fields.get("deployer")} {ago} min ago  {services}')
else:
    print(f'(未デプロイ) @ {commit}  {services}')
'''
    source = f'APP={config.require("APP_SERVICE")!r}\nDB={config.require("DB_SERVICE")!r}\n' + source
    for host in config.hosts:
        result = config.ssh(host, 'python3 -', input=source, check=False)
        print(f'{host}  {result.stdout.strip() if result.returncode == 0 else "✖ unreachable"}')
    return 0


def unlock(config, yes=False):
    if not yes:
        for host in config.hosts:
            owner = lock_owner(config, host)
            if owner:
                print(f'  {host}: {owner.rsplit(" ", 1)[0]} がロック中')
        with open('/dev/tty', 'r+') as tty:
            tty.write('他のメンバーがデプロイ中でないことを確認しましたか？ [y/N] ')
            tty.flush()
            if tty.readline().strip().lower() != 'y':
                raise ToolError('中止しました')
    unlock_all(config, config.hosts)
    print('▶ ロックを解除しました')
    return 0


def targets(config, mode):
    path = config.tools / f'pprotein/targets.{mode}.json'
    if not path.exists():
        raise ToolError(f'{path} がありません（task bootstrap で生成されます）')
    command = "curl -fsS -m 10 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:9000/api/group/targets"
    if config.ssh(config.require('PPROTEIN_HOST'), command, input=path.read_text(), check=False).returncode:
        raise ToolError('pprotein への targets 登録に失敗しました。task status で確認してください')
    first = config.hosts[0]
    ip = config.require(config.get('PPROTEIN_HOST').upper() + '_IP')
    if config.ssh(first, f'curl -fsS -m 3 -o /dev/null {shlex.quote(f"http://{ip}:9000/api/group/targets")}', check=False).returncode:
        raise ToolError(f'{first} から pprotein（{ip}:9000）に届きません')
    print(f'▶ pprotein の targets を {mode} に切り替えました')
    return 0


def pprotein(config):
    print(f'▶ {config.require("PPROTEIN_HOST")}:9000 を localhost:9000 に転送します（Ctrl-C で終了）', flush=True)
    timer = threading.Timer(1, webbrowser.open, args=('http://localhost:9000',))
    timer.daemon = True
    timer.start()
    try:
        return config.run(['ssh', '-N', '-L', '9000:localhost:9000', config.get('PPROTEIN_HOST')], check=False).returncode
    finally:
        timer.cancel()
