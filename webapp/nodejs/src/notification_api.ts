import type { Handler } from "hono";
import { must, type Queryer } from "./db.ts";
import type { NotificationWakeup } from "./notification_wakeup.ts";
import { logError, marshalJSON } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession, type Session } from "./session.ts";

type GetNotificationsResponse = {
  id: string;
  postingWindowId: string;
  region: string;
  createdAt: Temporal.Instant;
};

type Subscriber = {
  session: Session;
  connectedAt: Temporal.Instant;
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal: AbortSignal;
  onAbort: () => void;
};

type NotificationRow = {
  slot: number;
  user_id: string | null;
  id: string | null;
  posting_window_id: string | null;
  region: string | null;
  created_at: Temporal.Instant | null;
};

const notificationPollInterval = 500;
const notificationBatchSize = 256;

// ハンドラーはworker内で一度作成する。通知内容は保持せず、待機接続だけを共有する。
class NotificationPoller {
  readonly db: Queryer;
  readonly subscribers = new Set<Subscriber>();
  timer: ReturnType<typeof setTimeout> | undefined;
  running = false;
  wakePending = false;
  readonly wakeup?: NotificationWakeup;

  constructor(db: Queryer, createWakeup?: (wake: () => void) => NotificationWakeup) {
    this.db = db;
    this.wakeup = createWakeup?.(() => this.wake());
  }

  add(subscriber: Subscriber): void {
    if (subscriber.signal.aborted) {
      try { subscriber.controller.close(); } catch {}
      return;
    }
    this.subscribers.add(subscriber);
    this.wakeup?.start();
    subscriber.signal.addEventListener("abort", subscriber.onAbort, { once: true });
    this.schedule(0);
  }

  remove(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    try { subscriber.controller.close(); } catch {}
    if (this.subscribers.size === 0) {
      this.wakeup?.stop();
      this.wakePending = false;
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    }
  }

  wake(): void {
    if (this.subscribers.size === 0) return;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule(0);
  }

  schedule(delay: number): void {
    if (this.running || this.timer !== undefined || this.subscribers.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delay);
  }

  async poll(): Promise<void> {
    this.running = true;
    this.wakePending = false;
    const startedAt = performance.now();
    const pending = [...this.subscribers];
    try {
      // 上限を設け、DB照会を重ねずに順次処理する。
      for (let offset = 0; offset < pending.length; offset += notificationBatchSize) {
        const batch = pending.slice(offset, offset + notificationBatchSize).filter((subscriber) => this.subscribers.has(subscriber));
        if (batch.length === 0) continue;
        let rows: NotificationRow[];
        try {
          rows = await this.db.select<NotificationRow>(`
    SELECT (recipient.ordinality - 1)::int AS slot, u.id AS user_id,
           notification.id, notification.posting_window_id, notification.region, notification.created_at
    FROM unnest($1::text[], $2::timestamptz[], $3::text[])
         WITH ORDINALITY AS recipient(user_id, connected_at, region, ordinality)
    LEFT JOIN users u ON u.id = recipient.user_id AND u.status = 'active' AND u.region = recipient.region
    LEFT JOIN LATERAL (
      SELECT n.id, n.posting_window_id, w.region, n.created_at
      FROM notifications n JOIN posting_windows w ON w.id = n.posting_window_id
      WHERE n.user_id = u.id AND n.created_at > recipient.connected_at AND w.ended_at IS NULL
      ORDER BY n.created_at, n.id LIMIT 1
    ) notification ON true
   `,
            batch.map(({ session }) => session.userID),
            batch.map(({ connectedAt }) => connectedAt.toString()),
            batch.map(({ session }) => session.region),
          );
        } catch (err) {
          logError("failed to get notifications", err);
          for (const subscriber of batch) this.remove(subscriber);
          continue;
        }
        for (const row of rows) {
          const subscriber = batch[row.slot];
          // SQL実行中に切断された接続へは送らない。
          if (!subscriber || !this.subscribers.has(subscriber)) continue;
          if (row.user_id === null) {
            this.remove(subscriber);
          } else if (row.id !== null) {
            const notification: GetNotificationsResponse = {
              id: row.id,
              postingWindowId: row.posting_window_id!,
              region: row.region!,
              createdAt: row.created_at!,
            };
            try {
              subscriber.controller.enqueue(new TextEncoder().encode(`data: ${marshalJSON(notification)}\n\n`));
            } catch {}
            this.remove(subscriber);
          }
        }
      }
    } finally {
      this.running = false;
      // 遅い照会中は次のpollを起動しない。完了後も待機を入れてbusy loopを防ぐ。
      this.schedule(this.wakePending ? 1 : Math.max(1, notificationPollInterval - (performance.now() - startedAt)));
    }
  }
}

export function getNotificationsHandler(h: HandlerContext,
  createWakeup = (wake: () => void): NotificationWakeup => h.db.createNotificationWakeup(wake),
): Handler<Env> {
  const poller = new NotificationPoller(h.db, createWakeup);
  return async (c) => {
    const session = getSession(c)!;
    const { clock_timestamp: connectedAt } = must(await h.db.get<{ clock_timestamp: Temporal.Instant }>(`SELECT clock_timestamp()`));
    const signal = c.req.raw.signal;
    let subscriber: Subscriber;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscriber = { session, connectedAt, signal, controller, onAbort: () => poller.remove(subscriber) };
        poller.add(subscriber);
      },
      cancel() {
        poller.remove(subscriber);
      },
    });
    return c.body(stream, 200, { "Content-Type": "text/event-stream" });
  };
}
