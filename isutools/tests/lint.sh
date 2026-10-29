#!/usr/bin/env bash
# isutools の lint（task test から実行）
set -euo pipefail
cd "$(dirname "$0")/../.."

# bash 3.2 は「$var（」のように変数直後の全角文字を変数名の一部として扱うため禁止する
if LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~]' isutools/lib/*.sh isutools/scripts/*.sh; then
  echo "✖ 変数の直後に全角文字があります。\${var} と書いてください" >&2
  exit 1
fi

find isutools/lib isutools/scripts isutools/tests -name '*.sh' -print0 |
  xargs -0 shellcheck -x isutools/tests/helpers/fake-ssh isutools/tests/helpers/stubs/_stub
