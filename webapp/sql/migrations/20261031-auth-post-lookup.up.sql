-- 既存DBへの適用用。トランザクション外で1本ずつ実行する。
-- 事前確認・失敗時の扱い・撤去: docs/query-lookup-indexes.md
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE INDEX CONCURRENTLY login_sessions_active_token_idx
  ON public.login_sessions(token_hash) WHERE active = true;

CREATE INDEX CONCURRENTLY posts_active_author_window_idx
  ON public.posts(author_id,posting_window_id) WHERE deleted_at IS NULL;
