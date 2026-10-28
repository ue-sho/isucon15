#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  git init -q --bare "$TMP/origin.git"
  git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
  cd "$TMP/work"
  git commit -q --allow-empty -m base
  git push -q origin main
  git switch -q -c feature/index-rides
  git commit -q --allow-empty -m "add index"
  git push -q -u origin feature/index-rides 2>/dev/null
}

pf() {
  run bash -c "cd \"$TMP/work\"; source \"$SRC_ROOT/isutools/lib/common.sh\"; source \"$SRC_ROOT/isutools/lib/preflight.sh\"; $*"
}

# origin 側に別の clone から commit を積む
push_from_other() {
  git clone -q "$TMP/origin.git" "$TMP/other" 2>/dev/null
  (cd "$TMP/other" && git switch -q "$1" && git commit -q --allow-empty -m other && git push -q origin "$1")
}

@test "ok when local equals origin (branch with slash)" {
  pf "preflight_branch feature/index-rides"
  assert_success
}

@test "fails when branch not pushed" {
  git switch -q -c feature/new
  pf "preflight_branch feature/new"
  assert_failure
  assert_contains "feature/new が origin にありません"
  assert_contains "git push -u origin feature/new"
}

@test "fails when local ahead" {
  git commit -q --allow-empty -m one
  git commit -q --allow-empty -m two
  pf "preflight_branch feature/index-rides"
  assert_failure
  assert_contains "未 push のコミットが 2 件あります"
}

@test "fails when origin ahead" {
  push_from_other feature/index-rides
  pf "preflight_branch feature/index-rides"
  assert_failure
  assert_contains "origin が 1 コミット先行しています"
}

@test "fails when diverged" {
  push_from_other feature/index-rides
  git commit -q --allow-empty -m mine
  pf "preflight_branch feature/index-rides"
  assert_failure
  assert_contains "分岐しています"
}

@test "warns but passes on dirty worktree" {
  echo dirty >file.txt
  pf "preflight_branch feature/index-rides"
  assert_success
  assert_contains "未コミットの変更があります"
}

@test "ok when branch exists only on origin" {
  push_from_other main
  git branch -q -D main
  pf "preflight_branch main"
  assert_success
  assert_contains "origin/main を反映します"
}

@test "current_branch fails on detached HEAD" {
  git switch -q --detach HEAD
  pf "current_branch"
  assert_failure
  assert_contains "detached HEAD"
}
