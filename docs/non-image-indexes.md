# 画像以外の検索索引（2026-10-31）

ユーザーの許可により、asia2のisureal DBへ索引4本を追加した。画像関連は他担当のため対象外。
作業ブランチは `perf/non-image-indexes`、調査開始時のローカルHEADは `9f4f46e9b5844f970dfc4dab8d809f5f5dffcc69`。
稼働アプリのSHA・収集グループID・対応するベンチ結果は未照合。

## 収集データと観測

pprotein保存先はasia2 `/var/lib/pprotein/data/`。
取得したログをローカル `/tmp/isu15-log-review/` で集計し、DB上で重い解析は実行していない。

- PostgreSQL: `dminrdpxarwi-slowlog.log`（2026-10-31 02:12:26〜02:14:26 UTC）
- nginx: `dminrdpwsrhn-httplog.log`、`dminrdpwyt45-httplog.log`、`dminrdpwxft8-httplog.log`（ホスト対応は未照合）
- SQLはexecuteだけを集計し、bind/parseとの二重計上を避けた。以下の時間は並行分を合算しておりCPU時間ではない。
- 投稿枠FOR UPDATE: 154回、合計172.65秒、平均1121ms。
- users行ロック（status条件付き・空白正規化後）: 513回、合計86.17秒。
- users全体LOCK TABLE: 62回、合計61.28秒。
- 友達の単一ユーザー両方向検索: 589回、合計9.03秒、平均15.34ms。IN句の友達検索は別に存在する。
- 未処理の友達申請ペア検索: 161回、合計2.11秒、平均13.09ms。
- nginxの投稿成功143件は、ログ別平均2.454/3.143/3.665秒。
- SSE通知は接続を保持するためreqtime合計だけでは改善順位を決めない。

## 追加と確認

適用SQL: `webapp/sql/004-non-image-indexes.sql`。
`CONCURRENTLY`、lock_timeout 3秒、statement_timeout 2分で適用。4本ともindisvalid/indisready=true。

| 索引 | 容量 | 推定計画の確認 |
|---|---:|---|
| users_username_id_idx | 416kB | username検索がSeq ScanからIndex Scan（上位cost 287.82→8.31） |
| friendships_high_low_idx | 2600kB | 両方向ORがSeq Scanから既存索引とのBitmapOr（cost 997.89→45.24） |
| friend_requests_pending_requester_recipient_idx | 280kB | 送信したpending一覧がIndex Scan |
| friend_requests_pending_recipient_requester_idx | 280kB | 受信pending一覧がIndex Scan、ペアORもBitmapOr（cost 1271.43→12.60） |

比較は固定のダミーIDを用いたEXPLAINのみ。アプリ接続での実計画・実時間・スコア改善は未確認。
ユーザー一覧の先頭ページは全件取得する実装のためSeq Scan+Sortのまま。索引だけではアプリ側絞り込みを解消しない。
ブロック表は推定走査cost 8.81と小さいため索引追加を見送った。通知索引は既存の調査 #18 に従い見送った。

## 再適用・撤去と未実行項目

DB初期化のreset.sqlはTRUNCATE/DELETE/UPDATE/INSERTで、表や索引を作り直さないため追加索引は維持される。
新しいDBを構築するときは004を単独で適用する。通常のデプロイやinit.shが004を自動適用する構成にはしていない。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' < webapp/sql/004-non-image-indexes.sql
```

戻す場合は、作成した4索引だけをCONCURRENTLYで撤去する。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' < webapp/sql/rollback-non-image-indexes.sql
```

実際の初期化・再起動・デプロイ・ベンチは未実施。初期化の索引再投入費用、更新時のWAL/書込増、前後スコアを次の調整済みベンチで確認する。
残る大きな候補は投稿枠の排他ロックとusers全体ロック（#15）。索引追加だけではロックの保持時間や地域内投稿の直列化は解消しない。
