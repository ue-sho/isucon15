-- 004-non-image-indexes.sqlの索引だけを撤去。トランザクション外で実行する。
SET lock_timeout = '3s';
SET statement_timeout = '2min';
DROP INDEX CONCURRENTLY IF EXISTS friend_requests_pending_recipient_requester_idx;
DROP INDEX CONCURRENTLY IF EXISTS friend_requests_pending_requester_recipient_idx;
DROP INDEX CONCURRENTLY IF EXISTS friendships_high_low_idx;
DROP INDEX CONCURRENTLY IF EXISTS users_username_id_idx;
RESET lock_timeout;
RESET statement_timeout;
