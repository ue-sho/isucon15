#!/usr/bin/env bash
# 計測の on/off を切り替える。リポジトリ上の isutools 管理ファイルを書き換えてコミットするだけで、
# サーバへの反映は task deploy で行う（push もしない）。
#   usage: logmode.sh on|off
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/render.sh
. "$SCRIPT_DIR/../lib/render.sh"
isu_load_config
cd "$REPO_ROOT"

mode="${1:-}"
case "$mode" in
  on | off) ;;
  *) isu_err "usage: logmode.sh on|off"; exit 1 ;;
esac

if [ "$(current_mode)" = "$mode" ]; then
  isu_info "すでに log-$mode です（変更なし）"
  exit 0
fi

render_all "$mode"

# isutools 管理ファイルだけをコミットする（他の変更は巻き込まない）
paths=""
for h in $HOSTS; do
  for f in \
    "$h/etc/nginx/conf.d/isutools-log.conf" \
    "$(slowlog_cnf_path "$h")" \
    "$h/etc/systemd/system/$APP_SERVICE.d/isutools.conf" \
    "$h/etc/systemd/system/pprotein-agent.service" \
    "$h/etc/systemd/system/pprotein.service"; do
    if [ -e "$f" ] || git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      paths="$paths $f"
    fi
  done
done
paths="$paths isutools/pprotein"

# shellcheck disable=SC2086
git add -A -- $paths
# shellcheck disable=SC2086
git commit -q -m "chore: log $mode" -- $paths
isu_info "log-$mode をコミットしました（$(git rev-parse --short=7 HEAD)）"
isu_info "push して task deploy で反映してください"
