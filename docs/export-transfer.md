# exportのDB転送量削減

2026-10-31、[Issue #44](https://github.com/ue-sho/isucon15/issues/44)。変更前はmain `ef058e7`。`GET /api/me/export` の画像取得だけを対象にする。

## 観測と原因の切り分け

- ユーザー提示のpprotein [Asia HTTP集計](http://localhost:9000/#/group/2026-10-31_05-07-22.522473/httplog/dmirhbpznryt-httplog.log/) は11件すべて2xx、累積58.102秒、平均5.282秒、最大/p95 19.681秒、本文520356〜5499686 bytes。URLはユーザーが確認した。ブラウザは応答停止のため今回のprofile/SQL実測の再取得はできていない。
- 対応するベンチは [#15863](https://portal.isucon.net/contestant/benchmark_jobs/15863)、14:07:22〜14:09:20 JST、4788点・Passed・減点0・messages空、計測版 `bf44a84`。この版のexport本体は変更前mainと同じ。
- JPEGはすでにZIPのSTORE、posts.jsonだけDEFLATE。画像を再圧縮するCPUコストではない。
- 共有PGへREAD ONLY、statement_timeout=3s、lock_timeout=250msで `EXPLAIN (GENERIC_PLAN TRUE)` を実行。作者索引→画像36partitionのPK lookup→posting_windowsとの結合。全画像Seq Scanはなく、cost 16592.13 / 推定386行。このcostは秒数ではなく、実負荷の実行時間・pool待ち・I/O待ちは未測定。
- `SHOW bytea_output` はhex。pgの現DBクラスはtext結果を取得するため、DB→Nodeでは画像1byteが16進2文字になる。[PostgreSQL 16のbytea仕様](https://www.postgresql.org/docs/16/datatype-binary.html#DATATYPE-BINARY)でも既定hexと2桁/byteを確認した。

確認できた無駄はDB転送量であり、実ベンチの5.282秒や19.681秒の主因を確定したわけではない。Asia内通信、DB負荷、event loop待ち、HTTP本文転送の寄与は別途比較が必要。

## 変更

SQLの画像projectionを `encode(i.data, 'base64') AS image_data_base64` にし、ZIP登録前に `Buffer.from(value, 'base64')` で復元する。PostgreSQLのbase64には改行が入るが、Nodeのデコードで正しく復元する。

DB内のbytea、SQLのJOIN・絞込み・順序、認証、ZIP内のJSON・画像名・画像bytes、署名、有効期限、レスポンスヘッダーを維持。全量取得・ZIP生成方式は今回変更せず、返す件数も制限しない。DDL・依存追加・キャッシュ・初期化変更は不要。DB側のbase64変換CPUは増えるため、帯域に余裕がある環境での効果を同一視しない。

## ローカル検証

Node 26.12.1、DockerのPostgreSQL 16.13、新規専用DBを127.0.0.1だけに公開して使用。共有DBの行・画像データは取得しない。

- `EXPORT_TEST_PG_PORT=<port> node --test test/export-api.test.ts`: 6件成功、失敗0、skip0。
- 旧実装のreference handlerとZIP全エントリをCRC確認後に展開してバイト比較。JSONの改行・Unicode escaping・画像署名・時刻精度・順序・連番パスも一致。
- 0件、64件の履歴、初期/最近のpartition、全byte値・padding・base64改行、別作者除外、画像欠損、投稿削除・caption/画像更新、未認証・地域不一致・退会・session失効、データ再作成後の旧画像不使用を確認。
- 型検査 `npm run check` と `git diff --check` 成功。
- 追加で既存署名・page-response試験を実行し、計51件中30成功・21失敗。失敗21件はpage-responseのHMAC回数期待値で、変更前main `ef058e7` の独立展開でも同じ21件が失敗（35件中14成功）。今回のexport差分とは独立の既存不整合として残す。全体テスト合格とは報告しない。

`test/export-transfer.bench.ts` は旧handlerと新handlerを同じローカルPG・TCPプロキシで比較する。100投稿・各50KiBのランダムbyte列、合計5120000 bytes、ZIPは両版5135949 bytes。JPEGエンコードは行わずSTOREの入力を模擬。各版1回warmup後、順序を交互に3回ずつ実行。サーバー→Node方向のPGプロトコルbytesを数える。

| 指標 | 変更前hex | 変更後base64 |
| --- | ---: | ---: |
| DB受信bytes/回（ユーザー取得も含む） | 10258346 | 6934753 |
| 2MiB/s制限時の応答ms、3回 | 5248 / 5265 / 5269 | 3608 / 3600 / 3615 |
| 上記中央値 | 5265ms | 3608ms |
| 同条件の画像SELECT待ち | 5194〜5199ms | 3528〜3538ms |
| 同条件の残り（ZIP等とユーザー取得） | 49〜71ms | 64〜80ms |
| 帯域制限なしの応答ms、3回 | 78 / 94 / 78 | 84 / 80 / 80 |

転送量32.4%減、帯域制限ありでは応答中央値31.5%減。帯域制限なしでは中央値78→80msで、短縮は確認できなかった。**2MiB/sはローカルで設定した仮想条件で、本番帯域の測定値ではない。** APIはHonoへローカル呼び出しし、クライアントまでの実ネットワーク・nginx・本番同時負荷は含めない。ベンチスコアと分けて評価する。

再現時は使い捨てPGを起動し、そのloopbackポートを指定する:

```sh
cd webapp/nodejs
npm ci --no-audit --no-fund
EXPORT_TEST_PG_PORT=<local-pg-port> node --test test/export-api.test.ts
EXPORT_BENCH_PG_PORT=<local-pg-port> EXPORT_BENCH_MIB_PER_SECOND=2 node test/export-transfer.bench.ts
npm run check
```

試験は新しい専用DBを作成する。試験用コンテナは作成者が終了後に停止・破棄する。

## PRと本番ベンチ

PRはmain基準のexport差分のみ。調査中の本番は #40 `perf/nginx-image-files @ 7331c86` であり、#33世代管理・#42索引等を含む。mainだけから分岐した本PRをそのままデプロイすると、現在の未マージ改善を戻してしまう。

このためベンチ用に別の `bench/export-archive` ブランチへ現在の #40版と本変更を統合する。実装PRのheadとベンチ用headは別で、両方を記録する。#39の認証再利用とはexport冒頭で同時編集になり得るが、本変更はprojection/復元部分だけなので両方維持できる。

ベンチはユーザーが実行する。#40単体の同構成結果を基準とし、今回のexport版との地域別export件数・成功・avg/p95・全体スコア・他APIを比較する。#15863との差をexportだけの効果とは扱わない。計測前後に別のデプロイ・画像書き出し・DDLを重ねない。

追加migrationは不要。切り戻しはベンチ用ブランチのexport変更だけをrevertするか、固定した元の #40版へ戻す。DBの保存形式や既存画像ファイルは今回変更しない。共有環境のデプロイ・再起動・initialize・競技ベンチ・マージは実施していない。
