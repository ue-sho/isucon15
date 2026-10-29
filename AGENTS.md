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
