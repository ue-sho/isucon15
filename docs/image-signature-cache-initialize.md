# 画像署名キャッシュをDB初期化と同じ世代へ切り替える

2026-10-31、Issue #13 / PR #32の初期化残件を補完する。基点は `3a19a28`（#32マージ後）。有効期限の丸め・延長、署名アルゴリズム、キャッシュ容量・60秒TTLは変更しない。

## 最新mainとの統合（2026-10-31）

PR head `9c376f174c460b1cca3d3cb2f8c434d7235a4bdd` へ、#38まで取り込んだmain `ef058e726628cb17b7ffa68eb1868334f1e1aad6` をマージした。競合や手動の製品コード変更はなく、未投稿フィードの早期終了、通知一括照会、Node.js以外の実装整理をmainどおり保持した。署名キャッシュ・世代管理の意味変更はない。

統合後に `npm run check` と、次の5ファイルを一度の `node --test` で実行し、**101成功・失敗0・skip0**を確認した。

- `test/image-signature-cache.test.ts`
- `test/image-signature-generation.test.ts`
- `test/image_api.test.ts`
- `test/feed-unposted.test.ts`
- `test/page-response.test.ts`

DB試験はDockerのPostgreSQL 16.13を使用し、127.0.0.1の動的ポートにだけ公開した新規コンテナ内に、空の専用DB `isureal_image_index_test` と `isureal_feed_unposted_test` を作成した。`IMAGE_SQL_TEST_PORT` と `FEED_UNPOSTED_TEST_PORT` はこのポートを指定した。世代試験は `IMAGE_SIGNATURE_GENERATION_TEST=1` で有効化し、試験自身が別の使い捨てPG16と6つの独立Nodeプロセスを起動した。今回作成したコンテナは試験終了後に破棄し、共有DB・サービスには接続していない。

署名のhit/missと古い非同期リクエスト、世代更新・同時reset・rollback、画像の削除・退会・差し替え・期限・パーティション、全4種類の未投稿フィード、一覧の50件境界とカーソルを確認した。この統合版のデプロイ・本番initialize・ベンチはまだ実施していない。PR #40の画像ファイル化は今回のmainに含まれず、同PRと合わせる場合は双方の世代管理を保持した別の統合確認が必要になる。

## 12:50 JSTのデプロイ失敗と復旧版

ユーザーがup SQLを実行してCOMMITまで成功し、共有DBの読み取りでも `singleton=true / generation=1` を確認した。**migrationは適用済みで、再実行不要。**

続く `ff664cc` のデプロイはeurope1・america1・asia2が成功し、asia1が8080の `EADDRINUSE` で失敗した。直前の反映版は `c5edca0`。asia1には地域別の補助systemdサービスがあり、古いmain基点の `ff664cc` はポート8080固定だったため、America用サービスが8080を占有し、本体とEurope用サービスが再起動を繰り返していた。rsyncは追加unitを削除しないので、古いコードの反映だけではこの構成を戻せない。

PR #33へ最新main `4f4a0a9` をマージし、`ISUREAL_PORT` 対応、本体8080・Europe8081・America8082のunit設定、最新nginx/PostgreSQL設定、一覧の50件化を保持した。世代管理の製品コードとSQLにはmain側との競合なし。統合後の型チェック成功、`IMAGE_SIGNATURE_GENERATION_TEST=1 npm test` は80成功・失敗0・3skip（画像DB・投稿ロックDB・地域別API DB）。既存isutoolsのbootstrap/deployテストはmacOSでGNU truncateオプションやjournalctl等の環境差により未通過で、成功扱いにはしていない。

この追補を含むpush済み版を同じブランチから再デプロイする。最新mainの既存設定を維持し、補助サービスやnginx設定を手動で削除しない。

```sh
task deploy BRANCH=fix/image-signature-cache-initialize && task status
ssh asia1 'systemctl is-active isureal-nodejs.service isureal-nodejs-europe.service isureal-nodejs-america.service'
ssh asia1 'sudo -n ss -ltnp "( sport = :8080 or sport = :8081 or sport = :8082 )"'
```

