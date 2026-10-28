#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  git init -q --bare "$TMP/origin.git"
  git clone -q "$TMP/origin.git" "$TMP/seed" 2>/dev/null
  (
    cd "$TMP/seed"
    mkdir -p webapp isutools
    echo "version: '3'" >Taskfile.yml
    echo "console.log(1)" >webapp/app.js
    echo "x" >isutools/x
    git add -A && git commit -q -m seed && git push -q origin main
  )
  R="$FAKE_HOSTS/s1/home/isucon"
  mkdir -p "$R/webapp" "$R/local/bin"
  echo "console.log(1)" >"$R/webapp/app.js"
  echo "go binary" >"$R/local/bin/go"
}

sync() {
  run "$ISUTOOLS_SSH" s1 "bash '$SRC_ROOT/isutools/scripts/repo-sync.sh' '$TMP/origin.git' main"
}

@test "initializes repo in existing home and keeps untracked files" {
  sync
  assert_success
  [ -f "$R/Taskfile.yml" ]
  [ -f "$R/isutools/x" ]
  [ -f "$R/local/bin/go" ]
  [ "$(git -C "$R" rev-parse HEAD)" = "$(git -C "$TMP/origin.git" rev-parse main)" ]
}

@test "identical existing files are not conflicts" {
  sync
  assert_success
  refute_contains "衝突"
}

@test "aborts listing conflicting files without changing anything" {
  echo "server original" >"$R/Taskfile.yml"
  echo "console.log(2)" >"$R/webapp/app.js"
  sync
  assert_failure
  assert_contains "Taskfile.yml"
  assert_contains "webapp/app.js"
  [ "$(cat "$R/Taskfile.yml")" = "server original" ]
  [ ! -e "$R/.git" ]
}

@test "is idempotent on rerun" {
  sync
  assert_success
  sync
  assert_success
  [ "$(git -C "$R" rev-parse HEAD)" = "$(git -C "$TMP/origin.git" rev-parse main)" ]
}

@test "rerun on a managed repo resets tracked changes from other branches" {
  sync
  (cd "$TMP/seed" && git switch -q -c feature/x && echo "console.log(3)" >webapp/app.js && git commit -qam f && git push -q origin feature/x)
  run "$ISUTOOLS_SSH" s1 "git fetch -q origin feature/x && git reset -q --hard FETCH_HEAD"
  sync
  assert_success
  [ "$(cat "$R/webapp/app.js")" = "console.log(1)" ]
}

@test "aborts on a managed repo when a tracked file has local edits" {
  sync
  echo "edited on server" >"$R/webapp/app.js"
  sync
  assert_failure
  assert_contains "webapp/app.js"
  [ "$(cat "$R/webapp/app.js")" = "edited on server" ]
}

@test "aborts when existing remote differs" {
  git -C "$R" init -q
  git -C "$R" remote add origin git@example.com:other/repo.git
  sync
  assert_failure
  assert_contains "other/repo.git"
}
