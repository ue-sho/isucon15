-- Apply before deploying the matching Node.js handler. No data/schema rewrite.
-- Must run inside the caller's READ COMMITTED transaction: locks remain held
-- while the application obtains postedAt from its own clock and saves the post.
CREATE OR REPLACE FUNCTION public.isureal_prepare_post(p_user_id text)
RETURNS TABLE (author jsonb, window_id text, starts_at timestamptz, active bigint, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user users%ROWTYPE;
  v_window posting_windows%ROWTYPE;
  v_active bigint;
  v_deleted bigint;
BEGIN
  SELECT u.* INTO v_user FROM users u
    WHERE u.id = p_user_id AND u.status = 'active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Separate commands intentionally take fresh snapshots after a lock wait.
  -- A window ended by the waiter’s predecessor disappears from the first
  -- result; the second command can then see its newly committed successor.
  SELECT w.* INTO v_window FROM posting_windows w
    WHERE w.region = v_user.region AND w.ended_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    SELECT w.* INTO v_window FROM posting_windows w
      WHERE w.region = v_user.region AND w.ended_at IS NULL FOR SHARE;
  END IF;
  IF FOUND THEN
    SELECT count(*) FILTER (WHERE p.deleted_at IS NULL),
           count(*) FILTER (WHERE p.deleted_at IS NOT NULL)
      INTO v_active, v_deleted
      FROM posts p JOIN posting_windows w ON w.id = p.posting_window_id
      WHERE p.author_id = p_user_id AND w.local_date = v_window.local_date;
  END IF;

  RETURN QUERY SELECT to_jsonb(v_user), v_window.id::text, v_window.starts_at, v_active, v_deleted;
END;
$$;
