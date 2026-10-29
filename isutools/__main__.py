"""Unified CLI. Use the root Taskfile for day-to-day operations."""
import argparse
import signal
import subprocess
import sys

from .lib.config import Config, ToolError


def parser():
    result = argparse.ArgumentParser(prog='python3 -m isutools')
    commands = result.add_subparsers(dest='command', required=True)
    for name in ['deploy', 'bench', 'bootstrap']:
        command = commands.add_parser(name)
        command.add_argument('--branch')
    commands.add_parser('inspect', help='初期構成の調査（task inspect -- --help）')
    commands.add_parser('status')
    commands.add_parser('pprotein')
    command = commands.add_parser('unlock')
    command.add_argument('-y', '--yes', action='store_true')
    command = commands.add_parser('targets')
    command.add_argument('mode', choices=['single', 'split'])
    command = commands.add_parser('notify')
    command.add_argument('text')
    command = commands.add_parser('remote-deploy')
    command.add_argument('host')
    commands.add_parser('bootstrap-import')
    commands.add_parser('render')
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Forward inventory arguments unchanged while applying the shared environment.
    if argv and argv[0] == 'inspect':
        config = Config()
        from .scripts import initial_inventory
        return initial_inventory.main(argv[1:], default_hosts=config.hosts, environment=config.values)
    args = parser().parse_args(argv)
    config = Config()
    from .lib import controller
    if args.command in ('deploy', 'bench'):
        return controller.deploy(config, args.branch or config.get('ISUTOOLS_BRANCH') or None, args.command == 'bench')
    if args.command == 'status':
        return controller.status(config)
    if args.command == 'unlock':
        return controller.unlock(config, args.yes)
    if args.command == 'targets':
        return controller.targets(config, args.mode)
    if args.command == 'pprotein':
        return controller.pprotein(config)
    if args.command == 'notify':
        controller.notify(config, args.text)
        return 0
    if args.command == 'remote-deploy':
        from .lib.remote import remote_deploy
        return remote_deploy(config, args.host)
    if args.command in ('bootstrap', 'bootstrap-import'):
        from .lib.bootstrap import bootstrap, bootstrap_import
        return bootstrap(config, args.branch or config.get('ISUTOOLS_BRANCH') or None) if args.command == 'bootstrap' else bootstrap_import(config)
    if args.command == 'render':
        from .lib.render import render_all
        render_all(config)
    return 0


def interrupted(signum, frame):
    # Raising through the controller's finally keeps benchmark recovery behavior.
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except ToolError as error:
        print(f'✖ {error}', file=sys.stderr)
    except subprocess.CalledProcessError as error:
        print(f'✖ コマンドが失敗しました（exit {error.returncode}）: {error.cmd[0]}', file=sys.stderr)
        if error.stdout:
            print(error.stdout, file=sys.stderr)
    except OSError as error:
        print(f'✖ {error.strerror}: {error.filename or "操作対象を確認してください"}', file=sys.stderr)
    sys.exit(1)
