# 初動の構成調査

[ISUCON14の構成調査](https://github.com/ue-sho/isucon14/issues/1)でまとめていた情報を、SSH経由で取得してMarkdownとJSONに保存します。
**bootstrapやデプロイで初期状態を変更する前**に実行してください。

## 使い方

手元と接続先にPython 3.8以降、手元にSSHが必要です。Pythonの追加パッケージは不要です。
接続には `~/.ssh/config` の設定を利用します。通常のSSHで接続とhost keyの確認を済ませてください。

```sh
python3 scripts/initial_inventory.py s1 s2 s3

# 対象DBを絞る（複数回指定可）
python3 scripts/initial_inventory.py s1 --database isuride

# 正確な件数が必要なとき。対象DB名の指定が必須
python3 scripts/initial_inventory.py s1 --database isuride --exact-counts

# DBへの接続が不要なホスト
python3 scripts/initial_inventory.py s1 --no-db
```

出力先は `reports/inventory/<UTC取得時刻>/` です。

```text
README.md       # 全ホストの取得状況とリンク
01-s1.md        # Issueへ貼れるホスト別の調査結果
01-s1.json      # 同じ結果の機械可読形式
02-s2.md
02-s2.json
...
```

生成物はGit管理から除外しています。投稿・pushは自動で行いません。内容を確認してMarkdownをIssueへ貼ってください。
`--output <保存先>`、`--timeout 180` で保存先とホストごとの上限秒数を変更できます。最大4台を並列収集します。
一部の項目・ホストを取得できなくても残りの結果を保存し、終了コード1を返します。取得成功は0、引数エラーは2です。
ミドルウェアの実行ファイルが見つからない場合は `not-found`、明示的な省略は `skipped` と記録します。

## 収集する情報

| 分類 | 内容 |
|---|---|
| ハードウェア | OS、アーキテクチャ、vCPU、CPUモデル、仮想化、メモリ、Swap、ルート領域の容量・使用量・空き |
| ソフトウェア | nginx、MySQLクライアント、Nodeのバージョンと実行ファイル |
| 稼働状況 | systemdの稼働サービス、プロセス名・PID、TCP/UDPの待受 |
| nginx | 転送先、待受、静的ファイルの場所などのディレクティブと出典ファイル・行番号 |
| DB | ローカルMySQL/MariaDBのサーバーバージョン、DB・BASE TABLE一覧、Engine、概算件数、データ＋インデックスの概算容量 |

NodeはPATHのほか `/home/isucon/local/*/bin/node` と、読み取れる稼働プロセスの実体も調べます。
`installed` は検出したバイナリの版、`running-process` は実行中Nodeの実体から取得した版です。
他言語のアプリバージョンや、プロセス引数から分かる起動スクリプトまでは自動取得しません。

## 取得方法と未確認事項

- パッケージ導入、設定変更、デプロイ、サービスの起動・停止・再起動は行いません。
- nginxは `nginx -T` で設定検査と取得を行います。構文エラーや権限不足の場合は未取得になります。設定検査は参照先ファイルを開くことがあります。
- nginx設定取得とDB接続は、通常権限で失敗した場合だけ既存の `sudo -n` を試します。パスワード入力は要求しません。
- DB接続はローカルのUnix socketに限定し、接続先にあるクライアント設定を利用します。非ローカルDB・PostgreSQL等は未対応です。アプリのenvファイルから認証情報を抽出しません。
- 接続ユーザーから見えるBASE TABLEのみ対象です。通常の件数はInnoDBでは推定値の `TABLE_ROWS`、容量は `DATA_LENGTH + INDEX_LENGTH` です。
- `--exact-counts` のときだけCOUNTを実行します。各表の接続に5秒の実行時間制限を設定し、制限設定が失敗した場合はCOUNTを実行しません。全表同時点のスナップショットではありません。
- COUNTはベンチと重ならない時間に実行してください。表が多いときは `--timeout` を調整してください。
- nginxは行単位で許可したディレクティブだけを抜粋します。複数行の値やserver/locationの対応を完全には解釈しません。設定と待受を記録し、実際の疎通やアプリからDB・決済先への経路は断定しません。
- プロセス引数、環境変数、設定全文、DB実データ、エラー全文は成果物に含めません。nginxのURLのユーザー情報・クエリ文字列は伏せます。ホスト名・パス・DB名は含まれます。

参照: [MySQL TABLES定義](https://dev.mysql.com/doc/refman/8.0/en/information-schema-tables-table.html)、
[nginxオプション](https://nginx.org/en/docs/switches.html)、
[MariaDBの実行時間制限](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/query-optimizations/aborting-statements)。

## Taskfileへの接続

PR #6のTaskfileとは独立しています。統合するときは、既存の `tasks:` 配下に次の入口を追加できます。

```yaml
  inspect:
    desc: 初期構成を調査してMarkdownとJSONに保存
    cmds:
      - python3 scripts/initial_inventory.py {{.CLI_ARGS}}
```

```sh
task inspect -- s1 s2 s3
```

## 開発時の確認

```sh
python3 -m unittest discover -s tests -v
```

コマンド応答とSSHを模擬したテストです。実際のLinuxサーバーへのSSH・sudo・MySQL接続は別途確認してください。
