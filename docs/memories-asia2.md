# AsiaのMemoriesをasia2へ移す

## 変更理由と範囲

署名改善を含むベンチ #22237（6228点、配布版 `b21e483`）のasia1実worker2本では、約60秒のプロファイルのサンプル重みの42.5%が画像署名、38.1%がJPEGだった。Memoriesからの署名生成だけで全サンプルの約27.7%を占めた。ホスト全体のCPU使用率や、変更後の改善率を表す数値ではない。

asia1でMemoriesの署名生成と投稿時のJPEG処理がCPUを取り合う状態を緩和するため、次の2経路をasia1のnginxから `192.168.4.10:8080`（asia2）へ転送する。

- `/api/memories`（完全一致）
- `/api/memories/:date`（単一パス要素。不正な日付も既存APIで検証する）

アプリのMemories処理・SQL・レスポンスは変更しない。Authorization、X-Client-IP、X-Country-Code、パス・クエリ・メソッドをそのまま転送し、HostとHTTP/1.1 keepaliveも従来と同様に扱う。未対応メソッドは既存アプリの405応答になる。nginxでのレスポンスキャッシュは追加せず、上流切断時の再送も行わない。

export、投稿、画像配信、通知、初期化、Europe/Americaの入口は変更しない。公開入口はasia1のまま、同じAsiaリージョン内の既存ネットワーク経路を使う。根拠となる規約・運営回答は当日マニュアルと `clarifications-2026-10-31.md` の #20 を参照。

## asia2のサービスと初期化

既存の `isureal-nodejs.service` を使い、ExecStartで `region=asia`、port=8080、worker=1、DB pool=2、DB host=127.0.0.1を明示する。DBと同居するためworker・接続数を抑える。ほかのDB接続設定は既存EnvironmentFileを使い、秘密情報を追加しない。

`multi-user.target.wants/isureal-nodejs.service` の相対symlinkを管理対象へ追加する。`remote_deploy` はrsyncの `-rl` でこれを配置し、daemon-reload後にenabledなアプリを再起動・確認する。既存の `task status` でもasia2のapp状態を確認できる。PostgreSQLクラスタの起動後にアプリを起動する依存も設定する。

DBスキーマ変更・データ移動・キャッシュ方式の変更はない。全workerが同じDBを参照し、認証クエリで共有の `image_signature_cache_state.generation` を毎回取得する既存方式を維持する。初期化時の世代更新が次の認証リクエストへ伝わるため、asia2専用の初期化通知は不要。IP banも既存の共有DB参照・200ms更新を使う。

## 手元検証

- `npm run check`。
- Node通常テスト: 82成功、DB等のopt-in試験13件skip。
- 追加した `memories-placement.test.ts` を使い、ローカルPostgreSQL 16と独立したNodeプロセス2本で検証。認証失敗、地域不一致、IP ban、不正入力、未対応メソッド、50件境界・次ページ、日付指定、他人の履歴の非表示、更新・削除の即時反映、別workerでの署名URL画像取得、世代・鍵変更、再起動後の取得が成功。
  - 世代更新はローカルDBで模擬した。公式初期データを使うinitialize全体の実行ではない。
- `ISUTOOLS_NGINX_PROXY_TEST=1 python3 -m unittest discover -s isutools/tests -p 'test_*proxy.py' -v`: 3試験成功。実nginx 1.24で全アプリホスト設定をparseし、Memoriesの月・日付・境界パス、ヘッダー・クエリ保持、gzip、エラー、切断時の再送なしを確認。既存Europe/America転送も確認。
  - Docker Desktopのhost network設定を変えずに実行できるよう、Macの試験fixtureは公開ポートとhost.docker.internalを使う。
- Linux上のsystemdで `is-enabled` がenabled、unitの `systemd-analyze verify` が成功。PostgreSQL依存unitは試験用stub。ホスト再起動の実測ではない。
- デプロイ既存試験46件がLinuxの隔離コンテナで成功。MacのBSD truncateは既存のGNUオプションに非対応なので、この試験には使わない。

独立workerの試験は、空の専用DB `isureal_memories_placement_test` をloopbackへ公開したうえで、次を実行する。既存DBは使わない。

```sh
MEMORIES_PLACEMENT_PG_PORT=指定したローカルPGポート node --test test/memories-placement.test.ts
```

## 反映とベンチ（ユーザーが実行）

本番反映・再起動・公式ベンチ・本番ホスト再起動は未実施。性能改善とDBとの資源競合は未確認。計測中の走行が終わり、他担当の反映と重ならない状態で進める。既存 `task deploy` はDB再起動とログ切り詰めも含むため、必要な計測結果は先に保存する。

初回はasia2を先に配置し、asia1から401応答で待受・DB接続を確認した後、入口を切り替える。すべて同じpush済みブランチを使う。DDLは不要。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-memories-asia2
HOSTS=asia2 task deploy BRANCH=perf/memories-asia2 &&
ssh asia2 'systemctl is-enabled isureal-nodejs.service && systemctl is-active isureal-nodejs.service' &&
ssh asia1 'code=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "http://192.168.4.10:8080/api/memories?month=2026-10") && test "$code" = 401' &&
HOSTS="asia1 europe1 america1" task deploy BRANCH=perf/memories-asia2 &&
task status &&
ssh asia1 'code=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1/api/memories?month=2026-10") && test "$code" = 401'
```

`task status` の4台のcommitがPRのhead SHAと一致し、asia2のapp=activeを確認する。401は疎通・認証拒否の確認であり、正常ユーザーの動作はベンチで確認する。

その後、ポータルのベンチ画面で **Enqueueを1回** 実行する。ポータルAPIによるCLI起動は未確認のため `task bench` は案内しない（同コマンドは再デプロイも行う）。PR作成前の確認ではBENCH_ENABLEDリポジトリ変数は未設定で、自動ベンチの条件は成立していない。

比較では対象SHA・初期化条件を揃え、score・passed・messagesに加えて、AsiaのMemoriesと投稿のp95、asia1の実worker負荷、asia2のCPU・メモリ・DB待ちを確認する。Memoriesを移したCPU分がそのまま得点へ換算されるとは限らない。

## 戻す場合

入口を先に戻す。PR未マージでmainが旧経路を維持している間は、アプリ3台へ `HOSTS="asia1 europe1 america1" task deploy BRANCH=main` を実行してMemoriesをasia1へ戻す。その確認後、asia2で `sudo systemctl disable --now isureal-nodejs.service` を実行する。既存deployは削除済みファイルを/etcから消さないため、ブランチを戻すだけでは自動起動symlinkは消えない。未使用のMemories upstream/snippetは残っても参照されない。

このPRをマージした後は、2つのlocationとasia2の自動起動設定を取り消した切戻し版を用意し、同じ順で入口から戻す。
