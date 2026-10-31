# Node.jsのpprotein収集確認

2026-10-31に実環境を確認。設定変更・サービス再起動・初期化・ベンチ実行は行っていない。

- asia1 / europe1 / america1の`isureal-nodejs.service`はすべてactive。
- asia1の実サービスのdrop-inには`NODE_OPTIONS=--require /home/isucon/isutools/profiler/profiler.cjs`が設定済み。6060番の待ち受けプロセスはNode.js。
- 3台それぞれの`http://127.0.0.1:6060/debug/pprof/profile?seconds=1`はHTTP 200で応答し、368〜375バイトのプロファイルを取得した。短時間・無負荷での接続確認であり、ベンチ中のサンプル内容は未検証。
- asia2のpproteinの`GET /api/group/targets`はsingle構成。asia1のhttplog、MySQL形式slowlog、6060番のpprofが登録されている。pprofは既にNode.jsを参照しており、切替不要。
- asia2からasia1のプライベートIPの同エンドポイントにも到達し、HTTP 200で取得できた。

PostgreSQLのSQL計測は別途対応が必要。登録済みslowlogはMySQL向けであり、PostgreSQLの収集成功を示さない。PostgreSQLには`log_min_duration_statement`によるSQL実行時間ログがあるが、出力形式と集計処理の適合は未確認。

今回の確認では稼働設定を変更していないため、切り戻し操作は不要。プロファイル全体の自動収集・解析の成功、ベンチ結果・グループIDは未確認。

## PostgreSQL用の設定ファイル追加

2026-10-31、依頼によりasia1 / america1 / europe1 / asia2すべてに、`etc/postgresql/16/main/conf.d/zz-isutools-slowlog.conf`を追加した。リポジトリ内だけの変更で、実環境への配置・reload・再起動は未実行。

実環境で読み取れたasia2の状態は、PostgreSQL 16、設定ファイル`/etc/postgresql/16/main/postgresql.conf`、`include_dir = 'conf.d'`、`logging_collector=off`、`log_min_duration_statement=-1`。他3台のPostgreSQLの導入・稼働・include設定は未確認。

追加設定は全SQLの実行時間を`/var/log/postgresql/postgresql-slow.log`に記録する。slp用のprefixは`%m [%p] `、ログ権限は0640。固定パスを追跡できるよう自動ローテーションは無効で、計測後はログを保全して容量を管理する。全SQLの記録によるI/O負荷を含めて計測する。

ローカルのPostgreSQL 17.11の設定パーサーで4ファイルの読み込みと値を確認した。対象のPostgreSQL 16での起動・ログ生成は未検証。

反映前には以下の対応が必要。

- DBが動く各ホストで、設定ディレクトリの読み込みとログディレクトリへのpostgresの書き込み権限を確認する。初回の`logging_collector=on`適用にはDB再起動が必要なので、担当間で順序・対象を確認する。
- pprotein-agentの`PPROTEIN_SLOWLOG`を上記ログパスへ変更し、`SupplementaryGroups`に`postgres`を追加する。agentの再起動と読み取り確認も必要。
- slowlogの収集対象はDBが実際に動いているホストに合わせる。現在のsingle設定のslowlog対象はasia1で、共有DBのasia2ではない。
- `slp pg --file /var/log/postgresql/postgresql-slow.log --log-line-prefix='%m [%p] ' --sort=sum-query-time --reverse`で集計する。pprotein UIからのPostgreSQL解析への切替は別途確認・対応が必要。
- `isutools/config.env`のDBサービス名・ログパスはまだMySQL用。今回のファイル追加だけでは`task deploy`によるPostgreSQL再起動・ログ管理は対応しない。

全SQL記録を止めるには`log_min_duration_statement=-1`へ変更してreloadする。元の収集方式へ戻す場合は、配置したconfを削除し、DB再起動で`logging_collector=off`に戻ったことを確認する。デプロイのrsyncは削除を同期しないため、Gitで削除するだけでは配置済みconfは消えない。

## groupターゲットを全4台へ変更

