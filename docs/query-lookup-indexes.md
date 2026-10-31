# 認証・投稿検索の追加索引

関連: [Issue #18](https://github.com/ue-sho/isucon15/issues/18)。
2026-10-31、`perf/query-indexes`、基点main `614a3c9`。

## 選定と影響

asia2（hostname ip-192-168-4-10、checkout ab01887、PostgreSQL16.15）のpg_indexes・表サイズと、実行しないgeneric EXPLAINを確認した。
過去のinventoryやIssue本文だけで適用済みと判断せず、現在存在しない索引を選定した。

| 追加する索引 | 理由 |
|---|---|
| login_sessions_active_token_idx: (token_hash) WHERE active=true | 認証が現状Seq Scan。表は230推定行/256kBと小さいが、全認証リクエストの点検索を対象にする。失効したsessionは索引から外れる |
| posts_active_author_window_idx: (author_id,posting_window_id) WHERE deleted_at IS NULL | 投稿済み判定・現在投稿・Memoriesで既存2索引のBitmapAndを繰り返す。作者と投稿枠を1索引で絞る |

既存PK/UNIQUEは変更しない。追加は非UNIQUE索引のみで、SQLの結果・認可条件・データの保存方法は変えない。
索引保守分の容量・WAL・INSERT/UPDATE/DELETE費用は増える。既存索引は削除しない。
comments/realmojisの一覧は既存post_id索引で推定1行まで絞れており、今回の追加を見送る。
ブロック表は推定254行/40kBで小さい。通知は既存(user_id,posting_window_id)を利用できるため追加しない。

## 適用・切り戻し

- 新規DB: `001-schema.sql`の各テーブル直後に定義。
- 既存DB: `migrations/20261031-auth-post-lookup.up.sql`をpsqlで単独実行。BEGIN/--single-transactionで囲まない。
- 通常のオンライン適用はCREATE INDEX CONCURRENTLYを1本ずつ実行。lock_timeout=3s、statement_timeout=5min。通常のDMLは継続できるが、CPU/I/O・WALと競合待ちは発生し得る。
- 古いスナップショットが残る場合の別手順は `20261031-auth-post-lookup.maintenance-up.sql`。対象表に他接続のロックがなく、他の稼働処理が別対象のFETCHのみの時間帯に限る。SHARE MODE NOWAITで対象2表をロックし、通常CREATE INDEXを同一Txで実行する。読取は継続できるが対象表の書込はCOMMITまで待つ。各文のstatement_timeout=30s、失敗時はTx全体をロールバックする。
- 適用前にデプロイロックと稼働SQLを確認し、計測・初期化・他DDLと重ねない。通常デプロイ・initializeからのDDL自動適用は追加しない。
- 適用後はpg_indexのindisvalid/indisready、索引定義・容量、generic計画を確認する。
- 失敗時は再実行で無視せず、索引のvalid/readyを調べる。途中生成されたINVALID索引はdown.sqlの該当DROP INDEX CONCURRENTLYだけで撤去し、再試行の要否を判断する。
- 切り戻し: `20261031-auth-post-lookup.down.sql`で今回の2本だけを撤去する。既存索引・データは維持する。
- reset.sqlは表を作り直さずTRUNCATE/DELETE/INSERTするため索引を維持する。新規専用PG16で実際のsnapshot/reset実行後にも両索引がvalid/readyで残ることを確認した。

## ローカル検証

Node26.10.0/PG16.11、新規専用DB・合成データ（投稿20万、session2万）。
`QUERY_INDEX_TEST_PG_PORT=15441 node test/query-indexes-db.test.ts`が成功。
up.sqlを実行し、両候補が実計画で選ばれること、前後の結果一致、再接続、snapshot/reset後の維持、down.sql後の結果一致を確認。
ローカルの単発EXPLAIN ANALYZEはsession 0.907→0.013ms、投稿点検索0.046→0.020ms。本番の表サイズ・負荷とは異なり、スコア改善の根拠とはしない。
型チェック・diff check成功。既存の署名回数テストは本変更と無関係で、全体テストの再実行はしていない。

本番のSQL時間・pool待ち・API時間・ベンチ比較は未検証。索引を増やしただけでスコア改善とは判断しない。

## 本番適用の状態

適用直前の安全確認で他のDB処理を検知し、CREATE INDEXの前に中止した。
続く読み取りではFETCHのactive接続2本とidle in transaction接続1本があった。
当初は未適用で停止。その後ユーザーから「かぶっていないならやってもよい」と許可を受けた。

適用前のgeneric推定cost（msではない）: session43.18、投稿済み判定100.72、Memories192.97。
投稿側は既存author_idとposting_window_idのBitmapAnd。コメント20.79、RealMoji24.82はいずれも既存post_id索引を利用。
計画原本は手元 `/tmp/isu15-query-indexes-before.json` に保存。実行時間・実scan量や本番で使われたcustom planの証明ではない。


## 本番適用完了

対象表の他接続ロックはなく、残る3接続は別対象のFETCHだった。ただし古いbackend_xminを保持していたためCONCURRENTLYの完了待ちが生じる状態だった。
[PG16の仕様](https://www.postgresql.org/docs/16/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)を確認し、競合する書込がない間に上記maintenance-up.sqlで原子的に通常作成した。
デプロイロックなし、対象表に他接続のロックなし、他の稼働処理はFETCHのみ、NOWAITで即時ロック取得を確認して実行。2本のCREATE INDEXとCOMMITが成功した。
既存のFETCH 3接続が作成後も継続していることを確認した。ユーザー処理のキャンセル・他接続の切断はしていない。

| 索引 | valid/ready | 容量 |
|---|---|---|
| login_sessions_active_token_idx | true/true | 32 kB |
| posts_active_author_window_idx | true/true | 62 MB |

| SQL | generic推定cost前→後 | 計画 |
|---|---|---|
| session認証 | 43.18→16.59 | Seq Scan→追加索引のIndex Scan |
| 投稿済み判定 | 100.72→52.26 | postsのBitmapAnd→追加索引のIndex Only Scan |
| Memories | 192.97→93.53 | postsのBitmapAnd→追加索引のIndex Scan |

これらは推定costでありmsではない。実行計画は本番でEXPLAINのみ取得し、ANALYZEや実データ集計は実行していない。
原本は手元 `/tmp/isu15-query-indexes-before.json` と `/tmp/isu15-query-indexes-after.json`。
本番DDLのみ反映済み。リポジトリではスキーマ・適用/撤去SQL・テストを同ブランチの差分として保持。アプリのデプロイ・再起動・初期化・追加ベンチは行っていない。

## API全体の追加確認

ユーザー提示のHTTP集計はlogin1023件、画像928件、friends feed216件、Memories205件、投稿枠109件、投稿100件など。
成功/失敗の内訳を混ぜず、索引で改善できる検索をアプリ全体のSQLと照合した。
画像の432件の4xxには署名等の拒否が含まれ得るため、すべてを画像有効性SQLの対象とは扱わない。

追加する3本:

| 索引 | 対象と根拠 |
|---|---|
| posts_active_image_author_idx: (image_id,author_id) WHERE deleted_at IS NULL | 署名確認後の投稿画像有効性。現在は作者の133推定投稿をBitmap取得してimage_idでfilter、generic cost506.45 |
| posts_author_window_counts_idx: (author_id,posting_window_id) INCLUDE(deleted_at) | POST postsとGET posting-window/currentのactive/deleted件数集計。削除済み行が必須で先の部分索引は使えず、既存2索引のBitmapAnd、cost106.46 |
| follows_followee_updated_idx: (followee_id,updated_at DESC,id DESC) INCLUDE(follower_id) | followers一覧の逆方向検索とLIMIT/ORDER。followsとusersのSeqScan+Sort、cost727.52 |

投稿の2本のauthor/window索引はキーが重なるが、部分索引はactive行の権限/Memory用、完全なcovering索引は削除履歴込みの件数集計用。
今回、適用済みの部分索引を削除せず、用途差を維持する。今後の実測で保守費用が上回る場合は統合を別変更で検討する。
追加分の書込・WAL・容量費用は増える。PK/UNIQUEとSQLの結果・認可条件は変えない。
追加適用/撤去は `20261031-api-lookup.up.sql` / `.down.sql`。先行2本の適用SQLとは分け、各ファイルをpsqlでトランザクション外に実行する。

見送りと既存対応:

- loginのusernameはusers_username_id_idx済み。有効token検索は先行追加済み。失効用user_idはsession表230推定行のため追加しない。
- invalid profile-imageのJPEG処理は索引で改善できない。別Issue #16。
- friends feedは公開中枠の投稿を全取得してアプリで選別する。SQLの絞込みとLIMITが先で、今回wideなcovering索引や並び順索引を追加しない（#19）。
- ブロック254推定行/40kB、admin session、IPBanなど小表は追加しない。既存PK/UNIQUEを維持。
- friendsは両方向索引、pending友達申請は双方向の部分索引済み。
- comments/RealMoji一覧は既存索引で推定1行。今回は作成/置換時の索引保守費用を増やさない。
- ユーザー検索は取得後にUnicode正規化・部分一致で選別する。単純なB-tree追加では解決しない。
- image_objectsは既存の各partition PK先頭idを使える。画像有効性RealMojiの索引も既存。重複して追加しない。
- SSEの集計時間は通知待機を含む。通知は既存(user_id,posting_window_id)を使い、時刻索引を追加しない。

ローカルPG16テストを5索引へ拡張し成功。合成投稿20万/session2万/follows1万で全5索引の利用と前後結果一致、active1/deleted1の集計、再接続、snapshot/reset後の5索引valid/ready、全撤去後の結果一致を確認した。
本番の追加前generic計画原本: `/tmp/isu15-index-audit2-before.json`。

追加3本も本番適用済み。適用前にデプロイロックなし、対象posts/followsの他接続ロックなし、他の稼働処理は別対象FETCH1接続だけと確認。
古いスナップショットがあるため `20261031-api-lookup.maintenance-up.sql` で通常作成した。対象表のSHAREロックをNOWAITで即時取得し、各文30秒制限・同一Txで3本作成とCOMMIT成功。元のFETCH接続も継続。
追加分もCONCURRENTLY用up/downと、書込がない時間帯専用maintenance-upをリポジトリに残す。通常デプロイ時にDDLを自動実行する処理は追加しない。

| 追加索引 | valid/ready | 容量 |
|---|---|---|
| posts_active_image_author_idx | true/true | 62 MB |
| posts_author_window_counts_idx | true/true | 68 MB |
| follows_followee_updated_idx | true/true | 1592 kB |

| SQL | generic推定cost前→後 | 適用後の主な計画 |
|---|---|---|
| 投稿画像の有効性 | 506.45→8.46 | posts_active_image_author_idxのIndex Only Scan |
| 投稿作成等のactive/deleted集計 | 106.46→46.19 | posts_author_window_counts_idxのIndex Only Scan |
| followers一覧（LIMIT 51） | 727.52→223.14 | 新索引Index Only Scan＋users PK、Sortなし |

これらは実行時間ではない。全3本で利用を確認したが、実負荷でのAPI時間・書込保守費用・WAL・ベンチスコアの前後比較は未確認。
追加前後の計画原本: `/tmp/isu15-index-audit2-before.json` / `/tmp/isu15-index-audit2-after.json`。
合成データのテストではsession0.978→0.011ms、投稿画像0.099→0.014ms、件数0.048→0.021ms、followers1.012→0.125msだったが、単発かつ分布が本番と異なるので採用効果の証明にはしない。

## 現在の反映状態

計5本は本番DBに反映済み。通常のデプロイ・サービス再起動は不要で、索引作成後は既存SQLの再計画で利用される。
デプロイやresetは追加索引を削除しない。001-schema.sqlには新規DB用の定義を置き、適用/撤去SQLには既存DB用の手順を残す。
アプリのデプロイ・再起動・本番初期化・ベンチは実行していない。
