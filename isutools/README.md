# isutools

ISUCON15 の構成調査・セットアップ・デプロイ・計測ツール。操作はリポジトリ直下の **Taskfile** にまとめ、運用処理とテストは **Python標準ライブラリ**で実装しています。Ansible は初期セットアップとベンチの実行、Node はアプリに組み込むプロファイラと収集スニペットに使います。

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `task inspect` | `HOSTS` の初期構成を調査して `docs/inventory/` に保存 |
| `task inspect -- s1 s2` | 指定したホストだけを調査 |
| `task bootstrap` | 初期セットアップ・初期状態の取り込み・初回デプロイ・計測設定（1人が1回） |
| `task deploy` | 現在ブランチの push 済みコミットを全ホストへ反映 |
| `task deploy BRANCH=feature/xxx` | 指定ブランチを反映 |
| `task bench BRANCH=feature/xxx` | デプロイしてポータルベンチを1回実行。省略時は現在ブランチ |
| `task status` | commit・最終デプロイ者・サービス・ロックを確認 |
| `task pprotein` | ポート転送して計測UIを開く。Ctrl-Cで終了 |
| `task pprotein:targets -- split` | 全ホストを計測。`single` は先頭ホストだけを計測 |
| `task unlock` | 残ったデプロイロックを確認して解除。`-- -y` で確認省略 |
| `task test` | 運用ツールとNode計測部の全テスト |

引数は `--` の後、対象ブランチは `BRANCH=...` で渡します。ブランチをシェルコードへ埋め込まず、共通CLIに環境変数で渡します。

## 事前準備（全員）

1. 手元に **Task（go-task）・Python 3.8以降・Git・OpenSSH・rsync** を用意します。macOS のTaskは `brew install go-task` で導入できます。Pythonの追加パッケージは不要です。
2. `~/.ssh/config` のHost名をチームでそろえます。初期設定は `s1 s2 s3`、ユーザーは `isucon` です。`ForwardAgent yes` はサーバー上のGitが手元の鍵でGitHubに接続するために必要です。

   ```sshconfig
   Host s1
       HostName <s1のグローバルIP>
       User isucon
       ForwardAgent yes
   Host s2
       HostName <s2のグローバルIP>
       User isucon
       ForwardAgent yes
   Host s3
       HostName <s3のグローバルIP>
       User isucon
       ForwardAgent yes
   ```

3. GitHub用の鍵をagentに載せます。Linuxは `eval "$(ssh-agent -s)"` → `ssh-add ~/.ssh/id_ed25519`、macOSは `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` です。
4. 接続先にもPython 3.8以降が必要です。bootstrap / benchを実行する人は、追加で `uv tool install ansible-core` または `brew install ansible` でAnsibleを準備します。
5. サーバー間の通信を許可します。計測にはアプリ → pproteinホストのTCP 9000、pproteinホスト → 計測対象のTCP 19000（agent）・6060（Node profiler）が必要です。DB分割時は3306番なども許可してください。

## 設定

全コマンドは同じ形式・優先順位で設定を読みます。**下の設定ほど優先**します。

| 順序 | 場所 | 用途 |
|---|---|---|
| 1 | `isutools/config.env` | チーム共通の問題固有設定。編集してcommit・push |
| 2 | `isutools/hosts.env` | bootstrapが収集・生成するプライベートIP。リポジトリで共有 |
| 3 | リポジトリ直下の `.env.isutools` | 手元の認証情報・通知先。Git管理外 |
| 4 | 環境変数 | 一時的な上書き、ActionsのVariables / Secrets |

形式は1行に `KEY=VALUE`。空白を含む値はクォートします。`export KEY=VALUE` とコメントも使えます。**変数展開・コマンド置換・他ファイルのsourceは行いません**。既存のローカル設定で `$VAR` や `$(command)` を使っている場合は、実際の値に置き換えてください。

```dotenv
# .env.isutools の例。必要な項目だけ設定する
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PORTAL_TARGET_ID=1
PORTAL_COOKIE="<Cookieヘッダー全体>"
PORTAL_CSRF_TOKEN="<CSRFトークン>"
```

