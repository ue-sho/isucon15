#!/usr/bin/env bash
# サーバの /home/isucon を競技用リポジトリに合わせる（bootstrap 用、冪等）。
# リポジトリがまだ無いサーバでも動くよう、他のファイルに依存しない。
#   usage: repo-sync.sh <git_remote> <branch>
#
# 上書きすると内容が失われるファイル（リポジトリ外で作られた / サーバ上で編集された）が
# 1つでもあれば、一覧を出して何も変更せずに中断する。追跡外のファイルはそのまま残る。
set -euo pipefail

remote="$1"
branch="$2"
root="${ISUTOOLS_ROOT:-/home/isucon}"
cd "$root"

created=0
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$remote"
  created=1
else
  current="$(git remote get-url origin 2>/dev/null || true)"
  if [ "$current" != "$remote" ]; then
    echo "✖ $root の origin が想定と違います: ${current:-(なし)}（想定: ${remote}）" >&2
    exit 1
  fi
fi

abort() {
  [ $created -eq 0 ] || rm -rf .git
  exit 1
}

if ! git fetch -q origin "$branch"; then
  echo "✖ origin から $branch を取得できません（ssh の ForwardAgent と GitHub の権限を確認）" >&2
  abort
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 中身を比べる対象: 初回は既存ファイルすべて、管理済みなら未コミットの変更と追跡外ファイルだけ
if git rev-parse -q --verify HEAD >/dev/null; then
  { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u >"$tmp/candidates"
else
  git ls-tree -r --name-only FETCH_HEAD >"$tmp/candidates"
fi

: >"$tmp/conflicts"
git ls-tree -r FETCH_HEAD | while IFS=$'\t' read -r meta path; do
  grep -qxF -- "$path" "$tmp/candidates" || continue
  [ -e "$path" ] || continue
  want="${meta##* }"
  if [ ! -f "$path" ] || [ "$(git hash-object -- "$path")" != "$want" ]; then
    echo "$path" >>"$tmp/conflicts"
  fi
done

if [ -s "$tmp/conflicts" ]; then
  echo "✖ 次のファイルがリポジトリの内容と衝突しています（何も変更していません）:" >&2
  sed 's/^/    /' "$tmp/conflicts" >&2
  echo "  退避するか、リポジトリ側に取り込んでから再実行してください" >&2
  abort
fi

git reset -q --hard FETCH_HEAD
echo "▶ $root を origin/$branch ($(git rev-parse --short=7 HEAD)) に合わせました"
