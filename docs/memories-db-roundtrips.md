# MemoriesのDB往復削減

**実装対象は2 SQL案。本番採用は保留。** 正しさとDB往復削減は確認できたが、ローカルpool2の4同時要求ではthroughputが旧版を下回った。特に少量反応は117.460→91.995 req/s（約21.7%低下）、単発APIは15.50→17.01ms。性能改善済みとして扱わず、Draft PRで比較結果を共有する。

## 変更

投稿取得・投稿の署名生成・RealMoji取得・RealMojiの署名生成・コメント取得が直列になっていた。投稿別50件制限を維持し、RealMojiとコメントを型付きの `UNION ALL` へまとめ、非空ページのデータ取得を3 SQLから2 SQLへ減らす。認証等の共通SQLはこの回数に含めない。空ページは投稿取得1 SQLのまま。

`memory_api.ts` は先に投稿と反応を取得し、その後で既存の `newPostResponse` / `newRealMojiResponse` / `newCommentResponse` を呼ぶ。DB処理をPromise.allで並列化せず、1要求が同時に使う接続は最大1本。接続数やworker数は変更しない。

専用helper `memory_interactions.ts` はactive・未削除・RealMojiの未差替えを絞り込んでから、投稿ごとに順位を計算し、各種類50件以下を返す。RealMojiは日時・ID降順、コメントは昇順。UNIONの出力順には依存せず、取得後の最大5,000行を順位順に整える。全体LIMITで投稿別上限を代用しない。

投稿の51件目はhasMore判定だけに使い、反応取得と署名生成の対象にしない。日時はJSON集約せず `timestamptz` として受け取り、共通DBのTemporal parserを使う。数値、bio公開条件、画像URL、署名方式は既存の行変換・応答関数を使う。

## 比較する案

- 旧版: main `993e1b0dd58d68d7b63e77bff26d046d2a0173b3` のハンドラーを `test/fixtures/memory-before-roundtrips.ts` に固定。投稿別50件制限を含む。共有の署名・認証・応答処理は新案と同じ版を使う。
- 2 SQL案: 投稿取得後、反応2種類をまとめて取得する。
- 1 SQL案: 投稿候補CTEを共有し、返却対象50投稿の反応を合わせて取得する。異なる投稿/反応の列はNULLで埋める。`test/fixtures/memory-single-snapshot.ts` に比較用実装を置き、本番フラグは追加しない。

最初の2 SQL試作はUNION後にもDB内で全体ソートしていた。大量反応で追加費用が見られたため、最終案は取得後の順位整列に変えた。以前の投稿別LATERAL LIMIT案は再実装していない。[既存の比較](memories-interaction-limit.md)とは別の改善である。

## 比較条件

- 新規の隔離PostgreSQL 16、loopback限定、DB `memories_test`。専用schemaに現在の `001-schema.sql` と合成データを入れANALYZEする。共有DB・生データは使わない。
- 既存の実PG試験データを `fixtures/memory-data.ts` へ分離して再利用。旧制限試験は固定した変更前ハンドラーの回帰試験として維持し、新試験で現行ハンドラーと比較する。
- 境界・偏り（51投稿、反応0/49/50/51/5,000件等）、少量（50投稿×10件）、大量（50×1,000件）、削除等混在（有効100件＋無効900件/投稿）。
- Node.js 26.12.1、pool=2、同じホスト・DB・データ・署名実装。署名native化を混ぜない。
- SQL時間は接続取得から転送・pg解析までの逐次実行時間。各案2回warm-up後8回、案の順序を交互にする。
- 受信量は専有中のpgソケットの `bytesRead` 差分。PostgreSQLプロトコルを含み、TCP/IPヘッダーは含まない。
- APIはHonoのin-process requestから本文読取りまで。実DBの認証・地域確認、署名、JSON化を含む。HTTPネットワーク・nginx・リージョン間遅延は含めない。
- 単発と4要求同時を各4組、案の順序を交互にする。各組の前に署名世代更新と同じ案のwarm-upを1回行い、計測区間から除く。時刻・署名期限を固定する。署名が2,048件を超える場合、warm-up後も全てcache hitにはならない。throughputは4件同時投入の完了件数/秒であり、長時間の定常負荷ではない。
- pool待ちは `pool.connect()` 開始からclient取得までの壁時計時間。Nodeイベントループ待ちも含み、PG内のlock待ちとは異なる。
- DB内負荷は実際のprepared statementを同じ接続で `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` し、generic/custom利用数、buffer、temp I/Oを確認する。SQL時間・API時間と加算しない。

## 最終版の比較結果

