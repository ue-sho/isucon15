-- 全アプリを旧register実装へ戻した後に単独実行する。
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '10min';
DROP INDEX CONCURRENTLY IF EXISTS public.users_username_unique_idx;