2026-10-31、依頼により`task pprotein:targets -- split`を実行し、asia2上のpproteinへ`isutools/pprotein/targets.split.json`を登録した。`GET /api/group/targets`でasia1 / europe1 / america1 / asia2の各httplog・slowlog・pprof、計12件の登録を確認。asia1からpproteinへの接続確認も成功した。

これは収集対象の変更であり、ベンチ・初期化・再起動は実行していない。全12対象の収集・解析成功は未確認。PostgreSQLログへのagent切替・解析対応は上記のとおり未実施。元のasia1のみの対象へ戻すには`task pprotein:targets -- single`を実行する。

## デプロイ時のPostgreSQL設定反映

2026-10-31、依頼により`isutools/config.env`の`DB_SERVICE`を`postgresql@16-main.service`へ変更した。asia2で同クラスタが`enabled-runtime`かつ`active`、親の`postgresql.service`も有効で、`start.conf`が`auto`であることを読み取り確認した。

`task deploy`は従来どおりホスト別の`etc/`を配置し、systemdのdaemon-reload後、有効なDBサービスを再起動する。これによりPostgreSQLの追加confも再起動で反映する。無効・未導入のホストではDBを起動しない。クラスタ本体の起動状態を確認し、失敗時はそのホストのアプリ再起動へ進まずエラーにする。DB再起動コマンド自体の失敗もデプロイ失敗として扱う。

この変更はDB設定の差分にかかわらず、有効なクラスタをデプロイごとに再起動する。実環境へのデプロイ・DB再起動は未実施。次回の実行時は担当間で対象と順序を確認する。SQLログの収集先・解析モードは別途対応が必要で、`SLOW_LOG`は今回変更していない。戻す場合は`DB_SERVICE`を以前の値へ戻す（PostgreSQLのconf自体は残る）。

検証：`python3 -m unittest discover -s isutools/tests -p 'test_*.py'`は112件成功。追加テストは設定コピーとDB→アプリの再起動順序、無効なDBのスキップ、DB起動確認失敗時の中断を確認する。実サーバーへの接続や再起動を行わないテスト。[Issue #2への記録](https://github.com/ue-sho/isucon15/issues/2#issuecomment-6537281731)。

## 自動収集が開始されない原因

2026-10-31の読み取り調査で、asia2のpprotein本体・agentはactive、groupターゲット12件も登録済みだった（各DurationはUI等で120秒に変更されていた）。一方、asia1の稼働コミット`a2ec9d6`の`webapp/nodejs/src/initialize.ts`には収集開始関数のimport・呼び出しがない。サービスには`PPROTEIN_ENABLED=1`と`PPROTEIN_URL`が設定済みだが、これだけでは自動収集は始まらない。

修正箇所はinitializeハンドラ。`isutools/snippets/pprotein-collect.ts`の関数をアプリへ組み込み、初期化時に呼び出す必要がある。今回の調査ではアプリ変更・自動収集開始・初期化・デプロイは行っていない。プロファイラの待ち受けとgroupターゲット登録の成功は、自動収集開始の成功とは別である。

### 初期化ハンドラへの組み込み

同日、依頼を受けて`fix/pprotein-initialize`ブランチで修正した。`webapp/nodejs/src/pprotein.ts`に収集スニペットを組み込み、initializeハンドラの先頭からawaitせずに呼び出す。`PPROTEIN_ENABLED=1`の場合のみgroup収集を要求し、HTTPエラー・接続失敗はログに記録する。2秒のタイムアウト・切断を理由に初期化を失敗させない。

検証は`npm run check`と`npm test`（webapp/nodejs内）を実行。型チェックと4件のテストが成功し、有効時の要求、無効時の抑止、応答待ちによるブロックがないこと、接続失敗時にthrowしないことを確認した。依存導入は`npm ci --no-audit --no-fund`で実施。実環境での収集開始・初期化・デプロイは未実行。反映後、次のベンチの初期化でgroupが作成されることを確認する必要がある。

戻す場合はinitializeハンドラの呼び出しを除去するか、`PPROTEIN_ENABLED=0`をサービスに反映する。
