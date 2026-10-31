-- 既存DB用。psqlで単独実行し、BEGIN / --single-transaction で囲まない。
-- 適用・失敗時の復旧・確認: docs/image-validity-index.md
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE INDEX CONCURRENTLY realmojis_active_image_reactor
  ON public.realmojis(image_id,reactor_id)
  WHERE replaced_at IS NULL AND deleted_at IS NULL;
