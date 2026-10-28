// isutools: ベンチ開始時に pprotein の一括収集を起動するスニペット。
//
// 貼り付け手順:
//   1. この関数をアプリのソース（例: src/pprotein.ts）にコピーする
//   2. POST /api/initialize ハンドラの先頭で triggerPproteinCollect() を呼ぶ（await しない）
//
// PPROTEIN_ENABLED / PPROTEIN_URL は systemd drop-in（isutools.conf）から渡される。
// 自動収集を止める場合は、手動で PPROTEIN_ENABLED=0 に変更する。
// 失敗してもベンチ（/initialize）には影響させない。

export function triggerPproteinCollect(): void {
  if (process.env.PPROTEIN_ENABLED !== "1") return;
  const url = `${process.env.PPROTEIN_URL}/api/group/collect`;
  // pprotein は収集が終わるまで応答しないことがあるため、短いタイムアウトで切る（収集自体は続く）
  fetch(url, { signal: AbortSignal.timeout(2000) })
    .then((res) => {
      if (!res.ok) console.error(`[pprotein] collect: HTTP ${res.status}`);
      return res.body?.cancel();
    })
    .catch((e: unknown) => {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") return;
      console.error("[pprotein] collect failed:", (e as Error)?.message ?? e);
    });
}
