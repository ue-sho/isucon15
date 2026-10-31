# ユーザー検索の候補転送削減

2026-10-31。基準コードは `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`。

## 理由と変更

旧検索は、検索語をSQLへ渡さず、cursor以後のactiveユーザー全件とブロック一覧を取得してNodeで絞り込む。[ベンチ27678の調査](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540744615)では、この候補SELECTは104回・SQL累積8.358秒、検索HTTP平均はEurope619ms・America598msだった。27678は7361点・Passed・計測版589f52dであり、このPRの基準mainや現在のデプロイ状態とは別である。

- `users.search_username/search_display_name` に従来と同じJSの `NFC → upper → lower → NFC` を保存する。登録のINSERT、表示名変更のUPDATEに含め、元の値と同じcommitで反映する。ログイン・セッション・membership lockは変更しない。
- 検索はusername/displayNameのOR、active・本人除外・双方向ブロック除外、元の `(username,id)` の順序とcursor、LIMIT51を1 SQLで処理する。最初の50行だけUserへ変換して画像署名し、51行目はhasMoreにだけ使う。
- `strpos(... COLLATE "C", query)` を使い、`%`、`_`、バックスラッシュ、区切り文字をパターンとして解釈しない。2列を結合しないため列の境界をまたぐ一致も作らない。PostgreSQL textに格納できないNULを含む検索語は、旧版同様0件を返す。
- bioは検索ではcertified_publicだけ公開する。友達であってもregularのbioは出さない。
- 新しい拡張・依存・索引・キャッシュは追加しない。追加列はnullableで既存データの書換えや削除をDDL時に要求しないが、新版を検索に使う前にバックフィルが必要。

## バックフィルと初期化

`src/user_search.ts` のバックフィルは、users/initial_usersにSHARE ROW EXCLUSIVEを取得してから元の文字列だけを読み、JSで計算した値を同じtransactionで更新する。通常の検索SELECTは妨げず、書込はcommitまで待つ。lock_timeoutは5秒。失敗時はrollbackし、古い値で新しい表示名を上書きしない。常時の検索ではこのロック・全件取得は行わない。

`initial_users` にも検索列を追加して、初期表示名から独立して正規化する。initializeはバックフィル完了後に既存init.shを呼ぶ。`reset.sql` はreplicaモードでも初期検索値を明示的にコピーし、元のプロフィールに変化がなく検索値だけが違う場合も修復する。通常triggerには依存しない。新しい001-schema.sqlから作ったsnapshotにも、initializeで同じバックフィルが適用される。

旧アプリが動く間は旧コードの登録・表示名変更が検索列を更新しない。DDLだけで検索を有効にせず、ベンチと書込を止めた反映区間で **DDL → 全アプリのデプロイ → バックフィル/整合確認 → 利用再開** の順にする。混在運用を続ける方式ではない。NodeのUnicodeデータが変わるバージョンへ更新した場合も、同じNodeでバックフィルし直す。

## 正しさの検証

Node26.12.1、専用PostgreSQL16.13。Git archiveで上記基準コミットのsrcを読み出し、旧ハンドラーを比較の正として使用した。

- Unicode NFC、結合文字、大小文字、ß/ẞ、ギリシャ文字、トルコ語のI、合字、かな、補助平面文字、絵文字。
- `%`、`_`、`\\`、`:`、`|`、空白、NULの文字通りの一致。username/displayNameのORと列境界の非一致。
- 双方向ブロック・退会・本人除外・bio公開条件、username同値時のid順序、cursorと全ページ、0/49/50/51件、hasMore、入力エラー。
- 51件の候補に画像があっても署名は50件（SHA256呼出し100,000回）。返却JSONは署名URLを含め旧版と一致。
- 登録直後、表示名変更直後、bioだけの更新。未commitのプロフィール変更は検索に見えず、commit後に元の値と検索値が同時に見える。行ロックで待機する2更新、rollback、バックフィル中に後着した更新も確認。
- 旧schemaへのmigrationを2回適用。実reset.sqlのreplicaモード・繰返しreset・検索値だけの破損・初期検索値欠損を確認。initializeハンドラーから実init.shを起動し、専用PGの実psqlで復元した。
- 実HTTPサーバーでsession・地域middlewareによる200/401/403を確認。force_generic_planでもcursor結果が一致。
- 5,037ユーザーでも4検索語・計105ページのJSONが旧版と一致。

