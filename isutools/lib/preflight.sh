# shellcheck shell=bash
# デプロイ前に、手元のブランチが origin と一致しているかを確認する。
# 前提: common.sh を source 済み。

# current_branch — 手元の現在ブランチ名
current_branch() {
  local b
  if ! b="$(git symbolic-ref --quiet --short HEAD)"; then
    isu_err "detached HEAD です。ブランチに切り替えてからデプロイしてください"
    return 1
  fi
  echo "$b"
}

# preflight_branch <branch>
preflight_branch() {
  local branch="$1"

  if ! git fetch --quiet origin "refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
    isu_err "$branch が origin にありません。git push -u origin $branch してください"
    return 1
  fi

  # 手元に無いブランチ（BRANCH= で指定）は origin の内容をそのまま使う
  if ! git show-ref --verify --quiet "refs/heads/$branch"; then
    isu_info "$branch は手元に無いため origin/$branch を反映します"
    return 0
  fi

  local counts ahead behind
  counts="$(git rev-list --left-right --count "refs/heads/$branch...refs/remotes/origin/$branch")"
  ahead="${counts%%[[:space:]]*}"
  behind="${counts##*[[:space:]]}"

  if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
    isu_err "ローカルと origin が分岐しています（ローカル +${ahead} / origin +${behind}）。pull して解消してください"
    return 1
  fi
  if [ "$ahead" -gt 0 ]; then
    isu_err "未 push のコミットが $ahead 件あります。git push してください"
    return 1
  fi
  if [ "$behind" -gt 0 ]; then
    isu_err "origin が $behind コミット先行しています。pull してください"
    return 1
  fi

  if [ -n "$(git status --porcelain)" ]; then
    isu_warn "未コミットの変更があります（デプロイされるのは push 済みの内容だけです）"
  fi
}
