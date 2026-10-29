#!/usr/bin/env bash
# サーバ側のデプロイ処理。deploy.sh が git reset した後に各ホストで実行する。
#   usage: DEPLOYER=<name> DEPLOY_BRANCH=<branch> remote-deploy.sh <host>
# 最終行に必ず `ISUTOOLS_RESULT status=ok|ng build=<秒> step=<ステップ>` を出力する。
set -euo pipefail

HOST="$1"
export REPO_ROOT="${ISUTOOLS_ROOT:-/home/isucon}"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$REPO_ROOT/isutools/lib/common.sh"
isu_load_config

# ssh 経由の非対話シェルでは ~/.bashrc の PATH 追加が効かないため、
# ISUCON がインストールした言語処理系（/home/isucon/local/*/bin）と NODE_BIN_DIR を明示的に足す
for d in "$ISUTOOLS_ROOT"/local/*/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
[ -z "${NODE_BIN_DIR:-}" ] || PATH="$NODE_BIN_DIR:$PATH"
export PATH

STATE_DIR="$ISUTOOLS_ROOT/.isutools"
mkdir -p "$STATE_DIR"

step=start
build_sec=0
on_exit() {
  local rc=$? commit
  commit="$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
  if [ $rc -eq 0 ]; then
    echo "ISUTOOLS_RESULT status=ok build=$build_sec step=done commit=$commit"
  else
    echo "ISUTOOLS_RESULT status=ng build=$build_sec step=$step commit=$commit"
  fi
}
trap on_exit EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# npm_ci_if_changed <name> <dir> — package-lock.json が前回と違えば npm ci
npm_ci_if_changed() {
  local name="$1" dir="$2" lock hash_file hash
  lock="$dir/package-lock.json"
  [ -f "$lock" ] || return 0
  hash_file="$STATE_DIR/lockhash.$name"
  hash="$(sha256 "$lock")"
  if [ "$(cat "$hash_file" 2>/dev/null || true)" = "$hash" ]; then
    echo "  $name: package-lock 変更なし（npm ci をスキップ）"
    return 0
  fi
  echo "  $name: npm ci"
  (cd "$dir" && npm ci --no-audit --no-fund)
  echo "$hash" >"$hash_file"
}

is_enabled() { systemctl is-enabled "$1" >/dev/null 2>&1; }

step=copy-etc
echo "[$HOST] /etc に設定を配置"
if [ -d "$REPO_ROOT/$HOST/etc" ]; then
  isu_sudo rsync -r --exclude=debian.cnf "$REPO_ROOT/$HOST/etc/" "$ISUTOOLS_ETC/"
fi

step=env-files
if [ -d "$REPO_ROOT/$HOST/home/isucon" ]; then
  echo "[$HOST] env ファイルを配置"
  cp -R "$REPO_ROOT/$HOST/home/isucon/." "$ISUTOOLS_ROOT/"
fi

step=build
started=$(date +%s)
npm_ci_if_changed app "$REPO_ROOT/$APP_DIR"
npm_ci_if_changed profiler "$REPO_ROOT/isutools/profiler"
if [ -n "${BUILD_CMD:-}" ]; then
  echo "[$HOST] build: $BUILD_CMD"
  (cd "$REPO_ROOT/$APP_DIR" && bash -c "$BUILD_CMD")
fi
build_sec=$(($(date +%s) - started))

step=nginx-test
if is_enabled nginx; then
  isu_sudo nginx -t
fi

step=restart
isu_sudo systemctl daemon-reload
for svc in "$DB_SERVICE" nginx "$APP_SERVICE"; do
  if is_enabled "$svc"; then
    echo "[$HOST] restart $svc"
    isu_sudo systemctl restart "$svc"
  fi
done

step=app-health
# systemctl restart は Type=simple だとプロセスがすぐ落ちても成功を返すため、少し待って生存を確認する
if is_enabled "$APP_SERVICE"; then
  sleep "${ISUTOOLS_HEALTH_WAIT:-3}"
  if ! systemctl is-active "$APP_SERVICE" >/dev/null 2>&1; then
    echo "[$HOST] $APP_SERVICE が起動していません。直近のログ:"
    isu_sudo journalctl -u "$APP_SERVICE" -n 20 --no-pager 2>/dev/null || true
    exit 1
  fi
else
  echo "[$HOST] ⚠ $APP_SERVICE はこのホストで無効です（再起動していません）"
fi

step=pprotein
# 手動で無効化した計測サービスを再開しない。
for svc in pprotein-agent.service pprotein.service; do
  if is_enabled "$svc"; then
    isu_sudo systemctl restart "$svc"
  fi
done

step=truncate
for log in "$NGINX_LOG" "$SLOW_LOG"; do
  if [ -e "$log" ]; then
    isu_sudo truncate -s 0 "$log"
    isu_sudo chmod +r "$log"
    isu_sudo chmod +rx "$(dirname "$log")"
  fi
done

step=record
{
  echo "deployer=${DEPLOYER:-unknown}"
  echo "branch=${DEPLOY_BRANCH:-unknown}"
  echo "commit=$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
  echo "at=$(date +%s)"
} >"$STATE_DIR/last-deploy"
