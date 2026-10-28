#!/usr/bin/env bash
# 手元から3台すべてにデプロイする。
#   usage: deploy.sh [branch]   （省略時は手元の現在ブランチ）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/preflight.sh
. "$SCRIPT_DIR/../lib/preflight.sh"
# shellcheck source=SCRIPTDIR/../lib/lock.sh
. "$SCRIPT_DIR/../lib/lock.sh"
# shellcheck source=SCRIPTDIR/../lib/summary.sh
. "$SCRIPT_DIR/../lib/summary.sh"
isu_load_config
cd "$REPO_ROOT"

branch="${1:-}"
[ -n "$branch" ] || branch="$(current_branch)"
preflight_branch "$branch"

sha="$(git rev-parse --short=7 "refs/remotes/origin/$branch")"
subject="$(git log -1 --format=%s "refs/remotes/origin/$branch")"
deployer="$(git config user.name 2>/dev/null || true)"
[ -n "$deployer" ] || deployer="${USER:-unknown}"
# shellcheck disable=SC2086
first_host="$(echo $HOSTS | cut -d' ' -f1)"

# previous_deploy — 先頭ホストのデプロイ記録を1行で返す
previous_deploy() {
  local rec who br cm at ago
  # shellcheck disable=SC2016
  rec="$(isu_ssh "$first_host" 'cat "${ISUTOOLS_ROOT:-/home/isucon}/.isutools/last-deploy" 2>/dev/null || true' 2>/dev/null || true)"
  if [ -z "$rec" ]; then
    echo "(none)"
    return
  fi
  who="$(echo "$rec" | sed -n 's/^deployer=//p')"
  br="$(echo "$rec" | sed -n 's/^branch=//p')"
  cm="$(echo "$rec" | sed -n 's/^commit=//p')"
  at="$(echo "$rec" | sed -n 's/^at=//p')"
  ago=$((($(date +%s) - ${at:-0}) / 60))
  echo "$who / $br @ $cm (${ago} min ago)"
}

header="▶ branch: $branch  ($sha \"$subject\")
▶ deployer: $deployer
▶ previous deploy: $(previous_deploy)"
echo "$header"

# shellcheck disable=SC2086
lock_all "$deployer" $HOSTS
# shellcheck disable=SC2086
trap 'unlock_all $HOSTS' EXIT

echo "▶ deploying to ${HOSTS// /, } ..."
logdir="$(mktemp -d)"
qbranch="$(printf '%q' "$branch")"
qdeployer="$(printf '%q' "$deployer")"
pids=""
for h in $HOSTS; do
  # shellcheck disable=SC2016
  isu_ssh "$h" 'cd "${ISUTOOLS_ROOT:-/home/isucon}"'" && git fetch --quiet origin $qbranch && git reset --quiet --hard FETCH_HEAD && DEPLOYER=$qdeployer DEPLOY_BRANCH=$qbranch bash isutools/scripts/remote-deploy.sh $h" \
    >"$logdir/$h.log" 2>&1 &
  pids="$pids $!"
done
for p in $pids; do
  wait "$p" || true
done

# shellcheck disable=SC2086
summary="$(format_summary "$branch" "$sha" "$subject" "$logdir" $HOSTS)"
echo "$summary"
rm -rf "$logdir"

bash "$SCRIPT_DIR/notify.sh" "$header
$summary"

case "$summary" in
  *"✖ failed on:"*) exit 1 ;;
esac
