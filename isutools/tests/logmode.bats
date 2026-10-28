#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  W="$TMP/work"
  git init -q --bare "$TMP/origin.git"
  make_work_repo "$W"
  sed 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' "$SRC_ROOT/isutools/config.env" >"$W/isutools/config.env"
  printf 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n' >"$W/isutools/hosts.env"
  cd "$W"
  git init -q
  git remote add origin "$TMP/origin.git"
  REPO_ROOT="$W" bash -c 'source isutools/lib/common.sh; source isutools/lib/render.sh; isu_load_config; render_all on'
  git add -A && git commit -q -m initial && git push -q origin main
}

lm() { run bash "$W/isutools/scripts/logmode.sh" "$@"; }
dropin() { echo "$W/$1/etc/systemd/system/isuapp-node.service.d/isutools.conf"; }

@test "log-off commits rendered off files" {
  lm off
  assert_success
  assert_contains "task deploy で反映してください"
  [ "$(git log -1 --format=%s)" = "chore: log off" ]
  [ -z "$(git status --porcelain)" ]
  assert_file_contains "$(dropin s2)" "PPROTEIN_ENABLED=0"
  assert_file_contains "$W/s3/etc/nginx/conf.d/isutools-log.conf" "access_log off;"
}

@test "log-off twice is a no-op" {
  lm off
  before="$(git rev-parse HEAD)"
  lm off
  assert_success
  assert_contains "すでに log-off です"
  [ "$(git rev-parse HEAD)" = "$before" ]
}

@test "log-on restores NODE_OPTIONS and slow log" {
  lm off
  lm on
  assert_success
  [ "$(git log -1 --format=%s)" = "chore: log on" ]
  assert_file_contains "$(dropin s1)" "NODE_OPTIONS=--require"
  assert_file_contains "$W/s1/etc/mysql/conf.d/isutools-slowlog.cnf" "long_query_time=0"
}

@test "log-off does not push" {
  origin_before="$(git -C "$TMP/origin.git" rev-parse main)"
  lm off
  [ "$(git -C "$TMP/origin.git" rev-parse main)" = "$origin_before" ]
}

@test "log-off leaves unrelated staged changes alone" {
  echo wip >"$W/wip.txt"
  git add wip.txt
  lm off
  assert_success
  run git show --name-only --format= HEAD
  refute_contains "wip.txt"
  run git diff --cached --name-only
  assert_contains "wip.txt"
}

@test "rejects unknown mode" {
  lm maybe
  assert_failure
}
