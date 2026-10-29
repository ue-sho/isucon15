#!/usr/bin/env python3
"""Standalone bootstrap script: sync an existing home without overwriting local edits."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def sync(root, remote, branch):
    def git(*args, check=True):
        return subprocess.run(['git', *args], cwd=root, text=True, capture_output=True, check=check)

    created = not (root / '.git').exists()
    if created:
        git('init', '-q')
        git('remote', 'add', 'origin', remote)
    elif git('remote', 'get-url', 'origin', check=False).stdout.strip() != remote:
        raise RuntimeError(f'{root} の origin が想定と違います（想定: {remote}）')
    try:
        if git('fetch', '-q', 'origin', branch, check=False).returncode:
            raise RuntimeError(f'origin から {branch} を取得できません（ForwardAgent と GitHub の権限を確認）')
        tree = git('ls-tree', '-rz', 'FETCH_HEAD').stdout.split('\0')
        entries = {}
        for entry in filter(None, tree):
            metadata, path = entry.split('\t', 1)
            entries[path] = metadata.split()[-1]
        if git('rev-parse', '-q', '--verify', 'HEAD', check=False).returncode == 0:
            candidates = set(git('diff', '--name-only', '-z', 'HEAD').stdout.split('\0'))
            candidates.update(git('ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0'))
        else:
            candidates = entries.keys()
        conflicts = []
        for name in sorted(set(candidates) & entries.keys()):
            path = root / name
            blocked = [parent for parent in path.parents if parent != root and root in parent.parents
                       and (parent.is_symlink() or (parent.exists() and not parent.is_dir()))]
            if blocked:
                conflicts.append(str(blocked[-1].relative_to(root)))
                continue
            if not path.exists() and not path.is_symlink():
                continue
            # Git symlinks store their target text, not the referred file contents.
            if path.is_symlink():
                actual = subprocess.run(['git', 'hash-object', '--stdin'], input=os.readlink(path),
                                        cwd=root, capture_output=True, text=True, check=True).stdout.strip()
            elif path.is_file():
                actual = git('hash-object', '--', name).stdout.strip()
            else:
                actual = None
            if actual != entries[name]:
                conflicts.append(name)
        if conflicts:
            raise RuntimeError('次のファイルがリポジトリの内容と衝突しています（何も変更していません）:\n    '
                               + '\n    '.join(conflicts) + '\n退避するかリポジトリ側に取り込んでください')
        git('reset', '-q', '--hard', 'FETCH_HEAD')
    except BaseException:
        if created:
            shutil.rmtree(root / '.git')
        raise
    print(f'▶ {root} を origin/{branch} ({git("rev-parse", "--short=7", "HEAD").stdout.strip()}) に合わせました')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(sync(Path(os.environ.get('ISUTOOLS_ROOT', '/home/isucon')), *sys.argv[1:]))
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'✖ {error}', file=sys.stderr)
        sys.exit(1)