最新main取り込み後の `npm run check` 成功。標準試験に検索PG試験を加えて **144成功・14スキップ・失敗0（158件）**。スキップは他機能の専用DB/外部環境を要する既存試験。共有環境のDDL・反映・初期化・公式ベンチは未実施。

## 局所測定

合成5,037ユーザー、プロフィール画像なし。単一Mac上のDocker PG16.13、Node26.12.1。DB接続pool上限2、呼出しは逐次で同時1接続。検索ハンドラーだけを呼び、認証/IP ban/nginx/画像署名/実WAN帯域制限/共有サーバーのCPU競合を含まない。

各検索語・RTT条件について、独立Nodeプロセスを **旧→新→新→旧** の順に実行。各プロセスは1回warmup後8回測定し、表は2プロセスそれぞれの中央値の範囲。DB受信量はTCP proxyで数えたPostgreSQLプロトコルの実バイト数（接続・prepared statement初回はwarmupに除外）。SQL行数と受信量は画像のないこの合成データの値である。

| 検索 | DB受信量 旧→新 | DB返却行数 旧→新 | RTT0のハンドラー時間 旧→新 | 模擬RTT100msの時間 旧→新 |
| --- | ---: | ---: | --- | --- |
| common（50件＋hasMore） | 1,979,233→20,948 B | 5,035候補＋ブロック2→51 | 13.87–14.66→0.98–1.63ms | 225.30–269.54→104.98–107.47ms |
| never-match（0件） | 1,979,233→283 B | 5,035候補＋ブロック2→0 | 17.53–19.99→2.13–5.57ms | 229.73–237.96→106.05–106.22ms |
| café（1件） | 1,979,233→443 B | 5,035候補＋ブロック2→1 | 16.42–34.08→4.83–5.13ms | 225.00–236.76→104.35–104.79ms |

ハンドラーのSQL数は2→1。RTT0のNode CPU時間中央値はcommonで9.44–9.89→1.10ms、0件で11.78–12.38→0.53–1.27ms、1件で12.97–15.58→1.06–1.24ms。これはNodeプロセスだけのCPU時間で、DBのCPUやHTTP経過時間とは別である。

測定後に同じSQLをEXPLAIN ANALYZEした単発のDB Execution Timeは、commonで旧3.875–12.673ms/新0.075–0.320ms、0件で旧3.997–8.967ms/新1.782–2.384ms、1件で旧3.453–9.040ms/新0.819–15.140ms。1件の新版に15.140msの外れ値もあり、DB時間が常に改善するとは断定しない。旧版は5,035行のSort、新版はLimitで実返却0/1/51行。これらは単発SQLの経過時間であり、27678のSQL累積時間や競技得点へ換算しない。

公式ベンチでは検索HTTPの地域別件数/平均/p95、asia2のCPU・SQL・待ち、登録/プロフィール更新・initialize時間、他APIの退行、総得点とエラーを確認する。**競技得点の改善は未確認**。

## 反映と切り戻し

共有環境では未実行。反映は他のベンチ・書込と重ならない区間で行う。DBはasia2、反映先はTaskfileのasia1/europe1/america1/asia2。NodeがTypeScriptを直接実行するため追加ビルドは不要で、依存の用意はtask deployに含まれる。

asia2を読取確認し、users/initial_usersはともにisureal所有、アプリロールにSELECT/UPDATE権限があることを確認した。この確認ではDDLやデータ変更は行っていない。

