-- 今回追加した非UNIQUE索引だけを撤去する。トランザクション外で実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';

DROP INDEX CONCURRENTLY IF EXISTS public.posts_active_author_window_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.login_sessions_active_token_idx;
