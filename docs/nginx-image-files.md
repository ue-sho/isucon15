# 画像ファイルのnginx配信（Issue #37）

画像本体の永続保存先は引き続きasia2のPostgreSQL `image_objects.data`。各アプリサーバーは最初の画像取得時にローカルへ書き出し、Node.jsが検証した後、`X-Accel-Redirect`でnginxから配信する。初期画像を含めた全画像の一括書き出しコマンドも提供する。アップロードやエクスポートの保存形式も変えない。

## 配信と整合性

- `ISUREAL_IMAGE_CACHE_DIR`が空なら従来のDB本文配信。3台のメインアプリのsystemd drop-inでは `/var/cache/isureal/images` を指定する。追加の地域別APIサービスでは有効にしない。
- ファイルは `initial/<先頭2桁>/<SHA-256>.jpg` または `runtime/<世代>/<先頭2桁>/<SHA-256>.jpg`（PNGは `.png`）。初期化時はinitialフォルダをコピーせず、そのまま再利用する。キーに画像の世代、画像ID、所有者、作成日時、画像行のxmin、MIMEを含める。初期画像の世代は初期データ境界の日時から算出し、追加画像はDB共通の世代を使う。一時ファイルを同期してからrenameし、不完全なファイルを公開しない。
- 署名・期限の形式と検証を維持する。毎回DBで所有者の有効状態、プロフィール・投稿・RealMojiの参照、削除・差し替えを確認する。ファイル命中時だけ画像本体のbytea取得を省く。書き出し後にも期限を確認する。
- nginxの `/_isureal_images/` は `internal`。クライアントから直接取得できない。`Cache-Control: no-store` を維持し、Range・条件付き更新によって既存の200応答を変えない。
- `reset.sql`は初期化トランザクション内で `initial_data_boundary.image_cache_generation` を更新する。各リクエストでこの値を取得し、全地域・全workerの追加画像の過去ファイルを論理的に無効化する。初期画像のファイルは再利用する。初期化後に画像IDが再利用されても古いファイルを使わない。
- DBを永続データの正として維持するため、各地域で直ちに最新の状態を検証できる。systemdの `CacheDirectory` は再起動後も残るが、ファイルが失われてもDBから再作成する。
- 空き容量が512MiB未満になる書き出し、または書き込み失敗時はDB本文にフォールバックする。JPEG/PNG以外もDB本文を返す。

## 本番反映の順序

現在はローカル検証のみ。本番のマイグレーション・配信切替・ベンチは未実施。

1. 対象と実施順を合わせたうえで、asia2の対象DBに `webapp/sql/migrations/20261031-image-file-generation.up.sql` を適用する。既存画像を変更しない列追加で、ロック取得の待機上限は3秒。失敗したら中断して原因を確認する。既存DBへ初期構築用の001/003 SQLを実行しない。
2. 同じ版のNode.js・nginx設定・systemd drop-inを3台へ配置し、設定検査後にサービスを再起動する。ファイルの実パスとnginxのaliasを一致させる。systemdがキャッシュディレクトリを作成し、アプリがディレクトリ0755・ファイル0644で書く。本番でコンテナは使わない。
3. 正常画像の取得、直接URLの拒否、サービス再起動後の取得を確認する。ユーザーが実行するベンチで整合性・初期化60秒以内・得点を比較する。

旧世代ファイルはリクエスト中に削除しない。自動GCは未実装。空き容量を監視し、不要ファイルの整理は画像配信を停止した作業時間に行う。キャッシュ自体はDBから復元可能である。

戻すときは `ISUREAL_IMAGE_CACHE_DIR` を空にしてアプリを再起動すればDB本文配信になる。EnvironmentFile側に同名設定がある場合はそちらが優先するため、実効値も確認する。完全に戻す場合はコード・reset.sqlを旧版に戻してからdown SQLで列を削除する。新reset.sqlが残ったまま列を削除しない。画像データの復元は不要。

## ローカル検証

