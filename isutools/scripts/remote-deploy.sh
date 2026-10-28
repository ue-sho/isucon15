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

STATE_DIR="$ISUTOOLS_ROOT/.isutools"
mkdir -p "$STATE_DIR"

step=start
build_sec=0
on_exit() {
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "ISUTOOLS_RESULT status=ok build=$build_sec step=done"
  else
    echo "ISUTOOLS_RESULT status=ng build=$build_sec step=$step"
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

step=pprotein
dropin="$ISUTOOLS_ETC/systemd/system/$APP_SERVICE.d/isutools.conf"
if grep -q '^Environment=PPROTEIN_ENABLED=1$' "$dropin" 2>/dev/null; then
  isu_sudo systemctl enable --now pprotein-agent.service
  isu_sudo systemctl restart pprotein-agent.service
  if [ "$HOST" = "$PPROTEIN_HOST" ]; then
    isu_sudo systemctl enable --now pprotein.service
    isu_sudo systemctl restart pprotein.service
  elif [ -f "$ISUTOOLS_ETC/systemd/system/pprotein.service" ]; then
    isu_sudo systemctl disable --now pprotein.service || true
  fi
else
  echo "[$HOST] 計測 off: pprotein を停止"
  isu_sudo systemctl disable --now pprotein-agent.service || true
  isu_sudo systemctl disable --now pprotein.service || true
fi

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
  echo "commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "at=$(date +%s)"
} >"$STATE_DIR/last-deploy"
