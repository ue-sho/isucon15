# 投稿準備の間にDB応答を処理する

PR #67初版 `e752f2c` のベンチ31590では、親mainと同じtreeの829399cを測った29060に比べ、投稿のDB往復7→4、平均Tx 893.294→657.942msという改善があった。一方、Asia投稿のreqtime p95は3183→4980ms、friends feedは724→1185msに増えた。両走行はPassed・減点0・messagesなし、点数は8478→8324。以下は追加調査と対策であり、追加版の得点改善を確認した結果ではない。

## 確認できたこと

保存済みSQLとHTTPを、指定ベンチの開始〜終了に絞って再集計した。pproteinのgroupと計測SHAは内蔵ブラウザで照合済み。個別ID・SQL引数・生ログはこの文書に含めない。

- 31590のAsiaで最も遅い投稿5件（4.98〜6.19秒）は、ベンチ開始からおよそ65〜72秒に集中。同時刻にfriends feedの3.25秒/3.84秒の応答もある。
- 同時間帯の最長投稿Txは4347.015msだが、SQL duration合計は16.976ms。prepare関数は0.753ms、画像＋投稿保存は14.620ms、COMMITは1.588ms。prepare完了→保存開始に2979.380ms、保存完了→COMMIT開始に766.412ms空いている。
- 他の投稿Txにも保存完了→COMMIT開始が2928.989msという空白がある。SQL実行だけでは秒単位の経過を説明できない。
- friends feed SQLはDB全体で507→479回、平均1.353→1.273ms、p95 4.639→4.028ms。最大は63.942→118.525ms。HTTP悪化をfeed SQLの一律な遅さとは扱わない。SQLの行返却・通信・アプリ側処理はこのdurationの外にもある。
- 同じ65〜74秒にAsia exportは2→4件、画像403は50→130件、login 401は30→104件、403は36→115件（区間に重なるHTTPを数えたもの）。負荷の混ざり方が異なる。画像・署名・JPEG・exportの各CPU寄与は実worker profileがなく確定できない。

HTTPの終了時刻は秒単位なので、重なりには最大約1秒の不確かさがある。SQLとの個別リクエスト対応を捏造しない。SQL durationはCPU時間ではなく、SQL間の空白全体をNode CPU時間と断定もしない。

**支持される仮説:** 同じNodeで投稿準備等の同期処理が連続すると、すでに届いているDB応答や他のリクエストの続きも待ち、トランザクションが必要以上に長くなる。初版にも残る問題であり、初版の4往復化がCPU負荷増やp95悪化の原因だったと証明したものではない。

## 追加した変更

変更する製品コードは `post_api.ts` の投稿作成だけ。

1. handlerごとに投稿の画像準備をFIFOで1つずつ進める。
2. 各準備の開始前に `node:timers/promises` の `setImmediate()` をawaitしてI/Oへ処理を戻す。
3. 従来と同じFile→Buffer→完全JPEG検証・寸法確認を行い、完了後は従来どおり独立したDB Txへ進む。

