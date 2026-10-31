-- 書込・ベンチ・他DDLがないと確認済みの時間帯だけ使用する。
-- 通常作成中は対象表の書込が待機する。読取は継続できる。
-- ロックが即時取得できなければ作成せず終了。2本は同一Txで原子的に適用する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '30s';

BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid<>pg_backend_pid() AND relation IN ('public.login_sessions'::regclass,'public.posts'::regclass)) THEN
    RAISE EXCEPTION 'Target table is in use; index creation cancelled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' AND ltrim(query) !~* '^FETCH') THEN
    RAISE EXCEPTION 'Other database work detected; index creation cancelled';
  END IF;
END $$;
LOCK TABLE public.login_sessions, public.posts IN SHARE MODE NOWAIT;

CREATE INDEX login_sessions_active_token_idx
  ON public.login_sessions(token_hash) WHERE active = true;

CREATE INDEX posts_active_author_window_idx
  ON public.posts(author_id,posting_window_id) WHERE deleted_at IS NULL;

COMMIT;
