#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  export REPO_ROOT="$TMP/repo"
  make_work_repo "$REPO_ROOT"
}

@test "isu_load_config reads config.env and optional .env.isutools" {
  echo 'DISCORD_WEBHOOK_URL=https://example.invalid/hook' >"$REPO_ROOT/.env.isutools"
  run bash -c 'source "$REPO_ROOT/isutools/lib/common.sh"; isu_load_config; echo "$HOSTS|$DISCORD_WEBHOOK_URL"'
  assert_success
  assert_contains "s1 s2 s3|https://example.invalid/hook"
}

@test "isu_load_config works without .env.isutools" {
  run bash -c 'source "$REPO_ROOT/isutools/lib/common.sh"; isu_load_config; echo "hosts=$HOSTS webhook=${DISCORD_WEBHOOK_URL:-}"'
  assert_success
  assert_contains "hosts=s1 s2 s3 webhook="
}