- Node.js型検査成功。最新main `614a3c9`を取り込んだ全テストは84件中80成功・4スキップ。
- 使い捨てPostgreSQL 16と実際のnginxによる画像API試験は30件成功。cold/warm、再起動相当の再生成、2地域、失効、行更新、同時書き出し、容量不足時のフォールバック、初期化、画像ID再利用を確認。
- 実nginxでJPEG/PNG本文・Content-Type、内部URLとパス探索の拒否、Range/条件付き要求、署名不正・期限切れ・削除後の拒否を確認。
- 3地域のnginx設定を使う既存proxy試験も成功。画像ファイル単体試験は同時書き出しとシンボリックリンクの拒否を確認。

DB/nginx統合試験は空の専用DBに限り、`IMAGE_SQL_TEST_PORT=<port> IMAGE_FILE_NGINX_TEST=1 node --test test/image_api.test.ts` で実行する。nginx用Dockerを使うのはローカル試験のみ。本番規模の初期化時間・ディスク使用量・得点改善は未確認。

## 全画像の事前書き出し

`src/export_image_files.ts` は初期画像を含む全画像を、画像APIと同じキーで書き出す。初期画像はinitialize後も再利用できる。initialize中には書き出しを行わず、初期化の同期処理に画像I/Oを追加しない。実際の画像取得時の署名・期限・削除検証は維持する。

反映後、ベンチも初期化も動いていない時間に、各アプリホストで以下を実行する（SSH先をasia1、europe1、america1に変更して順番に実行）。アプリの再起動は不要。一括書き出しは全画像をDBから読むため、ベンチ中には実行しない。

```sh
ssh asia1 'sudo systemd-run --wait --pipe --collect --unit=isureal-image-export --property=User=isucon --property=Group=isucon --property=WorkingDirectory=/home/isucon/webapp/nodejs --property=EnvironmentFile=/home/isucon/env.sh --setenv=ISUREAL_IMAGE_CACHE_DIR=/var/cache/isureal/images /home/isucon/local/node/bin/node src/export_image_files.ts'
```

単一のREAD ONLY REPEATABLE READトランザクションのcursorで4,096画像ずつ取得し、32並列で一時ファイルを書き出す。バッチのファイルシステム同期後にrenameして公開し、再度同期する。4,096件ごとに進捗を出力する。通常の画像APIの単発書き出しは引き続きファイル単位で同期する。書き出し済みのファイルはスキップし、written/existing/unsupported/bytesを集計する。JPEG/PNG以外は従来のDB本文配信であり、unsupportedとして数える。容量不足・書き込み失敗は成功扱いにせず停止する。途中でinitializeにより世代が変わった場合も失敗にし、終了後の再実行を促す。DB変更は行わず、再実行可能。

追加確認: PostgreSQLで一括書き出し、再実行、初期化後の初期画像再利用、容量不足、初期化競合を検証。実nginxを含む画像API30件も成功し、reset後の初期画像取得がbyteaを取得しないことと、追加画像ID再利用時の無効化を確認した。本番の全件所要時間・ディスク使用量は未計測。

本番の速度調査では、asia1のディスクutilが約81%、書き込みが約2,300 IOPSだった。2万画像のサンプルで内容の重複は0件。全件出力はバッチ同期へ変更し、小ファイルごとの同期待ちを減らす。GNU `sync -f` が必要（本番で存在確認済み）。

## 地域で分担する高速な事前書き出し

コマンド末尾に `--region` を付けると、`ISUREAL_REGION` と画像所有者のusers.regionが一致する画像のみを書き出す。asia1/europe1/america1でそれぞれ実行すると全画像を分担できる。他地域の画像へのアクセスも従来の検証とDB本文／オンデマンドファイル生成で処理できる。全画像の全地域複製が必要な場合はフラグを省略する。

本番観測: asia 1,808,830件/13,593,311,590 bytes、europe 7,055件/85,079,513 bytes、america 11,257件/121,369,045 bytes。欧米への全件複製は約10MB/秒の転送が制約となり短時間で終わらないため、地域分担を採用する。書き出し時の配置判断に使うregionは取得後の認可判断には使わない。ユーザーの地域が変わってもDBから取得可能である。