全台の新SHA、asia1の3サービスすべてactive、8080/8081/8082の待受を確認してからベンチを再開する。`task status` のapp表示は本体だけで、補助2サービスの確認を代用しない。この復旧版の再デプロイ・再ベンチは作業者が実行する。

## 初期化の保証

共有PostgreSQLに1行の `image_signature_cache_state` を置き、`reset.sql` のデータ復元と同じトランザクションで `generation` を増やす。COMMITを全リージョンに共通の無効化点とする。途中失敗では世代もロールバックし、行が存在しない場合は初期化を失敗させる。最初にこの行を更新・ロックするため、同時に走るresetも直列化される。

通常の認証SQLと、画像GETの所有者検索SQLに世代の読取を加える。追加のSQL往復、常設DB接続、内部HTTPエンドポイント、リージョン別の通知先設定は不要。既存の共有DB接続・ルーター経由の通信を利用する。

- 署名生成は `sessionMiddleware` が取得した世代を `AsyncLocalStorage.run` でリクエストに結び付ける。画像GETの署名検証は、所有者SQLで取得した世代のスコープ内で行う。
- workerが新世代を初めて観測するとMapと容量カウンターを消去する。世代は文字列からBigIntへ変換し、整数精度を落とさない。
- 初期化前リクエストの遅い継続処理が古い世代を持っていても、workerが新世代を観測した後はキャッシュの参照・追加を行わない。世代を巻き戻さない。
- 世代未取得・不正値の場合は、元と同じHMAC計算だけを行い、キャッシュを参照・追加しない。SQL自体の失敗は通常どおりエラーとし、古いキャッシュへのフォールバックはしない。
- 署名の形式・期限、所有者の現在の鍵とactive状態、画像有効性SQL、返却直前の期限確認は維持する。画像・権限・検証結果は保存しない。

**initialize成功後に開始したリクエストは、どのworkerでも旧世代のキャッシュを再利用しない。** 休止中workerも次回のDB読取で追従し、新規workerは空のMapから始まる。地域別の追加プロセスにも同じコード・DBで対応できる。

これは世代による論理的な初期化であり、initialize応答前に全プロセスへ通知してMap実体の消去をACK確認する方式ではない。未アクセスworkerの古いMap実体は、次の新世代アクセス時まで容量上限内で残り得る。初期化と競合する開始済みリクエストを停止する機能も追加していない。署名はDB状態に依存しない純粋計算なので、既に開始済みの計算の出力互換性は保たれる。

## 既存DBへの適用

新しいアプリと `reset.sql` は世代テーブルを参照する。**共有DB asia2へup SQLを一度適用してから、全アプリプロセスを新版へ更新する。** テーブルを追加せず先にアプリを切り替えると認証・画像取得・initializeが失敗する。旧版アプリとの混在中は全workerへの初期化対応が成立しないため、切替を完了してからベンチを行う。

担当とDDL・デプロイ・ベンチの順序を調整したうえで、このPRを含む手元のリポジトリルートから実行する。

```sh
# テーブルの有無を事前確認
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' <<'SQL'
SELECT to_regclass('public.image_signature_cache_state');
SQL

# 未適用の場合だけ実行
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-image-signature-cache-state.up.sql

# 定義・1行・世代を確認
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' <<'SQL'
\d public.image_signature_cache_state
SELECT singleton, generation FROM public.image_signature_cache_state;
SQL
```

up SQLはトランザクション内で既存アプリのDBロール `isureal` に切り替えて作成するため、新テーブルの所有者も `isureal` になる。認証情報やロール自体は変更しない。独自に別のDBロールへ変更している環境では、適用前にアプリとresetの接続ロールを照合する。

既存の同名テーブルを黙って受け入れず、重複適用はエラーにする。既に存在する場合は定義と行を確認し、その世代を1へ戻さない。既存テーブル・履歴・画像の変更は行わない。初回構築用 `001-schema.sql` にも同じ定義を追加したが、同ファイルは他テーブルをDROPするため既存DBへは適用しない。

