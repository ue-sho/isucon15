# shellcheck shell=bash
# isutools 共通ライブラリ。各スクリプトから source する。
# 手元（macOS の bash 3.2）とサーバ（Ubuntu）の両方で動くこと。

# サーバ上のパス（テストでは偽ホストに差し替える）
ISUTOOLS_ROOT="${ISUTOOLS_ROOT:-/home/isucon}"
ISUTOOLS_ETC="${ISUTOOLS_ETC:-/etc}"
ISUTOOLS_SUDO="${ISUTOOLS_SUDO-sudo}"

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
ISUTOOLS_DIR="$REPO_ROOT/isutools"

export ISUTOOLS_ROOT ISUTOOLS_ETC ISUTOOLS_SUDO REPO_ROOT ISUTOOLS_DIR

isu_info() { echo "▶ $*"; }
isu_warn() { echo "⚠ $*" >&2; }
isu_err() { echo "✖ $*" >&2; }

# config.env → hosts.env（あれば）→ .env.isutools（あれば）の順に読み込む
isu_load_config() {
  set -a
  # shellcheck source=/dev/null
  . "$ISUTOOLS_DIR/config.env"
  if [ -f "$ISUTOOLS_DIR/hosts.env" ]; then
    # shellcheck source=/dev/null
    . "$ISUTOOLS_DIR/hosts.env"
  fi
  if [ -f "$REPO_ROOT/.env.isutools" ]; then
    # shellcheck source=/dev/null
    . "$REPO_ROOT/.env.isutools"
  fi
  set +a
}

# isu_ssh <host> <command-string>
isu_ssh() {
  local host="$1"
  shift
  # shellcheck disable=SC2086 # ISUTOOLS_SSH はコマンド + オプションとして分割する
  ${ISUTOOLS_SSH:-ssh -A} "$host" "$@"
}

# sudo 付きで実行する（ISUTOOLS_SUDO が空なら素で実行）
isu_sudo() {
  if [ -n "$ISUTOOLS_SUDO" ]; then
    "$ISUTOOLS_SUDO" "$@"
  else
    "$@"
  fi
}
