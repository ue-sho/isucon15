# 画像のRealMoji有効性検索に部分索引を追加する

対象: [Issue #14](https://github.com/ue-sho/isucon15/issues/14)。2026-10-31、`origin/main` の `343f3ea` を基準に実装し、PR作成時に最新の `9f4f46e` へrebaseした。この間に画像API・SQLスキーマ・resetの変更はない。

## 変更と根拠

`webapp/nodejs/src/image_api.ts` の画像取得SQLは、有効なRealMojiを `image_id` と `reactor_id` で探す。次の非UNIQUE部分索引を追加する。

```sql
CREATE INDEX realmojis_active_image_reactor
  ON realmojis(image_id,reactor_id)
  WHERE replaced_at IS NULL AND deleted_at IS NULL;
```

本番DBの再監査では、この条件に対応する索引がなく、generic EXPLAINのRealMoji側にSeq Scanがあった。ORとEXISTSがあるため、すべての画像要求で全行を読むとの意味ではない。PR作成時の読み取りでも既存索引はPK、`realmojis_one_active`、`realmojis_post_id` の3本だった。

変更は索引のみ。署名・期限・所有者・投稿と作者の有効性を判定するアプリSQLはそのまま利用する。posts側の索引、画像パーティション、親テーブル統計、キャッシュは今回の変更に含めない。索引の容量と書き込み・初期化時の保守コストは増えるため、本番ベンチで比較する。

## 既存DBへの反映

**共有DBのasia2に一度だけ適用する。PRのマージや `task deploy` だけでは追加されない。** ベンチ・初期化・他のDDLと重ならない時点をueshoと合わせて実行する。アプリやDBの再起動はこの索引の適用には不要。

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

取り消しもasia2で一度だけ、ベンチ外で実行する。GitのrevertだけではDBの索引は消えない。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-realmojis-active-image.down.sql
```

取り消し後も確認SQLを実行し、索引がなくなったことを確かめる。取り消しがタイムアウトした場合も状態を確認して再試行する。

`initialize.ts` → `webapp/sql/init.sh` → `reset.sql` はデータを戻し、テーブルや索引を作り直さない。追加した索引は通常のinitializeとDB再起動後も残る。初回構築用の `001-schema.sql` にも同一定義を追加しているが、このファイルはテーブルをDROPするため既存DBへの適用には使わない。

## 検証結果

本番DDL・再起動・initialize・ベンチは未実施。ローカルの使い捨てPostgreSQL 16.13（aarch64、Docker、ポート公開なし）で以下を確認した。実データ・本番の画像や認証情報は使っていない。

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

SQL全体の単発時間はそれぞれ20.793→5.190ms、23.006→5.271msだった。合成データ・単発・ウォームキャッシュの局所確認であり、本番の応答時間やスコア改善率を示す値ではない。署名・期限切れのHTTP検証、初期化の所要時間、索引サイズ・書き込み費用、本番の実行計画とベンチの比較は未実施。

## 本番での比較

1. 適用前後でコミット・索引状態・ベンチIDを記録する。他の改善との同時変更を避ける。
2. 画像の成功と403を分け、HTTP件数・時間、DB実行計画・buffersを比較する。RealMojiに由来する画像と無効な旧画像の両方を見る。実行を伴うSQL解析はベンチ外で調整する。
3. 署名不正・期限切れ・所有者退会・画像差し替え・投稿削除・投稿者退会の応答と、初期化後・再起動後の動作を確認する。
4. ベンチの成功・失敗、スコア、初期化時間、書き込み側の負荷をIssue #14に追記して採否を決める。

PostgreSQLの仕様: [CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html)、[DROP INDEX](https://www.postgresql.org/docs/16/sql-dropindex.html)。
