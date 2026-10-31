-- 書込・計測・他DDLがない時間帯専用。対象表の書込はCOMMITまで待機する。
-- NOWAITで即時取得できなければ中止。各文30秒制限、同一Txで原子的に適用。
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '30s';

BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid<>pg_backend_pid() AND relation IN ('public.posts'::regclass,'public.follows'::regclass)) THEN
    RAISE EXCEPTION 'Target table is in use; index creation cancelled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' AND ltrim(query) !~* '^FETCH') THEN
    RAISE EXCEPTION 'Other database work detected; index creation cancelled';
  END IF;
END $$;
LOCK TABLE public.posts, public.follows IN SHARE MODE NOWAIT;

CREATE INDEX posts_active_image_author_idx
  ON public.posts(image_id,author_id) WHERE deleted_at IS NULL;

-- 削除済み投稿も含む投稿枠の件数集計用。部分索引では代用できない。
CREATE INDEX posts_author_window_counts_idx
  ON public.posts(author_id,posting_window_id) INCLUDE(deleted_at);

CREATE INDEX follows_followee_updated_idx
  ON public.follows(followee_id,updated_at DESC,id DESC) INCLUDE(follower_id);

COMMIT;
