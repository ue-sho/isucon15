-- Apply once before deploying the generation-aware application/reset script.
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
SET statement_timeout = '30s';
BEGIN;
-- The contest application/reset role must own and access the new state.
SET LOCAL ROLE isureal;
CREATE TABLE image_signature_cache_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  generation bigint NOT NULL CHECK (generation >= 1)
);
INSERT INTO image_signature_cache_state VALUES (true, 1);
COMMIT;
