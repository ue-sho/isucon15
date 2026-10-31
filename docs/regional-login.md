# Europe/AmericaのログインをDB近傍へ転送する

`perf/regional-login`、起点main `589f52d`。PR #60の事前SELECT方式は含めない。

## 変更

europe1/america1のnginxで `POST /api/auth/login` だけを既存の地域別アプリへ転送する。
DBはasia2の共有PostgreSQLのまま。データの移動・複製やSQLの変更はない。

| 入口 | 転送先 | アプリの地域 |
|---|---|---|
| europe1 nginx | asia1 `192.168.1.10:8081` | europe |
| america1 nginx | asia1 `192.168.1.10:8082` | america |

既存の `isureal-regional-api.conf` snippet/upstreamを使う。
成功ログインのBEGIN・ユーザー行ロック付き認証SELECT・セッション置換CTE・COMMITは従来の4往復を維持する。
地域間で4回SQLを往復する経路を、HTTP転送1往復とDB近傍のSQL4往復へ変える。
失敗ログインも従来のトランザクションを使う。成功時の追加SELECTは導入しない。

POST以外、末尾slash・余分なパス要素、登録・ログアウトは元の経路へ送る。
本文・URI・クエリ・Authorization・X-Client-IP・X-Country-Codeを保持し、BANとログは転送先の既存ミドルウェアが処理する。
`proxy_next_upstream off` により、切断や503時の再送・別workerへのfallbackをしない。
固定リージョン・ルーター経由の既存構成を維持する。新しいサービス・DB設定・poolサイズ変更はない。

## ローカル検証

Node.js 26、実nginx 1.24、専用PostgreSQL16コンテナを使用する。
本番の設定値・DBには接続しない。

```sh
ISUTOOLS_NGINX_PROXY_TEST=1 python3 -m unittest discover -s isutools/tests -p test_regional_api_proxy.py -v
cd webapp/nodejs
npm run check
REGIONAL_RELATIONSHIP_TEST=1 node --test --test-concurrency=1 'test/**/*.test.ts'
```

実nginxの設定解釈、両地域の転送先、本文・ヘッダー・クエリ保持、対象外経路、切断/503時の再送なしを検証する。
実APIで従来経路とのユーザー応答一致、不正な鍵、旧token失効、別プロセスからの即時認証・地域拒否、同時ログインでactive1件、ログアウト、退会済みユーザー、IP BANを検証する。
login自体に地域制限がない既存仕様も維持する。退会との競合は実際のユーザー行ロックと `pg_blocking_pids` で待機を確認し、両順序で検証する。

## 本番での採否・切り戻し

本番反映・競技ベンチは未実施。HTTP転送後の性能向上は仮説であり、スコア改善は未確認。
asia1上の補助workerはCPUやDB poolをfriendsフィード・関係更新と共有するため、負荷増加の影響を確認する。
同じmainとの比較で正常ログインの地域別件数・p95、friendsフィードの完了数・p95、総スコア、502/timeout、補助workerのCPUとpool待ちを見る。

反映はユーザーと順序・対象を確認して実施する。既存の地域別アプリの版と8081/8082待受を先に確認する。
通常のtask deployはアプリ/DB再起動・ログtruncateを伴うため、ログ保全と他作業との調整が必要。
切り戻しは2台のnginxに追加したログインlocationを除去し、`nginx -t` 成功後にreloadする。DBの巻き戻しは不要。
