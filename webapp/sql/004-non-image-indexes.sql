-- 画像以外の認証・関係検索用。psql -X -v ON_ERROR_STOP=1 -f で単独適用する。
-- CONCURRENTLYのためBEGIN/COMMIT内では実行しない。reset.sqlは既存索引を維持する。
SET lock_timeout = '3s';
SET statement_timeout = '2min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_username_id_idx
  ON users (username, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS friendships_high_low_idx
  ON friendships (user_high_id, user_low_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS friend_requests_pending_requester_recipient_idx
  ON friend_requests (requester_id, recipient_id) WHERE status = 'pending';
CREATE INDEX CONCURRENTLY IF NOT EXISTS friend_requests_pending_recipient_requester_idx
  ON friend_requests (recipient_id, requester_id) WHERE status = 'pending';

RESET lock_timeout;
RESET statement_timeout;
