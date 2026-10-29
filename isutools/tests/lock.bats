#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
}

lk() {
  run bash -c "source \"$SRC_ROOT/isutools/lib/common.sh\"; source \"$SRC_ROOT/isutools/lib/lock.sh\"; $*"
}

lockdir() { echo "$FAKE_HOSTS/$1/home/isucon/.isutools/deploy.lock"; }

@test "lock_all acquires all hosts" {
  lk "lock_all alice s1 s2 s3"
  assert_success
  for h in s1 s2 s3; do
    [ -d "$(lockdir "$h")" ]
    assert_file_contains "$(lockdir "$h")/owner" "alice"
  done
}

@test "lock_all releases acquired locks when one host is locked and shows owner" {
  mkdir -p "$(lockdir s2)"
  echo "bob 1700000000" >"$(lockdir s2)/owner"
  lk "lock_all alice s1 s2 s3"
  assert_failure
  assert_contains "bob"
  assert_contains "s2"
  [ ! -e "$(lockdir s1)" ]
  [ ! -e "$(lockdir s3)" ]
  assert_file_contains "$(lockdir s2)/owner" "bob"
}

@test "lock_all releases when one host is unreachable" {
  export FAKE_UNREACHABLE=s3
  lk "lock_all alice s1 s2 s3"
  assert_failure
  assert_contains "s3"
  [ ! -e "$(lockdir s1)" ]
  [ ! -e "$(lockdir s2)" ]
}

@test "lock_owner prints owner of a locked host" {
  mkdir -p "$(lockdir s1)"
  echo "bob 1700000000" >"$(lockdir s1)/owner"
  lk "lock_owner s1"
  assert_success
  assert_contains "bob"
}

@test "unlock_all is idempotent" {
  lk "lock_all alice s1 s2 s3 && unlock_all s1 s2 s3 && unlock_all s1 s2 s3"
  assert_success
  for h in s1 s2 s3; do [ ! -e "$(lockdir "$h")" ]; done
}

@test "lock owner with spaces is recorded and shown" {
  lk "lock_all 'Shohei Ueda' s1"
  assert_success
  assert_file_contains "$(lockdir s1)/owner" "Shohei Ueda "
  lk "lock_all alice s1"
  assert_failure
  assert_contains "Shohei Ueda が実行中"
}
