#!/usr/bin/env bats

setup() {
  load helpers/setup
  common_setup
  N="$TMP/nginx"
  mkdir -p "$N/sites-available"
  cat >"$N/nginx.conf" <<'EOF'
http {
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
EOF
  cat >"$N/sites-available/isuapp.conf" <<'EOF'
server {
  listen 80;
  access_log /var/log/nginx/app.log main;
  # access_log /already/commented.log;
}
EOF
}

h() {
  run bash -c "source \"$SRC_ROOT/isutools/lib/common.sh\"; source \"$SRC_ROOT/isutools/lib/bootstrap_helpers.sh\"; $*"
}

@test "disable_original_access_log comments out access_log and is idempotent" {
  h "disable_original_access_log '$N' && disable_original_access_log '$N'"
  assert_success
  assert_file_contains "$N/nginx.conf" "# access_log /var/log/nginx/access.log; # disabled by isutools"
  assert_file_contains "$N/sites-available/isuapp.conf" "# access_log /var/log/nginx/app.log main; # disabled by isutools"
  assert_file_contains "$N/sites-available/isuapp.conf" "  # access_log /already/commented.log;"
  run grep -c "disabled by isutools" "$N/nginx.conf"
  [ "$output" = 1 ]
  run grep -c "# # access_log" "$N/nginx.conf"
  [ "$output" = 0 ]
  assert_file_contains "$N/nginx.conf" "error_log /var/log/nginx/error.log;"
}

@test "disable_original_access_log fails without conf.d include" {
  printf 'http {\n  access_log /x.log;\n}\n' >"$N/nginx.conf"
  h "disable_original_access_log '$N'"
  assert_failure
  assert_contains "conf.d"
}

@test "find_large_files lists files over threshold" {
  mkdir -p "$TMP/w/sql" "$TMP/w/node_modules"
  truncate -s 51M "$TMP/w/sql/big.sql"
  truncate -s 49M "$TMP/w/sql/small.sql"
  truncate -s 60M "$TMP/w/node_modules/dep.bin"
  h "find_large_files '$TMP/w' 50"
  assert_success
  [ "$output" = sql/big.sql ]
}

@test "disable_original_access_log also covers conf.d and real files in sites-enabled" {
  mkdir -p "$N/conf.d" "$N/sites-enabled"
  printf 'server {\n  access_log /var/log/nginx/conf-d.log;\n}\n' >"$N/conf.d/app.conf"
  printf 'access_log /var/log/nginx/access.log isutools_ltsv;\n' >"$N/conf.d/isutools-log.conf"
  printf 'server {\n  access_log /var/log/nginx/real.log;\n}\n' >"$N/sites-enabled/real.conf"
  ln -s ../sites-available/isuapp.conf "$N/sites-enabled/isuapp.conf"
  h "disable_original_access_log '$N'"
  assert_success
  assert_file_contains "$N/conf.d/app.conf" "# access_log /var/log/nginx/conf-d.log; # disabled by isutools"
  assert_file_contains "$N/sites-enabled/real.conf" "# access_log /var/log/nginx/real.log; # disabled by isutools"
  refute_file_contains "$N/conf.d/isutools-log.conf" "disabled by isutools"
  [ -L "$N/sites-enabled/isuapp.conf" ]
  run grep -c "disabled by isutools" "$N/sites-available/isuapp.conf"
  [ "$output" = 1 ]
}
