# 投稿枠の共有ロック化（Issue #15）

## 対象と開始時点

- 実施日: 2026-10-31 JST。ISUCON2026 / ISUReal、Node.js、PostgreSQL 16。
- 担当: [Issue #15](https://github.com/ue-sho/isucon15/issues/15)。全体調査: [Issue #11](https://github.com/ue-sho/isucon15/issues/11)。着手時に両Issue、#15コメント、最新PR一覧、コード、worktreeを確認。
- 基点: `9f4f46e9b5844f970dfc4dab8d809f5f5dffcc69`（着手時の `origin/main`、PR #21マージ済み）。調査Issueに記載された稼働SHAとは別で、本番の現在SHAは今回確認していない。
- ブランチ: `perf/post-window-lock`。
- 専用worktree: `/Users/yk/Documents/private/isu-con/isucon15-post-window-lock`。
- 元のworktreeは `docs/competition-agent-guidance` / `1ecea18`、未追跡 `docs/initialize.md` があった。元の作業ツリーと他担当のworktreeは編集していない。
- PR #26（画像索引）・#27（その他索引）は着手時open。本変更に取り込んでいない。#13画像署名、#14スキーマ・画像SQL、#25一覧も変更していない。

変更は `src/post_api.ts` の `createPostHandler` 内の2つの投稿枠検索、専用 `test/post-window-lock.test.ts`、この文書のみ。package.json、lockfile、initialize、共通設定・計測設定は変更なし。共有環境への接続・DDL・デプロイ・再起動・初期化・ベンチ、push・マージ、Issue更新は実施していない。

## 変更と整合性

初回と再検索の `posting_windows ... FOR UPDATE` をともに `FOR SHARE` に変更した。SQL回数、画像処理、レスポンス生成、トランザクションの範囲は同じ。

PostgreSQL 16の[行ロック互換表](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)では、`FOR SHARE` 同士は両立するが、`FOR NO KEY UPDATE` / `FOR UPDATE` と競合する。管理ハンドラの `UPDATE posting_windows SET ended_at = ...` は非キー更新であり、共有ロック保持中は待機する。`FOR KEY SHARE` は非キー更新を妨げないので代用できない。実際のスキーマとPG16でこの違いを確認した。

| 維持する条件 | 根拠と検証 |
| --- | --- |
| 同一ユーザーの排他・二重投稿防止 | 先頭の `users ... FOR NO KEY UPDATE` を維持。後続投稿は待機後に件数を読み、201と409になる |
| 別ユーザーの同一地域投稿 | 同じ枠の共有ロックを併有できる。片方の画像INSERT後・未コミットの間に、他方が201まで進む |
| 投稿が先に枠を確保 | 共有ロックをCOMMIT/ROLLBACKまで保持し、管理ハンドラの期間終了UPDATEを待たせる |
| 期間切替が先に進行 | 終了UPDATEで待った初回SELECTは、再評価した `ended_at IS NULL` が偽になり0件。次のSELECTが新しい枠を取得する |
| 再検索で取得した枠 | 別ユーザーと共有でき、さらに次の期間終了UPDATEを待たせることも確認 |
| 地域変更 | 投稿のユーザーロックと地域UPDATEが競合。投稿先行・地域変更先行の両順序で、確定した地域の枠を使う |
| 削除上限 | ユーザー排他と `local_date` 単位の件数判定を維持。2回目の削除と再投稿を競合させ、削除後の再投稿は409。同日・別地域への移動後も409 |
| 画像と投稿の原子性 | 同じTx内のINSERTを維持。外部接続にはコミット前の両データが見えず、投稿INSERTをDBトリガーで失敗させると画像もロールバックされる |

再探索はPostgreSQLの[READ COMMITTED](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)を前提とする。テストではデフォルト分離レベルを実測した。本番でも適用前に確認する。既存どおり検索は最大2回で、両方0件なら409。連続する多数の期間切替で必ず成功する保証は追加していない。

`admin_posting_window_api.ts` は期間終了UPDATEより前に `clock_timestamp()` を取得する。したがって待機中の時計時刻と、終了UPDATE/COMMITの実行順序を同一視しない。この時刻の取り方、usersテーブルロック、通知生成は既存どおりで今回の対象外。共有ロックでも期間開始の待機は残るため、管理APIの遅延・timeoutも比較する。

## 再現する検証

Node.js 26以上、Docker、ローカルの `postgres:16` イメージが必要。テスト自身が使い捨てコンテナを起動し、127.0.0.1の動的ポートだけを公開する。DBデータはtmpfs、終了時は自分で作成したコンテナのみ停止・自動削除する。接続先URLや本番の環境変数は受け取らない。trust認証はこのローカルの使い捨てDBだけで使用する。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-post-window-lock/webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm run check
POST_WINDOW_LOCK_TEST=1 npm test
```

専用テストだけなら `POST_WINDOW_LOCK_TEST=1 node --test test/post-window-lock.test.ts`。通常の `npm test` ではこのDBテストは明示的にskipするため、適用前確認では環境変数を省略しない。

テストは各ケースで新規の空DBを作り、リポジトリの `webapp/sql/001-schema.sql` を変更せず読み込む。実データ・ダンプ・initializeは使わない。合成ユーザー2人と小さいJPEGを使用し、Hono経由で実際の投稿・削除・地域変更・期間開始・friends feedハンドラと本来のDB/Txを実行する。テスト側のTxラッパーは競合の順序制御のみで、SQLや結果を置き換えない。投稿用poolは最大8接続、別の観測接続から `pg_stat_activity`、`pg_locks`、`pg_blocking_pids` を検査する。

認証済みセッションはテスト側で与えるため、認証・地域middleware、実ネットワーク、複数アプリホストは検証対象外。friends feedの確認はローカルの実ハンドラでの読み取りであり、公式ベンチの採点確認ではない。

## 実施結果

実行環境: macOS上のNode `v26.12.1`、DockerのPostgreSQL `16.13 (Debian 16.13-1.pgdg13+1)` / arm64、READ COMMITTED。
使用したローカルイメージID: `sha256:71e27bf60b70bded003791b5573f8b808365613f341df20ffcf0c1ed7bc13ddf`。

| 確認 | 結果 |
| --- | --- |
| 基点のアプリ + 専用テスト | 10項目中8成功。初回検索・再検索それぞれの「別ユーザーが先行投稿の未コミット中に完了する」2項目は想定どおり失敗し、既存の直列化を検出 |
| 変更後 `npm run check` | 成功 |
| 変更後 `POST_WINDOW_LOCK_TEST=1 npm test` | 成功。専用10項目 + 既存4項目、親テストを含むNode表示は15 pass / 0 fail / 0 skip |
| 同一ユーザー、期間切替両順序、地域変更両順序 | PostgreSQL上のブロッカーとロック待機を確認し、解放後のHTTP応答・保存先を確認 |
| 2回削除上限・投稿枠なし | 409、不要な画像INSERTなし |
| 投稿INSERT失敗 | 意図的な500の後、画像・投稿とも0件。ロック解放後の再試行は201 |
| friends feed | 別ユーザーの同時投稿コミット後、期間内に互いの投稿を取得 |

初期のテスト作成時に不足していたContent-Lengthと合成鍵の形式を修正してから比較した。上の基点比較結果はその修正後のもの。テストの待機制限・全体実行時間は性能計測値ではなく、成功判定を本番の遅延改善幅に換算しない。

局所的には同じ投稿枠による別ユーザー間の直列化を解消できた。本番でロック待ちが主因か、全体スコアが上がるかは未検証。高並列時の共有行ロック管理コスト、DB/pool/IO負荷、期間切替の待機時間も残る比較事項。

## 適用と取り消し（統合担当が合意後に実施）

1. 統合先の最新Issue/PR/差分・稼働SHAを再確認する。#25と同じ `post_api.ts` を触る可能性があるため、ファイル全体で上書きせず `createPostHandler` の2か所の差分だけ統合する。
2. この専用ブランチの変更コミットを統合用ブランチへcherry-pickする。基点以降の他変更を巻き戻す操作はしない。

   ```sh
   # 自分の統合用worktree内で実施
   git show --stat perf/post-window-lock
   git cherry-pick perf/post-window-lock
   cd webapp/nodejs
   npm run check
   POST_WINDOW_LOCK_TEST=1 npm test
   ```

3. DBの分離レベル、3台のアプリ反映先、他担当の計測予定、適用前SHAを確認。今回必要なのはアプリ変更だけで、DDL・migration・追加依存・初期化設定の変更は不要。
4. push・共有環境操作は別途合意後に統合担当が実施する。既存 `task deploy BRANCH=<統合ブランチ>` はpush済みSHAが必要で、全ホストの設定配置と有効サービスの再起動を伴う。PG再起動やログ処理も含み得るため、アプリ2行だけを反映するコマンドだと誤認しない。既存手順の副作用を確認し、今回必要な反映方法を選ぶ。`task bench` もデプロイを伴うので、単独のベンチコマンドとして扱わない。
5. 反映後は3台のSHAとサービス状態を確認し、公式ベンチで検証。計測条件をそろえるための初期化やベンチ開始は共有担当と調整する。

取り消しは統合先の当該コミットを `git revert <統合先のコミットSHA>` して、同じ承認済み反映手順で再配置する。専用ブランチのコミットSHAは `git rev-parse perf/post-window-lock` で確認できる。DB逆migrationは不要。別改善を含む古いブランチ全体への巻き戻しは避ける。適用前なら、このコミットを統合しなければ本番への影響はない。

## 次のベンチで見る項目

- 比較する前後の稼働SHA、他改善の有無、初期化・キャッシュ状態、計測期間、同時作業、PG設定を記録する。#13/#14/#25等との同時反映をこの変更単独の効果にしない。
- 地域別のPOST `/api/posts` の成功数、平均・p95/p99、timeout、409 `post_slot_unavailable`、再試行、公式のエラーメッセージを比較する。HTTP件数と採点件数は別に扱う。
- 投稿開始→受理→friends feed検証完了が**同じ投稿期間内**に収まるかを確認する。[公式マニュアル](https://gist.github.com/whywaita/17f3ab1a8c1b7585c571f4f8afe5f531)の採点は201だけでなく期間終了前のfriends feed検証成功が条件。通常/最終期間、地域倍率も対応させる。
- 管理用期間開始APIの遅延・timeout、終了済み枠への不正投稿、同一ユーザー重複、削除上限、地域移動、画像/投稿の整合性を確認する。
- ベンチの同じ時間帯で `pg_stat_activity.wait_event_type/wait_event`、`pg_blocking_pids`、`pg_locks` の待機とブロッカーを観測し、posting_windows行・users行・usersテーブル・pool待ち・CPU/IOを切り分ける。HTTP遅延だけからロック待ちが主因と断定しない。SQL本文・bind値・実データを共有しない。
- pproteinを見る場合はブラウザを使い、group ID・収集期間・地域・稼働SHAと対応付ける。今回pproteinは未参照、計測設定も変更していない。

## Issue #15への短い追記案（未投稿）

`perf/post-window-lock`、基点 `9f4f46e9b5844f970dfc4dab8d809f5f5dffcc69`。createPostHandlerの投稿枠検索2か所をFOR SHAREへ変更し、ユーザー排他・期間切替時の再探索・削除上限・画像/投稿の同一Txを維持しました。隔離PG16.13の複数接続と実ハンドラで10項目を検証し、初回/再検索の別ユーザー並行投稿、同一ユーザー409、期間切替両順序、地域変更両順序、削除上限、ロールバック、friends feedが成功。型チェック・既存4テストも成功。基点では別ユーザー並行の2項目が失敗することも確認しました。本番のロック待ち寄与・スコア改善は未検証。適用/取り消しと次回ベンチ項目は `docs/post-window-lock.md`。共有環境操作・push・マージは未実施。
