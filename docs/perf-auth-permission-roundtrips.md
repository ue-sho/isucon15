# Issue #17: 認証・単一投稿権限・書込応答のDB往復削減

2026-10-31、[Issue #17](https://github.com/ue-sho/isucon15/issues/17)。
基点は最新mainの `614a3c9`（PR #36取り込み済み）。作業ブランチは `perf/auth-permission-roundtrips`。

## 変更と維持する条件

- session認証のusers JOINでユーザー情報も取得し、そのリクエストのGET me、feed、exportで再利用する。リクエストをまたぐ認証・権限キャッシュは追加しない。書込Txでは認証時のユーザー情報を使わず、従来どおりロック後のDB状態を読む。
- 単一投稿の権限確認では、全友人グラフを取得せず、投稿有無・対象作者とのブロック・直接の友達・共通友達を1 SQLで取得する。公開投稿・自己投稿では共通友達のEXISTSを省く。閲覧とコメントの違い（友達の友達、自己投稿、終了済み枠）を維持する。
- ログインはusername取得時の行ロックを維持し、同じユーザーの再ロックだけを省く専用関数を使う。汎用session作成関数はactive行ロックを維持する。session INSERTはRETURNINGでDB作成時刻を取得する。
- 登録、投稿、コメント、RealMojiのINSERT直後の再SELECTをRETURNINGへ変更する。投稿はCTEのRETURNINGとposting_windowsのJOINで従来のPost変換を使う。
- PATCH meは複数フィールドのUPDATEと再SELECTを1 UPDATE RETURNINGへ統合する。投稿PATCHも1 UPDATE RETURNINGへ統合し、未指定列と空文字列を区別する。
- 投稿作成はユーザーロックとユーザー情報取得を1 SELECTへ統合する。投稿期間のFOR SHARE、再探索、同日投稿・削除回数判定、画像と投稿の同一Txを維持する。
- friend requestの全友達取得→ペアEXISTSと関係更新のRETURNINGはmainですでに実装済み。追加変更しない。
- 独立読取のPromise.allは追加しない。同一Txの接続では往復を消せず、pool競合を増やす変更を混在させない。

マニュアルの通知・変更可能範囲・外部仕様・初期化条件に加え、「負荷走行の打ち切り」「データの反映」を確認。認証・公開範囲・友達・ブロックの判定と、書込成功後の他地域での即時反映を維持する。
DDL、永続データの保存方式、初期化処理、DB設定、プロセスをまたぐキャッシュは変更しない。切り戻しはこのブランチのコード差分を取り消す。

## SQL回数

BEGIN/COMMITとIPBanを除き、認証を含む正常系。変更前は基点のコードから数えた値、変更後は新規専用PG16のAPIテストで確認した値。投稿権限の変更前は友達がいるケース。

| API | 変更前 | 変更後 |
|---|---:|---:|
| 登録 | 4 | 3 |
| ログイン | 5 | 3 |
| GET me | 2 | 1 |
| PATCH me（3フィールド） | 5 | 2 |
| export | 3 | 2 |
| 投稿作成（枠の再探索なし） | 8 | 6 |
| 投稿詳細 | 7 | 3 |
| 投稿更新（caption・visibility） | 8 | 6 |
| コメント作成（他人への投稿） | 13 | 8 |
| RealMoji作成 | 15 | 10 |
| コメント・RealMoji一覧 | 8 | 4 |

通常feedは認証ユーザー再取得の1 SQLを省く。対象ユーザーの取得が省略されたことをテストで確認した。

## ローカル検証

Node.js 26.10.0、PostgreSQL 16.11、実サービス設定を使わない新規専用DB・合成データのみ。

- `npm run check`、`git diff --check`: 成功。
- `AUTH_PERMISSION_TEST_PG_PORT=<local-port> node test/auth-permission-db.test.ts`: 親1＋サブテスト4件、全5件成功。内部で432ケースの権限を従来のloadViewerContext/canViewと比較し一致。3地域・投稿有無・関係6通り・公開範囲3通り・終了有無・自己/他人を比較。
- 同時ログイン後は1セッションのみ有効、再ログイン/ログアウト後の旧token拒否、不正loginで既存sessionを失効しないこと、退会後の認証拒否を確認。
- 書込後の応答、空文字列・未指定列、exportの投稿情報と画像バイト、閲覧できてもコメントできない友達の友達、公開範囲変更・友達解除・ブロック・終了・退会の次リクエストへの反映を確認。
- `POST_WINDOW_LOCK_TEST=1 node test/post-window-lock.test.ts`: 専用PG16コンテナで全11件成功。異なる/同じ投稿者、投稿期間切替の前後、地域変更の前後、削除上限、失敗時ロールバック。統合SELECT/UPDATEに合わせてテストのSQL監視条件だけ追従した。
- `REGIONAL_API_TEST_PG_PORT=<local-port> node test/regional-api-db.test.ts`: 全1件成功。3地域用アプリと共有DBで投稿と友達feedの即時反映。
- 全体の標準テスト: 83件中57成功・21失敗・5スキップ。失敗21件は既知のpage-responseのHMAC回数期待値（署名キャッシュ未考慮）。この問題はPR #36以前のHEADでも再現済み。新しい権限照会へmockを追従したが、署名回数の既存期待値は今回変更していない。opt-in DBテストは上記で別途実行した。

本番反映・本番再起動・初期化・ベンチ・push・マージは未実施。
実負荷でのSQL時間・pool待ち・API時間・スコア比較は未確認で、ローカルのSQL回数削減だけで採用確定とはしない。
