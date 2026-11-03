// Experimental candidate only: compare typed UNION + shared post CTE with
// the smaller two-statement production path. No production switch is added.
import type { Queryer, Row } from "../../src/db.ts";
import { selectMemoryInteractions } from "../../src/memory_interactions.ts";
import { userColumns } from "../../src/user.ts";

export async function capture(run: (db: Queryer) => Promise<unknown>): Promise<string> {
  let text = "";
  await run({
    async get() { throw new Error("unexpected get"); },
    async exec() { throw new Error("unexpected exec"); },
    async select<T>(sql: string): Promise<T[]> { text = sql; return []; },
  });
  return text;
}

const interactionSQL = await capture(db => selectMemoryInteractions(db, ["fixture"]));
const postColumns = ["id", "author_id", "posting_window_id", "image_id", "caption", "visibility",
  "location_kind", "latitude", "longitude", "locality", "posted_at", "on_time_deadline", "window_ended_at",
  ...userColumns.map(c => `author.${c}`)];
const interactionColumns = ["memory_kind", "id", "post_id", "actor_id", "image_id", "reaction_type",
  "body", "created_at", "deleted_at", ...userColumns.map(c => `actor.${c}`), "memory_rank"];
const columns = [...new Set([...postColumns, ...interactionColumns])];
const projection = (available: string[], alias: string) => columns.map(c =>
  available.includes(c) ? `${alias}."${c}"` : `NULL AS "${c}"`).join(", ");

export function singleSnapshot(db: Queryer): Queryer {
  let interactions: Row[] | undefined;
  return {
    get: (sql, ...args) => db.get(sql, ...args),
    exec: (sql, ...args) => db.exec(sql, ...args),
    async select<T>(sql: string, ...args: unknown[]): Promise<T[]> {
      if (sql.includes("FROM posts p")) {
        const rows = await db.select(`
          WITH memory_posts AS MATERIALIZED (${sql}),
          memory_page AS MATERIALIZED (SELECT id FROM memory_posts ORDER BY posted_at DESC, id DESC LIMIT 50),
          memory_interactions AS (${interactionSQL.replaceAll("ANY($1::varchar[])", "ANY(ARRAY(SELECT id FROM memory_page))")})
          SELECT 'post' AS memory_source, ${projection(postColumns, "p")},
                 row_number() OVER (ORDER BY p.posted_at DESC, p.id DESC) AS memory_sequence
          FROM memory_posts p
          UNION ALL
          SELECT 'interaction', ${projection(interactionColumns, "i")}, memory_rank
          FROM memory_interactions i
          ORDER BY memory_source, post_id, memory_sequence
        `, ...args);
        interactions = rows.filter(r => r.memory_source === "interaction");
        return rows.filter(r => r.memory_source === "post") as T[];
      }
      if (sql.includes("FROM realmojis r")) {
        if (!interactions) throw new Error("missing candidate page");
        return interactions as T[];
      }
      return db.select<T>(sql, ...args);
    },
  };
}
