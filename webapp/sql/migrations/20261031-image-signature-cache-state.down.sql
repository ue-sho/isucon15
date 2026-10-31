-- Revert both the application and reset.sql before removing this table.
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '30s';
DROP TABLE IF EXISTS image_signature_cache_state;
