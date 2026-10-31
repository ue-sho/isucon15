# following・友達の友達フィードの候補転送とDB往復削減

2026-10-31。比較基点は `c0556a4fba0ea42063cbd53f07ace0f6f8690064`。

## 問題と変更

`GET /api/feeds/following` と `GET /api/feeds/friends-of-friends` は、現在期間の全投稿、友人グラフ、推薦用の関係をNodeへ取得してから対象を選別していた。投稿数・関係数に応じて転送行数とprepared statementのパラメーター数も増える。認証済みUserを再利用しても、友人がいる正常系のハンドラーはfollowingが6 SQL、友達の友達が7 SQL。これは認証・IPBanを除いた回数で、N+1とは区別する。

`src/discovery_feed.ts` にそれぞれ1 SQLの取得を追加した。

- followingはフォロー、投稿済み、現在枠、公開範囲、双方向blockをDB内で判定してから最大51件に制限する。
- 友達の友達は直接の友達を除外し、共通友達数・友人の反応・つながり数をDB内で計算する。点数は `10 * engagement + 3 * mutual + min(connection, 30)`。同じ友人の複数コメント・RealMojiはUNIONで1人分として数える。
- 推薦用の候補はID・作者ID・投稿時刻・共通友達数に限定し、順位決定後の最大51件について本文・作者情報を取得する。Node側で変換・署名するのは返す50件まで。
- 投稿時刻・IDの同点順序、hasMore、未投稿時の空応答、全地域の公開中投稿の扱いを維持する。推薦の時刻cursorは従来のTemporal比較に合わせてepoch nanosecondsをnumericで比較し、DBのmicrosecond丸めで境界を変えない。
- リクエストをまたぐ認可・関係・順位のキャッシュは追加しない。変更後の1 statement内で現在の状態を照会する。
- friends/publicの処理、リージョン転送、DBスキーマ、pool設定、署名・JPEGの実装は変更しない。

## 実行計画で修正した点

最初のSQL案は、友人グラフの行数を過小推定した計画で、5001作者に対して過去投稿まで繰り返し取得し、105001投稿を読んだ。大規模合成データでDB実行時間が約175msとなったため、その案は採用していない。

現在期間の小さい投稿情報を`current_posts AS MATERIALIZED`で先に分離し、友人グラフの探索とつながり計算を関係JOINへ変更した。大規模合成データの最終比較では推薦SQLの実行時間は約30–43ms。推定値だけで改善を判定せず、EXPLAIN ANALYZEとハンドラー全体で確認した。

## ローカル比較

Node v26.12.1、PostgreSQL16.13、専用ローカルPGコンテナ（2 CPU・512MiB）、合成データ、pool1接続。変更前のsrcをGitから展開して独立したNodeプロセスで実行し、順序はbefore/after/after/before。各プロセスは2回warmup後、RTTなし10回、模擬RTT100msでは4回測定した。認証済みUserのsnapshotを渡し、認証・IPBan・nginx・ルーター・実WAN帯域制限は含めない。

大規模fixtureは直接の友人110人、無関係な利用者5000人、過去投稿100000件と友人の過去30日分。以下は各before/afterを独立に2回実行した際の中央値の範囲。受信量はPostgreSQLプロトコルを含むソケットbytesReadの差分。

| 大規模データ | following・変更前 | following・変更後 | 推薦・変更前 | 推薦・変更後 |
|---|---:|---:|---:|---:|
| SQL数（認証/IPBan除く） | 6 | 1 | 7 | 1 |
| DBからの取得行数 | 10405 | 51 | 15346 | 51 |
| DBからの受信量 | 5551923 B | 53545 B | 5775525 B | 53291 B |
| RTTなしの応答中央値 | 119–122ms | 69–72ms | 139–140ms | 110–111ms |
| 模擬RTT100msの応答中央値 | 764–772ms | 181–210ms | 918–962ms | 239–249ms |
| RTTなしのNode CPU中央値 | 101–104ms | 71–75ms | 110–114ms | 75–77ms |
| EXPLAIN実行時間・RTTなし | 24–25ms | 2–3ms | 約26ms | 30–31ms |

小規模fixture（友人12人・無関係30人）では、RTTなしの中央値はfollowing約48–52→45ms、推薦約47–49→45ms。模擬RTT100msではfollowing約674–703→160–468ms、推薦約802–811→161–164ms。followingのafter片側はばらつきがあり、局所測定をスコアへ換算しない。

推薦はNode CPU・通信・ハンドラー時間を減らす一方、大規模データのDB実行時間は約4–9ms増えた。実負荷ではasia2のCPU・DB待ちと、Memories workerとの同居を確認する必要がある。ローカル比較だけで公式スコア上昇を保証しない。

再現用:

```sh
# 空の専用ローカルDB isureal_friends_feed_test を用意して実行する。
DISCOVERY_FEED_TEST_PORT=<local-port> node --test test/discovery-feed.test.ts
# 上のテストで専用DBに作成されたmarkerを確認してから合成fixtureを再作成する。
DISCOVERY_FEED_TEST_PORT=<local-port> DISCOVERY_FEED_BENCH_OUTPUT=/tmp/discovery-feed-bench node test/discovery-feed.bench.ts
```

## 正しさと未確認事項

- 専用PG16の変更前JSON比較38件成功。0/49/50/51/120件、複数ページ、同点、micro/nanosecond、共通友達数、つながり30上限、反応の重複除外・削除・置換・退会、公開範囲、双方向block、友達/フォロー変更、投稿削除、地域移動・同日の他地域投稿、session失効を検証。
- 未投稿時はEXPLAIN ANALYZEでfriendships/followsの走査が実行されないことを確認。force_generic_planでも変更前JSONと一致。
- 既存の未投稿/public/friendsフィードのPG回帰18件成功。標準テスト・型チェックの結果はPRに記載する。
- 共有サーバーへの反映、共有DB変更、初期化、公式ベンチ、実NGINX経由の今回の性能比較は未実施。
- 追加DDL・依存追加は不要。切り戻しは本変更のrevertで可能で、DBやキャッシュの復元は不要。

公式ベンチでは同じ統合版を基準とし、対象2フィードの地域別成功数・p95、asia2のDB CPU/待ち、投稿・friends・画像の退行と総スコアを比較する。