PostgreSQL 16.13 / aarch64、work_mem=4MB、shared_buffers=128MB、jit=on、plan_cache_mode=auto。実装・共有処理はmain `053af6e` を基準に比較した。ホストを専有していないため、絶対時間と小さい差は環境依存。

表の三つの値は **旧3 SQL / 実装2 SQL / 比較1 SQL** の順。SQL時間は8回の中央値。API時間は単発4回の中央値。

| 条件 | 返却行数（全案同じ） | PG受信bytes | SQL ms | 単発API ms |
|---|---:|---|---|---|
| 境界・偏り | 719 | 401,584 / 411,412 / 482,696 | 11.63 / 11.39 / 13.94 | 23.60 / 26.71 / 37.55 |
| 少量 | 1050 | 583,119 / 598,089 / 702,265 | 6.01 / 5.84 / 8.54 | 15.50 / 17.01 / 21.33 |
| 大量 | 5050 | 2,867,021 / 2,943,989 / 3,452,165 | 79.47 / 81.57 / 106.33 | 1,838.67 / 1,814.78 / 1,844.00 |
| 削除等混在 | 5050 | 2,892,921 / 2,969,889 / 3,478,065 | 25.22 / 25.46 / 39.71 | 1,818.47 / 1,877.79 / 1,826.16 |

4同時要求の各batchから件数/秒と1要求平均pool待ちを求め、その4batchの中央値を載せる。API待ちが減っても、throughputが増えたとは限らない。

| 条件 | throughput（req/s） | pool取得待ち（ms/要求） |
|---|---|---|
| 境界・偏り | 95.324 / 78.058 / 67.261 | 11.53 / 14.82 / 17.39 |
| 少量 | 117.460 / 91.995 / 82.720 | 8.34 / 10.47 / 10.98 |
| 大量 | 0.572 / 0.540 / 0.548 | 1,744.42 / 526.54 / 517.19 |
| 削除等混在 | 0.555 / 0.551 / 0.553 | 1,763.15 / 482.07 / 491.52 |

単発APIの最小〜最大（4回）:

| 条件 | 旧3 SQL ms | 実装2 SQL ms | 比較1 SQL ms |
|---|---|---|---|
| 境界・偏り | 22.04〜42.93 | 15.60〜33.06 | 33.31〜111.71 |
| 少量 | 13.12〜16.85 | 16.44〜20.16 | 19.62〜22.69 |
| 大量 | 1,830.24〜1,853.71 | 1,807.45〜1,942.76 | 1,820.34〜1,922.51 |
| 削除等混在 | 1,744.68〜1,902.36 | 1,767.92〜2,095.42 | 1,792.36〜1,870.32 |

実際のprepared statementのEXPLAINを同じ接続で実行した結果。全案でcustom plan 5回の後にgeneric planが選択されていた。DB内時間は単回の診断値であり、繰り返しAPI測定と区別する。hit/tempは各データSQLの合計。全案のshared readは0。

| 条件 | DB内 ms | shared hit blocks | temp read/write blocks |
|---|---|---|---|
| 境界・偏り | 9.09 / 8.97 / 10.48 | 1771 / 1771 / 1771 | 494,495 / 494,495 / 494,495 |
| 少量 | 2.26 / 3.25 / 3.92 | 589 / 589 / 589 | 0,0 / 0,0 / 0,0 |
| 大量 | 96.79 / 82.28 / 86.73 | 5145 / 5145 / 5145 | 6207,6219 / 6207,6219 / 6207,6219 |
| 削除等混在 | 14.96 / 23.20 / 35.30 | 5331 / 5331 / 5331 | 0,0 / 0,0 / 0,0 |

生結果: `/tmp/memories-roundtrips-final.json`（ローカルのみ、Git対象外）。最初の順位のみ整列した試作は `/tmp/memories-roundtrips-comparison.json`。最終版は投稿ごとにまとめて順位順に変換し、旧版と署名呼出し順をそろえ、行のコピーも省いた。初回と最終版の測定値を一つの改善幅として足し合わせない。

## 選定理由と限界

2 SQL案を実装対象に選んだ理由は、1 SQL案より小さな変更で1往復を削減でき、型とページ契約を保てるため。型付きのUNIONに伴いPG受信量は旧版比約2.4〜2.7%増える。1 SQL案は約20.0〜20.4%増え、全条件でSQL時間が悪化した。投稿/反応の異なる列の射影と再分離も必要で、今回は本番コードへ採らない。

