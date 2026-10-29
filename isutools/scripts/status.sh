#!/usr/bin/env bash
# 3台それぞれの反映状態を1行ずつ表示する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
isu_load_config

# サーバ側で実行するスクリプト（stdin で送る）。引数: APP_SERVICE DB_SERVICE
# shellcheck disable=SC2016
REMOTE='
set -u
root="${ISUTOOLS_ROOT:-/home/isucon}"
cd "$root" || exit 1
state() { if systemctl is-active "$1" >/dev/null 2>&1; then echo active; else echo inactive; fi; }
commit="$(git rev-parse --short=7 HEAD 2>/dev/null || echo -)"
rec="$root/.isutools/last-deploy"
lock="-"
if [ -d "$root/.isutools/deploy.lock" ]; then
  lock="$(sed "s/ [0-9]*$//" "$root/.isutools/deploy.lock/owner" 2>/dev/null || echo "?")"
fi
svcs="app=$(state "$1") nginx=$(state nginx) db=$(state "$2") agent=$(state pprotein-agent.service) lock=$lock"
if [ -f "$rec" ]; then
  who="$(sed -n "s/^deployer=//p" "$rec")"
  br="$(sed -n "s/^branch=//p" "$rec")"
  at="$(sed -n "s/^at=//p" "$rec")"
  ago=$((($(date +%s) - ${at:-0}) / 60))
  echo "$br @ $commit  last: $who $ago min ago  $svcs"
else
  echo "(未デプロイ) @ $commit  $svcs"
fi
'

for h in $HOSTS; do
  if line="$(printf '%s' "$REMOTE" | isu_ssh "$h" "bash -s -- $(printf '%q' "$APP_SERVICE") $(printf '%q' "$DB_SERVICE")" 2>/dev/null)"; then
    echo "$h  $line"
  else
    echo "$h  ✖ unreachable"
  fi
done
