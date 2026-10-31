#!/bin/sh
# Fresh local containers only; never uses the application's DB/Redis credentials.
set -eu
cd "$(dirname "$0")/../.."
test_node=${IMAGE_AUTH_TEST_NODE:-node}
test_suffix=$(date +%s)-$$
test_redis=isu15-image-auth-redis-$test_suffix
test_pg=isu15-image-auth-pg-$test_suffix
cleanup() {
  docker rm --force --volumes "$test_redis" "$test_pg" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker run --detach --name "$test_redis" --publish 127.0.0.1::6379 redis:7.4-alpine \
  redis-server --appendonly yes --appendfsync always --no-appendfsync-on-rewrite no \
  --aof-load-truncated no --save '' --maxmemory-policy noeviction >/dev/null
docker run --detach --name "$test_pg" --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=isureal_image_auth_test postgres:16 >/dev/null
test_attempt=0
until docker exec "$test_pg" pg_isready -U postgres -d isureal_image_auth_test >/dev/null 2>&1 \
  && docker exec "$test_redis" redis-cli ping >/dev/null 2>&1; do
  test_attempt=$((test_attempt + 1))
  [ "$test_attempt" -lt 100 ] || exit 1
  sleep 0.1
done
IMAGE_AUTH_REDIS_TEST_PORT=$(docker port "$test_redis" 6379 | sed 's/.*://') \
IMAGE_AUTH_PG_TEST_PORT=$(docker port "$test_pg" 5432 | sed 's/.*://') \
IMAGE_AUTH_REDIS_TEST_CONTAINER=$test_redis \
  "$test_node" --test test/image-authorization-cache.test.ts
