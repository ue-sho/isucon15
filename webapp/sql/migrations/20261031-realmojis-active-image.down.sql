-- 追加した索引だけを取り消す。トランザクション外で単独実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '10min';

DROP INDEX CONCURRENTLY IF EXISTS public.realmojis_active_image_reactor;
