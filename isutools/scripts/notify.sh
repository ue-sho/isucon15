#!/usr/bin/env bash
# Discord Webhook に通知する。未設定・失敗でも常に exit 0（デプロイの成否に影響させない）。
#   usage: notify.sh <text>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
isu_load_config

[ -n "${DISCORD_WEBHOOK_URL:-}" ] || exit 0

text="$1"
max=1800

# 行単位で切り詰める（マルチバイト文字の途中で切らないため）
content=""
truncated=0
while IFS= read -r line || [ -n "$line" ]; do
  candidate="$content$line"$'\n'
  if [ "$(printf '%s' "$candidate" | LC_ALL=C wc -c | tr -d ' ')" -gt "$max" ]; then
    if [ -z "$content" ]; then
      content="$(printf '%s' "$line" | LC_ALL=C cut -b "1-$max")"$'\n'
    fi
    truncated=1
    break
  fi
  content="$candidate"
done <<<"$text"
[ $truncated -eq 0 ] || content="${content}...(truncated)"$'\n'

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

body="{\"content\": \"$(json_escape '```'$'\n'"$content"'```')\"}"

if ! curl -fsS -m 5 -H 'Content-Type: application/json' -d "$body" "$DISCORD_WEBHOOK_URL" >/dev/null 2>&1; then
  isu_warn "Discord への通知に失敗しました（デプロイ自体には影響しません）"
fi
exit 0
