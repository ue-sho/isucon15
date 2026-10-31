-- 単独実行。BEGIN / --single-transaction で囲まない。
-- 先に docs/auth-register-login.md の重複確認を行う。
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '10min';
CREATE UNIQUE INDEX CONCURRENTLY users_username_unique_idx ON public.users(username);
