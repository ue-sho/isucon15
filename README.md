# ISUCON15

競技サーバーの構成調査・準備・デプロイ・計測は、リポジトリのTaskfileから操作します。
必要なツール、共通設定、競技当日の流れは[isutools README](isutools/README.md)を参照してください。

- [初期構成の調査](docs/initial-inventory.md)：`task inspect` で収集し、`docs/inventory/` に結果を保存
- [ベンチ実行とPR・Discordへの通知](docs/benchmark.md)：`task bench` とActionsの設定
- テスト：`task test`（運用ツールはPythonのunittest、Node計測部はnode:test）
