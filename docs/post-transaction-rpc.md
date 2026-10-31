# 投稿トランザクションをDB内で完結させる

## 根拠と変更

PR #62は公式[#29286](https://portal.isucon.net/contestant/benchmark_jobs/29286)で4035点へ退行した。Passed・減点0だが、Asiaの期間開始タイムアウトと期間外投稿のmessagesがあるため採用しない。#58の[#28240](https://portal.isucon.net/contestant/benchmark_jobs/28240)は8377点だった。

#29286のgroup `2026-10-31_07-37-08.374639` のasia2 SQLでは、ある投稿が枠のFOR SHAREからCOMMITまで6196ms保持した。SQL実行合計は約13msで、SQL間に最大2787msの空白がある。期間終了UPDATEの待ち4301–5623ms、共通advisory lockの待ち8237msも観測した。次のSQLがアプリから届くまでの遅延がロックを延ばす経路がある。CPUと通信の寄与は未確定。生ログ・SQL引数・画像・署名URLは添付しない。

画像・multipart・caption・公開範囲・位置の検証は各地域の既存Nodeで行い、POSTの転送やworker配置は変えない。その後、画像を含む引数を送り、`public.isureal_create_post_v1` を1回呼ぶ。ユーザーのFOR NO KEY UPDATE、現在枠のFOR SHARE、同日投稿数、画像と投稿のINSERTをPL/pgSQL内で処理する。クライアント側でBEGINせず、呼出しのimplicit transactionで確定する。ロック取得後にNodeへ戻って次のSQLを待つ区間をなくす。DB自体のI/O・ロック待ちまで解消するという意味ではない。

ロック順序と同日の再投稿制限を維持する。関数はVOLATILEとし、各内部SQLで新しいsnapshotを取得する。期間終了UPDATEを待った結果、旧枠が条件外になれば別のSELECTで新枠を再探索する。STABLEや1本のCTEへ変えてはならない。[PostgreSQL 16の仕様](https://www.postgresql.org/docs/16/xfunc-volatility.html)を参照。

投稿時刻は従来の「件数判定直後のNodeの現在時刻」から、同じ位置のDB `clock_timestamp()`へ変更する。期間開始・期限と同じDB時計でmicrosecond精度を維持する。戻り値の日時はTemporalへ変換し、既存の応答生成を使う。

起動時に関数の存在を確認し、未適用なら従来経路を使う。関数を適用した後にはアプリ再起動が必要。稼働中の関数エラーを従来経路で再試行することはしない。

## 検証

Node v26.12.1、隔離PostgreSQL 16.13、001-schema.sqlと合成データ。専用Dockerを起動・終了し、外部DBや本番envを受け取らない。

```sh
cd webapp/nodejs
npm run check
npm test
POST_TRANSACTION_TEST=1 POST_TRANSACTION_BENCH_RTT_MS=100 node --test test/post-transaction.test.ts
POST_WINDOW_LOCK_TEST=1 node --test test/post-window-lock.test.ts
```

専用試験で以下を確認する。

- 従来経路とのJSON比較（動的なID・署名URL・時刻を除く）、3種類の位置、Unicode、公開範囲、画像全バイト、画像作成時刻と投稿時刻の一致。
- 未開枠・開始前・削除ユーザー・不正JPEG、2回削除制限、同日地域変更、遅刻秒数、翌日投稿。
- 同時投稿201/409、地域変更ロック待ち後の新地域、期間終了待ち後の新枠探索。
- 枠の共有ロック中に別ユーザーは投稿でき、期間終了はCOMMITを待つ。
- INSERT例外で画像もロールバックし、次の投稿が成功する。
- PGクライアントの受信をpauseして結果を未読にしても、別接続から投稿が見え、backendはidle/xact_start=NULLとなり、ユーザー更新と期間終了のロックを取得できる。
- 実reset.sql後にも関数が残り、追加画像/投稿が消えて再投稿できる。
- 実HTTP/newServerの関数自動検出、認証/地域/JPEG拒否、他地域friendsフィードへの即時反映、署名URLの画像全バイト取得。投稿で明示BEGINを使わないことも確認。
- down/upの再適用と未適用時の従来経路。
- 非superuserでも既存テーブルの権限があれば動作し、権限がなければ拒否する（SECURITY INVOKER）。

最新main取り込み後、型チェック、標準118件（102成功・16スキップ）、専用PG試験16件、既存投稿枠ロック試験21件が成功した。正常投稿のハンドラー内通信はBEGIN/COMMITを含む7往復から関数呼出し1往復へ減る。認証・IPBanのSQLは別である。

約366KBの512×512 JPEG、模擬RTT100ms、ABBA、各ブロック1 warmup＋4回のHonoハンドラー比較は従来755–794ms、関数呼出し143–150ms。認証・IPBan・nginx・実WAN帯域制限・実機CPU飽和は含まない。実HTTPの正しさ確認と模擬RTT性能比較は別試験であり、公式スコアは未確認。

## 反映順と戻し方

この版は#58と最新mainの地域別ログインを含み、失敗した#62のPOST集約は含まない。共有DDL・デプロイ・再起動・ベンチは実行担当が行う。必要ログの保全と他担当との順序調整後に進める。

1. asia2/isurealで関数が未作成か確認する。既存なら適用履歴・定義を確認し、upを無条件に再実行しない。
2. 未作成の場合だけup.sqlを適用。テーブル変更・データ移行・主要依存追加はなく、DDLはlock_timeout 3s / statement_timeout 30s。
3. 関数がVOLATILE / SECURITY INVOKERで、アプリロールにEXECUTE権限があることを確認する。
4. ブランチを全4台に反映し、headとサービス状態を確認する。
5. ポータルでEnqueue。messages、Asiaの期間開始、投稿とfriendsの成功数/p95、他地域の退行を比較する。Passedだけで採用しない。

以下はリポジトリ直下で実行する。

```sh
ssh asia2 'sudo -u postgres psql -X -At -d isureal -c "SELECT to_regprocedure('\''public.isureal_create_post_v1(text,text,text,bytea,text,text,text,numeric,numeric,text)'\'');"'
# 上が空の場合のみ
ssh asia2 'sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' < webapp/sql/migrations/20261031-post-transaction.up.sql
ssh asia2 'sudo -u postgres psql -X -d isureal -c "SELECT p.provolatile,p.prosecdef,has_function_privilege('\''isureal'\'',p.oid,'\''EXECUTE'\'') AS app_can_execute FROM pg_proc p WHERE p.oid=to_regprocedure('\''public.isureal_create_post_v1(text,text,text,bytea,text,text,text,numeric,numeric,text)'\'');"'
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/post-transaction-rpc &&
DISCORD_WEBHOOK_URL= task status &&
ssh asia1 'systemctl is-active isureal-nodejs.service isureal-nodejs-europe.service isureal-nodejs-america.service'
```

関数確認の期待値は1行で `v / f / t`。asia2のnginx inactiveは既存構成どおり。正常なら[ポータル](https://portal.isucon.net/contestant/benchmark_jobs)でEnqueue。

切り戻しは先に確認済みアプリ版へデプロイする。使われない関数は残してよい。削除する場合だけ全worker切替後にdown.sqlを同じDB接続で適用する。関数を先に削除すると、有効と判定済みのworkerで投稿が失敗する。
