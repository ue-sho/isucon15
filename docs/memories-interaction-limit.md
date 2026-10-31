# Memoriesの投稿別リアクション取得制限

2026-10-31（JST）。作業ブランチは `perf/memories-interaction-limit`。以下の初回計測は基準 `1ecea18` に対する実装コミット `e4450eb` の結果。初回 `memory_api.ts` のSHA-256は `59f3798cf25b16188e3dcbfdf9f79613e689d18735f031539958466c03d52d7d`。main取り込み後の条件・結果は末尾の追補と区別する。

## 判断と変更

ローカルの合成データでは、50投稿×有効反応1,000件の場合、種類ごとに50,000行を取得して2,500件だけ返していた。過剰取得は95%。一方、50投稿×10件では取得・返却とも500件で、取得量の削減余地はない。

投稿別に `row_number() OVER (PARTITION BY post_id ORDER BY created_at, id)` を付け、順位50以下をDBから返す方式をローカルの候補として実装した。RealMojiは両列DESC、コメントは両列ASCにする。全体LIMIT 2500は使わない。

`memoryPostQueryer` が既存helperのSELECTを包み、既存のactive・未削除・未差替え条件を適用した結果に順位を付ける。helperの行変換、応答生成、画像署名は再利用する。SQLは種類ごとに1回のまま。Node側の50件ガードも維持する。外側のORDER BYにも投稿IDと同じ日時・ID順を指定し、投稿内の順序を保証する。

変更範囲は `memory_api.ts`、専用テスト、本メモだけ。投稿ページング、現在の投稿枠、友達、blockによる制限を変更・追加していない。`comment.ts`、`realmoji.ts`、他担当の `page-response.test.ts` は編集していない。インデックス・スキーマ・依存関係の変更もない。

**本番の反応件数分布は未確認。** 今回は専用worktreeとローカルDBだけで検証した。共有環境の負荷・他担当の計測状況を調整していないため、共有DBでの集計、DDL、デプロイ、再起動、公式ベンチは実施していない。本番採否とスコア効果は保留。実データで大半が投稿別50件以下なら、この変更を見送る理由になる。

## 初回の比較条件

- PostgreSQL 16.13、Docker `postgres:16`、aarch64。専用コンテナのloopbackポートのみ使用。
- Node.js 26.12.1。リポジトリの `001-schema.sql` を新規のテスト専用schemaに適用し、追加インデックスなしでANALYZE。
- `work_mem=4MB`、`shared_buffers=128MB`、`plan_cache_mode=auto`、`jit=on`、`max_parallel_workers_per_gather=2`。コンテナ独自のCPU・メモリ制限なし。ホスト全体の他作業を停止した専用機ではない。
- 投稿201件、各反応表111,908件、users 5,906件の合成データ。同じDB・データ・接続プールサイズ1で旧・新を比較。
- 旧SQLは変更していない `selectCurrentRealMojis` / `selectCommentsWithAuthor` から元のIN句・ORDER BYで生成。旧モードではSQLのみ差し替え、同一のMemoriesハンドラーと元のNode側50件ガードを実行する。
- SQL時間は `DB.select` の待ち時間（DB実行、転送、pgの日時等の解析を含む）。旧・新の順を交互にし、各2回のwarm-up後8回の中央値。
- DB内時間は実際に使ったprepared statementへの `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) EXECUTE`。旧・新を交互に各1回warm-up後6回。ノードごとの時計計測による比較の歪みを避ける。generic/customの選択回数も保存する。
- API時間はHonoのin-process request開始から応答本文の読み取り完了まで。実DBの認証・リージョン確認、投稿・反応取得、行変換、画像署名、JSON化を含む。旧・新各1回warm-up後、旧新→新旧→旧新→新旧の各4回。HTTPネットワーク、nginx、ルーター、画像本体の取得は含まない。
- テスト内だけ `Temporal.Now.instant()` を固定し、署名・有効期限も含むJSON全文、HTTP status、Content-Typeを比較する。実装の時刻処理や署名処理は変更しない。

境界ケースは先頭50投稿に有効反応0/49/50/51/5,000件と45投稿×3件を配置。51投稿目には3件あり、1ページ目の反応取得対象に入らない。削除・inactive等の無効反応120件を各投稿へ追加する。大量ケースは50投稿×有効1,000件、少量ケースは50投稿×有効10件、削除混在ケースは50投稿×有効100件＋無効900件。コメント本文512文字、ユーザーbio64文字、2人にprofile画像を設定した。

