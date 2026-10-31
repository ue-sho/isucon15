BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DROP FUNCTION IF EXISTS public.isureal_create_post_v1(text, text, text, bytea, text, text, text, numeric, numeric, text);
COMMIT;
