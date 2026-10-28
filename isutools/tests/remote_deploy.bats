#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  H="$FAKE_HOSTS/s1"
  R="$H/home/isucon"
  make_work_repo "$R"
  export LOGS="$TMP/logs"
  mkdir -p "$LOGS/nginx" "$LOGS/mysql"
  sed -e 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' \
    -e "s|^NGINX_LOG=.*|NGINX_LOG=$LOGS/nginx/access.log|" \
    -e "s|^SLOW_LOG=.*|SLOW_LOG=$LOGS/mysql/slow.log|" \
    "$SRC_ROOT/isutools/config.env" >"$R/isutools/config.env"
  printf 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n' >"$R/isutools/hosts.env"
  mkdir -p "$R/webapp/nodejs" "$R/s1/etc/mysql" "$R/s1/etc/nginx"
  echo '{"lockfileVersion":3}' >"$R/webapp/nodejs/package-lock.json"
  mkdir -p "$R/isutools/profiler"
  echo '{"lockfileVersion":3,"name":"profiler"}' >"$R/isutools/profiler/package-lock.json"
  echo "[client]" >"$R/s1/etc/mysql/debian.cnf"
  echo "[mysqld]" >"$R/s1/etc/mysql/my.cnf"
  echo "events {}" >"$R/s1/etc/nginx/nginx.conf"
  echo "access" >"$LOGS/nginx/access.log"
  echo "slow" >"$LOGS/mysql/slow.log"
  printf 'mysql\nnginx\nisuapp-node.service\n' >"$H/enabled"
  render_initial
}

# render を偽ホストのリポジトリ上で実行
render_initial() {
  REPO_ROOT="$R" bash -c "source \"$R/isutools/lib/common.sh\"; source \"$R/isutools/lib/render.sh\"; isu_load_config; render_all"
}

deploy() {
  run "$ISUTOOLS_SSH" "${1:-s1}" "DEPLOYER='Alice A' DEPLOY_BRANCH=feature/x bash isutools/scripts/remote-deploy.sh ${1:-s1}"
}

calls() { cat "$H/calls.log" 2>/dev/null || true; }

@test "first deploy runs npm ci and writes record" {
  deploy
  assert_success
  assert_contains "ISUTOOLS_RESULT status=ok"
  run calls
  assert_contains "npm ci"
  assert_file_contains "$R/.isutools/last-deploy" "deployer=Alice A"
  assert_file_contains "$R/.isutools/last-deploy" "branch=feature/x"
}

@test "second deploy skips npm ci when lock unchanged" {
  deploy
  deploy
  assert_success
  run grep -c "^npm ci" "$H/calls.log"
  # アプリと profiler の lock それぞれ1回ずつ
  [ "$output" = 2 ]
}

@test "copies host etc but never debian.cnf" {
  deploy
  assert_success
  [ -f "$H/etc/mysql/my.cnf" ]
  [ -f "$H/etc/nginx/conf.d/isutools-log.conf" ]
  [ -f "$H/etc/systemd/system/isuapp-node.service.d/isutools.conf" ]
  [ ! -e "$H/etc/mysql/debian.cnf" ]
}

@test "restarts only enabled services" {
  printf 'nginx\nisuapp-node.service\n' >"$H/enabled"
  deploy
  assert_success
  run calls
  assert_contains "systemctl daemon-reload"
  assert_contains "systemctl restart nginx"
  assert_contains "systemctl restart isuapp-node.service"
  refute_contains "systemctl restart mysql"
}

@test "respects manually disabled profiling services" {
  deploy
  assert_success
  run calls
  refute_contains "systemctl enable"
  refute_contains "systemctl disable"
  refute_contains "systemctl restart pprotein"
  printf 'pprotein-agent.service\npprotein.service\n' >>"$H/enabled"
  : >"$H/calls.log"
  deploy
  assert_success
  run calls
  assert_contains "systemctl restart pprotein-agent.service"
  assert_contains "systemctl restart pprotein.service"
  refute_contains "systemctl enable"
  refute_contains "systemctl disable"
}

@test "truncates logs" {
  deploy
  assert_success
  [ ! -s "$LOGS/nginx/access.log" ]
  [ ! -s "$LOGS/mysql/slow.log" ]
}

@test "works without logs, env files or record (first boot)" {
  rm -f "$LOGS/nginx/access.log" "$LOGS/mysql/slow.log"
  deploy
  assert_success
  assert_contains "status=ok"
}

@test "copies ISUCON env files from host dir" {
  mkdir -p "$R/s1/home/isucon"
  echo "ISUCON_DB_HOST=127.0.0.1" >"$R/s1/home/isucon/env.sh"
  deploy
  assert_success
  assert_file_contains "$R/env.sh" "ISUCON_DB_HOST=127.0.0.1"
}

@test "stops with status=ng step=nginx-test when nginx -t fails" {
  touch "$H/fail-nginx"
  deploy
  assert_failure
  assert_contains "ISUTOOLS_RESULT status=ng"
  assert_contains "step=nginx-test"
  run calls
  refute_contains "systemctl restart"
}

@test "fails with step=app-health when the app does not stay up after restart" {
  echo isuapp-node.service >"$H/inactive"
  deploy
  assert_failure
  assert_contains "step=app-health"
  assert_contains "isuapp-node.service が起動していません"
}

@test "passes app-health when the app is active" {
  deploy
  assert_success
  run calls
  assert_contains "systemctl is-active isuapp-node.service"
}

@test "warns when APP_SERVICE is not enabled on the host" {
  printf 'mysql\nnginx\n' >"$H/enabled"
  deploy
  assert_success
  assert_contains "isuapp-node.service はこのホストで無効です"
}

@test "puts ISUCON-installed node (/home/isucon/local/*/bin) on PATH for npm" {
  mkdir -p "$R/local/node/bin"
  printf '#!/usr/bin/env bash\necho "$*" >>"%s/local-npm.log"\n' "$TMP" >"$R/local/node/bin/npm"
  chmod +x "$R/local/node/bin/npm"
  deploy
  assert_success
  assert_file_contains "$TMP/local-npm.log" "ci"
}

@test "NODE_BIN_DIR in config is put on PATH" {
  mkdir -p "$TMP/nodebin"
  printf '#!/usr/bin/env bash\necho "$*" >>"%s/cfg-npm.log"\n' "$TMP" >"$TMP/nodebin/npm"
  chmod +x "$TMP/nodebin/npm"
  echo "NODE_BIN_DIR=$TMP/nodebin" >>"$R/isutools/config.env"
  deploy
  assert_success
  assert_file_contains "$TMP/cfg-npm.log" "ci"
}
