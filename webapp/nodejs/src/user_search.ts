import type { DB } from "./db.ts";

// Keep exactly the same Unicode mapping as the original search, including ß -> ss.
// PostgreSQL lower() is not an equivalent replacement.
export function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

// Used during rollout and before reset. Block writers until the source values and
// their search values commit together; do not overwrite a concurrent profile edit.
export async function backfillUserSearch(db: DB): Promise<void> {
  await using tx = await db.begin();
  await tx.exec("SET LOCAL lock_timeout = '5s'");
  await tx.exec("LOCK TABLE users, initial_users IN SHARE ROW EXCLUSIVE MODE");
  for (const table of ["users", "initial_users"] as const) {
    const rows = await tx.select<{ id: string; username: string; display_name: string }>(
      `SELECT id, username, display_name FROM ${table}`,
    );
    const values = rows.map((row) => ({
      id: row.id,
      username: normalizeSearchText(row.username),
      display_name: normalizeSearchText(row.display_name),
    }));
    await tx.exec(
      `UPDATE ${table} u SET search_username = v.username, search_display_name = v.display_name
       FROM jsonb_to_recordset($1::jsonb) AS v(id text, username text, display_name text)
       WHERE u.id = v.id AND (u.search_username, u.search_display_name)
         IS DISTINCT FROM (v.username, v.display_name)`,
      JSON.stringify(values),
    );
  }
  await tx.commit();
}
