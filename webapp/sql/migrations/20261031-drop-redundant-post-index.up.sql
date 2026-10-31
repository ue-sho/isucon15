-- posts_author_window_counts_idxがvalid/readyで存在することを確認してから実行する。
-- トランザクション外で実行する。今回追加した重複索引1本だけを撤去する。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '5min';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.posts_author_window_counts_idx') AND indisvalid AND indisready
  ) THEN RAISE EXCEPTION 'Replacement index is missing or invalid'; END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.posts_active_author_window_idx;
