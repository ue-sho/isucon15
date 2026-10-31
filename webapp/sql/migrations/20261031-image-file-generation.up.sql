BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE initial_data_boundary
  ADD COLUMN IF NOT EXISTS image_cache_generation text NOT NULL DEFAULT gen_random_uuid()::text;
COMMIT;
