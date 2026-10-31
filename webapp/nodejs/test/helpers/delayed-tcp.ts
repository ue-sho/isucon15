import net from "node:net";

// ローカル比較専用。TCP接続先は必ずloopback、片道ごとにRTT/2を加える。
export async function delayedTCP(targetPort: number, rttMs: number) {
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 1000) throw new Error("invalid test RTT");
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, rttMs / 2);
    timers.add(timer);
  };
  const server = net.createServer((downstream) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("close", () => sockets.delete(socket));
    }
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("data", (chunk) => later(() => { if (!upstream.destroyed) upstream.write(chunk); }));
    upstream.on("data", (chunk) => later(() => { if (!downstream.destroyed) downstream.write(chunk); }));
    downstream.on("end", () => later(() => upstream.end()));
    upstream.on("end", () => later(() => downstream.end()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  return { port: address.port, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
