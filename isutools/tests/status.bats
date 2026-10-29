#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  export REPO_ROOT="$TMP/repo"
  make_work_repo "$REPO_ROOT"
  sed 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' "$SRC_ROOT/isutools/config.env" >"$REPO_ROOT/isutools/config.env"
  for h in s1 s2 s3; do
    r="$FAKE_HOSTS/$h/home/isucon"
    git -C "$r" init -q
    git -C "$r" commit -q --allow-empty -m init
    mkdir -p "$r/.isutools"
    printf 'deployer=Alice A\nbranch=feature/x\ncommit=abc1234\nat=%s\n' "$(($(date +%s) - 180))" >"$r/.isutools/last-deploy"
  done
  printf 'nginx\nisuapp-node.service\npprotein-agent.service\n' >"$FAKE_HOSTS/s1/enabled"
}

st() { run bash "$REPO_ROOT/isutools/scripts/status.sh"; }

@test "status shows branch, commit, last deployer per host" {
  st
  assert_success
  sha="$(git -C "$FAKE_HOSTS/s1/home/isucon" rev-parse --short=7 HEAD)"
  assert_contains "s1  feature/x @ $sha  last: Alice A 3 min ago"
  assert_contains "app=active nginx=active db=inactive agent=active lock=-"
  assert_contains "s3  feature/x"
}

@test "status marks unreachable host" {
  export FAKE_UNREACHABLE=s2
  st
  assert_success
  assert_contains "s2  ✖ unreachable"
  assert_contains "s1  feature/x"
}

@test "status shows lock owner" {
  mkdir -p "$FAKE_HOSTS/s1/home/isucon/.isutools/deploy.lock"
  echo "Bob 1700000000" >"$FAKE_HOSTS/s1/home/isucon/.isutools/deploy.lock/owner"
  st
  assert_contains "lock=Bob"
}

@test "status works before first deploy" {
  rm "$FAKE_HOSTS/s1/home/isucon/.isutools/last-deploy"
  st
  assert_success
  assert_contains "s1  (未デプロイ)"
}

@test "unlock -y removes locks on all hosts" {
  for h in s1 s2 s3; do mkdir -p "$FAKE_HOSTS/$h/home/isucon/.isutools/deploy.lock"; done
  run bash "$REPO_ROOT/isutools/scripts/unlock.sh" -y
  assert_success
  for h in s1 s2 s3; do [ ! -e "$FAKE_HOSTS/$h/home/isucon/.isutools/deploy.lock" ]; done
}
