#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  export REPO_ROOT="$TMP/repo"
  make_work_repo "$REPO_ROOT"
  printf 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n' >"$REPO_ROOT/isutools/hosts.env"
  REPO_ROOT="$REPO_ROOT" bash -c 'source "$REPO_ROOT/isutools/lib/common.sh"; source "$REPO_ROOT/isutools/lib/render.sh"; isu_load_config; render_all'
}

pt() { run bash "$REPO_ROOT/isutools/scripts/pprotein-targets.sh" "$@"; }

@test "posts selected targets json via pprotein host" {
  pt split
  assert_success
  assert_file_contains "$FAKE_HOSTS/s3/calls.log" "http://localhost:9000/api/group/targets"
  diff "$FAKE_HOSTS/s3/curl.stdin" "$REPO_ROOT/isutools/pprotein/targets.split.json"
  assert_file_contains "$FAKE_HOSTS/s1/calls.log" "http://10.0.0.3:9000/api/group/targets"
  assert_contains "split"
}

@test "rejects unknown mode" {
  pt triple
  assert_failure
  assert_contains "single か split"
}

@test "reports unreachable pprotein from s1" {
  touch "$FAKE_HOSTS/s1/fail-curl"
  pt single
  assert_failure
  assert_contains "s1 から pprotein"
}

@test "fails when posting to pprotein fails" {
  touch "$FAKE_HOSTS/s3/fail-curl"
  pt single
  assert_failure
  assert_contains "登録に失敗"
}
