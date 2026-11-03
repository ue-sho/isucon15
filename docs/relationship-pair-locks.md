# 関係更新のペアロック設計・隔離実験

状態: **設計のdraft。本番採用は保留**。`src/`、稼働設定、migrationは変更しない。
試作は `webapp/nodejs/research/relationship-pair-locks/` に置き、アプリからimportしない。

## 根拠と判定範囲

- 調査開始main: `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`。
- [Issue #11の追加調査](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540744615)の対象はベンチ **27678 / 7361点 / Passed / 589f52d2ed9e2deb79dd4090c751771c310b706d**。
  `users ... FOR NO KEY UPDATE` の対象SQLは801回、累積19.084秒、最大1.428秒。
  取得処理とロック待ちを含むSQL時間であり、待ち時間だけの値ではない。HTTP時間、CPU時間、得点とも別の指標。
- 開始時のGitHub確認では #58 と #64 はopen、#63 はmerged、#57 は未マージclosed。
  #62 はopen draftで、公式ベンチの退行を受け採用対象外と記載されていた。現在の稼働版を意味しない。
- Aの投稿Tx短縮とCのコメント経路改善の評価後に、残存待ちがこの変更の複雑さに見合うか判断する。
  本実験は競技負荷、WAN、HTTP middleware、JPEG、画像署名、abuseの再現ではない。得点改善を主張しない。

## 現行経路の棚卸し

以下のパスは `webapp/nodejs/src/` 配下。NKU=`FOR NO KEY UPDATE`、S=`FOR SHARE`。
usersの明示ロック以外に、UPDATEや外部キーが取得するロックも考慮する。

| 経路・根拠 | 現行の順序・確認条件 | 候補での扱い |
| --- | --- | --- |
| `relationship.ts:48` `beginRelationshipTx` | BEGIN → min/max IDのusers NKU、両方active確認 | 全user S → graph共有 → pair排他。自己関係/空IDの400は呼出し境界で維持 |
| `friend_request_api.ts:21` 申請・逆方向申請による承認 | helper → block/friend/pending検査 → request INSERTまたはaccepted＋friendship | 同一無向ペアを通す。pendingにはペアunique制約がないため事前検査の排他は必須 |
| 同`:68` 承認/拒否/取消 | request事前取得、操作主体検査 → helper → request再読取 → pending検査、accept時block → 更新 | 事前取得はロック対象特定用。ロック後再検査を省かない |
| `relationship_api.ts:16,32,61` 友達解除/follow/unfollow | helper → 対象ペア変更。followはcertified_public、双方向block、重複検査 | pair排他。follow方向はデータ上維持、ロックキーだけ無向にする |
| 同`:77,105` block/unblock | helper → block → friendship削除、双方向follow削除、pending取消を同じTx | pair＋graph共有。過去のcomment/RealMojiは削除しない。unblockは関係を復元しない |
| `comment_api.ts:32` コメント作成 | 投稿事前取得 → actor/作者users NKUを重複除去し昇順 → `canComment`再検査 → INSERT | actor/作者S → graph共有 → pair排他（自己コメントならpair不要）。直接の友達条件をpairで固定 |
| 同`:99` コメント削除 | actor NKU → comment `FOR UPDATE` → commenter/投稿作者の所有検査 → 論理削除 | 既存NKUを維持。候補作成のSと競合する。block/友達条件を新規に追加しない |
| `realmoji_api.ts:42` RealMoji置換 | JPEG/種別検証、投稿事前取得、自己反応拒否 → helper → `canViewPost` → 既存反応置換、画像と反応INSERT | actor/作者S → graph排他 → pair排他。試作は公開範囲によらず保守的にgraph排他を使う |
| 同`:143` RealMoji削除 | actor NKU → reaction `FOR UPDATE` → reactor/投稿作者検査 → 論理削除 | NKU維持。置換時のusers Sとの排他も維持 |
| `post_api.ts:56` 投稿作成 | author active NKU → 現在投稿枠S → 枠/件数検査 → 画像/投稿INSERT | 変更しない。actorの「当日投稿あり」を変えるためSとの競合が必要。Aの採用版で再監査 |
| 同`:236,287` 投稿変更/削除 | author NKU → 投稿/枠/所有・削除回数検査 → posts UPDATE | 変更しない。公開範囲、対象投稿消滅、viewer自身の投稿条件を守る |
| `account_deletion_api.ts:8` 退会 | notification membership共有 → active user NKU → status deleted、session無効化 | 変更しない。候補のSが先なら退会は待つ。退会先行なら候補はactive再検査で拒否 |
| `user_api.ts:148` プロフィール・地域変更 | 地域変更時membership共有 → users UPDATE（暗黙NKU） | 変更しない。地域/表示名/bioの更新はSと競合する |
| `profile_image_api.ts:9,40` 画像設定/削除 | user NKU → image/ users変更 | 変更しない。署名/応答構築中のuser情報を安定させる |
| `admin_user_api.ts:11` 認証済み公開アカウントへ変更 | users UPDATE（暗黙NKU） | follow検査のSと競合する。認証取消APIは現行拒否のまま |
| `user_api.ts:64` 登録 | membership共有 → username bigint advisory → 新users INSERT | 変更しない。既存usersを後からロックする経路ではない |
| `user_api.ts:98` login、`session.ts:73,98` logout/session作成 | users NKU → sessions更新 | 変更しない。middlewareの認証/地域/IP検査も維持。既存のsession検査時点以上の保証は主張しない |
| `admin_posting_window_api.ts:27` 期間切替 | membership排他 → 期間UPDATE/INSERT → 通知INSERTのFK key-share | 変更しない。FK key-shareはusers S/NKUと両立。期間終了とinteractionは現行もusersロックだけでは直列化していない |
| feed/ユーザー詳細/コメント一覧/RealMoji一覧/画像認可/export | 通常の読取。`post.ts`/`comment.ts`等の公開範囲・block・active判定 | 本案でロックを追加しない。即時反映要件と現在の読取判定を維持。別担当の最適化は触らない |

`post.ts:getPostPermissions`では、他人の投稿の閲覧に「当日投稿あり」「対象枠が未終了」「双方向blockなし」「公開範囲」を用いる。
コメントはさらにpublicまたは直接の友達が必要で、FoFだけでは許可されない。RealMojiは閲覧権限を使うためFoFだけでも許可される。
現行の2-hop SQLは中間ユーザーのactive状態を条件にしていない。本案でも勝手に追加しない。退会は関係行を物理削除しない。

## 維持する不変条件

1. 同一無向ペアの申請状態遷移、友達、follow、block、承認は直列化される。逆方向申請による自動承認、操作主体、404/403/409を維持する。
2. blockのコミット後に開始した関係作成/interactionは許可されない。先行したinteractionは残り得るが、block後の読取権限は拒否する。
3. ロック後からコミットまで対象usersの生存・region・account_type等を変更させない。退会後の新規関係作成を防ぐ。既存行の残存を「不整合」と誤判定しない。
4. 投稿削除、公開範囲変更、viewer自身の投稿削除が権限検査と書込の間へ割り込まない。同じ投稿/actorのRealMojiはactive一件、置換と新規画像保存は原子的。
5. FoF許可を支えるA–CとC–Bのどちらの辺も、権限検査後に消えない。直接のA–B pairだけでは守れない。
6. 中途失敗は全変更をrollbackし、ロックをプールへ持ち越さない。認証、地域、block、退会、署名、abuse、画像検証は独立して必要であり、省略しない。

これは現行の書込経路がusers NKUで提供する範囲を整理したもの。全APIのserializable性やHTTPレスポンス時刻までの排他を保証するものではない。
期間切替の現行の隙間、認証後のsession置換、中間ユーザーの退会に新しい仕様を作らない。

## 候補の取得順

全対象を先に確定し、必要な最強モードを最初に取得する。取得済みロックのupgradeや、小さいキーの後付け取得は禁止する。

1. 必要な経路だけ既存notification membership lock。登録は続いて既存username lockを取る。
2. usersをID昇順、重複除去してロック。関係/interactionはS、users/投稿等を変更する既存経路はNKU。
3. graph guardを**実際のhashキーの数値昇順**で取得。関係を書き換える処理とコメントは両端の共有モード、FoF依存のRealMojiは両端の排他モード。
4. 全pairの排他advisory lockを**実際のhashキーの数値昇順**で取得。
5. ロックとは別SQLで対象投稿、active、関係、公開範囲等を再読取する。必要な子行を更新しCOMMIT。エラー時はROLLBACK。

既存投稿作成はusers → posting_window S → 子行、既存interaction削除はusers → 対象子行の順を維持する。
同一Txで複数子行を触る将来の拡張は型とIDの順を固定する。usersを後からUPDATEしたくなった場合はSからupgradeせず、最初からNKUで取り直す。
新しい関係が途中で見つかり取得対象が増えた場合も全Txをrollbackして対象を再計算する。pairを取った後でgraphやusersへ戻らない。

graph共有を通常の関係更新に使う理由は、A–BとA–Cの更新同士を競合させないため。FoF判定側だけがA/Bのgraph排他を取ると、
A–C–Bのあらゆる2-hop経路の変更は必ずAかBのgraph共有と衝突する。中間Cの列挙も、既存の辺だけをロックする方法も不要で、新規の辺も含められる。
代償としてRealMojiとA/Bに接する無関係な関係更新は待つ。全RealMojiをgraph排他にする保守案の費用は未計測。
公開投稿だけgraph共有へ弱める最適化は、users S後に公開範囲を確定させてから最強モードを選ぶ別検証が必要。

users SはNKUと競合するがKEY SHAREはしない。status/region等は主キーを変えないUPDATEなのでKEY SHAREでは防げない。
行ロックとtransaction advisoryの性質は[PG16ロック仕様](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)に従う。
ロック取得と権限読取を単一CTEへ合体すると待機前のsnapshotが残り得るため、本試作は別statementで再検査する。
根拠は[Read Committedのstatement単位snapshot](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)。

### キー、衝突、解放、混在

- pairはIDを昇順に並べたJSON配列をUTF-8 SHA-256へ渡し、先頭4byteをsigned big-endian int32にする。区切り文字だけの連結は使わない。
- graphはIDを同じhashにする。二引数namespaceはgraph=`1380730706`、pair=`1380730707`。通知の`(20261031,1)`と異なり、登録の一引数bigint空間とも別。
- hash衝突は別pairの過剰直列化を起こすが、衝突したキーを共用するので排他が失われることはない。キーはdeduplicateし、hash後に並べる。
  graph同士の衝突も保守的な待ちになる。32bitの衝突頻度、lock managerメモリ、hot userの待ちは採用前に評価する。
- 常に`pg_advisory_xact_lock[_shared]`。セッションロックは使わない。COMMIT、ROLLBACK、接続終了で解放。
  savepoint以降のロックはそのrollbackで解放されるため、ロックを失った後に同じ操作を継続しない。例外を握り潰して書込を続けない。
- deadlock/serialization failure時は全Txをrollbackし再読取からやり直す。HTTPの機械的再送、commit結果不明時の重複書込はしない。
  既存APIのエラー分類・再試行予算は本実装で決め、今回の実験に自動再試行を入れて失敗を隠さない。
- 旧NKUと新Sの混在は同じusersで競合するため、移行中は旧方式の広い直列化が残る。これを安全性の追加根拠にするには混在試験も必要。
  helperだけの差替えで完成とせず、comment、RealMoji、FoF、全更新経路をまとめてレビューする。

## 実験の実行

Docker、Node 26以降、既存のnpm依存が必要。新しい本番依存やDDLは追加しない。

```sh
cd webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm exec tsc -- -p research/relationship-pair-locks/tsconfig.json
cd ../..
node webapp/nodejs/research/relationship-pair-locks/run.mjs
```

runnerは専用の一時PostgreSQL 16コンテナを作り、127.0.0.1の自動割当portだけを公開する。
DB名固定・ランダムmarker・空DB確認後に既存schemaを読み、A/B/C/Dの合成データだけを使う。
外部DB URL、既存コンテナ名は受け取らない。試験後に専用コンテナを削除する。共有DBの初期化SQLとして試験を実行しない。

現行側は実際の`beginRelationshipTx`、権限判定は実際の`canComment`/`canViewPost`を使用。
子行の操作は競合に必要なSQLを切り出したモデルで、ハンドラー全体の移植ではない。コメント現行側も同じNKUのhelperでロック形状を再現する。
HTTPレスポンス、全入力拒否、JPEG実byte保存、署名、通知、abuse、初期化APIまではこの試験の成功から主張しない。

競合試験は先行Txのロック取得完了をawaitし、後続を起動して、observerの`pg_blocking_pids`と`pg_stat_activity.wait_event_type='Lock'`で待ちを確認してから先行を解放する。
並行できる場合は先行Txが未commitのまま後続の書込/commit完了を確認する。競合の根拠をsleep時間にしない。
5ms pollingはロック状態の観測用、6秒statement timeoutはハング検出用。両順序と最終状態を検査する。

結果は[実験記録](relationship-pair-locks-results.md)を参照。

## 本実装する場合のファイルと未完の確認

| ファイル | 変更または再監査する理由 |
| --- | --- |
| `webapp/nodejs/src/relationship.ts` | lifecycle/graph/pairの取得、自己関係拒否とエラー時解放、複数pairのAPI |
| `webapp/nodejs/src/friend_request_api.ts` | 申請/遷移全体を同一ロック規約へ。検査と更新の間を保護 |
| `webapp/nodejs/src/relationship_api.ts` | blockの複合変更、follow、解除、unblockすべてを同一規約へ |
| `webapp/nodejs/src/comment_api.ts` | 独自NKUループと自己コメント、削除経路の排他の統合検証 |
| `webapp/nodejs/src/realmoji_api.ts` | FoF graph排他、置換の一意性と削除との排他 |
| `webapp/nodejs/src/post.ts`, `comment.ts` | 権限判定の依存を監査。条件そのものを減らす変更はしない |
| `webapp/nodejs/src/post_api.ts`, `account_deletion_api.ts`, `user_api.ts`, `profile_image_api.ts`, `session.ts`, `admin_user_api.ts`, `notification_membership.ts`, `admin_posting_window_api.ts` | 原則ロックを維持。A/C/通知担当の採用後のコードとの順序整合を再監査 |
| `webapp/nodejs/test/relationship-api.test.ts`, `auth-permission-db.test.ts`, `regional-relationship-db.test.ts`, 新規DB競合試験 | 本物のHTTPハンドラー、各地域、認証/入力/エラー/画像/abuse、混在版の回帰確認 |

本番のschema/index変更は現案では不要。graph/hash helperを本番へ持ち込む前に、全取得箇所とnamespaceの重複を再検索する。
本PRは設計/試験だけなので、デプロイしても候補ロックは有効にならない。候補の公式ベンチをするには別の本実装PRが必要。

## A/C導入後の判断材料

同じ採用版・DDL・worker/pool・負荷条件の公式ベンチで比較する。27678との単純な点差や、異なる変更の改善幅の加算はしない。

- usersロックの回数、総/平均/p95/max取得時間に加え、実blocker/waiter、待機イベント、保持区間、Tx全体時間。
  取得完了後→commitの時間だけでは取得途中の保持は含まれない。SQL累積、HTTP経過、CPUサンプルは分ける。
- A/B・A/Cの異なるpairが実際にどれだけ競合しているか。同一pairの待ちは本案でも消えない。
- 地域別関係API/コメント/RealMojiの成功数、403/404/409/5xx、平均/p95とtimeout。block・退会直後の整合性。
- 投稿期間切替、投稿成功と期間内friends確認、feed、画像、exportなど他経路の退行。
- DBのdeadlock件数、接続pool待ち、active Tx、advisory lock数、hash衝突、graph排他待ち、長いTxによる待ちの連鎖。
- 全体score/Passed/messagesを個別のSQL指標と併記する。ローカル並行性の実証は得点の根拠にしない。

A/Cで待ちが十分減る場合は本案を採用しない。待ちが残っても、本物のハンドラーによる全境界・両順序試験、
全リージョンの同時更新、初期化/再起動、混在版、長時間/多接続負荷が未確認なら設計保留を継続する。
