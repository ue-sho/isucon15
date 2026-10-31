-- Revert/deploy the old handler before removing the function.
DROP FUNCTION IF EXISTS public.isureal_prepare_post(text);