`BUILD_CMD` はアプリのビルド時だけBashで実行するコマンドです。設定ファイルそのものは実行しません。

競技開始時に確認する主な共通設定は次のとおりです。

| 項目 | 内容 |
|---|---|
| `HOSTS` | SSHのHost名を空白区切りで指定。Ansibleの接続先もここから生成 |
| `GIT_REMOTE` | 競技用リポジトリのURL |
| `APP_DIR` | `/home/isucon` からの相対パス。例: `webapp/nodejs` |
| `APP_SERVICE` | アプリのsystemdサービス名。初期値から必ず変更 |
| `BUILD_CMD` | ビルドコマンド。不要なら空 |
| `NODE_BIN_DIR` | Node / npmの場所。`/home/isucon/local/*/bin` なら空でよい |
| `DB_SERVICE` | `mysql` または `mariadb` |
| `NGINX_LOG` / `SLOW_LOG` | 計測ログのパス |
| `PPROTEIN_HOST` | pprotein本体を置くホスト。初期値は `s3` |
| `ENV_FILES` | ISUCON提供のenvファイル。空ならアプリunitの `EnvironmentFile=` から検出 |

ベンチAPIの設定と認証の当日確認は[ベンチ実行手順](../docs/benchmark.md)を参照してください。

## 競技開始時（1人だけ）

1. `ssh s1` / `ssh s2` / `ssh s3` で接続を確認します。host keyの登録も兼ねます。
2. **初期状態を変える前に** `task inspect` を実行します。結果は `docs/inventory/<UTC取得時刻>/` に保存します。内容を確認してからコミットしてください。収集範囲とオプションは[構成調査](../docs/initial-inventory.md)を参照してください。
3. `isutools/config.env` を問題に合わせて編集し、mainにcommit・pushします。使用言語の切替とアプリサービスの有効化・無効化は手動で行います。
4. mainで `task bootstrap` を実行します。
   - Ansibleでalp / slp / pprotein-agentを全ホスト、pprotein本体を指定ホストに導入
   - 元の `/etc/nginx` と `/etc/mysql` を `/home/isucon/backup/` に退避
   - 各ホストの設定と先頭ホストの `webapp/` を取り込み、計測設定を変更する前の初期コミットを保存
   - 計測設定は別コミットにし、初期コミットとまとめてpush。初期SHAを `isutools/initial-state.json` に記録
   - サーバーの `/home/isucon` をこのリポジトリに合わせる
   - LTSVアクセスログ・MySQL slow log（`long_query_time=0`）・Nodeプロファイラの初期設定を生成してデプロイ
   - 計測サービスを初回有効化し、targets登録と先頭ホストからの接続確認を実行
5. `/initialize` の先頭で `isutools/snippets/pprotein-collect.ts` の `triggerPproteinCollect()` を呼びます。awaitせず、ブランチを切ってcommit・push → `task deploy` します。
6. `task pprotein` でUIを開き、alpの `matching_groups` を問題のURLに合わせます。

専用サーバーでbootstrapを検証するときは、検証ブランチをpushして `task bootstrap BRANCH=test/isutools-servers` を実行できます。実行時のブランチも指定先にそろえてください。初期取り込み・push・初回デプロイは指定ブランチで完結します。省略時はmainです。

## 初期状態の参照

bootstrapは、収集したコード・ホスト別設定を変更前のコミットとして残し、その後に計測設定を別コミットで追加します。初期SHAは `isutools/initial-state.json` の `commit` で確認できます。

```sh
git show <初期SHA>:s1/etc/nginx/nginx.conf
git diff <初期SHA> -- webapp s1 s2 s3
```

初期SHAを基準に、コードや設定の変更を追えます。サービスの有効化・無効化など、ファイル以外の状態はGit履歴の対象に含まれません。

DBデータのバックアップは行いません。`node_modules`、`debian.cnf`、`LARGE_FILE_MB` を超えるファイルもGit対象外です。元のnginx / MySQL設定はサーバーの `/home/isucon/backup/etc/` にも残します。

