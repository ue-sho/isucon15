import type { Queryer } from "../../src/db.ts";
import { sha256Hex } from "../../src/session.ts";
type Kind = "realmojis" | "comments";
export const groups = [
  { name: "boundary", counts: [0, 49, 50, 51, 5000, ...Array<number>(46).fill(3)], junk: 120 },
  { name: "sparse", counts: Array<number>(50).fill(10), junk: 0 },
  { name: "dense", counts: Array<number>(50).fill(1000), junk: 0 },
  { name: "filtered", counts: Array<number>(50).fill(100), junk: 900 },
] as const;
export const postID = (group: string, i: number) => `${group}-p-${String(i + 1).padStart(3, "0")}`;
export const interactionID = (kind: Kind, group: string, i: number, j: number) =>
  `${kind === "comments" ? "c" : "r"}-${postID(group, i)}-${String(j).padStart(5, "0")}`;

export async function seed(db: Queryer): Promise<void> {
  for (const sql of `
    INSERT INTO users(id, username, secret_key_hash, display_name, bio, region, profile_image_id)
    SELECT 'u-' || n, 'u-' || n, repeat('a',64), 'user ' || n, repeat('bio ',16), 'asia',
           CASE WHEN n <= 2 THEN 'profile-' || n END
    FROM generate_series(1,5000) n;
    INSERT INTO users(id, username, secret_key_hash, display_name, region, status)
    VALUES ('inactive', 'inactive', repeat('b',64), 'inactive', 'asia', 'inactive'),
           ('deleted', 'deleted', repeat('c',64), 'deleted', 'asia', 'deleted');
    INSERT INTO users(id,username,secret_key_hash,display_name,region,status)
    SELECT 'inactive-' || n, 'inactive-' || n, repeat('b',64), 'inactive', 'asia',
           CASE WHEN n % 2 = 0 THEN 'inactive' ELSE 'deleted' END FROM generate_series(1,900) n;
    INSERT INTO posting_windows(id, region, local_date, starts_at, on_time_deadline, ended_at)
    VALUES ('history', 'asia', '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:02:00Z', '2026-10-11T00:00:00Z'),
           ('current', 'asia', '2026-10-31', '2026-10-31T00:00:00Z', '2026-10-31T00:02:00Z', NULL);
  `.split(";").filter(sql => sql.trim())) await db.exec(sql);
  for (const group of groups) {
    await db.exec(`INSERT INTO users(id,username,secret_key_hash,display_name,region)
      VALUES ($1::text,$1::text,repeat('d',64),$1::text,'asia')`, group.name);
    await db.exec(`INSERT INTO login_sessions(id,user_id,token_hash) VALUES ($1,$1,$2)`, group.name, sha256Hex(`memory-${group.name}`));
    // No friendships, an ended posting window, no current post, and blocks in
    // both directions: historical interactions must still be visible.
    await db.exec(`INSERT INTO block_relations(id,blocker_id,blocked_id)
      VALUES ($1::text || '-out',$1::text,'u-1'), ($1::text || '-in','u-2',$1::text)`, group.name);
    const ids = group.counts.map((_, i) => postID(group.name, i));
    await db.exec(`INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,posted_at)
      SELECT id,$1,'history','image-' || id,'memory','friends','none',
             '2026-10-10T12:00:00Z'::timestamptz - ord * interval '1 second'
      FROM unnest($2::varchar[]) WITH ORDINALITY p(id,ord)`, group.name, ids);
    for (const kind of ["comments", "realmojis"] as const) {
      const actor = kind === "comments" ? "author_id" : "reactor_id";
      const fields = kind === "comments" ? "body" : "image_id,reaction_type";
      const values = kind === "comments" ? "repeat('comment ',64)" : "'image-' || id || '-' || n,'like'";
      const prefix = kind === "comments" ? "c-" : "r-";
      await db.exec(`INSERT INTO ${kind}(id,post_id,${actor},${fields},created_at)
        SELECT '${prefix}' || id || '-' || lpad(n::text,5,'0'), id, 'u-' || n, ${values},
               '2026-10-10T12:00:00Z'::timestamptz + ((n-1)/3) * interval '1 microsecond'
        FROM unnest($1::varchar[],$2::int[]) p(id,count) CROSS JOIN LATERAL generate_series(1,count) n`, ids, group.counts);
      if (group.junk === 0) continue;
      const replacementField = kind === "realmojis" ? ",replaced_at" : "";
      const replacementValue = kind === "realmojis" ? ",CASE WHEN n % 3 = 1 THEN '2026-10-11'::timestamptz END" : "";
      const invalidActor = kind === "comments"
        ? "CASE WHEN n % 3 = 0 THEN 'u-1' WHEN n % 3 = 1 THEN 'inactive' ELSE 'deleted' END"
        : "CASE WHEN n % 3 = 0 THEN 'u-1' WHEN n % 3 = 1 THEN 'u-2' ELSE 'inactive-' || n END";
      await db.exec(`INSERT INTO ${kind}(id,post_id,${actor},${fields},created_at,deleted_at${replacementField})
        SELECT '${prefix}junk-' || id || '-' || lpad(n::text,5,'0'), id, ${invalidActor}, ${values},
               ${kind === "comments" ? "'2026-10-09'" : "'2026-10-12'"}::timestamptz,
               CASE WHEN n % 3 = 0 THEN '2026-10-11'::timestamptz END${replacementValue}
        FROM unnest($1::varchar[]) p(id) CROSS JOIN generate_series(1,$2::int) n`, ids, group.junk);
    }
  }
  await db.exec("ANALYZE");
}
