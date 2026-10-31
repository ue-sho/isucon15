# 画像の有効性検索と取得先パーティションを絞る

対象: [Issue #14](https://github.com/ue-sho/isucon15/issues/14)。2026-10-31、`origin/main` の `343f3ea` を基準に実装し、PR作成時に最新の `9f4f46e` へrebaseした。この間に画像API・SQLスキーマ・resetの変更はない。

## 変更と根拠

`webapp/nodejs/src/image_api.ts` の画像取得SQLは、有効なRealMojiを `image_id` と `reactor_id` で探す。次の非UNIQUE部分索引を追加する。

```sql
CREATE INDEX realmojis_active_image_reactor
  ON realmojis(image_id,reactor_id)
  WHERE replaced_at IS NULL AND deleted_at IS NULL;
```

本番DBの再監査では、この条件に対応する索引がなく、generic EXPLAINのRealMoji側にSeq Scanがあった。ORとEXISTSがあるため、すべての画像要求で全行を読むとの意味ではない。PR作成時の読み取りでも既存索引はPK、`realmojis_one_active`、`realmojis_post_id` の3本だった。

初版 `d9f4847` は索引のみの変更。ベンチ3551後の追加改善では、署名検証前の所有者検索で `i.created_at` と `i.owner_user_id` も取得し、署名検証後の第2SQLに次の条件を渡す。

```sql
WHERE i.id = $1 AND i.created_at = $2 AND u.id = $3 AND (...従来の有効性判定...)
```

作成日時を与えることで第2SQLの画像パーティションを1つに絞り、所有者IDで `users_pkey` を使えるようにする。SQLは引き続き2回。第1SQLの36パーティション検索は残る。日時は既存のDB変換に従い `Temporal.Instant` で受け渡し、PostgreSQLのマイクロ秒精度を維持する。

署名・期限・所有者・投稿と作者の有効性判定は維持する。第1SQLの直後に退会・削除・差し替えが起きても、第2SQLで状態を確認する。署名検証前に画像本体は取得しない。画像生成は既存アプリの `randomUUID()` による一意なID、作成後に所有者と日時を変更しないモデルを前提とする。DBの主キーは `(id, created_at)` なので、アプリ外から同じIDを別パーティションへ投入した場合の取得結果の同一性までは保証しない。

追加改善に新しいDDLは不要。posts側の索引、パーティション構成、統計、キャッシュは変更しない。初版で追加した索引の容量と書き込み・初期化時の保守コストは、本番ベンチで引き続き比較する。

## 既存DBへの反映

**ベンチ3551後の確認では、共有DB asia2の索引は適用済み・有効（109MB）。今回のアプリSQL追加改善でup SQLを再実行する必要はない。** 新版のデプロイと再ベンチは未実施。

以下は未適用環境での手順。共有DBのasia2に一度だけ適用する。PRのマージや `task deploy` だけでは追加されない。ベンチ・初期化・他のDDLと重ならない時点をueshoと合わせて実行する。アプリやDBの再起動はこの索引の適用には不要。

以下はこのPRを含む手元のリポジトリルートで実行する。まず名前・定義・有効性を確認する。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' <<'SQL'
SELECT c.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'public.realmojis'::regclass
ORDER BY c.relname;
SQL
```

同名索引がなければ適用する。同名で同じ定義かつ `indisvalid` / `indisready` が両方trueなら適用済み。同名の別定義・無効な索引があれば、その原因を確認してから対処する。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-realmojis-active-image.up.sql
```

上の確認SQLを再実行して、定義と有効性を確認する。`IF NOT EXISTS` で無効な同名索引を成功扱いしないため、適用SQLは同名索引があればエラーにする。

作成は `CONCURRENTLY`。通常の書き込みを排他する構築ロックは取らないが、CPU・I/O負荷や既存トランザクション待ちは発生する。`BEGIN` や `psql --single-transaction` では実行しない。lock timeoutは5秒、statement timeoutは10分。中断やタイムアウト後は無効な索引が残る場合があるので、状態を確認し、この変更で残った索引を次の取り消しSQLで除去してから再試行する。

## 取り消しと初期化

今回のパーティション絞り込みだけを比較・取り消す場合は、アプリを `d9f4847` 相当に戻し、索引は維持する。追加DDLがないためDBの復元は不要。

初版で追加した索引も取り消す場合は、asia2で一度だけ、ベンチ外で次を実行する。GitのrevertだけではDBの索引は消えない。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-realmojis-active-image.down.sql
```

取り消し後も確認SQLを実行し、索引がなくなったことを確かめる。取り消しがタイムアウトした場合も状態を確認して再試行する。

`initialize.ts` → `webapp/sql/init.sh` → `reset.sql` はデータを戻し、テーブルや索引を作り直さない。追加した索引は通常のinitializeとDB再起動後も残る。初回構築用の `001-schema.sql` にも同一定義を追加しているが、このファイルはテーブルをDROPするため既存DBへの適用には使わない。

## 初版のローカル検証

初版 `d9f4847` 作成時、ローカルの使い捨てPostgreSQL 16.13（aarch64、Docker、ポート公開なし）で以下を確認した。実データ・本番の画像や認証情報は使っていない。

- 元スキーマにup SQLを適用し、索引の定義と `indisvalid` / `indisready` を確認。重複適用はエラーになる。
- アプリソースから画像取得の第2SQLを取り出し、索引の前後で11ケースの結果が同一。有効RealMoji・プロフィール・投稿画像は取得でき、差し替え済み・削除済み・reactor不一致・投稿削除・投稿者退会・reactor退会・参照なし・画像なしは取得できない。
- 有効RealMojiの `replaced_at` / `deleted_at` を更新すると取得不能になり、元へ戻すと再取得できる。
- 実際の `003-initial-snapshot.sql` と `reset.sql` を検証データに適用。境界以後の画像・RealMojiは削除され、初期画像の取得結果と索引の有効状態は維持される。
- down、downの再実行、upでの再追加が成功。変更後 `001-schema.sql` での新規構築でも同じ索引定義になる。

30,007件の合成RealMojiと36画像パーティションで、元の画像SQL全体に `EXPLAIN (ANALYZE, BUFFERS)` を実行した。`enable_seqscan` 等のプラン強制はしていない。

| 検証画像 | 追加前のRealMoji検索 | 追加後のRealMoji検索 | RealMojiのshared hit blocks（前→後） |
| --- | --- | --- | --- |
| 有効なRealMoji画像 | Seq Scan（出力30,005行、除外2行） | Index Scan（1行） | 370 → 4 |
| どこからも参照されない画像 | Seq Scan（出力30,005行、除外2行） | Index Scan（0行） | 370 → 3 |

SQL全体の単発時間はそれぞれ20.793→5.190ms、23.006→5.271msだった。合成データ・単発・ウォームキャッシュの局所確認であり、本番の応答時間やスコア改善率を示す値ではない。

## 初版の本番ベンチと採否

2026-10-31、ポータルとpproteinをブラウザで比較した。[詳細・計測ファイル・保留理由](https://github.com/ue-sho/isucon15/pull/26#issuecomment-6537793877)。このベンチには今回のパーティション絞り込みは含まれない。

| 指標 | 変更前 | 索引追加後 |
| --- | --- | --- |
| ベンチ | [3009](https://portal.isucon.net/contestant/benchmark_jobs/3009) | [3551](https://portal.isucon.net/contestant/benchmark_jobs/3551) |
| ソース | `4b32ae0` | `d9f4847` |
| 結果 | 4003 / Passed / 減点0 | 3520 / Passed / 減点0 |
| pprotein group | `2026-10-31_02-12-26.074967` | `2026-10-31_02-21-10.176746` |
| 画像有効性SQL 回数 / 平均 | 689 / 192.295ms | 762 / 16.663ms |
| 画像HTTP 件数 / 平均（全status、3台合計） | 1019 / 492.460ms | 1150 / 390.230ms |
| users行ロックSQL平均 | 119.367ms | 191.860ms |
| initialize HTTP | 2.656秒 | 3.302秒 |

画像SQL平均は約91.3%短縮したが、スコアは483点（12.1%）低下したためマージ保留。[Issue #18の別索引4本](https://github.com/ue-sho/isucon15/issues/18#issuecomment-6537701685)もこの間に適用され、画像索引単独のA/B比較ではない。SQL累積時間は並行処理・待ちを含み、HTTP時間やCPU時間と同一視できない。pproteinの収集はinitializeから約120秒で、ベンチ全期間とも完全一致しない。画像HTTP平均には4xxが含まれ、同じ画像サイズ・種類の比較ではない。全体スコア低下の原因は未確定。

## 追加改善の検証

Node.js 26.12.1、使い捨てPostgreSQL 16.13、合成データで確認。`npm run check` が成功し、`IMAGE_SQL_TEST_PORT=<port> npm test` は32件成功・失敗0・skip0（画像の27子テスト＋親テスト、既存pproteinの4件）。GPT-6.1 Solの独立レビューでもblocking事項なし。

`test/image_api.test.ts` は実DBと実際のHonoハンドラーを使い、次を検証する。

- 初版と同じ11ケースのHTTP応答、画像bytes・media type・`Cache-Control: no-store`。
- マイクロ秒、タイムゾーン付き日時、先頭・特殊期間・defaultパーティションの5境界。
- 第1SQLと第2SQLの間のRealMoji差し替え・削除、投稿削除、投稿者・所有者退会、プロフィール解除、画像削除の7ケースが403。
- 署名不正は画像本体SQLを実行せず、期限切れはSQLを実行しない。画像取得中に期限を過ぎた場合も403。
- prepared statementのgeneric planでも第2SQLの `Subplans Removed = 35`、実行画像パーティション1個、所有者の `users_pkey` 検索になる。

5,004ユーザー、30,007件のRealMoji、36画像パーティションで、`d9f4847` と追加改善後のソースからSQLを抽出して比較した。両方に初版の索引があり、`plan_cache_mode=force_generic_plan` で `EXPLAIN (ANALYZE, BUFFERS)` を交互に12組実行、先頭2組を除いた各10回の中央値。

| 指標 | `d9f4847` | 追加改善後 |
| --- | --- | --- |
| 第1SQL 実行時間 | 0.0395ms | 0.039ms |
| 第1SQL 実行画像パーティション | 36 | 36 |
| 第2SQL 実行時間 | 4.909ms | 4.243ms |
| 第2SQL shared hit blocks（全体） | 554 | 442 |
| 第2SQL 実行画像パーティション | 36 | 1 |
| 第2SQL 所有者検索 | Seq Scan（5,003行） | users_pkey Index Scan（1行） |

ウォームキャッシュの合成データであり、本番の速度・スコア改善を示す値ではない。本番DBでは実行を伴わない `EXPLAIN (GENERIC_PLAN TRUE)` のみを読み取り専用・3秒timeoutで確認し、所有者の `users_pkey`、既存の `posts_author_id`、`realmojis_active_image_reactor` を利用する計画を確認した。これは実パラメーターを渡して実行していないため、本番での実行時パーティション除外や実時間は未検証。

### ローカルでの再現

空の使い捨てDB専用。テストは `127.0.0.1`、DB名 `isureal_image_index_test` 固定で、publicスキーマに既存テーブルがある場合は開始前に停止する。`IMAGE_SQL_TEST_PORT` 未指定時はDBテストをskipする。再実行する場合は、このテスト用コンテナを作り直す。

```sh
# リポジトリルートから実行（Node.js >=26とDockerが必要）
docker run --detach --name isucon14-image-test \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=isureal_image_index_test \
  --publish 127.0.0.1::5432 postgres:16
# accepting connectionsになることを確認してから続ける
docker exec isucon14-image-test pg_isready -U postgres -d isureal_image_index_test
image_test_port=$(docker port isucon14-image-test 5432 | cut -d: -f2)
cd webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm run check
IMAGE_SQL_TEST_PORT="$image_test_port" npm test
# 検証で作成したコンテナとデータだけを破棄
docker stop --timeout 5 isucon14-image-test
docker rm --volumes isucon14-image-test
```

## 次の本番比較

追加改善版のデプロイ・再ベンチ・マージは未実施で、採否は引き続き保留。今回の変更でスコア低下やusersのロック待ちを解決したとは判断しない。

1. 他のデプロイ・DDLと重ならない時点を調整し、追加改善版をアプリへ反映する。初版の索引が有効なら追加DDLは不要。
2. ベンチID・全台のコミット・索引状態・再起動とウォームアップ条件を記録する。Issue #18を含む全DB索引状態を前後で固定し、索引を維持した `d9f4847` と比較する。
3. 画像の成功と403を分け、SQL時間・HTTP時間・件数と正しさを確認する。第1SQLと第2SQLを分け、初期化後の動作も見る。
4. 全体スコア・グランプリ件数・usersロック待ち・投稿とexport・初期化時間を比較し、Issue #14へ記録して採否を決める。

PostgreSQLの仕様: [CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html)、[DROP INDEX](https://www.postgresql.org/docs/16/sql-dropindex.html)、[Partition Pruning](https://www.postgresql.org/docs/16/ddl-partitioning.html#DDL-PARTITION-PRUNING)。
