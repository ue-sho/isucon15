# shellcheck shell=bash
# bats 共通ヘルパー。各テストファイルの setup() から読み込む。

HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$HELPERS_DIR/../../.." && pwd)"
export HELPERS_DIR SRC_ROOT

# テストごとの一時領域と偽ホスト
common_setup() {
  export TMP="$BATS_TEST_TMPDIR"
  export FAKE_HOSTS="$TMP/hosts"
  export ISUTOOLS_SSH="$HELPERS_DIR/fake-ssh"
  export FAKE_UNREACHABLE=""
  export ISUTOOLS_HEALTH_WAIT=0
  export GIT_AUTHOR_NAME=tester GIT_AUTHOR_EMAIL=tester@example.com
  export GIT_COMMITTER_NAME=tester GIT_COMMITTER_EMAIL=tester@example.com
  export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
  git config --global init.defaultBranch main
  git config --global user.name tester
  git config --global user.email tester@example.com
  local h
  for h in s1 s2 s3; do
    mkdir -p "$FAKE_HOSTS/$h/home/isucon" "$FAKE_HOSTS/$h/etc"
    : >"$FAKE_HOSTS/$h/enabled"
  done
}

# 本物の isutools をコピーした作業リポジトリ（REPO_ROOT）を作る
# $1: ディレクトリ
make_work_repo() {
  local dir="$1"
  mkdir -p "$dir"
  rsync -a --exclude=.bootstrap --exclude=node_modules --exclude=tests "$SRC_ROOT/isutools/" "$dir/isutools/"
  cp "$SRC_ROOT/.gitignore" "$dir/" 2>/dev/null || true
  cp "$SRC_ROOT/Taskfile.yml" "$dir/" 2>/dev/null || true
}

assert_success() {
  if [ "$status" -ne 0 ]; then
    echo "expected success, got $status" >&2
    echo "$output" >&2
    return 1
  fi
}

assert_failure() {
  if [ "$status" -eq 0 ]; then
    echo "expected failure, got 0" >&2
    echo "$output" >&2
    return 1
  fi
}

assert_contains() {
  case "$output" in
    *"$1"*) return 0 ;;
  esac
  echo "expected output to contain: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  return 1
}

refute_contains() {
  case "$output" in
    *"$1"*)
      echo "expected output NOT to contain: $1" >&2
      echo "$output" >&2
      return 1
      ;;
  esac
  return 0
}

assert_file_contains() {
  if ! grep -qF -- "$2" "$1"; then
    echo "expected $1 to contain: $2" >&2
    cat "$1" >&2 2>/dev/null || echo "(file missing)" >&2
    return 1
  fi
}

refute_file_contains() {
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then
    echo "expected $1 NOT to contain: $2" >&2
    cat "$1" >&2
    return 1
  fi
}
