-- Additive and repeatable. Run before deploying the new application.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS search_username text COLLATE "C",
  ADD COLUMN IF NOT EXISTS search_display_name text COLLATE "C";
ALTER TABLE initial_users
  ADD COLUMN IF NOT EXISTS search_username text COLLATE "C",
  ADD COLUMN IF NOT EXISTS search_display_name text COLLATE "C";
COMMIT;
