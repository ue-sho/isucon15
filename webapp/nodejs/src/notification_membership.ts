import type { Tx } from "./db.ts";

// 2引数のadvisory lockは登録時の1引数hashキーと名前空間が異なる。
// 通知対象を変える操作だけがshared、投稿期間開始がexclusiveを取得する。
// 必ずusers行をロックする前に取得し、COMMIT/ROLLBACKまで保持する。
export async function lockNotificationMembership(tx: Tx, exclusive = false): Promise<void> {
  await tx.exec(exclusive
    ? "SELECT pg_advisory_xact_lock(20261031, 1)"
    : "SELECT pg_advisory_xact_lock_shared(20261031, 1)");
}
