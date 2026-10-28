#!/usr/bin/env bash
# pprotein の UI を開く。pprotein のホストへポートフォワードし、ブラウザで localhost:9000 を開く。
# Ctrl-C で終了。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
isu_load_config

url=http://localhost:9000
isu_info "$PPROTEIN_HOST:9000 を localhost:9000 に転送します（Ctrl-C で終了）"
(
  sleep 1
  if command -v open >/dev/null 2>&1; then open "$url"; else xdg-open "$url" >/dev/null 2>&1 || echo "ブラウザで $url を開いてください"; fi
) &
exec ssh -N -L 9000:localhost:9000 "$PPROTEIN_HOST"