## 取り消し

アプリコードと `reset.sql` を先に戻す。世代テーブルは残しても旧版の動作に影響しない。テーブルを除去する場合だけ、全プロセスが旧コードであることを確認してベンチ外でdown SQLを実行する。

```sh
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-image-signature-cache-state.down.sql
```

旧版#32へ戻すと、元のキャッシュ初期化残件も戻る。世代テーブルを作り直す場合やDB全体を古いバックアップへ復元する場合は、全アプリを再起動してMapと観測済み世代を揃える。通常のresetでは世代を減らさない。

## 検証と反映状況

Node.js 26、使い捨てPostgreSQL 16、合成データで確認した。

| 検証 | 結果 |
| --- | --- |
| `npm run check` | 成功 |
| `IMAGE_SIGNATURE_GENERATION_TEST=1 npm test` | 38成功・失敗0・2skip（既存画像DBテストと投稿ロックDBテスト） |
| 別の使い捨てDBで `IMAGE_SQL_TEST_PORT=<port> node --test test/image_api.test.ts` | 28成功・失敗0・skip0。削除・退会・差し替え、日時精度、パーティション除外を維持 |
| GPT-6.1 Solによる独立レビュー | 製品コード・DDLのblocking事項なし。指摘されたmigration所有権も対応・実テスト済み |

新しい統合テストは3地域×2workerに相当する6つの別Nodeプロセスを起動し、実際の認証middleware→プロフィール応答→署名生成と、画像取得ハンドラーをHono経由で呼ぶ。実DBを共有し、同じ画像ID・鍵・期限で次を確認した。

- 初回1000回HMAC、再利用時0回。実際のreset後は全6プロセスで再び1000回、その後0回となり、画像bytesと署名URLは一致する。
- 休止していたプロセスと新規プロセスも最初の利用で新世代へ移る。生成側と検証側が署名を共用できる。
- 通常のプロフィール取得・画像取得はともに既存どおり2回のSQLで済み、世代専用のDB往復はない。
- 世代行欠落時はキャッシュを使わず計算する。resetはデータ変更前に失敗し、世代の参照SQL自体が失敗した要求は500になる。
- reset途中のエラーで世代・データ更新がともに取り消される。同時resetは実DBの行ロックで待機し、順にCOMMITして世代が2進む。
- 実up/down SQLで所有者が `isureal` となり、同ロールのSELECT/UPDATE、重複up失敗時の既存行保持、down後の再upが成立する。

単体テストではBigInt精度、非同期リクエスト間の世代分離、遅い旧リクエストによる巻き戻し・再投入の防止、世代未指定や例外後のスコープ非漏出も検証した。実リージョン間ネットワーク・稼働中cluster・initialize HTTPの本番通し実行は未検証。既存の投稿ロック実DBテストは今回再実行していない。

再現コマンド（新統合テストはDockerの `postgres:16` を使い、127.0.0.1だけへ動的ポートを公開。自分で作ったコンテナは終了時に破棄する）:

```sh
cd webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm run check
IMAGE_SIGNATURE_GENERATION_TEST=1 npm test
```

既存画像DBテストの使い捨てDB作成は[画像SQLの再現手順](image-validity-index.md#ローカルでの再現)を参照。新テストのDB接続先は固定名のローカルDBで、本番の環境変数・DB URLを受け取らない。

本番DBへの短い読み取りでは `isureal` ロールにpublicスキーマ作成権限があり、世代テーブルは未作成であることを確認した。この確認ではDDLやアプリの行データ取得はしていない。

本番DDL・デプロイ・再起動・initialize・ベンチは未実施。本番では全アプリのSHAと世代テーブルを確認後、initializeが[公式Clarification #32](https://portal.isucon.net/contestant/clarifications)の60秒以内に完了し、各地域で画像・フィード・Memories・exportの正しさと署名計算負荷を確認する。スコア・レイテンシへの影響は未計測。
