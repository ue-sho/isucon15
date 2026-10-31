// Isolation experiment only. Nothing in src/ imports this module.
import { createHash } from "node:crypto";
import { type DB, type Tx } from "../../src/db.ts";

// Two-int advisory namespaces, separate from notification (20261031, 1)
// and the one-bigint username registration namespace.
export const GRAPH = 1380730706;
export const PAIR = 1380730707;
export type Pair = readonly [string, string];
export type Hash = (value: string) => number;
export const hash: Hash = (value) => createHash("sha256").update(value).digest().readInt32BE(0);
export const pairKey = (pair: Pair) => JSON.stringify([...pair].sort());
export const sortedKeys = (values: string[], digest: Hash = hash) => [...new Set(values.map(digest))].sort((a, b) => a - b);

export async function pairLocks(tx: Tx, pairs: Pair[], digest: Hash = hash): Promise<void> {
  // Order the actual lock keys, not the unhashed pair names; deduplicate collisions.
  for (const key of sortedKeys(pairs.map(pairKey), digest)) {
    await tx.exec("SELECT pg_advisory_xact_lock($1::int, $2::int)", PAIR, key);
  }
}

export async function beginCandidate(db: DB, pairs: Pair[], options: {
  // Exclusive graph guards freeze all edges incident to the two FoF endpoints.
  // Edge writers use shared guards, so A-B and A-C writers can overlap.
  graph?: "shared" | "exclusive" | "none";
  digest?: Hash;
  rowMode?: "SHARE" | "KEY SHARE"; // KEY SHARE is a negative control, never proposed.
  users?: string[];
} = {}): Promise<Tx> {
  const ids = [...new Set(options.users ?? pairs.flat())].sort();
  const tx = await db.begin();
  try {
    for (const id of ids) {
      const row = await tx.get(`SELECT id FROM users WHERE id=$1 AND status='active' FOR ${options.rowMode ?? "SHARE"}`, id);
      if (!row) throw new Error("inactive_user");
    }
    const graph = options.graph ?? "shared";
    if (graph !== "none") {
      for (const key of sortedKeys(ids, options.digest)) {
        await tx.exec(graph === "exclusive"
          ? "SELECT pg_advisory_xact_lock($1::int, $2::int)"
          : "SELECT pg_advisory_xact_lock_shared($1::int, $2::int)", GRAPH, key);
      }
    }
    await pairLocks(tx, pairs, options.digest);
    return tx;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
