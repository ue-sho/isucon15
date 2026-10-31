import { parentPort } from "node:worker_threads";

// Queue/lifecycle tests use a deterministic slow worker, without huge images.
parentPort!.on("message", (data: ArrayBuffer) => {
  const command = new Uint8Array(data)[2];
  if (command === 1) process.exit(1);
  if (command === 2) throw new Error("synthetic decoder failure");
  // Occupy this thread while the main event loop serves other requests.
  const end = performance.now() + 100;
  while (performance.now() < end) { /* CPU work */ }
  parentPort!.postMessage({ data, image: { width: 1, height: 1 } }, [data]);
});
