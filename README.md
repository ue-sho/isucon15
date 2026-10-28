# ベンチ結果をPRへ返す

PRの作成・pushを受けて、コード反映 → ベンチ1回 → 結果コメントを実行します。
デプロイはISUCON14のTaskfileを参考にSSHで行い、ベンチはポータルAPIから起動します。

| 場所 | 処理 |
| --- | --- |
| Actionsの実行マシン | TaskfileからポータルAPIへ起動を依頼し、完了後の出力の末尾20行と実行ログへのリンクをPRへ投稿 |
| アプリサーバー | 指定コミットを取得し、設定したビルド・再起動コマンドを実行 |
| 運営のベンチ環境 | ポータルが受け付けたベンチを実行 |

## 設定

1. 最新のself-hosted runnerを実行マシンへ登録し、`isucon`ラベルを付ける。Git・Bash・Python 3・[Task](https://taskfile.dev/)を用意し、その実行ユーザーでアプリサーバーへSSH接続できるようにする。
2. アプリ配置先は、このリポジトリを`origin`からfetchできるGit作業ツリーにする。runnerのチェックアウト先とは分ける。
3. GitHubのSettings → Secrets and variables → Actions → Variablesに次の値を設定する。

| Variable | 内容 |
| --- | --- |
| `APP_HOST` | アプリのSSH接続先。SSH設定の別名も利用可 |
| `APP_DIR` | アプリサーバー上のGit作業ツリーの絶対パス |
| `DEPLOY_COMMAND` | `APP_DIR`内で実行する、必要なビルド・再起動コマンド |
| `PORTAL_URL` | ポータルのURL。省略時は`https://portal.isucon.net` |
| `PORTAL_TARGET_ID` | ポータル上の対象サーバーID（IPアドレスではない） |
| `BENCH_ENABLED` | 設定後に`true`にすると自動実行を開始。未設定ではスキップ |

同じ画面のSecretsに`PORTAL_COOKIE`（Cookieヘッダー全体）と`PORTAL_CSRF_TOKEN`を設定します。認証情報の取得方法は当日確認し、値はコードやPRへ書かないでください。SSH鍵はrunner側で管理します。

## 現時点の確認と当日の確認

- **確認済み（2026-10-28）**：[現行の配信JS](https://portal.isucon.net/packs/vendor-ac7406362287a2806962.js)に起動の`POST /api/contestant/benchmark_jobs`と結果取得の`GET /api/contestant/benchmark_jobs/{id}`、Protobuf通信・CSRFヘッダーの実装がある。
- **定義の照合済み**：配信JSの[起動・取得](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/services/contestant/benchmark_pb.js)・[ジョブ](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_job_pb.js)・[結果](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_result_pb.js)の定義が、ISUCON14の公開スキーマと一致する。
- **ローカル確認済み**：模擬APIで起動1回・同一ジョブの完了待ち・成功と失敗の結果出力を確認。
- **当日確認**：自動操作の利用条件、認証方法と有効期間、対象サーバーID、実際の起動・完了・結果取得。現在の競技ページは`contest is not open`で、実ポータルでの通し実行は未確認。

今回はデプロイとself-hosted runnerの構成を維持しています。

## 動作

- 同じリポジトリ内のPRを対象に、反映から結果投稿まで1本ずつ実行します。
- 対象はpush時のコミットです。反映後はその版がサーバーに残ります。
- 反映に失敗したらベンチを実行せず、失敗の状態と実行ログへのリンクをPRへ返します。
- 起動APIは1回だけ呼び、返されたジョブIDを3秒間隔で約10分待ちます。待機がタイムアウトしても、起動済みジョブは取り消しません。
- ベンチの出力と`job_id`・`status`・`passed`・`score`を返します。ポータルの成功判定で終了コードを決め、PRの`反映`・`ベンチ`欄には各コマンドの終了状態を表示します。

ローカルでは接続設定とポータル認証情報を環境変数で渡し、同じタスクを実行できます。

```sh
task deploy REV=<コミットSHA>
task bench
```
