-- 既存DB用。トランザクション外で1本ずつ実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE INDEX CONCURRENTLY posts_active_image_author_idx
  ON public.posts(image_id,author_id) WHERE deleted_at IS NULL;

-- 削除済み投稿も含む投稿枠の件数集計用。部分索引では代用できない。
CREATE INDEX CONCURRENTLY posts_author_window_counts_idx
  ON public.posts(author_id,posting_window_id) INCLUDE(deleted_at);

CREATE INDEX CONCURRENTLY follows_followee_updated_idx
  ON public.follows(followee_id,updated_at DESC,id DESC) INCLUDE(follower_id);
