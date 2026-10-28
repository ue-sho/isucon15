# shellcheck shell=bash
# 3台まとめてのデプロイロック。1台でも取れなければ全部解放して失敗する。
# 前提: common.sh を source 済み。

# リモートで評価されるロックディレクトリ（シングルクォートのまま送る）
# shellcheck disable=SC2016
ISU_REMOTE_LOCK='"${ISUTOOLS_ROOT:-/home/isucon}/.isutools/deploy.lock"'

# lock_owner <host> — ロック保持者（"名前 epoch"）を出力。無ければ空
lock_owner() {
  isu_ssh "$1" "cat $ISU_REMOTE_LOCK/owner 2>/dev/null || true"
}

# lock_all <owner> <host...>
lock_all() {
  local owner="$1"
  shift
  local acquired="" h q
  q="$(printf '%q' "$owner $(date +%s)")"
  for h in "$@"; do
    if isu_ssh "$h" "mkdir -p \"\$(dirname $ISU_REMOTE_LOCK)\" && mkdir $ISU_REMOTE_LOCK 2>/dev/null && echo $q > $ISU_REMOTE_LOCK/owner" 2>/dev/null; then
      acquired="$acquired $h"
      continue
    fi
    local who
    who="$(lock_owner "$h" 2>/dev/null || true)"
    if [ -n "$who" ]; then
      isu_err "$h はデプロイ中です（${who% *} が実行中）。終わるのを待つか、task unlock で解除してください"
    else
      isu_err "$h のロックを取れませんでした（ssh できない可能性があります）"
    fi
    # shellcheck disable=SC2086
    [ -z "$acquired" ] || unlock_all $acquired
    return 1
  done
}

# unlock_all <host...>
unlock_all() {
  local h
  for h in "$@"; do
    isu_ssh "$h" "rm -rf $ISU_REMOTE_LOCK" 2>/dev/null || isu_warn "$h のロック解除に失敗しました"
  done
}