## 取得件数

以下は1ページ・**反応1種類あたり**の件数。RealMoji・コメントとも同じ結果。

| 条件 | 旧DB取得 | 旧API返却 | 新DB取得・新API返却 | DB取得行数の削減率 |
|---|---:|---:|---:|---:|
| 境界値・5,000件の偏り | 5,285 | 334 | 334 | 93.68% |
| 少量（50×10） | 500 | 500 | 500 | 0% |
| 大量（50×1,000） | 50,000 | 2,500 | 2,500 | 95% |
| 削除等の混在（有効50×100） | 5,000 | 2,500 | 2,500 | 50% |

無効反応は旧実装でもDBで除外されるため、旧DB取得件数には含めていない。ただしDB内の走査対象にはなる。DBから返す行数の減少と、DBが調べる行数の減少は別である。

## 時間と実行計画

単位はms、各欄は旧→新の中央値。SQL時間とDB内時間は別の計測であり、足し合わせない。

| 条件 | RealMoji SQL | コメントSQL | RealMoji DB内 | コメントDB内 | API |
|---|---:|---:|---:|---:|---:|
| 境界値・偏り | 13.21 → 4.86 | 21.60 → 5.86 | 3.31 → 4.18 | 6.61 → 4.73 | 624.8 → 588.5 |
| 少量 | 3.22 → 2.74 | 2.79 → 3.15 | 1.38 → 1.16 | 1.14 → 0.96 | 731.3 → 734.9 |
| 大量 | 130.12 → 45.43 | 185.15 → 43.21 | 53.84 → 40.96 | 43.81 → 39.40 | 3039.8 → 2684.4 |
| 削除等混在 | 19.46 → 12.63 | 35.05 → 16.56 | 11.06 → 8.41 | 13.54 → 7.31 | 2740.7 → 2612.2 |

APIの最小〜最大（各4回）:

| 条件 | 旧API | 新API |
|---|---:|---:|
| 境界値・偏り | 614.8〜663.7 | 577.9〜594.1 |
| 少量 | 724.6〜744.7 | 720.9〜744.9 |
| 大量 | 2941.9〜3170.3 | 2624.6〜2769.5 |
| 削除等混在 | 2654.6〜2950.9 | 2577.5〜2825.0 |

大量条件ではAPI中央値が約11.7%短縮した。少量は取得量が変わらず、コメントSQLが2.79→3.15ms、APIが731.3→734.9msと微増している。削除混在は最終測定の中央値では短縮したが範囲が重なり、予備計測には少量・混在のAPIが悪化した試行もあった。API改善が全分布で再現すると判断しない。

走査・sortの確認結果:

| 条件 | RealMoji shared hit（旧→新） | コメントshared hit（旧→新） | sort入力行（各種類） |
|---|---:|---:|---:|
| 境界値・偏り | 532 → 532 | 1,227 → 1,227 | 5,285 → 5,285 |
| 少量 | 275 → 275 | 302 → 302 | 500 → 500 |
| 大量 | 1,023 → 1,023 | 9,288 → 4,110 | 50,000 → 50,000 |
| 削除等混在 | 1,118 → 1,118 | 9,288 → 4,201 | 5,000 → 5,000 |

- 最終案のRealMojiは旧と同じ候補行を索引走査。コメントは大量・混在で旧の並列全表走査から対象投稿の索引走査へ変わり、走査範囲とbuffer hitが減った。少量・境界では走査量が同じ。全ケースでshared readは0（warm cache）。
- 外側ORDER BYはwindowの並びを再利用し、追加sortは発生しなかった。sort入力行数は減っていない。旧の並列sortは各workerの入力を合計して比較し、EXPLAINの平均行数×loopsには丸め誤差がある。
- 少量のsortメモリはRealMoji 158→162KB、コメント400→401KBと微増。混在のRealMojiも1,561→1,596KB。投稿IDをsort keyに加える費用がある。
- 大量のtemp read/writeはRealMoji 1,640/1,643→1,602/1,605 blocks、コメント4,635/4,644→4,605/4,614 blocks。追加のspillや繰り返し走査は見られなかったが、ディスクsort自体は残る。コメント旧計画のworker別sort容量と新計画の単一sort容量を、そのまま1対1で比較しない。
- 境界ケースのRealMoji DB内時間は3.32→4.18msへ増えた（交互6回でも確認）。走査量・sort入力は同じで、順位計算とsort key追加の費用を含む。取得・解析を含むSQL時間とAPI時間は減ったが、「DB内負荷が一切増えない」とは結論しない。
- `plan_cache_mode=auto` で旧はcustom plan、新はgeneric planを使った。実際のprepared statementをEXPLAINし、任意のplan設定を強制していない。本番の統計・件数・prepared statementの実行履歴で計画が変わり得る。

