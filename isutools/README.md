# isutools

ISUCON15 用のセットアップ・デプロイ・計測ツール。手元から `task` コマンドで3台（s1, s2, s3）を操作する。

- セットアップは競技開始時に **1人が1回だけ** `task bootstrap`
- デプロイは **誰でも** `task deploy`（手元の現在ブランチを3台すべてに反映）
- 計測は pprotein（ベンチごとに httplog / slowlog / Node の pprof を自動収集）

## 事前準備（全員）

1. `task` をインストール（macOS: `brew install go-task`。Linux でも Go Task の `task` を使用）
2. `~/.ssh/config` に3台を書く。**Host 名は全員 `s1` `s2` `s3` にそろえ、`ForwardAgent yes` を必ず入れる**
   （サーバ上の git が手元の鍵で GitHub に接続するため。サーバに鍵は置かない）

   ```
   Host s1
       HostName <s1 のグローバル IP>
       User isucon
       ForwardAgent yes
   Host s2
       HostName <s2 のグローバル IP>
       User isucon
       ForwardAgent yes
   Host s3
       HostName <s3 のグローバル IP>
       User isucon
       ForwardAgent yes
   ```

3. GitHub 用の鍵を agent に載せる。Linux は `eval "$(ssh-agent -s)"` → `ssh-add ~/.ssh/id_ed25519`、
   macOS は `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`
4. （任意）Discord に通知する場合、リポジトリ直下に `.env.isutools` を作る（コミットされない）

   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

bootstrap を実行する人だけ、追加で `uv tool install ansible-core`（または `brew install ansible`）。

サーバ間のプライベート IP 通信もセキュリティグループで許可しておく。
計測にはアプリ → pprotein ホストの TCP 9000、pprotein ホスト → 計測対象の TCP 19000（agent）と
6060（Node profiler）が必要。競技用の3台で共通のセキュリティグループを使う場合、
ソースをそのグループ自身とした全通信の許可でもよい。DB 分割時の3306番などにも対応できる。

## 競技開始時（1人だけ）

1. 3台に `ssh s1` / `ssh s2` / `ssh s3` できることを確認する（host key の登録も兼ねる）
2. `isutools/config.env` を問題に合わせて編集し、main に commit・push する

   | 項目 | 内容 |
   |---|---|
   | `APP_DIR` | アプリのディレクトリ（`/home/isucon` からの相対パス。例: `webapp/nodejs`） |
   | `APP_SERVICE` | アプリの systemd サービス名（例: `isuapp-node.service`）。実環境で確認 |
   | `BUILD_CMD` | デプロイ時のビルドコマンド（TypeScript をビルドするなら `npm run build`。不要なら空） |
   | `NODE_BIN_DIR` | node / npm の場所。`/home/isucon/local/*/bin` にあるなら空でよい（`ssh s1 'ls ~/local'` で確認） |
   | `DB_SERVICE` | `mysql` か `mariadb` |
   | `NGINX_LOG` / `SLOW_LOG` | ログのパス（基本は初期値のまま） |
   | `PPROTEIN_HOST` | pprotein 本体を置くホスト（ベンチで使われない s3 が初期値） |
   | `ENV_FILES` | ISUCON 提供の env ファイル。空なら `APP_SERVICE` の `EnvironmentFile=` から自動検出 |

   使用言語の切替とアプリサービスの有効化・無効化は、実行前に手動で行う。
   bootstrap はアプリサービスの有効化・無効化を変更しない。

3. `task bootstrap`（main ブランチで実行）。やること:
   - 3台に alp / slp / pprotein-agent（s3 には pprotein も）をインストール
   - 元の `/etc/nginx` `/etc/mysql` を `/home/isucon/backup/` に退避
   - 3台の設定と s1 の `webapp/` を手元に集めて、初期コミットを main に push
   - 3台の `/home/isucon` をこのリポジトリに合わせる
   - nginx のアクセスログ（LTSV）と MySQL の slow log（`long_query_time=0`）を有効にして初回デプロイ
   - pprotein の計測対象を登録し、s1 から pprotein に届くか確認
