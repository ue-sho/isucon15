# 画像ファイルのnginx配信（Issue #37）

画像本体の永続保存先は引き続きasia2のPostgreSQL `image_objects.data`。各アプリサーバーは最初の画像取得時にローカルへ書き出し、Node.jsが検証した後、`X-Accel-Redirect`でnginxから配信する。初期画像を含めた全画像の一括書き出しコマンドも提供する。アップロードやエクスポートの保存形式も変えない。

## 配信と整合性

- `ISUREAL_IMAGE_CACHE_DIR`が空なら従来のDB本文配信。3台のメインアプリのsystemd drop-inでは `/var/cache/isureal/images` を指定する。追加の地域別APIサービスでは有効にしない。
- ファイルは `initial/<先頭2桁>/<SHA-256>.jpg` または `runtime/<世代>/<先頭2桁>/<SHA-256>.jpg`（PNGは `.png`）。初期化時はinitialフォルダをコピーせず、そのまま再利用する。キーに画像の世代、画像ID、所有者、作成日時、画像行のxmin、MIMEを含める。初期画像の世代は初期データ境界の日時から算出し、追加画像はDB共通の世代を使う。一時ファイルへの書き込み完了後にrenameし、不完全なファイルを公開しない。通常APIでは派生キャッシュのfsyncを待たず、消失時はDBから再生成する。
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

単一のREAD ONLY REPEATABLE READトランザクションのcursorで4,096画像ずつ取得し、32並列で一時ファイルを書き出す。バッチのファイルシステム同期後にrenameして公開し、再度同期する。4,096件ごとに進捗を出力する。通常の画像APIの単発書き出しはfsyncを待たず、完全に書いた一時ファイルをrenameして公開する。書き出し済みのファイルはスキップし、written/existing/unsupported/bytesを集計する。JPEG/PNG以外は従来のDB本文配信であり、unsupportedとして数える。容量不足・書き込み失敗は成功扱いにせず停止する。途中でinitializeにより世代が変わった場合も失敗にし、終了後の再実行を促す。DB変更は行わず、再実行可能。

追加確認: PostgreSQLで一括書き出し、再実行、初期化後の初期画像再利用、容量不足、初期化競合を検証。実nginxを含む画像API30件も成功し、reset後の初期画像取得がbyteaを取得しないことと、追加画像ID再利用時の無効化を確認した。本番の全件所要時間・ディスク使用量は未計測。

本番の速度調査では、asia1のディスクutilが約81%、書き込みが約2,300 IOPSだった。2万画像のサンプルで内容の重複は0件。全件出力はバッチ同期へ変更し、小ファイルごとの同期待ちを減らす。GNU `sync -f` が必要（本番で存在確認済み）。

## 地域で分担する高速な事前書き出し

コマンド末尾に `--region` を付けると、`ISUREAL_REGION` と画像所有者のusers.regionが一致する画像のみを書き出す。asia1/europe1/america1でそれぞれ実行すると全画像を分担できる。他地域の画像へのアクセスも従来の検証とDB本文／オンデマンドファイル生成で処理できる。全画像の全地域複製が必要な場合はフラグを省略する。

本番観測: asia 1,808,830件/13,593,311,590 bytes、europe 7,055件/85,079,513 bytes、america 11,257件/121,369,045 bytes。欧米への全件複製は約10MB/秒の転送が制約となり短時間で終わらないため、地域分担を採用する。書き出し時の配置判断に使うregionは取得後の認可判断には使わない。ユーザーの地域が変わってもDBから取得可能である。

追加観測: initial_data_boundaryの統計未作成により実際1行を1,200行と推定し、一括書き出しのcursorが約21億行の見積もり・巨大なハッシュ結合を選んでいた。asia2で同テーブルのみANALYZEし、1行の境界と約180万行の画像を順次走査する計画へ改善。003と列追加migrationにもANALYZEを追加し、新規構築時の再発を防ぐ。この統計更新は本番へ適用済みで、行データは変更しない。

## 画像GETの待ち時間削減（2026-10-31、Issue #37向け記録）

作業ブランチ: `perf/image-warm-validation`。署名計算・JPEG検証の別作業には変更を加えない。

