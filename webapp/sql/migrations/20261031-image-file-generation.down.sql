-- 先に画像ファイル機能と世代更新を使わないコードへ戻してから実行する。
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE initial_data_boundary DROP COLUMN IF EXISTS image_cache_generation;
COMMIT;
