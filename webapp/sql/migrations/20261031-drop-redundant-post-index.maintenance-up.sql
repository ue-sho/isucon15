-- 計測/書込がなく、別対象のFETCHのみの時間帯専用。
-- postsの読取・書込は一時待機する。即時ロック不可なら変更せず中止する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '30s';
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.posts_author_window_counts_idx') AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'Replacement index is missing or invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid<>pg_backend_pid() AND relation='public.posts'::regclass) THEN
    RAISE EXCEPTION 'Target table is in use';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' AND ltrim(query) !~* '^FETCH') THEN
    RAISE EXCEPTION 'Other database work detected';
  END IF;
END $$;
LOCK TABLE public.posts IN ACCESS EXCLUSIVE MODE NOWAIT;
DROP INDEX IF EXISTS public.posts_active_author_window_idx;
COMMIT;