同じ署名付きURLを同じworkerで再取得した場合、所有者・画像行の版などの探索ヒントを使い、DB往復を2回から1回に削減する。ヒントは最大2,048件、キー4,096文字以内。認可結果はキャッシュせず、毎回DBで画像の存在・所有者の状態・参照の有効性・画像版・画像キャッシュ世代・署名キャッシュ世代・現在の鍵のSHA-256を照合する。鍵自体は照合SQLのパラメータに渡さない。照合不一致ならヒントを破棄して通常経路で再取得し、更新画像を取得する。初回URL・別workerでは従来の2 SQL。

単発キャッシュ作成のfsyncを省略する。永続データは従来どおりPostgreSQLであり、キャッシュの電源断耐性には依存しない。write・close後のrenameは維持する。一括書き出しの同期処理は変更しない。

検証: Node.js 26.10.0、ローカルPostgreSQL 17.11と実nginx 1.24で画像API31件成功。同一URLの1 SQL、画像更新後の新しい内容、削除・鍵変更の拒否、世代変更の再取得、初期化・再起動相当・2地域・本文・内部URL拒否を確認。全体テスト82成功・12スキップ。型検査成功。本番PG16での検証、実ベンチでの命中率・得点改善は未確認。本番反映・再起動・初期化・ベンチは未実施。

戻し方: このブランチの画像API・画像ファイル処理の変更を戻す。DB migrationやnginx設定の追加変更は不要。

GitHub CLIが未認証のためIssueへの転記は未実施。

## Redisで検証済み画像URLを共有する（2026-10-31）

作業ブランチ: `perf/image-authorization-redis`。作業開始の基点は `5b7361f`、PR作成前にmain `589f52d` へ載せ直し、#56の画像DB転送のbase64化を維持した。[PR #64](https://github.com/ue-sho/isucon15/pull/64)。Issue #37の追加改善案で、本番反映・ベンチは未実施。ユーザーからRedis依存の追加とローカル実装・検証の許可を得ている。

### 通常経路と整合性

`ISUREAL_IMAGE_AUTH_REDIS_URL` を設定すると、画像の状態を変えるAPIにRedisの無効化処理を追加する。`ISUREAL_IMAGE_AUTH_CACHE_READS=1` も設定したファイル配信アプリだけが、検証済みURLを再利用する。アプリの環境変数の既定値は無効だが、下記の調整付きデプロイは認証付きURLと有効化設定を配置する。

- 画像ID・expの文字列・sigの完全な組のSHA-256をキーにする。共有するのは配信URI・MIME・所有者スコープ・無効化世代で、秘密鍵・画像本体は保存しない。成功した検証だけを、最大60秒かつURLの期限まで登録する。命中ごとにRedisが現在の所有者・全体の世代と更新中マーカーをLuaで照合する。命中時は署名の反復計算と画像SQLを省き、ローカルファイルを確認して `X-Accel-Redirect` を返す。パラメータ形式・重複・期限・返却直前の期限は毎回検証する。
- 未登録・失効・Redisエラー・ファイルなしは従来のDB検証へ戻す。DB検証前に所有者と全体の世代を取得し、登録時にも一致を要求する。所有者検索と世代取得の間の鍵変更も、検証SQLで鍵のSHA-256・署名キャッシュ世代を再照合して拒否する。無関係な所有者の更新が続いていても登録できる。
- プロフィール画像変更・削除、RealMoji差し替えは所有者単位で無効化する。退会・投稿編集・投稿削除・RealMoji削除・initializeは全体を無効化する。投稿削除や退会が他の所有者のRealMoji画像にも及ぶため、後者を所有者だけに絞らない。投稿作成・新規登録は新しいIDしか生成せず、既存の有効画像を無効にしないため対象外。
- 更新開始前に永続マーカーを立て、DBのCOMMITまたはROLLBACK完了後に世代をもう一度変更して解除する。同じ所有者の並行更新は件数で管理する。古い検証結果は再登録できない。関係・公開範囲のAPIやフィード等の権限判定は従来のDB処理を維持し、キャッシュする対象を画像GETの既存の有効性判定に限定する。
- マーカーにTTLを付けない。プロセス停止・結果の確定できない5xxでは残して、該当画像をDB検証へ戻す。Redis停止時は無効化を確認できない画像関連更新を開始せず503にする。通常の起動後の接続断は自動再接続するが、起動時にRedisの設定・初期状態を確認できなければ起動を失敗させる。
- 「画像SQL 0回」は有効URLとローカルファイルの両方が命中した場合。初回・失効後・ファイル消失時はDBを読む。既存のIP banの定期再読込SQLは別に残る。

