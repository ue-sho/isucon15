# 投稿期間開始commitによる通知pollの起床

2026-10-31。基点・取り込み済みmain: `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`。

## 目的と根拠

投稿期間開始のcommit後、次の500ms pollを待つ時間を減らす。通知内容、対象者、地域、接続時刻、終了期間の判定は既存のバッチSQLを使う。

[Issue #11の計測記録](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540744615)のベンチ27678は7361点・Passed、計測版は`589f52d`。poll SQL 1061回の累積222ms、通知INSERT 18回の累積9.929秒、期間開始Tx平均979msである。これらを現在のmainや稼働状態の測定値とは扱わない。今回減らすのはcommit後の待機であり、通知INSERTやmembership lockの待ちそのものではない。SQL累積時間、HTTP接続寿命、CPU時間、競技得点は別の指標である。

既存のPR #36の256接続単位のバッチpoll、PR #47のmembership排他を維持する。地域別membership lock、通知行の期間単位への再設計は別案として残す。`user_api.ts`、`notification_membership.ts`、`reset.sql`は変更しない。

## 実装

- `admin_posting_window_api.ts`: 通知INSERTをdata-modifying CTEで包み、同じSQLで空payloadの`pg_notify`を1回呼ぶ。期間開始と同じTxに属し、SQL往復数は増やさない。対象者0人でも起床イベントは作るが、配信はSQLの結果だけで決まる。
- `notification_api.ts`: 通知イベントを受けたら待機timerを早める。poll中ならpendingフラグにまとめ、実行中の巡回完了後に1回再照会する。SQLは従来どおり最大256接続ずつ直列に実行し、送信後はその購読を削除する。500ms周期のpollは残す。
- `notification_wakeup.ts`: 既存poolの物理接続をLISTENに利用する。pg 8.23.1の`onConnect`がLISTEN完了を待ってから接続を借り手へ渡す。通常リクエストのBEGINへLISTENを混入させず、クエリの暗黙queueにも依存しない。登録完了後にも再照会を要求する。
- `db.ts`: helperの所有、`onConnect`、poller登録、`end()`時の解放だけを追加する。通常のget/select/exec/begin、poolサイズ、Txの実装は変更しない。

[PostgreSQL NOTIFY](https://www.postgresql.org/docs/16/sql-notify.html)はTxのcommit後に送信され、rollbackでは送信されない。[LISTEN](https://www.postgresql.org/docs/16/sql-listen.html)開始時の競合は登録commit後の再照会で補う。payloadは配信対象の根拠に使わない。[pg PoolのonConnect](https://node-postgres.com/apis/pool)は新規物理接続がpoolに渡る前に完了を待つAPIである。

### 接続数・失敗時の動作

専用接続を追加すると既定構成の通常pool最大94に主worker 6接続を上乗せするため、今回は採らない。既存poolを使い、通知専用のcheckoutは保持しない。追加接続数は0、poolのmaxも変えない。物理接続ごとのLISTEN 1往復とイベント受信処理は増える。通知利用のない補助workerでも、DB接続の初期化時にはLISTENを登録するがpollは起こさない。

同一イベントを複数のpool接続が受信しても、同時刻の起床はまとめる。遅れて別接続へ届けば追加の直列pollはあり得るが、購読を削除済みなので二重配信しない。全接続が長いTx中ならイベント受信も遅れ得る。この場合の即時性は保証せず、通常pollとpoolの解放を待つ。接続数を増やして回避しない。

切断された物理接続のイベントlistenerを解放する。poolが通常リクエストまたはpollのために再接続すると、再びLISTENし照会する。通知専用の再接続ループは持たない。LISTEN自体の失敗は通常SQLを妨げずfallbackへ戻り、次の物理接続での登録試行は250msから最大30秒の指数backoffで抑える。既存の未登録接続を強制切断しないため、LISTEN失敗後に同じ接続だけが使われ続ける場合は通常pollのままとなる。

全購読が終了するとpoll timerを消し、イベントを受けても照会しない。pool接続のLISTEN登録はその接続の寿命まで残す。通常Tx内へUNLISTENを差し込まず、idle eviction・接続断・DB.end・プロセス終了で登録を解放する。新しいretry timerやheartbeat timerは作らない。DB.endはhelperのlistenerも除去する。

## 検証

Node v26.12.1、使い捨てPostgreSQL 16.13、READ COMMITTED、合成データで実施。共有環境へは接続していない。

```sh
cd webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm run check
NOTIFICATION_COMMIT_TEST=1 POST_WINDOW_LOCK_TEST=1 npm test
```

2026-10-31の実行は151件中138成功、13 skip、失敗0。通知統合試験11件（親を含む）、既存membership/投稿ロック試験21件（親を含む）、通知バッチ/起床単体試験も成功。skipは今回有効化していない他機能のopt-in DB/HTTP等の試験であり、通知統合試験にskipはない。型チェックとdiff checkも成功。

| 条件 | 確認内容 |
| --- | --- |
| commit / rollback | commit前に通知行もSSE配信も見えず、pg_notify後に失敗させたTxはrollbackしてイベントも配信されない |
| pollとの競合 | 読取済みの古い結果を保持した状態でcommit、複数NOTIFY、接続追加・切断を重ね、次巡回で1件だけ送信。SQL同時実行は1 |
| LISTEN開始 | LISTEN未登録の間にcommitした通知を登録後のDB照会で回収。登録完了時の起床も単体試験で確認 |
| 接続断・取りこぼし | 専用コンテナの当該DBのpool backendを終了。再接続、起床無効時の通常poll回収、その後の新期間配信を確認 |
| pool飽和 | max=2の両接続をTxで占有しても接続を追加せず、解放後に配信 |
| 配信条件 | active/地域/接続時刻/終了期間を既存SQLで再確認。startsAtからcommitまでの途中接続には従来どおり配信しない |
| 初期化 | 既存snapshot/reset SQLを隔離DBで実行し、古い通知が残らず新期間を配信。共有環境のinitialize API全体は未実施 |
| worker | 独立poolの並行利用に加え、別Nodeプロセス2個へ実HTTP SSEで配信。一方を終了・再起動して再配信 |
| 解放 | 全購読終了後のpoll停止、DB.end時の物理接続・イベントlistener解放、指数backoffと上限、再登録成功後の解除 |
| membership | 既存試験で登録・地域変更・退会と期間開始の両順序、二重開始、通知生成失敗時の原子性を再確認 |

実環境のnginx・router・WAN遅延、負荷時のpool/CPU/通知queue、初期化APIのスクリプト呼出し全体、OSサービス再起動は未検証。

## commitからSSE配送までの局所比較

同じ候補コードで起床callbackだけを無効/有効にし、500ms pollのみとの差を分離した。順序はpoll→notify→notify→poll、各組4回、各方式8サンプル。各SSEの初回照会後、30ms＋35/70/105/140ms待って期間を開始。合成ユーザー2人、pool max=2、同じMac上の隔離PGと実HTTP loopback、nginxなし。SQLは両方式で同じである。main全体との性能比較ではない。

同一プロセスの単調時計で、COMMIT送信直前をS、応答直後をA、HTTPクライアントがSSE本文を読み終えた時刻をRとした。DB内部の確定時刻CはS〜Aの間にあるため、`R-A <= R-C <= R-S`を報告する。COMMIT応答をDB内部の確定時刻と同一視しない。

| 方式 | n | commit→HTTP SSE本文受信の中央値の範囲 | COMMIT応答→本文受信 min–max |
| --- | ---: | ---: | ---: |
| 500ms pollのみ | 8 | 374.765–375.233ms | 316.939–428.908ms |
| commit起床＋500ms fallback | 8 | 2.377–2.809ms | 1.145–2.723ms |

COMMITの送信から応答までの幅は約0.28–0.91ms。上の差はこの合成条件で次のpoll待ちを減らせた結果であり、通知INSERT時間、期間開始Tx全体、SQLサーバー実行時間、SSE接続寿命、競技得点の改善を表さない。試験は各サンプルと範囲をdiagnosticに出すが、生ログはコミットしない。

## 反映と戻し方

新規DDL、依存追加、schema変更、専用接続、pool/worker設定変更は不要。NodeはTypeScriptを直接実行するため追加ビルドも不要。全アプリを同じ版へ通常deployし、commitとサービス状態を確認してからベンチする。旧publisherがNOTIFYを発行しない混在中も通常pollは動くが、比較条件にはしない。

公式ベンチ・デプロイ・DDL・共有サービス再起動・マージは未実施。競技得点への効果は未確認。取り消しはこのPRのアプリ変更をrevertして再deployすればよく、逆migrationは不要。

ベンチでは同条件の前後で得点・messages・期間開始API・投稿成功・他地域の退行を確認する。配送遅延を測るときはcommitと対応するSSE配送を対応づけ、HTTPアクセスログのSSE接続時間で代用しない。DB接続数とpool待ち、LISTEN失敗ログ、NOTIFY由来の追加poll数も確認する。
