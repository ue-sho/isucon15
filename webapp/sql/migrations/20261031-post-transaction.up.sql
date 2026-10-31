-- 画像検証は各地域のNodeで行い、ロックを保持する区間だけDB内で完結させる。
-- VOLATILE: ロック待ち後のSQLは新しいsnapshotを取得する（STABLE/1本のCTEへ変えない）。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE FUNCTION public.isureal_create_post_v1(
  p_user_id text, p_image_id text, p_post_id text, p_image bytea,
  p_caption text, p_visibility text, p_location_kind text,
  p_latitude numeric, p_longitude numeric, p_locality text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user users%ROWTYPE;
  v_window posting_windows%ROWTYPE;
  v_post posts%ROWTYPE;
  v_active bigint;
  v_deleted bigint;
  v_posted_at timestamptz;
BEGIN
  SELECT u.* INTO v_user FROM users u
  WHERE u.id = p_user_id AND u.status = 'active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'no_rows');
  END IF;

  SELECT w.* INTO v_window FROM posting_windows w
  WHERE w.region = v_user.region AND w.ended_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    -- 旧枠のUPDATE待ちで行が条件外になった場合、新snapshotで新枠を再探索。
    SELECT w.* INTO v_window FROM posting_windows w
    WHERE w.region = v_user.region AND w.ended_at IS NULL FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'post_slot_unavailable');
  END IF;

  SELECT count(*) FILTER (WHERE p.deleted_at IS NULL),
         count(*) FILTER (WHERE p.deleted_at IS NOT NULL)
  INTO v_active, v_deleted
  FROM posts p JOIN posting_windows w ON w.id = p.posting_window_id
  WHERE p.author_id = p_user_id AND w.local_date = v_window.local_date;

  v_posted_at := clock_timestamp();
  IF v_active <> 0 OR v_deleted >= 2 OR v_posted_at < v_window.starts_at THEN
    RETURN jsonb_build_object('error', 'post_slot_unavailable');
  END IF;

  INSERT INTO image_objects(id, owner_user_id, data, media_type, created_at)
  VALUES (p_image_id, p_user_id, p_image, 'image/jpeg', v_posted_at);
  INSERT INTO posts(id, author_id, posting_window_id, image_id, caption, visibility,
                    location_kind, latitude, longitude, locality, posted_at)
  VALUES (p_post_id, p_user_id, v_window.id, p_image_id, p_caption, p_visibility,
          p_location_kind, p_latitude, p_longitude, p_locality, v_posted_at)
  RETURNING * INTO v_post;

  RETURN jsonb_build_object(
    'user', to_jsonb(v_user),
    'post', to_jsonb(v_post) || jsonb_build_object(
      'on_time_deadline', v_window.on_time_deadline, 'window_ended_at', v_window.ended_at
    )
  );
END;
$$;
COMMIT;
