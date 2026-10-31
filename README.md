# ISUCON15

競技サーバーの構成調査・準備・デプロイ・計測は、リポジトリのTaskfileから操作します。
必要なツール、共通設定、競技当日の流れは[isutools README](isutools/README.md)を参照してください。

- [AIの作業方針](AGENTS.md)：競技の前提・サービス概要・操作コマンド
- [当日マニュアル保存版](docs/manual-2026-10-31.md)：ユーザー提供のISUCON2026公式マニュアル全文
- [ISUReal初動調査](docs/service-investigation.md)：yohの仕様・DB・通信経路・Initialize調査と未確認事項
- [競技当日の進め方](docs/competition-workflow.md)：手順はdocs、実施チェックはIssue #2、改善仮説・検証は改善Issue
- [初期構成の調査](docs/initial-inventory.md)：`task inspect` で収集し、`docs/inventory/` に結果を保存
- [ベンチ実行とPR・Discordへの通知](docs/benchmark.md)：`task bench` とActionsの設定
- テスト：`task test`（運用ツールはPythonのunittest、Node計測部はnode:test）
