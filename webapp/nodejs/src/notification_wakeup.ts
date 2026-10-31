import type pg from "pg";
import { logError } from "./response.ts";

export const notificationChannel = "isureal_posting_window_committed";

export interface NotificationWakeup {
  start(): void;
  stop(): void;
}

// LISTEN is registered in pool.onConnect, before the first borrower can query.
// No connection is reserved: idle pool clients receive events, and busy clients
// may receive them after their transaction. The normal poll remains the fallback.
export class PoolNotificationWakeup implements NotificationWakeup {
  wake: () => void = () => {};
  readonly clients = new Map<pg.ClientBase, () => void>();
  active = false;
  disposed = false;
  retryAt = 0;
  retryDelay = 250;

  start(): void { this.active = true; }
  stop(): void { this.active = false; }

  // One registration per physical connection, including pool reconnections.
  // If LISTEN fails, allow application queries and keep the periodic fallback.
  async connect(client: pg.ClientBase): Promise<void> {
    if (this.disposed || this.clients.has(client) || Date.now() < this.retryAt) return;
    const onNotification = (message: pg.Notification) => {
      if (this.active && message.channel === notificationChannel) this.wake();
    };
    const cleanup = () => {
      client.off("notification", onNotification);
      client.off("end", cleanup);
      this.clients.delete(client);
    };
    this.clients.set(client, cleanup);
    client.on("notification", onNotification);
    client.once("end", cleanup);
    try {
      await client.query(`LISTEN ${notificationChannel}`);
      this.retryAt = 0;
      this.retryDelay = 250;
      // Inspect again after LISTEN commits, covering the initial registration race.
      if (this.active && this.clients.has(client)) this.wake();
    } catch (err) {
      cleanup();
      this.retryAt = Date.now() + this.retryDelay;
      this.retryDelay = Math.min(30000, this.retryDelay * 2);
      logError("notification LISTEN failed; periodic polling continues", err);
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const cleanup of this.clients.values()) cleanup();
    // DB.end closes all physical connections and their LISTEN registrations.
    // Do not inject UNLISTEN into transactions owned by other requests.
  }
}
