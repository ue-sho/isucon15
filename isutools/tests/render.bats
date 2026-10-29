#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  export REPO_ROOT="$TMP/repo"
  make_work_repo "$REPO_ROOT"
  printf 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n' >"$REPO_ROOT/isutools/hosts.env"
  sed 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' "$SRC_ROOT/isutools/config.env" >"$REPO_ROOT/isutools/config.env"
}

render() {
  run bash -c "source \"$REPO_ROOT/isutools/lib/common.sh\"; source \"$REPO_ROOT/isutools/lib/render.sh\"; isu_load_config; ${*}"
}

dropin() { echo "$REPO_ROOT/$1/etc/systemd/system/isuapp-node.service.d/isutools.conf"; }

@test "render on writes slow log with long_query_time=0 for all hosts" {
  render "render_all"
  assert_success
  for h in s1 s2 s3; do
    f="$REPO_ROOT/$h/etc/mysql/conf.d/zz-isutools-slowlog.cnf"
    assert_file_contains "$f" "[mysqld]"
    assert_file_contains "$f" "slow_query_log=1"
    assert_file_contains "$f" "long_query_time=0"
    assert_file_contains "$f" "slow_query_log_file=/var/log/mysql/mysql-slow.log"
    assert_file_contains "$REPO_ROOT/$h/etc/nginx/conf.d/isutools-log.conf" "access_log /var/log/nginx/access.log isutools_ltsv;"
    assert_file_contains "$(dropin "$h")" "PPROTEIN_ENABLED=1"
    assert_file_contains "$(dropin "$h")" 'Environment="NODE_OPTIONS=--require /home/isucon/isutools/profiler/profiler.cjs"'
    assert_file_contains "$REPO_ROOT/$h/etc/systemd/system/pprotein-agent.service" "PPROTEIN_HTTPLOG=/var/log/nginx/access.log"
    assert_file_contains "$REPO_ROOT/$h/etc/systemd/system/pprotein-agent.service" "SupplementaryGroups=adm mysql"
  done
}

@test "pprotein.service is rendered only on PPROTEIN_HOST" {
  render "render_all"
  assert_success
  [ -f "$REPO_ROOT/s3/etc/systemd/system/pprotein.service" ]
  [ ! -e "$REPO_ROOT/s1/etc/systemd/system/pprotein.service" ]
  [ ! -e "$REPO_ROOT/s2/etc/systemd/system/pprotein.service" ]

  render "PPROTEIN_HOST=s2 render_all"
  assert_success
  [ -f "$REPO_ROOT/s2/etc/systemd/system/pprotein.service" ]
  [ ! -e "$REPO_ROOT/s3/etc/systemd/system/pprotein.service" ]
}

@test "PPROTEIN_URL uses private IP of PPROTEIN_HOST" {
  render "render_all"
  assert_success
  assert_file_contains "$(dropin s1)" "PPROTEIN_URL=http://10.0.0.3:9000"
}

@test "targets json: single has 3, split has 9, all valid JSON" {
  render "render_all"
  assert_success
  run jq length "$REPO_ROOT/isutools/pprotein/targets.single.json"
  [ "$output" = 3 ]
  run jq length "$REPO_ROOT/isutools/pprotein/targets.split.json"
  [ "$output" = 9 ]
  run jq -r '.[] | "\(.Type) \(.Label) \(.URL) \(.Duration)"' "$REPO_ROOT/isutools/pprotein/targets.single.json"
  assert_contains "httplog s1-httplog http://10.0.0.1:19000/debug/log/httplog 70"
  assert_contains "slowlog s1-slowlog http://10.0.0.1:19000/debug/log/slowlog 70"
  assert_contains "pprof s1-pprof http://10.0.0.1:6060/debug/pprof/profile 60"
  run jq -r '.[].Label' "$REPO_ROOT/isutools/pprotein/targets.split.json"
  assert_contains "s3-slowlog"
}

@test "render fails when IP of PPROTEIN_HOST is unknown" {
  rm "$REPO_ROOT/isutools/hosts.env"
  render "render_all"
  assert_failure
  assert_contains "hosts.env"
}

@test "slow log cnf goes to mysql.conf.d when present (read after conf.d)" {
  mkdir -p "$REPO_ROOT/s1/etc/mysql/mysql.conf.d" "$REPO_ROOT/s2/etc/mysql/mariadb.conf.d"
  render "render_all"
  assert_success
  assert_file_contains "$REPO_ROOT/s1/etc/mysql/mysql.conf.d/zz-isutools-slowlog.cnf" "long_query_time=0"
  assert_file_contains "$REPO_ROOT/s2/etc/mysql/mariadb.conf.d/zz-isutools-slowlog.cnf" "long_query_time=0"
  assert_file_contains "$REPO_ROOT/s3/etc/mysql/conf.d/zz-isutools-slowlog.cnf" "long_query_time=0"
  [ ! -e "$REPO_ROOT/s1/etc/mysql/conf.d/zz-isutools-slowlog.cnf" ]
}