画像本体・投稿・ユーザーの永続化の正はPostgreSQLのまま。nginxのinternal設定、ファイル世代、既存の初期画像の再利用も維持する。initializeの全体マーカーと世代変更で全リージョンの過去の判定を失効させ、初期化直前の要求からの再登録も拒否する。

### Redisの配置と切り替え

ユーザーの依頼で `asia2/etc/isureal-image-redis/redis.conf` と `asia2/etc/systemd/system/isureal-image-redis.service` を正とし、手動用テンプレートを廃止した。読み取りSSHでasia2の実アドレス `192.168.4.10` を確認済み。Redisはloopbackとこのアドレスの6380番で待ち受ける。既存ルーター経由の通信を維持し、ルーターやファイアウォールは変更しない。CPU・メモリ・I/Oの余力と本番疎通・起動はまだ未確認。

この版のツールをcheckoutした作業ツリーから `task deploy BRANCH=perf/image-authorization-redis` を実行すると、push済み版の `isutools/image-cache-deploy.json` を使って次を行う。旧版のツールからの直接remote-deployは拒否する。**通常の並列デプロイと異なり、この版はデプロイ中に全APIを一時停止する。** ベンチや他メンバーの作業が動いていない時間に実行する。

1. 全ホストを同じSHAへcheckoutし、asia1の3 APIとeurope1/america1/asia2の各メインAPIを停止する。
2. asia2にRedisが未導入ならaptで `redis-server` / `redis-tools` を導入する。今回新規に導入したデフォルトサービスだけを停止・無効化し、専用の `isureal-image-redis.service` を使う。既存Redisがある場合は再導入も既存サービスの停止も行わない。
3. 初回だけ64桁のランダムな認証情報を作成し、asia2の `/etc/isureal-image-redis/deploy.secret`（root:root、0600）で保持する。以後は同じ値を使う。認証情報はSSHの標準入力で配布し、コマンド引数・Git・デプロイログに載せない。Redis用 `auth.conf` はroot:redis 0640、全ホストの `client.env` はroot:isucon 0640で配置する。
4. 各ホストの `/etc`・アプリ依存を反映する。Redisの設定を適用し、専用サービスをenable・再起動する。APIはこの段階では起動しない。データは `/var/lib/isureal-image-redis` のAOFに保持し、再デプロイでも削除しない。
5. asia2からDBの同一ユーザーの既存接続が全て終了したことを確認する。初回は制御状態を作成し、次回以降は全体の世代を更新して旧判定と残存マーカーを無効化する。画像・ユーザー・投稿のDBデータは変更しない。DB接続が残れば失敗させ、状態を更新しない。
6. 全ホストで認証付きRedis接続と設定・制御状態を検証する。成功後に各メインAPIをenableし、全APIを起動する。各サービスのactiveと、8080/8081/8082の該当APIのHTTP応答を確認する。途中で失敗したら全APIを停止し、秘匿情報を含まないホストログをローカルの `isutools-deploy-*` に保持する。停止時に作る `/etc/isureal-image-redis/deploy-in-progress` とsystemdのConditionで、不完全なデプロイが再起動後に自動復帰することも防ぐ。マーカーは全準備が成功した起動段階でだけ削除する。

