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

prepare_benchmark() {
  export PORTAL_TARGET_ID=1 PORTAL_COOKIE=dummy PORTAL_CSRF_TOKEN=dummy
  mkdir -p "$TMP/bin"
  cat >"$TMP/bin/ansible-playbook" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = benchmark.yml ]
for h in s1 s2 s3; do
  [ -d "$FAKE_HOSTS/$h/home/isucon/.isutools/deploy.lock" ]
done
# A second ordinary deploy must fail while the benchmark holds the same locks.
if bash "$REPO_ROOT/isutools/scripts/deploy.sh" >"$TMP/concurrent.log" 2>&1; then
  echo 'concurrent deployment unexpectedly succeeded' >&2
  exit 99
fi
grep -q 'デプロイ中' "$TMP/concurrent.log"
echo 'mock benchmark executed with locks held'
case "${BENCH_TEST_RESULT:-success}" in
  success) exit 0 ;;
  failed) exit 1 ;;
  unknown) echo '{"job_id":123,"status":"active"}' >"$ISUTOOLS_BENCH_STATE"; exit 1 ;;
esac
SH
  chmod +x "$TMP/bin/ansible-playbook"
  export PATH="$TMP/bin:$PATH"
}

@test "benchmark holds deploy locks through Ansible and releases confirmed outcomes" {
  prepare_benchmark
  for result in success failed; do
    export BENCH_TEST_RESULT="$result"
    do_deploy --bench
    if [ "$result" = success ]; then assert_success; else assert_failure; fi
    assert_contains 'mock benchmark executed with locks held'
    for h in s1 s2 s3; do [ ! -e "$(lockdir "$h")" ]; done
  done
}

@test "unfinished benchmark retains locks and blocks the next deploy" {
  prepare_benchmark
  export BENCH_TEST_RESULT=unknown
  do_deploy --bench
  assert_failure
  assert_contains 'デプロイロックを保持します'
  for h in s1 s2 s3; do [ -d "$(lockdir "$h")" ]; done
  do_deploy
  assert_failure
  assert_contains 'デプロイ中'
}

@test "failed deployment never starts the benchmark and releases locks" {
  prepare_benchmark
  echo nginx >"$FAKE_HOSTS/s2/enabled"
  touch "$FAKE_HOSTS/s2/fail-nginx"
  do_deploy --bench
  assert_failure
  refute_contains 'mock benchmark executed with locks held'
  for h in s1 s2 s3; do [ ! -e "$(lockdir "$h")" ]; done
}
