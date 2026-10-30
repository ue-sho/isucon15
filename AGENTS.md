# ISUCON15

ISUCON15で、仕様を満たしながらWebアプリケーションのチューニングを行うリポジトリです。
アプリケーションは **Node.js** で実装します。計測結果をもとに改善し、変更前後のベンチ結果を比較します。

## 競技サービス

競技開始後に追記します。

- サービス概要：未記入
- 仕様・採点方法：未記入
- アプリの配置・起動方法：未記入
- DB・サーバー構成：未記入

## コマンド

| コマンド | 用途 |
|---|---|
| `task deploy` | 現在ブランチのpush済みコミットを全ホストへ反映 |
| `task deploy BRANCH=feature/xxx` | 指定ブランチを反映 |
| `task bench` | デプロイしてベンチを実行（ポータルの認証設定が必要） |
| `task status` | 反映コミット・サービス・ロックを確認 |
| `task pprotein` | 計測結果のUIを開く |
| `task pprotein:targets -- split` | 全ホストを計測対象にする（`single`で先頭ホストのみ） |
| `task unlock` | 終了を確認したデプロイ・ベンチの残存ロックを解除 |

操作・設定の詳細は [isutools README](isutools/README.md) を参照してください。
改善仮説・検証結果は改善ごとのIssue、共通手順や構成はdocs、当日の実施チェックは [Issue #2](https://github.com/ue-sho/isucon15/issues/2) に記録します。

## pproteinの計測データ

pprotein本体は `isutools/config.env` の **`PPROTEIN_HOST`**（初期値は `s3`）で動作し、取得データは **`/var/lib/pprotein/data/`** に保存されます。
systemdの作業ディレクトリは `/var/lib/pprotein` です。`localhost:9000` はSSH転送先のUIであり、手元の保存先ではありません。

| ファイル | 内容 |
|---|---|
| `*-httplog.log` | 取得したHTTPアクセスログ |
| `*-slowlog.log` | 取得したMySQLスロークエリログ |
| `*-pprof.pb.gz` | 取得したNode.jsプロファイル |
| `*-memo.log` | 計測グループのメモ・ベンチ結果 |
| `pprotein.db` | 計測結果のメタデータ |
| `alp.yml` / `slp.yml` / `targets.json` | HTTP・SQLの集計設定と収集対象 |

初期設定での保存ファイルは `ssh s3 'ls -lh /var/lib/pprotein/data/'` で確認できます。
計測をIssueに記録するときは、グループID・対象コミット・ベンチ結果と併せてログのファイル名も残してください。
