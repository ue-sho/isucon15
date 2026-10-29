#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  W="$TMP/work"
  git init -q --bare "$TMP/origin.git"
  make_work_repo "$W"
  export LOGS="$TMP/logs"
  mkdir -p "$LOGS"
  sed -e 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' \
    -e "s|^NGINX_LOG=.*|NGINX_LOG=$LOGS/access.log|" \
    -e "s|^SLOW_LOG=.*|SLOW_LOG=$LOGS/slow.log|" \
    "$SRC_ROOT/isutools/config.env" >"$W/isutools/config.env"
  printf 'S1_IP=10.0.0.1\nS2_IP=10.0.0.2\nS3_IP=10.0.0.3\n' >"$W/isutools/hosts.env"
  (
    cd "$W"
    git init -q
    git remote add origin "$TMP/origin.git"
    REPO_ROOT="$W" bash -c 'source isutools/lib/common.sh; source isutools/lib/render.sh; isu_load_config; render_all'
    git add -A && git commit -q -m "initial" && git push -q origin main
  )
  for h in s1 s2 s3; do
    rm -rf "$FAKE_HOSTS/$h/home/isucon"
    git clone -q "$TMP/origin.git" "$FAKE_HOSTS/$h/home/isucon"
  done
  cd "$W"
  git switch -q -c feature/index-rides
  echo change >"$W/change.txt"
  git add change.txt && git commit -q -m "add index to rides"
  git push -q -u origin feature/index-rides 2>/dev/null
  BASE_SHA="$(git rev-parse --short=7 main)"
  NEW_SHA="$(git rev-parse --short=7 HEAD)"
}

host_sha() { git -C "$FAKE_HOSTS/$1/home/isucon" rev-parse --short=7 HEAD; }
lockdir() { echo "$FAKE_HOSTS/$1/home/isucon/.isutools/deploy.lock"; }

do_deploy() {
  run bash "$W/isutools/scripts/deploy.sh" "$@"
}

@test "deploys current branch to all hosts and prints summary" {
  do_deploy
  assert_success
  assert_contains "▶ branch: feature/index-rides  ($NEW_SHA \"add index to rides\")"
  assert_contains "▶ previous deploy: (none)"
  assert_contains "  s1 ✔ $NEW_SHA"
  assert_contains "  s2 ✔ $NEW_SHA"
  assert_contains "  s3 ✔ $NEW_SHA"
  assert_contains "▶ done: feature/index-rides @ $NEW_SHA on all hosts"
  for h in s1 s2 s3; do [ "$(host_sha "$h")" = "$NEW_SHA" ]; done
}

@test "BRANCH argument overrides current branch" {
  do_deploy main
  assert_success
  assert_contains "done: main @ $BASE_SHA"
  [ "$(host_sha s1)" = "$BASE_SHA" ]
}

@test "aborts before any reset when preflight fails" {
  git commit -q --allow-empty -m unpushed
  do_deploy
  assert_failure
  assert_contains "未 push のコミット"
  for h in s1 s2 s3; do [ "$(host_sha "$h")" = "$BASE_SHA" ]; done
}

@test "aborts without reset when a host is unreachable" {
  export FAKE_UNREACHABLE=s2
  do_deploy
  assert_failure
  for h in s1 s3; do
    [ "$(host_sha "$h")" = "$BASE_SHA" ]
    [ ! -e "$(lockdir "$h")" ]
  done
}

@test "exits 1 and shows failed host log when remote step fails" {
  echo nginx >"$FAKE_HOSTS/s2/enabled"
  touch "$FAKE_HOSTS/s2/fail-nginx"
  do_deploy
  assert_failure
  assert_contains "  s1 ✔"
  assert_contains "  s2 ✖ failed at nginx-test"
  assert_contains "injected failure"
  assert_contains "✖ failed on: s2"
}

@test "releases locks after success and after failure" {
  do_deploy
  for h in s1 s2 s3; do [ ! -e "$(lockdir "$h")" ]; done
  touch "$FAKE_HOSTS/s1/fail-npm"
  echo '{}' >"$W/isutools/profiler/package-lock.json"
  git add -A && git commit -q -m lock && git push -q
  do_deploy
  assert_failure
  for h in s1 s2 s3; do [ ! -e "$(lockdir "$h")" ]; done
}

@test "shows previous deployer" {
  git config user.name "Alice A"
  do_deploy
  assert_success
  git config user.name "Bob"
  do_deploy
  assert_success
  assert_contains "▶ deployer: Bob"
  assert_contains "▶ previous deploy: Alice A / feature/index-rides @ $NEW_SHA"
}

@test "deploy exit code unaffected by notify failure" {
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\nexit 22\n' >"$TMP/bin/curl"
  chmod +x "$TMP/bin/curl"
  echo 'DISCORD_WEBHOOK_URL=https://discord.invalid/hook' >"$W/.env.isutools"
  PATH="$TMP/bin:$PATH" do_deploy
  assert_success
  assert_contains "Discord への通知に失敗しました"
}