## 初回基準版でのLATERAL案との比較

既存helperのSQL全体を `unnest(postIDs) CROSS JOIN LATERAL (...)` で包み、その内側で条件適用後に投稿別LIMIT 50を取る案も実PostgreSQLで試した。応答全文・取得件数は一致した。

大量反応では投稿ごとのtop-N heapsortと最大2,500行の外側sortになり、試行時には旧SQLのディスクsortが消えた。一方、少量反応では追加の投稿別sortが50回発生し、shared buffer hitもRealMoji 275→323、コメント302→348に増えた。各投稿の候補行は索引で取得し、usersのhashは再利用されたため、users全表を50回読み直す計画ではなかった。

本番分布が不明な状態で、取得削減のないページにも索引アクセスとsortを増やすLATERAL案は採用しなかった。順位方式は追加の投稿別索引探索を避けられるが、DB内の候補行走査とsortを打ち切る方式ではない。特に大量反応のディスクsortは残る。DB時間がすべての分布で改善する保証はない。

## 検証内容

専用テストは `webapp/nodejs/test/memory-interactions-postgres.test.ts`。

- 有効0/49/50/51/5,000件、最大50投稿に各1,000件、少量反応。
- コメント削除、RealMoji削除・差替え、ユーザーinactive/deletedの混在。無効行を選択方向の先頭に置き、除外が上位50件の選択より前であることを確認。
- 3件ずつ同じmicrosecondの日時にし、50件の境界でも日時＋IDのASC/DESCが一致することを期待ID列で検証。
- 終了済み投稿枠、現在枠に自分の投稿なし、友達なし、双方向のblockがあるユーザーの反応も履歴として取得。
- 月別・日別の先頭ページ、51投稿目へのカーソル、空の月・日、不正なページングと日付。空ページでは反応SQLが0回。
- SQLは各1回、取得行数は返却件数と一致。応答の投稿順、`hasMore`、反応順、profile画像URL・RealMoji画像URLの署名も含めて旧応答と一致。

`npm run check` 成功、実PostgreSQLでの専用テストは成功（1 test、skip 0、約85秒）。ポート指定なしではこのテストは明示的にskipするため、通常の `npm test` だけを実DB検証の成功と扱わない。

## 再現方法

対象worktreeは `/Users/yk/Documents/private/isu-con/isucon15-memories-interaction-limit`。次は現行ブランチでローカルの空DBを新しく起動する手順であり、共有DBへ向けない。初回の数値を再現する場合は `e4450eb` の版が必要。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-memories-interaction-limit/webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
docker run --detach --rm --name isucon15-memories-recheck \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=memories_test \
  -p 127.0.0.1::5432 postgres:16
docker exec isucon15-memories-recheck pg_isready -U postgres -d memories_test
docker port isucon15-memories-recheck 5432/tcp
# 上で表示されたポート番号を設定する
MEMORIES_PG_PORT=表示されたポート \
MEMORIES_PG_BENCHMARK=1 MEMORIES_REPORT_PATH=/tmp/memories-comparison.json \
  node --test test/memory-interactions-postgres.test.ts
