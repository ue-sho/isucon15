# 登録・ログインのDB往復削減

registerはusers全体のSHARE ROW EXCLUSIVEロックと重複確認SELECTを廃止し、usernameのUNIQUE索引とINSERT ON CONFLICT DO NOTHING RETURNINGに変更する。明示的なBEGIN/COMMITも不要となり、正常登録は5往復から1往復になる。同名登録は1件だけ成功し、残りは409 username_takenとなる。退会済みユーザー名も引き続き予約される。

loginはユーザー行のFOR NO KEY UPDATEを維持し、旧セッションの失効UPDATEと新セッションのINSERTをデータ変更CTEにまとめる。BEGIN/COMMITを含む5往復から4往復になる。INSERTは失効CTEの集計結果を参照するため、旧セッションが0件でも1件作成する。同時ログインを直列化するユーザーロックと、退会との排他は維持する。

## 既存DBへの適用

本番データの重複有無・性能効果は未確認。計測中を避け、対象DBと適用順序を確認してから実行する。本変更では本番への接続・適用・ベンチは実施していない。

1. `SELECT count(*) - count(DISTINCT username) AS duplicate_count FROM users;` で重複数が0であることを確認する。重複があれば適用を中止し、初期データを書き換えない。
2. 旧アプリのまま `webapp/sql/migrations/20261031-users-username-unique.up.sql` をpsqlで単独実行する。
3. `SELECT indisunique, indisvalid, indisready FROM pg_index WHERE indexrelid = 'public.users_username_unique_idx'::regclass;` の3列がtrueであることを確認する。
4. 全アプリへ新実装を反映する。索引より先にアプリを反映するとregisterが失敗する。

CONCURRENTLYの失敗で無効な索引が残った場合は、新アプリへ切り替えずdown.sqlで削除して原因を確認する。通常の戻し方も、全アプリを旧実装へ戻してからdown.sqlを実行する。従来のusers_username_id_idxは残す。

新規DBは001-schema.sqlで索引を作成する。既存DBのreset.sqlはusersを再作成しないため索引は維持される。永続化方式の変更や追加キャッシュはない。

## 検証

新規ローカルPostgreSQLでauth-permission-db.test.tsを実行し、同名8並列登録が201×1・409×7になること、登録のSQLが1件であること、同時ログイン後に有効なトークンが1件であること、置換・ログアウト・退会による失効と権限比較432ケースの成功を確認した。競技ベンチによるスコア比較は未実施。
