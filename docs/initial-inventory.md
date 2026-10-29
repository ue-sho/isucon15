# 初動の構成調査

[ISUCON14の構成調査](https://github.com/ue-sho/isucon14/issues/1)でまとめていた情報を、SSH経由で取得してMarkdownとJSONに保存します。
**bootstrapやデプロイで初期状態を変更する前**に実行してください。

## 使い方

手元と接続先にPython 3.8以降、手元にSSHとTask（go-task）が必要です。Pythonの追加パッケージは不要です。
接続には `~/.ssh/config` の設定を利用します。通常のSSHで接続とhost keyの確認を済ませてください。
DB情報の取得には、接続先にMySQL/MariaDBのクライアントまたはPostgreSQLの `psql` が必要です。

```sh
task inspect -- s1 s2 s3

# 対象DBを絞る（複数回指定可）
task inspect -- s1 --database isuride

# DBの種類を指定する（既定のautoは両方を調査）
task inspect -- s1 --db-type postgresql --database isuride
task inspect -- s1 --db-type mysql --database isuride

# 正確な件数が必要なとき。対象DB名の指定が必須
task inspect -- s1 --database isuride --exact-counts

# DBへの接続が不要なホスト
task inspect -- s1 --no-db
```

出力先は `docs/inventory/<UTC取得時刻>/` です。

```text
README.md       # 全ホストの取得状況とリンク
01-s1.md        # ホスト別の調査結果
01-s1.json      # 同じ結果の機械可読形式
02-s2.md
02-s2.json
...
```

生成物はGit管理の対象です。内容を確認してから、`docs/inventory/`をコミット・pushしてください。
コミット・pushやIssue投稿は自動で行いません。
`--output <保存先>`、`--timeout 180` で保存先とホストごとの上限秒数を変更できます。最大4台を並列収集します。
一部の項目・ホストを取得できなくても残りの結果を保存し、終了コード1を返します。取得成功は0、引数エラーは2です。
ミドルウェアの実行ファイルが見つからない場合は `not-found`、明示的な省略は `skipped` と記録します。
`--db-type` は `auto`、`mysql`、`postgresql` から選びます。`auto` では両方のクライアントを調べ、
`--database` は両方のDBに適用します。種類が分かっているホストでは `--db-type` を指定してください。

接続先を省略した `task inspect` は、共通設定の `HOSTS` を使います。設定形式と優先順位は[isutools README](../isutools/README.md#設定)を参照してください。

## 収集する情報

| 分類 | 内容 |
|---|---|
| ハードウェア | OS、アーキテクチャ、vCPU、CPUモデル、仮想化、メモリ、Swap、ルート領域の容量・使用量・空き |
| ソフトウェア | nginx、MySQLクライアント、psql、Nodeのバージョンと実行ファイル |
| 稼働状況 | systemdの稼働サービス、プロセス名・PID、TCP/UDPの待受 |
| nginx | 転送先、待受、静的ファイルの場所などのディレクティブと出典ファイル・行番号 |
| MySQL/MariaDB | ローカルサーバーのバージョン、DB・BASE TABLE一覧、Engine、概算件数、データ＋インデックスの概算容量 |
| PostgreSQL | ローカルサーバーのバージョン、接続先socket・ポート、接続可能なDB一覧、schema・テーブル名、概算件数、インデックス・TOASTを含む容量 |

NodeはPATHのほか `/home/isucon/local/*/bin/node` と、読み取れる稼働プロセスの実体も調べます。
`installed` は検出したバイナリの版、`running-process` は実行中Nodeの実体から取得した版です。
他言語のアプリバージョンや、プロセス引数から分かる起動スクリプトまでは自動取得しません。

## 取得方法と未確認事項

- パッケージ導入、設定変更、デプロイ、サービスの起動・停止・再起動は行いません。
- nginxは `nginx -T` で設定検査と取得を行います。構文エラーや権限不足の場合は未取得になります。設定検査は参照先ファイルを開くことがあります。
- nginx設定取得とMySQL/MariaDB接続は、通常権限で失敗した場合だけ既存の `sudo -n` を試します。パスワード入力は要求しません。
- DB接続はローカルのUnix socketに限定します。非ローカルDBは未対応です。アプリのenvファイルから認証情報を抽出しません。
- MySQL/MariaDBは接続先にあるクライアント設定を利用し、接続ユーザーから見えるBASE TABLEのみ対象です。通常の件数はInnoDBでは推定値の `TABLE_ROWS`、容量は `DATA_LENGTH + INDEX_LENGTH` です。
- PostgreSQLは `/var/run/postgresql` と `/tmp` のsocketを探し、socket名からポートを取得します。見つからない場合は5432を試します。接続できた最初のクラスタだけを調査します。
- PostgreSQLは既存の `PGUSER`（未指定なら現在のOSユーザー）で接続し、失敗した場合は既存の `sudo -n -u postgres` でOS・DBユーザーを `postgres` にして試します。パスワード入力は要求せず、`psql -X` でpsql起動設定を読みません。
- PostgreSQLは接続可能な非template DBを列挙し、SELECT権限のある通常テーブル（`relkind = 'r'`、一時テーブル・システムschemaを除く）を対象にします。パーティションの末端テーブルを含み、データを持たないパーティション親は除きます。概算件数は `pg_class.reltuples`（負値は未取得）、容量は `pg_total_relation_size` です。
- `--exact-counts` のときだけCOUNTを実行します。各表の接続に5秒の実行時間制限を設定し、制限設定が失敗した場合はCOUNTを実行しません。PostgreSQLは読み取り専用接続で `COUNT(*) FROM ONLY` を使い、継承先・パーティションとの重複集計を避けます。行セキュリティで一部の行しか見えない場合は件数を未取得にします。全表同時点のスナップショットではありません。
- COUNTはベンチと重ならない時間に実行してください。表が多いときは `--timeout` を調整してください。
- nginxは行単位で許可したディレクティブだけを抜粋します。複数行の値やserver/locationの対応を完全には解釈しません。設定と待受を記録し、実際の疎通やアプリからDB・決済先への経路は断定しません。
- プロセス引数、環境変数、設定全文、DB実データ、エラー全文は成果物に含めません。nginxのURLのユーザー情報・クエリ文字列は伏せます。ホスト名・パス・DB名は含まれます。

参照: [MySQL TABLES定義](https://dev.mysql.com/doc/refman/8.0/en/information-schema-tables-table.html)、
[nginxオプション](https://nginx.org/en/docs/switches.html)、
[MariaDBの実行時間制限](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/query-optimizations/aborting-statements)、
[PostgreSQLのpsql](https://www.postgresql.org/docs/current/app-psql.html)、
[pg_class](https://www.postgresql.org/docs/current/catalog-pg-class.html)、
[容量取得関数](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE)、
[接続時の実行時間・読み取り専用・行セキュリティ設定](https://www.postgresql.org/docs/current/runtime-config-client.html)。

## 実行入口と開発時の確認

通常はリポジトリのTaskfileから実行します。接続先・オプションは `--` の後に渡します。

```sh
task inspect
task inspect -- s1 --db-type mysql --database isuxxx
task inspect -- --help
task test:inventory
```

運用ツール全体のテストは `task test:python`、Nodeの計測部も含める場合は `task test` です。
Python標準のunittestと一時Gitリポジトリ・偽SSHを使い、外部サーバーへ接続しません。
DBの接続探索順・部分失敗時の継続、Nodeの検出、SSH引数、出力形式とCLIを確認します。
実際のLinuxサーバーへのSSH・sudo・MySQL/MariaDB・PostgreSQL接続は別途確認してください。
