# shellcheck shell=bash
# デプロイ結果のサマリを整形する。
# 前提: common.sh を source 済み。

# _result_field <result-line> <key>
_result_field() {
  echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"
}

# format_summary <branch> <sha> <subject> <logdir> <host...>
# <logdir>/<host>.log の最終 ISUTOOLS_RESULT 行からホストごとの結果を出す
format_summary() {
  local branch="$1" sha="$2" logdir="$4"
  shift 4
  local failed="" h log result status build step commit
  for h in "$@"; do
    log="$logdir/$h.log"
    result="$(grep '^ISUTOOLS_RESULT ' "$log" 2>/dev/null | tail -1 || true)"
    if [ -z "$result" ]; then
      echo "  $h ✖ 接続またはスクリプト起動に失敗"
      tail -n 20 "$log" 2>/dev/null | sed 's/^/      | /'
      failed="$failed $h"
      continue
    fi
    status="$(_result_field "$result" status)"
    build="$(_result_field "$result" build)"
    step="$(_result_field "$result" step)"
    commit="$(_result_field "$result" commit)"
    if [ "$status" != ok ]; then
      echo "  $h ✖ failed at $step"
      grep -v '^ISUTOOLS_RESULT ' "$log" | tail -n 20 | sed 's/^/      | /'
      failed="$failed $h"
    elif [ "$commit" != "$sha" ]; then
      echo "  $h ✖ commit $commit (expected $sha)"
      failed="$failed $h"
    else
      echo "  $h ✔ $commit  build ${build}s  restart ok"
    fi
  done
  if [ -z "$failed" ]; then
    echo "▶ done: $branch @ $sha on all hosts"
  else
    echo "✖ failed on:$failed"
  fi
}
