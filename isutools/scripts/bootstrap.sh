#!/usr/bin/env bash
# 競技開始時に1人が1回だけ実行する: Ansible でセットアップ → 初回デプロイ → pprotein の targets 登録。
# 再実行しても壊れない（取り込み済みなら初期コミットは作らない）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
isu_load_config
cd "$REPO_ROOT"

if ! command -v ansible-playbook >/dev/null 2>&1; then
  isu_err "ansible-playbook がありません。uv tool install ansible-core（または brew install ansible）してください"
  exit 1
fi
if [ "$APP_SERVICE" = isuxxx-node.service ]; then
  isu_err "isutools/config.env の APP_SERVICE が初期値のままです。問題に合わせて編集・push してください"
  exit 1
fi

isu_info "Ansible collection を準備"
ansible-galaxy collection install -r "$ISUTOOLS_DIR/ansible/requirements.yml" >/dev/null

isu_info "playbook を実行"
(cd "$ISUTOOLS_DIR/ansible" && ansible-playbook bootstrap.yml)

isu_info "初回デプロイ（main）"
bash "$SCRIPT_DIR/deploy.sh" main

isu_info "pprotein の targets を登録"
bash "$SCRIPT_DIR/pprotein-targets.sh" single

isu_info "bootstrap 完了。/initialize に isutools/snippets/pprotein-collect.ts を組み込んでください"
