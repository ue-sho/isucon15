#!/usr/bin/env bash
# デプロイロックを強制解除する（デプロイが異常終了してロックが残った場合用）。
#   usage: unlock.sh [-y]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/lock.sh
. "$SCRIPT_DIR/../lib/lock.sh"
isu_load_config

if [ "${1:-}" != "-y" ]; then
  for h in $HOSTS; do
    who="$(lock_owner "$h" 2>/dev/null || true)"
    [ -z "$who" ] || echo "  $h: ${who% *} がロック中"
  done
  printf '他のメンバーがデプロイ中でないことを確認しましたか？ [y/N] '
  read -r ans </dev/tty
  [ "$ans" = y ] || [ "$ans" = Y ] || { echo "中止しました"; exit 1; }
fi

# shellcheck disable=SC2086
unlock_all $HOSTS
isu_info "ロックを解除しました"
