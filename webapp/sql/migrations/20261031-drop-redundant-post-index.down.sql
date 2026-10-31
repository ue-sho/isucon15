-- 部分索引を戻す場合。トランザクション外で実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';
CREATE INDEX CONCURRENTLY posts_active_author_window_idx
  ON public.posts(author_id,posting_window_id) WHERE deleted_at IS NULL;
