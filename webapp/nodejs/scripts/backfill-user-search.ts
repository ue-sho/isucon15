import { configFromEnv } from "../src/config.ts";
import { DB } from "../src/db.ts";
import { backfillUserSearch, normalizeSearchText } from "../src/user_search.ts";

const db = new DB(configFromEnv(), 1);
try {
  if (!process.argv.includes("--check")) await backfillUserSearch(db);
  for (const table of ["users", "initial_users"] as const) {
    const rows = await db.select(`SELECT username, display_name, search_username, search_display_name FROM ${table}`);
    const mismatches = rows.filter((row) => row.search_username !== normalizeSearchText(row.username)
      || row.search_display_name !== normalizeSearchText(row.display_name)).length;
    console.log(JSON.stringify({ table, rows: rows.length, mismatches }));
    if (mismatches) process.exitCode = 1;
  }
} finally {
  await db.end();
}
