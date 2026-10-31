# Issue #19: friendsフィードのSQL選別と51件制限

2026-10-31。対象は [Issue #19](https://github.com/ue-sho/isucon15/issues/19) のfriendsフィードのみ。専用worktree `isucon15-friends-feed-sql`、ブランチ `perf/friends-feed-sql`。初回実装の着手時にfetchし、mainが `60b1f560d2427edf401aa12c3a2f2b83df081ef4` であることを確認した。初回実装完了時の確認でもmainは同じだった。後続のPR作成時には下記のとおり最新mainへリベースした。

## 変更

入力検証後、汎用 `loadViewerContext` より前でfriendsだけを `src/friends_feed.ts` に分岐する。1 SQLで閲覧できる投稿を最大51件選び、先頭50件だけ作者・投稿の変換、画像署名、応答生成を行う。51件目は `hasMore` だけに使う。

- 直接の友達IDをDB内の `ARRAY` にし、`ANY` で照合する。友達の友達の取得・Node.jsのSet構築を省く。可変長のプレースホルダーは増やさない。
- 作者のactive、未削除、未終了の投稿期間、自分以外、直接の友達、双方向block除外、公開範囲の全条件を適用してから `ORDER BY posted_at DESC, id DESC LIMIT 51`。
- 直接の友達に対しては `public` / `friends` / `friends_of_friends` が閲覧可能。未知の公開範囲は返さない。
- 閲覧者はDB上の現在の地域を使う。その地域の未終了枠の `local_date` と、本人の未削除投稿の枠の `local_date` が一致することを確認する。本人投稿の枠の地域・終了状態は追加制限しない。別地域・終了済み枠の同日投稿でも閲覧できる既存挙動を維持する。
- 作者の地域・日付は閲覧者に限定しない。未終了なら他地域の日付が異なる投稿も対象。
- 未終了の投稿期間を `MATERIALIZED` CTEにまとめる。地域ごとに未終了枠が一つという既存制約の下では最大3枠。過去投稿ごとに期間の主キーを引く計画を避けるため。
- 初回とcursorありの2種類の固定SQLを使う。cursorは従来と同じタプル比較。`Temporal.Instant` をDB層へ渡し、Dateやミリ秒へ変換しない。
- 閲覧条件は1 statementのスナップショットで評価する。関係更新後の次リクエストに即時反映し、リクエストをまたぐ権限・応答キャッシュは追加しない。

`post.ts`、他の3種類のfeed、ランキング、JPEG、通知、画像配信、スキーマ、依存、初期化、DB設定は変更しない。

## 正しさ

Node.js v26.12.1、実PostgreSQL 16.13の新規ローカルコンテナ、リポジトリの `001-schema.sql` と合成fixtureで確認。テストはlocalhost・固定のテストDB名に限定し、初回はpublic schemaが空であることを検査する。再実行は、このテストが作ったmarkerのあるDBに明示opt-inした場合だけ許可する。

参照側はmain `60b1f56` の全 `src` を `git archive` で一時ディレクトリへ抽出する。変更後の実装から期待値を再構成しない。Honoの認証済みハンドラーを同じfixtureに対して実行し、URL期限を決める時計を固定して、HTTP status・Content-Type・JSONの全文を比較した。

`test/friends-feed.test.ts`: **45件成功（親1＋44項目）**。

- 0 / 49 / 50 / 51 / 120件、3ページ、重複・欠落なし、同時刻のID順。
- PostgreSQLのmicrosecond、異なるUTC offset、nanosecond付きcursorの既存丸め挙動、prepared statementのcursor反復。
- 未投稿、本人投稿の削除、現在枠なし、前日投稿のみ、現在地域の変更、別地域の同日・異日・終了済み枠。
- 作者の投稿期間終了、友達解除、双方向block、全公開範囲の変更、投稿削除、作者退会、閲覧者退会、全友達解除。更新後の次リクエストも比較。
- 無関係な新しい候補5,000件が先行しても必要な50件を返す。
- 入力エラーのstatus・JSONとDB呼出し0回、存在しない閲覧者の空応答、非ランキングでの `beforeScore` の既存挙動。
- 51件目にアクセスすると失敗するrowを使い、変換が行われないことを確認。署名キャッシュを使わない試験で、50件×投稿/プロフィール画像×1,000回のHMACだけを実行することも確認。
- 未投稿時のEXPLAINで候補投稿・作者・友達の走査が `Actual Loops=0`。空応答の確定後に本人投稿がcommitされた場合、次リクエストから閲覧できる。
- public / following / friends-of-friendsの本文・順序・cursor・未投稿時が参照側と一致。

追加で、既存 `regional-api-db.test.ts` **1件成功**。別の新規ローカルDBに対し、実際の認証・投稿APIと3地域用アプリを使い、投稿後のfriends取得とblock後の即時反映を確認した。

- `npm run check`: 成功。
- friendsの実DB試験を有効にした全体 `npm test`: **127件中102成功、21失敗、4スキップ**。
- 失敗21件は既存 `page-response.test.ts` の署名回数期待値。main `60b1f56` を別コピーで実行した結果も82件中57成功・同じ21件失敗・4スキップで、失敗名の集合が完全一致した。署名キャッシュを考慮しない期待値であり、この変更で直していない。
- スキップ4件は他機能のopt-in DB試験。上記地域間試験は別途実行済み。全体テストを全件成功とは扱わない。

## 性能比較の条件

実行開始時刻: 2026-10-31 13:55:51 JST。Apple M5 / 10 CPU / RAM 24 GiB、Node.js v26.12.1、Docker上のPostgreSQL 16.13（aarch64）。コンテナ個別のCPU・メモリ制限なし。ホスト全体の他プロセス負荷は固定していない。SQLは既存インデックスのみ、追加DDLなし。

**すべて合成データ。実環境のactive投稿件数・友達数・履歴分布を測定したものではない。** 本番データや画像をコピーしていない。

| fixture | 閲覧可能な直接友達投稿 | 無関係な現在投稿 | 無関係な過去投稿 | 各友達の過去投稿 | posts総数 |
|---|---:|---:|---:|---:|---:|
| small | 60 | 20 | 0 | 0日 | 86 |
| large | 110 | 30,000 | 100,000 | 30日 | 133,416 |
| history-heavy | 110 | 30,000 | 100,000 | 365日 | 170,266 |

ほかに本人投稿1件と、block・退会・非友達などの作者5人を含む。過去投稿は終了済みの日別枠へ分散。large/history-heavyは二段階の友達グラフに5,000本の辺も持つ。旧実装が選ぶ未終了候補はsmallで84件、他2条件で30,114件。返せる投稿集合は前後で同じ。

`test/friends-feed.bench.ts` は各fixtureをANALYZEした後、旧→新→新→旧（ABBA）の順に**別Nodeプロセス**で測定する。1ブロックにつきcold 1回、warmup 10回、その後30回。各実装は60回のwarm標本を持つ。poolサイズ1、逐次実行、DBは同じfixtureを保持する。cold/warmの画像署名条件を前後でそろえる。

時間はHonoの `app.request` 開始からJSON読取りまでで、認証/IP制限ミドルウェア・HTTPサーバーのsocket・地域間RTTを含まない。CPUはNodeプロセスのuser+system時間。heap/RSSは各応答の直後に標本化した最大値であり、厳密な瞬間ピークではない。GCはcold前とwarmup後だけ明示実行する。PG受信bytesは、既存接続のDB TCP socketの `bytesRead` 差分で測り、PostgreSQLプロトコルを含み、接続handshake・TCPヘッダーを含まない。

以下の範囲はABBA内の**2ブロックの値の範囲**。異なるfixture間の差を改善効果と解釈しない。

| 指標 | small 旧→新 | large 旧→新 | history-heavy 旧→新 |
|---|---|---|---|
| SQL回数/要求 | 6 → 1 | 6 → 1 | 6 → 1 |
| DB返却行数/要求（全SQL合計） | 235 → 51 | 35,345 → 51 | 35,345 → 51 |
| PG受信bytes/要求 | 93,000 → 54,795 | 31,590,803 → 54,795 | 31,590,803 → 54,795 |
| 応答中央値 ms | 2.55–2.56 → 1.68–1.85 | 317.68–332.88 → 2.69–3.05 | 276.58–283.89 → 3.75–3.86 |
| 応答p95 ms | 4.79–5.60 → 3.70–4.51 | 405.28–467.10 → 4.59–7.97 | 306.84–348.92 → 4.44–4.75 |
| Node CPU中央値 ms/要求 | 1.44–1.47 → 1.01–1.05 | 178.13–184.79 → 1.37–1.51 | 151.43–156.59 → 1.14–1.15 |
| heap標本最大 MiB | 21.50–21.59 → 17.19–20.21 | 76.19–76.79 → 17.21–17.45 | 179.07–280.35 → 17.21 |
| RSS標本最大 MiB | 133.84–135.20 → 123.61–125.06 | 313.11–472.38 → 124.88–125.78 | 426.75–507.72 → 122.83–124.72 |
| cold応答 ms（各ブロック1回） | 128.21–133.16 → 120.80–125.35 | 419.07–514.02 → 184.73–202.34 | 412.39–425.96 → 134.03–190.22 |

## DB側の計画と負荷

API計測とは別に、採取した全SQLを同じDBでprepared実行6回の後、`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) EXECUTE ...` で各12回測定。1要求を構成するSQLの合計を比較した。新SQLはこの反復でcustom 5回・generic 13回となった。キャッシュ済みgeneric planでも確認している。

| 指標 | small 旧→新 | large 旧→新 | history-heavy 旧→新 |
|---|---|---|---|
| DB実行時間の中央値 ms | 0.111–0.122 → 0.254–0.283 | 116.965–138.181 → 0.844–0.995 | 119.999–128.631 → 2.020–4.823 |
| DB計画時間の中央値 ms | 0.089–0.098 → 0.006–0.008 | 0.251–0.259 → 0.005–0.007 | 0.239–0.242 → 0.004–0.019 |
| 計画＋実行時間の中央値 ms | 0.203–0.221 → 0.259–0.288 | 117.230–138.464 → 0.851–1.013 | 120.226–128.859 → 2.023–4.842 |
| shared hit blocks（各SQLのrootの合計） | 24 → 21 | 93,199 → 643 | 93,229 → 1,228 |
| temp written blocks | 0 → 0 | 3,516 → 0 | 3,516 → 0 |

largeはfriendshipsの両方向インデックスから113 IDを作り、`posts_author_id` のBitmap Scanで3,413投稿を調べ、未終了枠とJOINして113件、作者active・block適用後110件をsortし51件に制限する。history-heavyでは `posts_posting_window_id` と `posts_author_id` のBitmapAndで現在枠と作者を交差させる。全候補のワイドな行の外部sortと転送を省けている。

試作の `IN (SELECT ...)` と期間の直接JOINでは、履歴の多い条件で期間の主キー探索が40,262回、shared hits 122,415、実行約37msになった。最終形は上記のCTE＋ARRAY/ANYに変更した。権限判定前にLIMITを置いて速くしたものではない。

**少数候補ではDB時間が微増した。全条件でDB負荷が改善したとは結論しない。** smallの計画＋実行は約0.20–0.22msから0.26–0.29msで、SQL往復を含む応答は短縮したがDB時間の増加は残る。多数候補ではDB時間・buffer参照・temp書き出しも減った。history-heavyのDB時間にはばらつきがあり、実負荷のCPU、同時実行、pool待ち、極端な友達数・block分布については追加確認が必要。

生結果はローカルの `/tmp/isucon19-friends-feed-20261031/verified/` に保存（`comparison.json`、ブロック別JSONとEXPLAIN、テスト出力）。ログ本体はGitに含めない。再現スクリプトと本表をGitに残す。計測時のSHA-256:

```text
src/feed_api.ts      3a173c91ecb3a92dd186f34d82bffc9dff1dd5f4b7c7ee79f7de1522cbc00d8b
src/friends_feed.ts  de66c9f9e2dfa1b8b2d19a5e4a665a550b66fb8cfb76c706b806daba78e63b4e
```

## 関連PRとの統合

- [#38](https://github.com/ue-sho/isucon15/pull/38) `a5041de`: 未投稿者の早期return。`feed_api.ts` の隣接行で3-way競合を確認。friendsの新分岐を残し、その後の汎用経路の `requirePostedToday` も残す。friends自体も未投稿時は候補を走査せず空を返す。
- [#39](https://github.com/ue-sho/isucon15/pull/39) `53f0f95`: 認証済みユーザー再利用・単一投稿権限。`feed_api.ts` の隣接行で3-way競合を確認。新分岐の後にある `session` と `loadViewerContext(..., session.user)` を維持する。friendsはユーザー全列を再取得せず、同じSQL内で現在地域とactiveを確認する。
- #38と#39自身も `loadViewerContext` の第3引数が競合する。ローカルの一時コピーだけで `authenticatedUser` を第3引数、早期returnオプションを第4引数として両機能を保持し、本変更を追加した。**型チェックと本変更の45件の実DB比較が成功**した。これは統合候補の検証であり、他担当ブランチや本ブランチの `post.ts` を書き換えたものではない。
- #38のテストはfriends未投稿時「2 SQL」を期待するが、本変更では1 SQLになる。PR作成前のリベースに合わせ、friendsだけの期待値を1 SQLへ、投稿競合のhookをfriends用 `select` 完了後にも対応する形へ更新した。他feedの2 SQL期待値は維持した。
- [#40](https://github.com/ue-sho/isucon15/pull/40): 作業中にhead更新を確認し、最後にローカルで照合した版は `a18fc973c86bee31baff9e5e0beebddc1d9c31ae`。今回の本番コードとの変更ファイル重複はなく、feedの3-way統合も競合なし。JPEG・通知・画像配信や書き出し処理には触れていない。#40側に既存署名回数テストの修正があるが、本ブランチへ取り込んでいない。

## 再現

mainの参照commitがローカルGit objectに存在することが必要。接続先は新規ローカルコンテナに限定する。既存サービスの環境変数ファイルを読まない。

```sh
cd webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
docker run --detach --name isucon19-friends-feed-local \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=isureal_friends_feed_test \
  --publish 127.0.0.1::5432 postgres:16
docker exec isucon19-friends-feed-local pg_isready -U postgres
# accepting connections を確認後:
export FRIENDS_FEED_TEST_PORT="$(docker port isucon19-friends-feed-local 5432/tcp | cut -d: -f2)"
node --test test/friends-feed.test.ts
npm run check

# 上の試験が作ったDBだけを再利用。fixtureは毎回入れ直す。
FRIENDS_FEED_TEST_REUSE=1 npm test
FRIENDS_FEED_BENCH_OUTPUT=/tmp/isucon19-friends-feed-results \
  node --expose-gc test/friends-feed.bench.ts

# 既存の地域間API試験は別DBで実行:
docker exec isucon19-friends-feed-local createdb -U postgres isureal_regional_api_test
REGIONAL_API_TEST_PG_PORT="$FRIENDS_FEED_TEST_PORT" node --test test/regional-api-db.test.ts

# 今回作成したコンテナだけを片付ける:
docker stop --timeout 5 isucon19-friends-feed-local
docker rm --volumes isucon19-friends-feed-local
```

## 適用・切り戻しと残件

初回の作業範囲はローカル実装・検証・関連ファイルのコミットまで。初回検証時点ではpush・マージ・本番反映・共有DBのDDL・再起動・初期化・競技ベンチ・Issue更新は実施していない。#40の記録には画像書き出し進行中とあり、共有環境へ接続せず比較用DBだけで測定した。

### PR作成前の最新mainへの統合

後続のpush・PR作成依頼を受けた確認で、mainは#38を取り込んだ `ef058e726628cb17b7ffa68eb1868334f1e1aad6` へ更新されていた。このmainへリベースし、friends分岐と他feedの `requirePostedToday: true` を両方残して競合を解消した。`post.ts` は最新mainのままで変更していない。

新規ローカルPostgreSQLの別々のDBで、本変更の45件と#38の17件、計**62件が成功**し、型チェックも成功した。SQL回数の期待値・競合hook以外の#38の試験条件は維持した。生出力は `/tmp/isucon19-friends-pr-check-tests.txt`。friendsのSQLと応答生成を担う `friends_feed.ts` は上記計測時と同じため、性能比較は再実行していない。上記127件の全体試験と性能数値は初回実装時点の記録であり、最新mainへの統合後の全体試験結果ではない。

統合担当は上の競合方針で本変更を適用し、#38/#39/#40の最終headに合わせて型チェック、friends実DB比較、関連PRの試験を再実行する。DB migrationやキャッシュ移行は不要。共有環境の画像書き出し完了、反映版、他担当の作業、初期化の影響を確認・調整してから通常のデプロイと同条件ベンチを行う。

切り戻しは、この変更コミットを `git revert <friends改善コミット>` し、調整済みの通常手順で再反映する。DB・画像・キャッシュの復元操作は不要。#38/#39の変更は残す。

本番の件数・分布、全体スコア、同時負荷・地域間RTT、関連PR全体を合わせた競技ベンチは未検証。ローカルの応答短縮を本番スコア改善と扱わない。smallのDB時間微増も含め、本番採用は統合後の計測で判断する。Issue #19のpublic/following・friends-of-friendsランキングなどは残件であり、friendsの改善だけでIssue全体を閉じない。