Redisは `appendonly yes`、`appendfsync always`、`no-appendfsync-on-rewrite no`、`aof-load-truncated no`、`save ""`、`maxmemory-policy noeviction` を維持する。**Redisは更新中マーカーも保持するため、揮発性キャッシュとして扱わない。** AOFの巻戻しや稼働中のFLUSH等は禁止。[Redis公式の永続化説明](https://redis.io/docs/latest/management/persistence/)のとおりalwaysは毎回のfsyncを伴うため、asia2のI/Oへの影響も確認する。

再起動時は、enableされたRedisと各メインAPIが自動起動する。asia2のメインAPIはRedisへのWants/Afterを持ち、asia1の補助APIは既存のメインAPIのWantsから起動する。Redisがまだ準備できない場合はアプリの `Restart=on-failure` / `RestartSec=5` で再試行する。**通常のサービス・OS再起動では初期化や制御状態の作り直しを実行しない。** 残存マーカーは安全側に残り、該当画像はDBで確認する。マーカーの解消は上記の全API停止・DB接続終了を確認する次回デプロイで行える。

戻すときはmanifestの `cache_reads` をfalseにした版をコミット・pushし、同じ調整付きデプロイで全読み取りをDBへ戻す。その後に旧版へ戻す場合も全APIを停止してから反映し、旧版に存在しない `image-authorization.conf` が `/etc` に残ることに注意する（rsyncは削除しない）。キャッシュから配信するプロセスが残る間に更新側だけを旧版へ戻さない。

反映後は初期化、削除・退会・差し替え・公開範囲・関係変更・履歴・export・再起動後の取得を確認し、実ベンチで命中率、asia1/asia2のCPU、AOFの書込待ち、503と得点を比較する。

### ローカル検証

Node.js 26.10.0、使い捨てPostgreSQL 16、Redis 7.4 Alpineで検証。合成データのみを使い、本番には接続していない。

```sh
cd webapp/nodejs
IMAGE_AUTH_CPU_BENCH=1 IMAGE_AUTH_NGINX_TEST=1 sh test/helpers/run-image-authorization.sh
```

スクリプトは専用コンテナを新規作成し、終了時に自分が作ったコンテナとvolumeを破棄する。Node.jsの指定は `IMAGE_AUTH_TEST_NODE=/path/to/node26`。DBやRedisの本番接続設定は受け取らず、既存のデータがある試験用DBも開始前に拒否する。

確認対象: 別worker・3地域の命中時0 SQL、未配置ファイルの再生成、不正署名・期限・重複、プロフィール削除、RealMoji差し替え・削除、投稿削除、投稿者退会、古い結果の再登録競合、鍵変更競合、同じ所有者の並行更新と別所有者の登録、4xx時の解放と5xx時の保留、実reset、アプリ再起動、RedisのSIGKILLからのAOF復旧、接続断時のDB確認と更新拒否、実nginxの本文・内部URL拒否・Range応答。

通常のテスト一式は、main統合後も制限を外したローカル環境で `node --test --test-concurrency=1 'test/**/*.test.ts'` を実行し、102成功・失敗0・15skip。これはRedis導入前からのDB等のopt-in試験を含むskipであり、全ての本番条件の通過を意味しない。制限環境の再実行では既存の `jpeg-decoder` と `pprotein` の2ファイルが失敗し、単独では11件とも成功した。失敗の詳細原因は未確定。追加した専用統合試験はmain統合後も実nginx・CPU比較込みで17成功・失敗0・skip0。型検査と試験スクリプトの構文検査も成功。

合成CPU比較は250要求を1組として順序を交互に5組ずつ測定し、既存の1 SQL経路とRedis命中経路を比較した。main統合前はNodeプロセスのCPU時間中央値が108.732ms → 86.189ms（約20.7%減）、統合後の再計測は95.458ms → 79.850ms（約16.4%減）、経過時間中央値は228.133ms → 113.517msだった。画像SQLは各1,250要求で1,250回 → 0回。URLの生成は計測外、実データは使用していない。Redis・PostgreSQL・nginxプロセスのCPUはこのCPU時間に含まない。raw結果は `/tmp/isu15-image-authorization-final.log`（統合前）と `/tmp/isu15-image-authorization-integrated.log`（統合後）、通常試験の成功結果は `/tmp/isu15-image-authorization-all-tests-verified.log` に保存し、実環境の低下率として扱わない。

未確認: 本番でのキャッシュ命中率、全APIの実配置、初期化60秒以内、Redis追加後の全体CPU・I/O・得点。CPU比較は同じ有効URLの連続取得に限定した合成計測であり、JPEG検証やフィードの署名生成はこの変更で省略しない。実装・検証の共有先はPR #64と関連Issue #37。

デプロイ自動適用・再起動対応の追補: 運用ツール全体133件成功（3skip）、追加の調整順序・秘密情報の非表示・失敗時の停止・自動起動・停止マーカーの試験7件成功。画像配信は実Redis/PG16/nginxで17件成功（今回はCPU比較を省略し、DB接続が残る間のデプロイ準備拒否と、全API停止後の繰り返し準備を追加）。型検査も成功。結果は `/tmp/isu15-image-cache-tools-final.log` と `/tmp/isu15-image-cache-deploy-integration.log`。実サーバーではasia2のIP・Redis未導入・API稼働の読み取り確認のみで、パッケージ導入・秘密情報の作成・デプロイ・サービス/OS再起動は行っていない。systemdの起動設定はコードと偽サービスで確認したもので、実機再起動試験の成功とは区別する。