4. `/initialize` に `isutools/snippets/pprotein-collect.ts` の `triggerPproteinCollect()` を組み込む
   （ハンドラの先頭で呼ぶ。await しない）→ ブランチを切って `task deploy`
5. `task pprotein` で UI を開き、httplog の設定（alp の `matching_groups`）を問題の URL に合わせる

## 日常の流れ

専用サーバで bootstrap 自体を検証する場合は、検証ブランチを push して
`task bootstrap BRANCH=test/isutools-servers` を実行できる。
初期状態の取り込み・push・サーバ同期・初回デプロイは指定ブランチで完結する。
省略時は `main`。実行時のブランチは指定先と一致している必要がある。

```
git switch -c feature/xxx
# 修正して commit
git push -u origin feature/xxx
task deploy          # 現在ブランチを3台に反映（結果は Discord にも流れる）
# ポータルからベンチ → task pprotein で結果を見る
# スコアが上がったら main にマージ
```

- `task deploy` は **push 済みの内容**を反映する。未 push・リモートとのズレがあれば何もせずに止まる
- 別ブランチを反映するなら `task deploy BRANCH=feature/yyy`
- 他の人がデプロイ中ならロックで止まる。冒頭に「直前に誰が何を反映したか」が出る
- サーバの設定（nginx / MySQL / systemd）は `s1/` `s2/` `s3/` 配下を編集する。deploy が `/etc` に配置する
  （`/etc` を直接いじっても次のデプロイで上書きされる）
- ログ・計測の停止と再開は手動で行う。設定変更は該当ホストのファイルに反映する。
  deploy は有効なサービスだけを再起動し、サービスの有効化・無効化は変更しない。
  pprotein / agent の初回有効化は bootstrap で行う。

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `task bootstrap` | 競技開始時のセットアップ（1人が1回） |
| `task deploy` | 現在ブランチを3台に反映（`BRANCH=` で指定可） |
| `task status` | 3台のブランチ / commit / 最終デプロイ者 / サービス状態 / ロック |
| `task pprotein` | pprotein の UI を開く（Ctrl-C で終了） |
| `task pprotein:targets -- split` | サーバ分割後に計測対象を全ホストに広げる（戻すときは `single`） |
| `task unlock` | 異常終了で残ったデプロイロックを解除 |

## 最終ベンチ前チェックリスト

1. ログ設定・`PPROTEIN_ENABLED`・`NODE_OPTIONS` を手動で変更し、計測サービスを停止・無効化する
2. `task status` で全ホストの `agent=inactive` を確認
3. アクセスログ・slow log が増えていないことを確認
4. 再起動試験: 3台を再起動して、アプリが動き計測が止まったままであることを確認
5. main にマージした状態で最終ベンチ

## 困ったとき

- **`未 push のコミットが N 件あります`**: `git push` してから再実行
- **`sN はデプロイ中です`**: 他の人のデプロイを待つ。異常終了で残っているなら `task unlock`
- **`origin から main を取得できません`**: `ForwardAgent yes` と `ssh-add` を確認（`ssh s1 ssh -T git@github.com` で確認できる）
- **`s1 から pprotein に届きません`**: s1 → s3 の 9000 番ポートが開いているか確認
- **サーバ分割**: DB を移すなどしたら、該当ホストの `sN/etc` と `config.env` を編集 → `task deploy`、
  計測は `task pprotein:targets -- split`
- **`unsupported locale setting`**: `LC_ALL=C.UTF-8 LANG=C.UTF-8 task bootstrap` で実行する
  （検証ブランチの場合は `BRANCH=...` も付ける）
- **デプロイ後の接続確認だけ失敗した場合**: サーバ間通信を許可した後、
  `task pprotein:targets -- single` で targets 登録と接続確認を再実行する

## 開発者向け

`task test`（bats-core / shellcheck / Node 22+ が必要）。テストは偽ホスト（ローカルのディレクトリ）と
偽 ssh（`isutools/tests/helpers/fake-ssh`）で動く。手元のスクリプトは macOS の bash 3.2 でも動くこと。
Ubuntu / Debian では `sudo apt install -y bats shellcheck jq rsync` でテスト用ツールをインストールできる。
