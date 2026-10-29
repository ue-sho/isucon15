"""Generate initial profiling configuration under the repository."""
import json
import re
from .config import ToolError


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def render_all(config):
    hosts = config.hosts
    ips = {host: config.get(host.upper() + '_IP') for host in hosts}
    pprotein = config.require('PPROTEIN_HOST')
    if not ips.get(pprotein) or not all(ips.values()):
        raise ToolError('プライベート IP が isutools/hosts.env にありません（task bootstrap で生成されます）')

    def template(name, path, **values):
        content = (config.tools / 'templates' / name).read_text()
        for key, value in values.items():
            content = content.replace('@@' + key + '@@', value)
        write(path, content)

    for host in hosts:
        etc = config.root / host / 'etc'
        template('nginx-log.conf', etc / 'nginx/conf.d/isutools-log.conf',
                 ACCESS_LOG=f'access_log {config.require("NGINX_LOG")} isutools_ltsv;')
        mysql = etc / 'mysql'
        directories = ['mariadb.conf.d', 'mysql.conf.d', 'conf.d']
        selected = next((name for name in directories if (mysql / name).is_dir()), 'conf.d')
        for name in directories:
            if name != selected:
                (mysql / name / 'zz-isutools-slowlog.cnf').unlink(missing_ok=True)
        template('mysql-slowlog.cnf', mysql / selected / 'zz-isutools-slowlog.cnf',
                 SLOWLOG_SETTINGS=f'slow_query_log=1\nslow_query_log_file={config.require("SLOW_LOG")}\nlong_query_time=0')
        systemd = etc / 'systemd/system'
        template('app-dropin.conf', systemd / (config.require('APP_SERVICE') + '.d/isutools.conf'),
                 APP_ENV='Environment=PPROTEIN_ENABLED=1\n'
                 f'Environment=PPROTEIN_URL=http://{ips[pprotein]}:9000\n'
                 'Environment="NODE_OPTIONS=--require /home/isucon/isutools/profiler/profiler.cjs"')
        template('pprotein-agent.service', systemd / 'pprotein-agent.service',
                 NGINX_LOG=config.require('NGINX_LOG'), SLOW_LOG=config.require('SLOW_LOG'))
        if host == pprotein:
            template('pprotein.service', systemd / 'pprotein.service')
        else:
            (systemd / 'pprotein.service').unlink(missing_ok=True)
    for mode, targets in [('single', hosts[:1]), ('split', hosts)]:
        data = [{'Type': kind, 'Label': f'{host}-{kind}',
                 'URL': f'http://{ips[host]}:{port}{path}', 'Duration': duration}
                for host in targets for kind, port, path, duration in
                [('httplog', 19000, '/debug/log/httplog', 70),
                 ('slowlog', 19000, '/debug/log/slowlog', 70),
                 ('pprof', 6060, '/debug/pprof/profile', 60)]]
        write(config.tools / f'pprotein/targets.{mode}.json', json.dumps(data, indent=2) + '\n')


def disable_original_access_log(directory):
    main = directory / 'nginx.conf'
    if not re.search(r'^\s*include\s+/etc/nginx/conf\.d/\*\.conf;', main.read_text(), re.M):
        raise ToolError(f'{main} に include /etc/nginx/conf.d/*.conf; がありません')
    paths = [main, *directory.glob('sites-available/*'), *directory.glob('conf.d/*.conf'),
             *directory.glob('sites-enabled/*')]
    for path in paths:
        if not path.is_file() or path.is_symlink() or path.name == 'isutools-log.conf':
            continue
        text = re.sub(r'^([ \t]*)(access_log[^\n]*)', r'\1# \2 # disabled by isutools', path.read_text(), flags=re.M)
        path.write_text(text)


def find_large_files(directory, mb):
    return sorted(path.relative_to(directory) for path in directory.rglob('*')
                  if path.is_file() and not path.is_symlink() and 'node_modules' not in path.parts
                  and path.stat().st_size > mb * 1024 * 1024)
