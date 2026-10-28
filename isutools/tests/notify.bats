#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  export REPO_ROOT="$TMP/repo"
  make_work_repo "$REPO_ROOT"
  mkdir -p "$TMP/bin"
  cat >"$TMP/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$TMP/curl.args"
[ ! -e "$TMP/curl-fail" ] || exit 22
EOF
  chmod +x "$TMP/bin/curl"
  export PATH="$TMP/bin:$PATH"
}

summ() {
  run bash -c "source \"$SRC_ROOT/isutools/lib/common.sh\"; source \"$SRC_ROOT/isutools/lib/summary.sh\"; $*"
}

@test "notify.sh no-ops without webhook" {
  run bash "$REPO_ROOT/isutools/scripts/notify.sh" "hello"
  assert_success
  [ ! -e "$TMP/curl.args" ]
}

@test "notify.sh posts escaped JSON content to webhook" {
  echo 'DISCORD_WEBHOOK_URL=https://discord.invalid/hook' >"$REPO_ROOT/.env.isutools"
  run bash "$REPO_ROOT/isutools/scripts/notify.sh" $'line1 "quoted"\nline2\\x'
  assert_success
  assert_file_contains "$TMP/curl.args" "https://discord.invalid/hook"
  body="$(grep '^{' "$TMP/curl.args")"
  run jq -r .content <<<"$body"
  assert_contains 'line1 "quoted"'
  assert_contains 'line2\x'
}

@test "notify.sh returns 0 when curl fails" {
  echo 'DISCORD_WEBHOOK_URL=https://discord.invalid/hook' >"$REPO_ROOT/.env.isutools"
  touch "$TMP/curl-fail"
  run bash "$REPO_ROOT/isutools/scripts/notify.sh" "hello"
  assert_success
  assert_contains "Discord"
}

@test "notify.sh truncates long messages" {
  echo 'DISCORD_WEBHOOK_URL=https://discord.invalid/hook' >"$REPO_ROOT/.env.isutools"
  run bash "$REPO_ROOT/isutools/scripts/notify.sh" "$(printf 'x%.0s' $(seq 1 3000))"
  assert_success
  body="$(grep '^{' "$TMP/curl.args")"
  len="$(jq -r '.content | length' <<<"$body")"
  [ "$len" -le 2000 ]
}

@test "format_summary shows failed host with step and log tail" {
  mkdir -p "$TMP/logs"
  printf 'ISUTOOLS_RESULT status=ok build=3 step=done commit=a1b2c3d\n' >"$TMP/logs/s1.log"
  printf 'nginx: [emerg] unknown directive\nISUTOOLS_RESULT status=ng build=3 step=nginx-test commit=a1b2c3d\n' >"$TMP/logs/s2.log"
  printf 'ssh: connect to host s3: Connection refused\n' >"$TMP/logs/s3.log"
  summ "format_summary main a1b2c3d 'x' '$TMP/logs' s1 s2 s3"
  assert_success
  assert_contains "  s2 ✖ failed at nginx-test"
  assert_contains "nginx: [emerg] unknown directive"
  assert_contains "  s3 ✖ 接続またはスクリプト起動に失敗"
  assert_contains "Connection refused"
  assert_contains "✖ failed on: s2 s3"
}

@test "format_summary marks host whose commit differs" {
  mkdir -p "$TMP/logs"
  printf 'ISUTOOLS_RESULT status=ok build=1 step=done commit=9999999\n' >"$TMP/logs/s1.log"
  summ "format_summary main a1b2c3d 'x' '$TMP/logs' s1"
  assert_contains "  s1 ✖ commit 9999999 (expected a1b2c3d)"
  assert_contains "✖ failed on: s1"
}
