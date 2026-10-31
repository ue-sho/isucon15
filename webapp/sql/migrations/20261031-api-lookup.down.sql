-- 今回の追加3本だけを撤去する。トランザクション外で実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';

DROP INDEX CONCURRENTLY IF EXISTS public.follows_followee_updated_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.posts_author_window_counts_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.posts_active_image_author_idx;