1. information_schema.columnsでusers/initial_usersのsearch_username/search_display_nameの4列を確認する。未適用なら下のmigrationを実行。適用済みならDDLを飛ばす。ADD COLUMN IF NOT EXISTSなので部分適用からも再開できる。
2. デプロイ後に新しいNodeでバックフィルし、users/initial_users双方のmismatches=0を確認する。--checkは読取だけである。
3. task statusで全4台のbranch/SHAとサービスを確認してから、ポータルでEnqueueする。task benchはデプロイも含むため重ねて実行しない。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-search-filter-pushdown
# 未適用時のみ。実行前に上記4列の有無を確認する。
ssh asia2 'sudo -n -u postgres psql -X -d isureal -v ON_ERROR_STOP=1' \
  < webapp/sql/migrations/20261031-user-search.up.sql
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/search-filter-pushdown
ssh asia2 'set -eu; set -a; . /home/isucon/env.sh; set +a; cd /home/isucon/webapp/nodejs; ISUREAL_DB_HOST=127.0.0.1 /home/isucon/local/node/bin/node scripts/backfill-user-search.ts; ISUREAL_DB_HOST=127.0.0.1 /home/isucon/local/node/bin/node scripts/backfill-user-search.ts --check'
DISCORD_WEBHOOK_URL= task status
ssh asia1 'systemctl is-active isureal-nodejs.service isureal-nodejs-europe.service isureal-nodejs-america.service'
```

正常なら [ポータルのベンチ一覧](https://portal.isucon.net/contestant/benchmark_jobs) のEnqueue。ポータルAPIは今回確認していない。PRのHEADには自動デプロイ/ベンチを抑止する `[skip ci]` を付ける。

切り戻しはこの変更をrevertしたコードを再デプロイする。追加列は旧コードに影響しないため残し、DROPや元データの再投入は不要。再採用時は旧版運用中の変更も含めてバックフィルし直す。

## ローカル再現

専用の空DB `isureal_search_test` とloopbackの公開ポートを使う。実サービスの環境変数を読み込まない。以下の新しいコンテナ名が未使用であることを確認する。通常のPG試験と局所測定はそれぞれ別の空DBで始める。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-search-filter-pushdown/webapp/nodejs
npm run check
docker run -d --name isureal-search-correctness \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=isureal_search_test \
  -p 127.0.0.1::5432 postgres:16
docker exec isureal-search-correctness pg_isready -U postgres -d isureal_search_test
# pg_isreadyがaccepting connectionsになってから実行する。
search_test_port=$(docker port isureal-search-correctness 5432 | cut -d: -f2)
SEARCH_TEST_PG_PORT="$search_test_port" node --test --test-timeout=45000 test/user-search.test.ts

docker run -d --name isureal-search-measurement \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=isureal_search_test \
  -p 127.0.0.1::5432 postgres:16
docker exec isureal-search-measurement pg_isready -U postgres -d isureal_search_test
search_bench_port=$(docker port isureal-search-measurement 5432 | cut -d: -f2)
SEARCH_TEST_PG_PORT="$search_bench_port" node test/user-search.bench.ts seed
SEARCH_TEST_PG_PORT="$search_bench_port" node test/user-search.bench.ts verify
for search_mode in old new new old; do
  SEARCH_TEST_PG_PORT="$search_bench_port" SEARCH_BENCH_RTT_MS=100 SEARCH_BENCH_QUERY=common \
    node test/user-search.bench.ts "$search_mode"
done
```

PG試験は新規DBであることをassertする。initializeハンドラーの試験は、ホストで動くpsql（Docker利用時は専用コンテナのpsqlにreset.sqlを渡すwrapper）をPATHに置き、そのディレクトリをSEARCH_TEST_PSQL_DIRで指定した場合に実行する。指定なしでも実reset.sqlのDB復元試験は行う。

仕様参照: [PG16 strpos](https://www.postgresql.org/docs/16/functions-string.html)、[table lock](https://www.postgresql.org/docs/16/explicit-locking.html)、[session_replication_role](https://www.postgresql.org/docs/16/runtime-config-client.html)。
