# ベンチ実行と結果通知

`task bench` でデプロイからポータルベンチ1回の実行・結果取得まで行います。Discord通知は任意です。
Actionsを有効にすると、PRの作成・pushでも同じ処理を呼び出してPRへ結果を返せます。
共通設定と基本操作は[isutools README](../isutools/README.md)を参照してください。

| 場所 | 処理 |
| --- | --- |
| Actionsの実行マシン | TaskfileからAnsibleを実行してポータルAPIへ起動を依頼し、完了後の出力の末尾20行と実行ログへのリンクをPRへ投稿 |
| 設定した競技サーバー | 確認済みコミットのコード・設定を反映 |
| 運営のベンチ環境 | ポータルが受け付けたベンチを実行 |

## 設定

1. [isutoolsの準備](../isutools/README.md#事前準備全員)に従って、SSH設定・鍵・サーバー設定を用意する。
2. 同じ設定を使える実行マシンへ最新のself-hosted runnerを登録し、`isucon`ラベルを付ける。Git・Bash・Python 3・Ansible・[Task](https://taskfile.dev/)を用意する。
3. GitHubのSettings → Secrets and variables → Actions → Variablesに次の値を設定する。

| Variable | 内容 |
| --- | --- |
| `PORTAL_URL` | ポータルのURL。省略時は`https://portal.isucon.net` |
| `PORTAL_TARGET_ID` | ポータル上の対象サーバーID（IPアドレスではない） |
| `BENCH_ENABLED` | 設定後に`true`にすると自動実行を開始。未設定ではスキップ |

Discordにも結果を送る場合は、同じ画面のSecretsに`DISCORD_WEBHOOK_URL`を設定します。ローカル実行では既存の`.env.isutools`の同名設定を使えます。未設定ならDiscord通知を省略します。

同じ画面のSecretsに`PORTAL_COOKIE`（Cookieヘッダー全体）と`PORTAL_CSRF_TOKEN`を設定します。認証情報の取得方法は当日確認し、値はコードやPRへ書かないでください。

## 現時点の確認と当日の確認

- **確認済み（2026-10-28）**：[現行の配信JS](https://portal.isucon.net/packs/vendor-ac7406362287a2806962.js)に起動の`POST /api/contestant/benchmark_jobs`と結果取得の`GET /api/contestant/benchmark_jobs/{id}`、Protobuf通信・CSRFヘッダーの実装がある。
- **定義の照合済み**：配信JSの[起動・取得](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/services/contestant/benchmark_pb.js)・[ジョブ](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_job_pb.js)・[結果](https://github.com/isucon/isucon14-portal/blob/main/portal/proto/isuxportal/resources/benchmark_result_pb.js)の定義が、ISUCON14の公開スキーマと一致する。
- **ローカル確認済み（2026-10-30）**：Pythonの共通CLIを偽SSHで検証し、確認済みコミットの全ホストへの反映・ベンチ中の排他制御・終了不明時のロック保持を確認。Ansibleと模擬APIでも起動1回・同一ジョブの完了待ち・成功/失敗・認証エラー・Discord通知失敗時の終了状態を確認。
- **当日確認**：自動操作の利用条件、認証方法と有効期間、対象サーバーID、実際の起動・完了・結果取得。10/28時点の競技ページは`contest is not open`で、実ポータルでの通し実行は未確認。

デプロイ処理・設定はisutools、全コマンドの設定優先順位は[isutools README](../isutools/README.md#設定)、ベンチAPIの設定はこのページを参照します。

## 動作

- 同じリポジトリ内のPRを対象に、反映から結果投稿まで1本ずつ実行します。
- Actionsではpush時のコミットをPRブランチ名でチェックアウトし、`task bench BRANCH=...`を呼びます。originとずれている場合は、isutoolsの既存の事前確認で止まります。
- 反映と通知はPythonの共通処理を使い、その後に`isutools/ansible/benchmark.yml`からポータルAPIを呼びます。デプロイからベンチの完了まで同じデプロイロックを保持し、手動の`task deploy`も防ぎます。反映後はその版がサーバーに残ります。
- 反映に失敗したらベンチを実行せず、失敗の状態と実行ログへのリンクをPRへ返します。
- 起動APIは1回だけ呼び、返されたジョブIDを3秒間隔で約10分待ちます。待機がタイムアウトしても、起動済みジョブは取り消しません。タイムアウト・通信切断・終了状態不明の場合はデプロイロックを保持し、後続の反映を止めます。起動POSTの応答が失われた場合も同様です。
- Ansibleから共通CLIの`notify`を呼び、ブランチ・コミット・成功/失敗・ジョブID・スコアをDiscordにも送ります。起動や取得に失敗した場合はエラーを通知します。通知失敗はベンチ自体の成否に影響しません。
- ベンチの出力と`job_id`・`status`・`passed`・`score`を返します。ポータルの成功判定で終了コードを決め、PRの`反映・ベンチ`欄には処理全体の終了状態を表示します。

ローカルではポータル設定・認証情報を環境変数またはリポジトリ直下の`.env.isutools`に設定し、次のコマンドでデプロイからベンチまで実行できます。ブランチを省略すると現在のブランチを使います。

```sh
task bench BRANCH=feature/xxx
```

## 終了を確認できなかったとき

ログに表示される`benchmark-state.json`にジョブIDまたは`submission-unknown`が残ります。
ポータルで対象ジョブが終了したこと（起動の成否が不明なら稼働中のジョブがないこと）を確認してから、`task unlock`でロックを解除してください。
ロックがある間は、次のActions実行もデプロイで停止します。解除後に対象のActionsを再実行できます。
通常終了したベンチは、成功・失敗ともにロックを解除します。