[NodeのsetImmediate](https://nodejs.org/api/timers.html#timerspromisessetimmediatevalue-options)と[event loopのpoll/check](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)に基づく実行順の制御。固定ミリ秒のsleepやレート制限ではない。DB Tx全体を直列化するものでもなく、異なる投稿者のTxは並行して進む。

待機する投稿自身はまだDB接続・ユーザー行・期間行のロックを持たない。postedAtは引き続きロック・件数確認後のアプリnow()。JPEG decoder/判定・保存bytes・画像署名・feed・共通DB/関係helperを変更せず、新しいworker・DB pool・依存・DDL・キャッシュ状態も追加しない。

準備の例外でも次の待機を進める。エラーは元のrequestへ返し、他のrequestへ移さない。本文のmultipart解析まではこの待機列の外であり、すべてのCPU負担を解消するものではない。個々のJPEG検証自体を途中で中断することもない。

## 隔離環境での再現と確認

Node v26.12.1、PostgreSQL 16.13、READ COMMITTED、合成データのみ。既存の `POST_WINDOW_LOCK_TEST=1` 試験が専用PG16コンテナを作成・終了する。

比較は両方とも同じ4 SQLのハンドラーで、初版相当の即時準備と追加版の準備順制御だけを変える。初期投稿のprepare完了後に同じ30msのアプリ待ちを置き、その間へ8件の実512×512 JPEG投稿とfriends feedを投入。旧→新→新→旧の順で各2回。decoderは計測前に同じ画像でwarmupする。

| 観測（平均） | 初版相当 | 追加版 |
|---|---:|---:|
| 既存投稿の応答まで | 172.187ms | 88.552ms |
| 同時friends feedの応答まで | 175.123ms | 46.825ms |
| 10ms timerの遅延超過 | 158.752ms | 13.795ms |
| 既存投稿のユーザーロック取得直後〜DB commit | 171.348ms | 67.336ms |
| 全バースト投稿完了まで | 203.536ms | 194.674ms |

全投稿201、画像/投稿各10件、feed 200。ロック時間はテスト用の計測INSERTと `pg_xact_commit_timestamp` により両端ともDB時計で測った。計測行は隔離fixtureだけで、製品のSQL/migrationには入れない。

この再現はHonoのin-processリクエストと実PGによるもので、実WAN・競技データ・実worker数を再現していない。2回ずつの局所平均を本番p95や得点改善率に換算しない。全投稿の完了時間にはばらつきがあり、スループット向上を主張しない。

追加試験で、画像読取の例外と不正JPEGの後も次の投稿が進み、失敗した準備がDB Txを開始しないことを確認。既存の同時投稿・削除・地域変更・退会・期間切替の両順序、アプリ時刻境界、画像bytes/属性、rollback、異なるユーザーの並行完了も再確認した。

提出前にorigin/mainを再fetchし、`993e1b0dd58d68d7b63e77bff26d046d2a0173b3` の取り込みを確認（更新なし）。取り込み後の型チェック、標準116件（102成功・14スキップ）、隔離PG投稿試験30件、実認証/権限・3地域試験7件はすべて失敗0。上の表は取り込み後の最後の混雑再現の平均で、以前の再現でも同じ方向を確認した。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-post-db-call/webapp/nodejs
npm run check
POST_WINDOW_LOCK_TEST=1 node --test test/post-window-lock.test.ts
npm test
```

## 反映と本番で残る確認

初版の `20261031-post-db-call.up.sql` が照合済みなら、**追加DDLは不要**。関数のbody MD5は引き続き `f8e8866296d58a830c04d8bb5385f562`。初版未適用時だけ [初回の適用手順](post-db-call.md#db適用デプロイベンチ) を使う。専用ビルドや依存導入の追加もない。

ユーザーが必要な前回ログを保存し、他担当との順序を合わせて実行する。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-post-db-call
git switch perf/post-db-call
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/post-db-call &&
DISCORD_WEBHOOK_URL= task status
ssh asia1 'systemctl is-active isureal-nodejs.service isureal-nodejs-europe.service isureal-nodejs-america.service'
```

4台のSHAが更新後のPR headに一致し、必要サービスactive・lockなしを確認後、[ポータル](https://portal.isucon.net/contestant/benchmark_jobs)でEnqueue。API認証は未確認なので `task bench` は並べない。新headの共有環境での効果は未確認。比較時はAsia投稿/friendsのp95と成功数、SQL間の空白、実workerのCPU/イベントループ待ち、他地域・他経路の退行を確認する。

追加版を戻すならこの追加コミットをrevertして再デプロイする。初版のDB4往復化と関数は保持できる。共有環境のDDL・デプロイ・再起動・追加ベンチ・マージはこの作業では行わない。