npm run check
docker stop isucon15-memories-recheck
```

テストは `127.0.0.1` / DB名 `memories_test` 固定。独自schemaを新規作成し、そのschemaだけを終了時に削除する。アプリのenvや認証情報は読まない。`pg_isready` が未readyならreadyになってから実行する。今回のローカル集計JSONと診断ログは、このworktreeのGit対象外 `.isutools/memories-interaction-limit/` に保存する。データ・ログはコミットしない。

戻す場合はこの変更のコミットをrevertすればよく、DDLやデータの巻き戻しは不要。本番反映する場合は、まず担当者と共有DBの計測を調整し、代表的な履歴ページの有効件数・取得/返却差、実際の索引と統計、同条件のAPI時間・ベンチ結果を確認する。

## SQLの参照先

- [PostgreSQL 16: Window Functions](https://www.postgresql.org/docs/16/tutorial-window.html): WHEREで除外された行はwindow関数の対象外。投稿ごとの順位と外側での絞り込みに利用。
- [PostgreSQL 16: LATERAL](https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-LATERAL): 比較した投稿別LIMIT案。
- [PostgreSQL 16: Using EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html)、[PREPARE](https://www.postgresql.org/docs/16/sql-prepare.html): DB内実行時間と転送時間の区別、実際のprepared statementの計画確認。

## main取り込み後の再検証（2026-10-31）

画像署名キャッシュ・初期化世代管理・51投稿目の署名省略を含むmain `fa082c17ae958fd1a3ff24fa24604a5b1c74b2bc` を取り込み、同じ合成データで再検証した。さらに `2c9e2fd786f4898e484fc29077f3d920ca2cb4d2` のfriendsフィード変更も取り込む。この追加差分はMemories・署名・DBスキーマ・運用ツールを変更していない。以下の計測はfa082c1版の共通処理を使った旧反応SQLと新反応SQLの比較であり、上の初回数値と混ぜない。

既存テストの簡易DBはselect/getだけを実装していたため、ラッパー生成時のexec.bindをやめ、get/execを呼ばれた時だけ元DBへ委譲するようにした。共有helperとpage-response.test.tsへの独自変更はない。mainから取り込んだ既存変更は維持した。

API時間は各サンプルの直前にテスト専用DBの署名世代を進め、同じ実装で1回warm-upしてから計測する。リセットとwarm-upは計測区間外。旧・新が異なるSQL行順で、相手のLRU状態を引き継ぐ影響を避けるためである。各4回・順序交互、SQLは各8回、EXPLAINは各6回。スキーマ・索引も取り込み後の001-schema.sqlを使用し、独自のDDLは追加していない。

| 条件 | DB取得（各種類、旧→新） | RealMoji SQL ms | コメントSQL ms | API ms |
|---|---:|---:|---:|---:|
| 境界値・偏り | 5,285 → 334 | 12.49 → 4.82 | 22.47 → 5.54 | 49.35 → 22.57 |
| 少量 | 500 → 500 | 3.19 → 2.48 | 2.58 → 2.79 | 16.58 → 20.32 |
| 大量 | 50,000 → 2,500 | 116.16 → 40.14 | 174.88 → 37.99 | 2863.85 → 2573.44 |
| 削除等混在 | 5,000 → 2,500 | 16.16 → 11.42 | 26.95 → 13.98 | 2552.55 → 2528.02 |

少量では取得件数が減らず、コメントSQLは2.58→2.79ms（+0.22ms）、APIは16.58→20.32ms（+3.75ms、約22.6%）となった。絶対時間は小さいが改善とは扱わない。APIの範囲は旧11.68〜17.33ms、新17.18〜22.87ms。大量のAPIは2,863.85→2,573.44ms（約10.1%短縮）だが、本番分布と実ネットワークでの効果は未確認。

境界RealMojiのDB内時間は3.47→4.39msと今回も微増。大量ではRealMoji 50.24→37.95ms、コメント43.31→33.74ms。取得削減とDB内走査削減を混同せず、本番で有効反応50件以下の投稿が中心なら見送りを検討する。

fa082c1取り込み後: npm run check成功。page-response・image-signature-cache・image-signature-generationの関連テストは47成功・0失敗・1 opt-in skip。Memories専用の実PostgreSQLテストは1成功・0失敗・0skip（約111秒）。途中のef058e7では既存の署名回数テストがmain単体でも21件失敗したが、その後取り込んだmainで解消済み。複数プロセスを起動する署名世代のopt-in試験は今回未実行。

最新結果はGit対象外の `.isutools/memories-interaction-limit/latest-main-comparison.json`。初回データ・計画は `comparison.json` に残した。main統合後も本番分布、共有環境でのDDL・デプロイ・再起動・公式ベンチは未確認・未実施。

本PR固有のDDLはない。ただし取り込んだmainの前提として、image_signature_cache_stateテーブルとinitial_data_boundary.image_cache_generation列が必要。既存の適用記録は他変更のdocsを参照し、反映前に存在を読み取り確認する。適用済みmigrationを無条件に再実行しない。
