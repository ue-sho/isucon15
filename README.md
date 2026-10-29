# ベンチ結果をPRへ返す

PRの作成・pushを受けて、コード反映 → ベンチ1回 → 結果コメントを実行します。
デプロイは[isutools](isutools/README.md)の既存処理を使い、ベンチはポータルAPIから起動します。

| 場所 | 処理 |
| --- | --- |
| Actionsの実行マシン | TaskfileからポータルAPIへ起動を依頼し、完了後の出力の末尾20行と実行ログへのリンクをPRへ投稿 |
| 競技サーバー3台 | isutoolsの既存手順でPRブランチのコード・設定を反映 |
| 運営のベンチ環境 | ポータルが受け付けたベンチを実行 |

## 設定

1. [isutoolsの準備](isutools/README.md#事前準備全員)に従って、SSH設定・鍵・サーバー設定を用意する。
2. 同じ設定を使える実行マシンへ最新のself-hosted runnerを登録し、`isucon`ラベルを付ける。Git・Bash・Python 3・[Task](https://taskfile.dev/)を用意する。
3. GitHubのSettings → Secrets and variables → Actions → Variablesに次の値を設定する。

| Variable | 内容 |
| --- | --- |
| `PORTAL_URL` | ポータルのURL。省略時は`https://portal.isucon.net` |
| `PORTAL_TARGET_ID` | ポータル上の対象サーバーID（IPアドレスではない） |
| `BENCH_ENABLED` | 設定後に`true`にすると自動実行を開始。未設定ではスキップ |

同じ画面のSecretsに`PORTAL_COOKIE`（Cookieヘッダー全体）と`PORTAL_CSRF_TOKEN`を設定します。認証情報の取得方法は当日確認し、値はコードやPRへ書かないでください。

## 現時点の確認と当日の確認

- **確認済み（2026-10-28）**：[現行の配信JS](https://portal.isucon.net/packs/vendor-ac7406362287a2806962.js)に起動の`POST /api/contestant/benchmark_jobs`と結果取得の`GET /api/contestant/benchmark_jobs/{id}`、Protobuf通信・CSRFヘッダーの実装がある。
- **定義の照合済み**：配信JSの[起動・取得](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/services/contestant/benchmark_pb.js)・[ジョブ](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_job_pb.js)・[結果](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_result_pb.js)の定義が、ISUCON14の公開スキーマと一致する。
- **ローカル確認済み**：模擬3台への既存デプロイ→模擬APIで起動1回・完了待ち→PR本文生成を確認。originより古い対象は、既存の事前確認で停止する。
- **当日確認**：自動操作の利用条件、認証方法と有効期間、対象サーバーID、実際の起動・完了・結果取得。10/28時点の競技ページは`contest is not open`で、実ポータルでの通し実行は未確認。

デプロイ処理・設定はisutools、ベンチAPIの設定はこのページを参照します。

## 動作

- 同じリポジトリ内のPRを対象に、反映から結果投稿まで1本ずつ実行します。
- Actionsではpush時のコミットをPRブランチ名でチェックアウトし、既存の`task deploy BRANCH=...`を呼びます。originとずれている場合は、isutoolsの既存の事前確認で止まります。
- 3台への反映・デプロイロック・通知はisutoolsの既存処理を使います。反映後はその版がサーバーに残ります。
- 反映に失敗したらベンチを実行せず、失敗の状態と実行ログへのリンクをPRへ返します。
- 起動APIは1回だけ呼び、返されたジョブIDを3秒間隔で約10分待ちます。待機がタイムアウトしても、起動済みジョブは取り消しません。
- ベンチの出力と`job_id`・`status`・`passed`・`score`を返します。ポータルの成功判定で終了コードを決め、PRの`反映`・`ベンチ`欄には各コマンドの終了状態を表示します。

ローカルでもisutoolsでデプロイし、ポータル設定・認証情報を環境変数で渡してベンチを実行できます。

```sh
task deploy BRANCH=feature/xxx
task bench
```
