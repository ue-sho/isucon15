#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  W="$TMP/work"
  git init -q --bare "$TMP/origin.git"
  make_work_repo "$W"
  sed 's/^APP_SERVICE=.*/APP_SERVICE=isuapp-node.service/' "$SRC_ROOT/isutools/config.env" >"$W/isutools/config.env"
  cd "$W"
  git init -q
  git remote add origin "$TMP/origin.git"
  git add -A && git commit -q -m tools && git push -q origin main
  B="$W/isutools/.bootstrap"
  n=0
  for h in s1 s2 s3; do
    n=$((n + 1))
    mkdir -p "$B/$h/etc/nginx/sites-available" "$B/$h/etc/mysql/conf.d" "$B/$h/etc/systemd/system" "$B/$h/home/isucon"
    printf 'http {\n    access_log /var/log/nginx/access.log;\n    include /etc/nginx/conf.d/*.conf;\n}\n' >"$B/$h/etc/nginx/nginx.conf"
    echo "[mysqld]" >"$B/$h/etc/mysql/my.cnf"
    echo "[client] password=secret" >"$B/$h/etc/mysql/debian.cnf"
    printf '[Service]\nEnvironmentFile=/home/isucon/env.sh\n' >"$B/$h/etc/systemd/system/isuapp-node.service"
    echo "ISUCON_DB_HOST=127.0.0.1" >"$B/$h/home/isucon/env.sh"
    echo "10.0.0.$n" >"$B/$h/ip"
  done
  mkdir -p "$B/s1/webapp/nodejs/node_modules/dep" "$B/s1/webapp/sql"
  echo "app" >"$B/s1/webapp/nodejs/app.ts"
  echo "dep" >"$B/s1/webapp/nodejs/node_modules/dep/index.js"
  truncate -s 51M "$B/s1/webapp/sql/initial.sql"
}

bl() { run bash "$W/isutools/scripts/bootstrap-local.sh"; }
origin_files() { git -C "$TMP/origin.git" ls-tree -r --name-only main; }

@test "imports webapp and per-host etc and pushes one commit" {
  bl
  assert_success
  [ "$(git -C "$TMP/origin.git" log -1 --format=%s main)" = "chore: import initial server state" ]
  run origin_files
  assert_contains "webapp/nodejs/app.ts"
  assert_contains "s2/etc/nginx/nginx.conf"
  assert_contains "s3/etc/systemd/system/isuapp-node.service"
  assert_contains "s3/etc/systemd/system/pprotein.service"
  assert_contains "s1/home/isucon/env.sh"
  assert_contains "isutools/hosts.env"
  assert_contains "isutools/pprotein/targets.single.json"
  refute_contains "node_modules"
  refute_contains "debian.cnf"
  assert_file_contains "$W/isutools/hosts.env" "S3_IP=10.0.0.3"
  assert_file_contains "$W/s1/etc/nginx/nginx.conf" "# access_log /var/log/nginx/access.log; # disabled by isutools"
  assert_file_contains "$W/s1/etc/systemd/system/isuapp-node.service.d/isutools.conf" "PPROTEIN_URL=http://10.0.0.3:9000"
}

@test "gitignores large files and env files" {
  bl
  assert_success
  assert_contains "webapp/sql/initial.sql"
  assert_file_contains "$W/.gitignore" "/webapp/sql/initial.sql"
  assert_file_contains "$W/.gitignore" "/env.sh"
  run origin_files
  refute_contains "webapp/sql/initial.sql"
}

@test "rerun makes no new commit" {
  bl
  assert_success
  before="$(git -C "$TMP/origin.git" rev-parse main)"
  bl
  assert_success
  assert_contains "変更なし"
  [ "$(git -C "$TMP/origin.git" rev-parse main)" = "$before" ]
  run grep -c "^/env.sh$" "$W/.gitignore"
  [ "$output" = 1 ]
}

@test "refuses to run on non-main branch" {
  git switch -q -c feature/x
  bl
  assert_failure
  assert_contains "main"
}

@test "fails when collected data is missing" {
  rm -rf "$B/s2"
  bl
  assert_failure
  assert_contains "s2"
}

@test "explicit bootstrap branch imports and pushes without changing main" {
  before="$(git rev-parse main)"
  git switch -q -c test/bootstrap
  export BOOTSTRAP_BRANCH=test/bootstrap
  bl
  assert_success
  [ "$(git -C "$TMP/origin.git" rev-parse main)" = "$before" ]
  [ "$(git -C "$TMP/origin.git" log -1 --format=%s test/bootstrap)" = "chore: import initial server state" ]
}

@test "explicit bootstrap branch rejects a different current branch" {
  export BOOTSTRAP_BRANCH=test/bootstrap
  bl
  assert_failure
  assert_contains "test/bootstrap"
}
