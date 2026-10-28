# shellcheck shell=bash
# isutools 管理ファイルを REPO_ROOT 配下に生成する。
# 前提: common.sh を source 済み、isu_load_config 済み。

# サーバ上のホームディレクトリ（生成物に埋め込むパス。手元のパスとは無関係）
SERVER_HOME=/home/isucon

shopt -u patsub_replacement 2>/dev/null || true

# _render_template <template-name> <dst> [KEY VALUE]...
_render_template() {
  local src="$ISUTOOLS_DIR/templates/$1" dst="$2"
  shift 2
  local content
  content="$(cat "$src")"
  while [ $# -ge 2 ]; do
    content="${content//@@$1@@/$2}"
    shift 2
  done
  mkdir -p "$(dirname "$dst")"
  printf '%s\n' "$content" >"$dst"
}

# host_ip <host> — hosts.env の S1_IP 等を返す
host_ip() {
  local var
  var="$(echo "$1" | tr '[:lower:]' '[:upper:]')_IP"
  echo "${!var:-}"
}

# _targets_json <mode-name> <host...>
_targets_json() {
  shift
  local first=1 h ip type
  echo "["
  for h in "$@"; do
    ip="$(host_ip "$h")"
    for type in httplog slowlog pprof; do
      [ $first -eq 1 ] || echo ","
      first=0
      case "$type" in
        httplog) printf '  {"Type": "httplog", "Label": "%s-httplog", "URL": "http://%s:19000/debug/log/httplog", "Duration": 70}' "$h" "$ip" ;;
        slowlog) printf '  {"Type": "slowlog", "Label": "%s-slowlog", "URL": "http://%s:19000/debug/log/slowlog", "Duration": 70}' "$h" "$ip" ;;
        pprof) printf '  {"Type": "pprof", "Label": "%s-pprof", "URL": "http://%s:6060/debug/pprof/profile", "Duration": 60}' "$h" "$ip" ;;
      esac
    done
  done
  printf '\n]\n'
}

# slowlog_cnf_path <host> — slow log 設定を置くパス（REPO_ROOT からの相対）
# my.cnf は conf.d/ の後に mysql.conf.d/（MariaDB は mariadb.conf.d/）を読むため、
# 既存の mysqld.cnf 等に上書きされないよう、最後に読まれるディレクトリの zz- ファイルに置く
slowlog_cnf_path() {
  local d
  for d in mariadb.conf.d mysql.conf.d; do
    if [ -d "$REPO_ROOT/$1/etc/mysql/$d" ]; then
      echo "$1/etc/mysql/$d/zz-isutools-slowlog.cnf"
      return
    fi
  done
  echo "$1/etc/mysql/conf.d/zz-isutools-slowlog.cnf"
}

# render_all — bootstrap 用の初期計測設定を生成する
render_all() {
  local pprotein_ip h
  pprotein_ip="$(host_ip "$PPROTEIN_HOST")"
  if [ -z "$pprotein_ip" ]; then
    isu_err "$PPROTEIN_HOST のプライベート IP が isutools/hosts.env にありません（task bootstrap で生成されます）"
    return 1
  fi
  for h in $HOSTS; do
    if [ -z "$(host_ip "$h")" ]; then
      isu_err "$h のプライベート IP が isutools/hosts.env にありません"
      return 1
    fi
  done

  local access_log slowlog app_env
  access_log="access_log $NGINX_LOG isutools_ltsv;"
  slowlog="slow_query_log=1
slow_query_log_file=$SLOW_LOG
long_query_time=0"
  app_env="Environment=PPROTEIN_ENABLED=1
Environment=PPROTEIN_URL=http://$pprotein_ip:9000
Environment=\"NODE_OPTIONS=--require $SERVER_HOME/isutools/profiler/profiler.cjs\""

  for h in $HOSTS; do
    local etc="$REPO_ROOT/$h/etc"
    _render_template nginx-log.conf "$etc/nginx/conf.d/isutools-log.conf" ACCESS_LOG "$access_log"
    local cnf d
    cnf="$(slowlog_cnf_path "$h")"
    for d in conf.d mysql.conf.d mariadb.conf.d; do
      [ "$h/etc/mysql/$d/zz-isutools-slowlog.cnf" = "$cnf" ] || rm -f "$etc/mysql/$d/zz-isutools-slowlog.cnf"
    done
    _render_template mysql-slowlog.cnf "$REPO_ROOT/$cnf" SLOWLOG_SETTINGS "$slowlog"
    _render_template app-dropin.conf "$etc/systemd/system/$APP_SERVICE.d/isutools.conf" APP_ENV "$app_env"
    _render_template pprotein-agent.service "$etc/systemd/system/pprotein-agent.service" \
      NGINX_LOG "$NGINX_LOG" SLOW_LOG "$SLOW_LOG"
    if [ "$h" = "$PPROTEIN_HOST" ]; then
      _render_template pprotein.service "$etc/systemd/system/pprotein.service"
    else
      rm -f "$etc/systemd/system/pprotein.service"
    fi
  done

  mkdir -p "$ISUTOOLS_DIR/pprotein"
  # shellcheck disable=SC2086 # HOSTS は空白区切りのリスト
  _targets_json single "$(echo $HOSTS | cut -d' ' -f1)" >"$ISUTOOLS_DIR/pprotein/targets.single.json"
  # shellcheck disable=SC2086
  _targets_json split $HOSTS >"$ISUTOOLS_DIR/pprotein/targets.split.json"
}
