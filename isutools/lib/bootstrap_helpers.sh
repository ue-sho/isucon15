# shellcheck shell=bash
# bootstrap で使う小さなヘルパー群。
# 前提: common.sh を source 済み。

# disable_original_access_log <nginx_dir>
# 有効な access_log 行をコメントアウトする（冪等）。ログ出力は isutools の conf.d/isutools-log.conf に一本化する。
# server ブロックの access_log は http の設定より優先されるため、server を書きうる場所をすべて対象にする:
#   nginx.conf / sites-available/* / conf.d/*.conf（isutools-log.conf 以外）/ sites-enabled/ の実ファイル
disable_original_access_log() {
  local dir="$1" f tmp
  if ! grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf;' "$dir/nginx.conf"; then
    isu_err "$dir/nginx.conf に include /etc/nginx/conf.d/*.conf; がありません。isutools のログ設定を読み込めません"
    return 1
  fi
  for f in "$dir/nginx.conf" "$dir"/sites-available/* "$dir"/conf.d/*.conf "$dir"/sites-enabled/*; do
    [ -f "$f" ] || continue
    [ ! -L "$f" ] || continue
    [ "$(basename "$f")" != isutools-log.conf ] || continue
    tmp="$(mktemp)"
    awk '{
      if (match($0, /^[ \t]*access_log[ \t]/)) {
        indent = $0; sub(/[^ \t].*$/, "", indent)
        body = $0; sub(/^[ \t]*/, "", body)
        print indent "# " body " # disabled by isutools"
      } else {
        print
      }
    }' "$f" >"$tmp"
    cat "$tmp" >"$f"
    rm -f "$tmp"
  done
}

# find_large_files <dir> <mb> — 閾値を超えるファイルを <dir> からの相対パスで出力する
find_large_files() {
  local dir="$1" mb="$2"
  (cd "$dir" && find . -type f -size +"${mb}"M -not -path '*/node_modules/*' | sed 's|^\./||' | sort)
}
