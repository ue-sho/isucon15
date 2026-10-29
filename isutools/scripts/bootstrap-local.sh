#!/usr/bin/env bash
# bootstrap（手元側）: Ansible が isutools/.bootstrap/ に集めたサーバの初期状態を
# リポジトリに取り込み、初期コミットを main に push する。
#
# 入力: isutools/.bootstrap/<host>/{etc/nginx,etc/mysql,etc/systemd/system/<APP_SERVICE>,home/isucon/*,ip}
#       isutools/.bootstrap/s1/webapp/
# 2回目以降（すでに取り込み済み）は何もしない。取り込み後の main を上書きしないため。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/render.sh
. "$SCRIPT_DIR/../lib/render.sh"
# shellcheck source=SCRIPTDIR/../lib/bootstrap_helpers.sh
. "$SCRIPT_DIR/../lib/bootstrap_helpers.sh"
isu_load_config
cd "$REPO_ROOT"

branch="${BOOTSTRAP_BRANCH:-main}"
if [ "$(git symbolic-ref --quiet --short HEAD || true)" != "$branch" ]; then
  isu_err "bootstrap は ${branch} ブランチで実行してください"
  exit 1
fi

if git ls-tree -d --name-only HEAD webapp | grep -qx webapp; then
  isu_info "初期取り込みは済んでいます（変更なし）"
  exit 0
fi

B="$ISUTOOLS_DIR/.bootstrap"
# shellcheck disable=SC2086
first="$(echo $HOSTS | cut -d' ' -f1)"
for h in $HOSTS; do
  if [ ! -d "$B/$h/etc" ] || [ ! -s "$B/$h/ip" ]; then
    isu_err "$h の収集データがありません: ${B}/${h}（Ansible の収集が失敗している可能性があります）"
    exit 1
  fi
done
if [ ! -d "$B/$first/webapp" ]; then
  isu_err "$first の webapp が収集されていません: $B/$first/webapp"
  exit 1
fi

# gitignore_add <pattern> — 重複しないように .gitignore に追記
gitignore_add() {
  grep -qxF -- "$1" .gitignore 2>/dev/null || echo "$1" >>.gitignore
}

isu_info "webapp を取り込み（${first}）"
mkdir -p webapp
rsync -a --exclude node_modules "$B/$first/webapp/" webapp/

: >"$ISUTOOLS_DIR/hosts.env"
for h in $HOSTS; do
  isu_info "$h の設定を取り込み"
  mkdir -p "$h/etc"
  rsync -a --exclude debian.cnf "$B/$h/etc/" "$h/etc/"
  if [ -d "$B/$h/home/isucon" ] && [ -n "$(ls -A "$B/$h/home/isucon")" ]; then
    mkdir -p "$h/home/isucon"
    rsync -a "$B/$h/home/isucon/" "$h/home/isucon/"
    for f in "$B/$h/home/isucon"/*; do
      gitignore_add "/$(basename "$f")"
    done
  fi
  if [ -d "$h/etc/nginx" ]; then
    disable_original_access_log "$h/etc/nginx"
  fi
  echo "$(echo "$h" | tr '[:lower:]' '[:upper:]')_IP=$(tr -d '[:space:]' <"$B/$h/ip")" >>"$ISUTOOLS_DIR/hosts.env"
done

# hosts.env を読み直してから生成
isu_load_config
render_all

gitignore_add "debian.cnf"
large="$(find_large_files webapp "$LARGE_FILE_MB")"
if [ -n "$large" ]; then
  isu_warn "${LARGE_FILE_MB}MB を超えるファイルはコミットしません（サーバ上には残ります）:"
  echo "$large" | while IFS= read -r f; do
    echo "    webapp/$f" >&2
    gitignore_add "/webapp/$f"
  done
fi

# shellcheck disable=SC2086
git add -A -- .gitignore webapp $HOSTS isutools/hosts.env isutools/pprotein
if git diff --cached --name-only | grep -q 'debian\.cnf$'; then
  isu_err "debian.cnf がステージされています。中断します"
  exit 1
fi
if git diff --cached --quiet; then
  isu_info "変更なし"
  exit 0
fi
git commit -q -m "chore: import initial server state"
git push -q origin "$branch"
isu_info "初期状態をコミットして push しました（$(git rev-parse --short=7 HEAD)）"