2 SQL案でも4同時要求のthroughputは全条件で旧版を下回った（約0.7〜21.7%）。大量条件のpool取得待ちは減ったが、完了件数/秒の改善を意味しない。単発APIの範囲も重なる条件がある。DBのbuffer hit・temp I/Oは最終計画で旧版と同じだったが、DB内時間が常に短縮したとは言えない。

ループバック計測には地域間の往復遅延がない。通信遅延のある実環境で往復削減が効く可能性は未検証であり、今回の悪化を打ち消せるとは仮定しない。本番でも退行する場合はこの変更を採用しない。署名native化や別担当の改善率を加算しない。

## snapshotと並行更新

Read CommittedではSELECTごとに開始時点のsnapshotを見る。従来は投稿・RealMoji・コメントが別snapshotだった。2 SQL案は投稿と反応が別、2種類の反応は同じsnapshotになる。1 SQL案は投稿も同じsnapshotにする。[PostgreSQL 16の説明](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)

[当日マニュアル](manual-2026-10-31.md)の「データの反映」は、書き込み成功後の読み取りへの反映を求める。新要求は毎回DBを読み、完了済み更新を反映する。要求実行中の更新について、旧実装の混在snapshotと常に同じJSONになるとは主張しない。

試験ではSELECTをadvisory lockで待機させ、snapshot確定後に別接続からRealMojiとコメントを削除してCOMMITする。旧版はRealMoji旧・コメント新が混在し、新案は両反応とも旧snapshot、次要求では両方とも削除済みになることを検証する。これはテストだけの同期で、本番にロックを追加しない。

## 正しさの確認項目

- 月別・日別、空、不正年月日/時刻、片側だけのcursor。
- 投稿0/49/50/51件、同じmicrosecond時刻で50件目をまたぐID cursor、位置の数値型。
- 投稿別反応上限、反応の同時刻ID順、削除・差替え・inactive/deletedユーザー除外。過去枠・友達なし・双方向blockがある履歴。
- HTTP status、Content-Type、署名付きURLを含むJSON全文一致。
- 投稿・反応・ユーザーの更新/削除、プロフィール画像変更、bio公開条件、並行削除後の再取得。
- 非空ページのデータSQL数3→2、返却行数維持、要求ごとの同時接続数1。
- 既存ページング/署名試験で51件目に署名を生成しないことも確認する。

最終確認結果: `npm run check` 成功。新しい実PG比較試験1成功・0skip（約354秒）、既存の実PG制限試験1成功・0skip（約16秒）。ページング・署名の関連試験47成功・0失敗・1 opt-in skip。skipは別プロセスの署名世代試験で、今回の実PG試験とは別。差分検査も成功。

## 再現

Node.js 26以上、Dockerのpostgres:16を使う。空の専用コンテナ以外へ向けない。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-memories-db-roundtrips/webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
docker run --detach --rm --name isucon15-memories-roundtrips-recheck \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=memories_test \
  -p 127.0.0.1::5432 postgres:16
docker exec isucon15-memories-roundtrips-recheck pg_isready -U postgres -d memories_test
MEMORIES_PG_PORT=$(docker port isucon15-memories-roundtrips-recheck 5432/tcp | cut -d: -f2) \
MEMORIES_PG_BENCHMARK=1 MEMORIES_REPORT_PATH=/tmp/memories-roundtrips.json \
  node --test test/memory-roundtrips-postgres.test.ts
npm run check
docker stop isucon15-memories-roundtrips-recheck
```

`MEMORIES_PG_PORT` なしは明示的skip。API時間測定の繰り返しが不要な回帰確認では `MEMORIES_PG_BENCHMARK` を外す。各試験が専用schemaを作成・終了時削除する。生の結果はGit対象外の `/tmp` に出力する。

## 反映前提と未確認事項

この変更固有のDDL・依存追加はない。mainのDB migrationは適用済みか確認し、適用済みSQLを再実行しない。戻す場合はこの変更をrevertして再デプロイする。

提出前にmain `053af6eca4400864c62269ca6188d6701dd8a7a3` を取り込んだ。追加差分は計測停止構成とinitializeの収集停止で、Memories・署名・DBスキーマは変更していない。今回のPR固有のnginx/systemd/pool変更はない。このmainはpprotein/agentとアクセス・SQL計測を停止するため、本番比較では計測条件をそろえる必要がある。

**共有環境のDDL・デプロイ・再起動・公式ベンチ・マージは未実施。** 本番分布・索引・統計、リージョン間遅延、DBとのCPU競合、他API混合負荷、初期化全体、独立worker/再起動、得点への効果は未確認。SQL回数や局所測定の改善をスコア向上と同一視しない。
