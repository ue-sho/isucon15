#!/usr/bin/env bash
# pprotein の収集対象（targets）を切り替える。
#   usage: pprotein-targets.sh single|split
#     single: 3台とも全部入りの初期構成（s1 だけを計測）
#     split : サーバ分割後（全ホストの httplog / slowlog / pprof を計測）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/render.sh
. "$SCRIPT_DIR/../lib/render.sh"
isu_load_config

mode="${1:-}"
case "$mode" in
  single | split) ;;
  *) isu_err "mode は single か split です: ${mode}"; exit 1 ;;
esac

file="$ISUTOOLS_DIR/pprotein/targets.$mode.json"
[ -f "$file" ] || { isu_err "$file がありません（task bootstrap で生成されます）"; exit 1; }

if ! isu_ssh "$PPROTEIN_HOST" "curl -fsS -m 10 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:9000/api/group/targets" <"$file" >/dev/null; then
  isu_err "pprotein（${PPROTEIN_HOST}）への targets 登録に失敗しました。pprotein.service が動いているか task status で確認してください"
  exit 1
fi
isu_info "pprotein の targets を $mode に切り替えました"

# ベンチが叩くホストから pprotein に届くか（/initialize の collect 呼び出し用）
# shellcheck disable=SC2086
first="$(echo $HOSTS | cut -d' ' -f1)"
ip="$(host_ip "$PPROTEIN_HOST")"
if ! isu_ssh "$first" "curl -fsS -m 3 -o /dev/null http://$ip:9000/api/group/targets"; then
  isu_err "$first から pprotein（$ip:9000）に届きません。セキュリティグループ / ファイアウォールを確認してください"
  exit 1
fi
isu_info "$first から pprotein に届くことを確認しました"
