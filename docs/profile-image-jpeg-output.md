# 拒否対象プロフィール画像のRGB出力生成を省く

PR #55のworker分離を前提とした追加改善。調査・計測・採否は [Issue #16](https://github.com/ue-sho/isucon15/issues/16#issuecomment-6540839487) に記録する。
ブランチ `perf/jpeg-validation-output`、起点main `993e1b0`。

## 維持する検証

プロフィール画像workerで使うdecoderに、完全parse後の分岐を追加する。
Huffman/entropy、progressive scan、量子化・IDCT、marker・成分の検証を最後まで行った後、512px超ならRGBへの変換・出力配列コピーを省く。
呼び出し元は従来どおり寸法超過を400で拒否し、破損画像は400かつ `invalid_image` として記録する。
出力を省く際も元の出力メモリ予算・対応色・成分行参照の条件を検証し、検証上限を緩めない。

SOF寸法を処理経路選択のヒントにするが、ヘッダーだけでは受理も拒否もしない。
正常サイズ、特殊・破損したmarker構成、64個以内のmarkerで判断できない入力は従来decoderを呼ぶ。
サイズ超過と判断した場合も完全decoderを実行し、フレームの解釈が異なれば実際の寸法に従う。

`src/vendor/jpeg-js/decoder.cjs` は既存依存jpeg-js0.4.4のコピーで、parse後の分岐以外は元ファイルと同一。
出典・元SHA256・BSD/Apacheライセンスを同ディレクトリに保持し、テストでソース一致を確認する。
新規依存は追加しない。投稿・RealMojiは元のdecoderを維持する。
workerの実行枠、元bytesのtransfer、保存、DB、キャッシュ、初期化は変更しない。

## 再現

Node.js26で以下を実行する。CPU比較は他のテストと同時実行しない。

```sh
cd webapp/nodejs
npm run check
node --test --test-concurrency=1 'test/**/*.test.ts'
node --expose-gc test/jpeg-profile.bench.ts
```

差分テストは合成JPEGだけを使う。grayscale/RGB/CMYK、progressive、非対応成分、512/513px、0寸法、途中切断、entropy破損、sampling異常、メモリ上限、特殊markerを従来版と比較する。
既存worker/APIテストで元bytes、保存の順序、abuse分類、キャンセル・worker再生成も確認する。

合成計測の6回中央値は、正常512pxの所要30.809→30.348ms、サイズ超過2048px単色のCPU582.053→398.798ms、1024pxノイズのCPU307.066→252.266ms。
本番のCPU寄与率やスコア向上を示す値ではない。実環境の改善効果は未確認。

## 採否・戻し方

本番比較は同じmainと初期条件で、asia1の通常worker・JPEG thread・地域別workerを分けてCPUを観測する。
プロフィール画像のstatus/abuse別時間、正常投稿/friends feedの完了数・p95、総スコア、メモリも比較する。
Redis画像認可キャッシュ（PR #64）の有効/無効を途中で変えず、効果を混ぜない。

戻す場合は `jpeg_worker.ts` のimportと呼び出しを `decodeJPEG` に戻して再反映する。
DB・キャッシュの復元は不要。反映・再起動・初期化・競技ベンチは対象と順序を合わせて実施する。