## 日常の流れ

```sh
git switch -c feature/xxx
# 修正してcommit
git push -u origin feature/xxx
task deploy
# ポータルからベンチを開始
task pprotein
# 結果を確認してmainへマージ
```

認証設定を確認できたら、`task bench` でデプロイとベンチをまとめて実行できます。`DISCORD_WEBHOOK_URL` を設定すると、デプロイ結果・ベンチ結果をDiscordへ通知します。通知失敗は処理の成否に影響しません。PRごとの自動実行は[Actionsの設定](../docs/benchmark.md)で有効化できます。

- デプロイは **事前確認したpush済みコミット**を全ホストへ反映します。未push・originとのズレがあれば止まり、実行中に同じブランチへpushされても反映対象は変わりません。
- デプロイ開始からベンチ完了まで、全ホストで同じロックを保持します。終了を確認できないベンチはロックを残し、状態ファイルの場所を表示します。ポータルで終了を確認してから `task unlock` してください。
- nginx / MySQL / systemdの設定は `s1/` `s2/` `s3/` 配下を編集します。デプロイ時に `/etc` へ配置します。
- デプロイは有効なサービスだけを再起動します。サービスの有効化・無効化と計測の停止・再開は手動で行います。pprotein / agentの初回有効化はbootstrapが行います。
- DBなどを別ホストへ移したら、各ホストの設定と共通設定を変更してデプロイし、`task pprotein:targets -- split` で全ホストを計測します。

## 当日の確認・終了前チェック

担当別の初動・改善サイクル・終了前の手順は[競技当日の進め方](../docs/competition-workflow.md)にまとめています。[Issue #2](https://github.com/ue-sho/isucon15/issues/2) は当日の担当・実施チェック・結果へのリンクを管理します。改善仮説・対象コード・期待する効果と検証結果は、改善ごとのIssueに記録します。

## 困ったとき

- **未push・originとのズレ**: commit・pushまたはpullしてから再実行してください。
- **デプロイ中のロック**: 他の人の作業を待ちます。異常終了なら、デプロイやベンチが動いていないことを確認して `task unlock` します。
- **サーバー上のGitが取得に失敗**: `ForwardAgent yes` と `ssh-add` を確認します。`ssh s1 ssh -T git@github.com` で接続を確認できます。
- **pproteinに届かない**: サーバー間通信とサービス状態を確認し、`task pprotein:targets -- single` で登録・接続確認をやり直します。
- **初期同期でファイルが衝突**: 表示されたサーバー上のファイルを退避するか、リポジトリに取り込んでから再実行してください。

## 開発と構成

```sh
task test:python       # Python標準unittest。追加パッケージ不要
task test:inventory    # 構成調査だけ（inspect:testも同じタスクの別名）
task test:node         # Node 22+・npmが必要。依存導入後にnode:testを実行
task test             # 上記のPython・Nodeテストをまとめて実行
```

Pythonのテストは一時Gitリポジトリと偽SSH・偽サービスで動きます。競技サーバーへ接続しません。Nodeの計測テストはローカルでポートを開きます。Bats・ShellCheckは不要です。

| 場所 | 役割 |
|---|---|
| `Taskfile.yml` | 日常操作とテストの入口 |
| `isutools/__main__.py` | Python共通CLI。TaskとAnsibleから呼び出す |
| `isutools/lib/` | 設定・デプロイ・ロック・通知・設定生成・初期取り込み |
| `isutools/scripts/` | 構成収集・ポータルAPI・リポジトリ初期同期の独立したPython処理 |
| `isutools/ansible/` | 初期セットアップとベンチ実行のplaybook |
| `isutools/templates/` | bootstrap時に生成する設定のテンプレート |
| `isutools/profiler/` / `isutools/snippets/` | アプリに組み込むNode計測部 |
| `isutools/tests/` | Pythonの単体・結合テストと偽ホスト用ヘルパー |
| `docs/` | ベンチ・構成調査の詳細と調査結果 |
