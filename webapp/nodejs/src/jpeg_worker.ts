import { parentPort } from "node:worker_threads";
import { decodeJPEG } from "./jpeg.ts";

parentPort!.on("message", (data: ArrayBuffer) => {
  const image = decodeJPEG(new Uint8Array(data));
  // 元の画像も返す。転送で本文のコピーを避け、保存するbytesを維持する。
  parentPort!.postMessage({ data, image }, [data]);
});
