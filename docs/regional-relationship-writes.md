# 友達関係更新をDB近傍の地域別アプリへ転送する

2026-10-31。対象はISUCON2026 ISUReal、ブランチ `perf/regional-relationship-writes`。
最新mainから作業し、PR提出前に取り込んだmain SHAはPR本文に記録する。

## 変更と意図

europe1/america1で実行していた関係更新のSQLを、既存のasia1上の地域別アプリで実行する。
新規友達申請では認証を除きBEGIN/COMMIT込み8往復、最初のユーザーロック取得後も6往復が残るため、DBまで約100msの地域間往復を繰り返す間もロックを保持する。
HTTPを一度転送してDB近傍で実行し、この通信待ちを減らすのが仮説。本番スコアの改善は未確認。

| 更新 | 転送条件 |
| --- | --- |
| 友達申請 | `POST /api/friend-requests` |
| 承認・拒否・取消 | `POST /api/friend-requests/:requestId/{accept,reject,cancel}` |
| 友達解除 | `DELETE /api/friendships/:userId` |
| follow / unfollow | `PUT / DELETE /api/follows/:userId` |
| block / unblock | `PUT / DELETE /api/blocks/:userId` |

本番の変更は2台の `etc/nginx/sites-available/isureal.conf` へのlocation追加のみ。
`limit_except` 内の `proxy_pass` で他メソッドは従来の `isureal_local_api` に渡す。
未知のaction、余分なパス要素、末尾slash、関係一覧、退会、画像を含む投稿等も既存経路のまま。
既存snippetを再利用し、europe1 → `192.168.1.10:8081` / region=europe、america1 → `192.168.1.10:8082` / region=americaへ送る。

Authorization、X-Client-IP、X-Country-Code、メソッド、本文、元のURI・クエリを維持する。
地域判定は既存認証が共有DBから読むユーザー地域による。ヘッダーで地域を上書きしない。
snippetの `proxy_next_upstream off` を維持し、更新エラー時の自動再送や別地域へのfallbackをしない。
`proxy_pass` のURI省略と `limit_except` での利用は[nginx公式仕様](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)を参照。

固定リージョン・運営ルーター経由の通信は既存構成のまま。
SQL、ロック、初期化、永続化、poolサイズ、worker数、画像処理、systemdは変更しない。
現行の地域別unit定義は各1 worker / pool 2。DB変更・DDL・新規サービスは不要。

## 手元の検証

Node.js 26、Docker Desktop、nginx 1.24、専用の一時PostgreSQL 16で実行。
本番環境の接続情報は使わず、コンテナの公開ポートとNode HTTPサーバーはloopbackに限定する。
Linuxでは従来どおりhost network、Docker Desktopではloopback公開ポートとhost.docker.internalを使う。
Linux分岐および本番の実ルーター・systemd・負荷下の挙動はこの手元検証の対象外。

```sh
ISUTOOLS_NGINX_PROXY_TEST=1 python3 -m unittest discover -s isutools/tests -p test_regional_api_proxy.py -v
cd webapp/nodejs
npm ci --no-audit --no-fund
npm run check
REGIONAL_RELATIONSHIP_TEST=1 npm test
```

- 全3アプリホストの実nginx設定を `nginx -t`。両edgeの全9更新で対応する地域別upstreamへ届くことを確認。
- 全9更新のAuthorization、X-Client-IP、X-Country-Code、メソッド、JSON本文、percent encodingを含むURI・重複クエリの保持。
- 正常認証、欠落・不正認証の401、別地域ユーザーの403、国コードでの地域判定迂回不可。
- 未対応メソッド・対象外パスの転送先維持。実APIで旧地域アプリとの応答一致も確認。
- 全9更新の成功と、commit完了後の別地域アプリからの申請・友達・follow・blockの即時観察。
- 同向き申請のpending重複防止、逆向き申請のfriendship重複防止。
- accept/block、follow/block、退会/申請を両方のロック取得順で実行。実SQLを使い、試験用Txラッパーで取得後に待ち合わせ、`pg_blocking_pids` で実際の待機を確認。
- 全9更新でupstream切断時は502・呼出し1回。503もそのまま返す。試験だけ予備upstreamと親レベルの再試行設定を加え、別upstreamへの再送がないことを確認。
- 既存のrelationship API試験を含むNode全体の試験。関係のない外部DB用opt-in試験のskipはPR本文に件数を記載。

試験用ラッパーはロックの順序制御とPID観察だけを行い、アプリの認証、SQL、結果、commit/rollbackを置換しない。
性能測定用ではなく、実nginxとDBを通した正しさの検証。
共有サーバーへのデプロイ・DDL・再起動・初期化・公式ベンチは実施していない。

## PRと本番比較

PR作成直前に `.github/workflows/benchmark.yml` とGitHubの `BENCH_ENABLED` を確認する。
現在のworkflowはその値が `true` のときPRのopened/synchronize/reopenedで `task bench` を実行する。
この確認のためにworkflowや変数を変更しない。ポータルAPIの認証・実動作は未確認のため手動Enqueueで引き渡す。

画像署名・JPEG等の版、DB、worker/pool、初期状態、収集期間、同時作業を固定した対照ベンチと比較する。
この転送単独の効果を評価し、別改善の効果を混ぜない。

- 対象APIの地域・status別件数とp95、ユーザー行ロック待ち。
- 総スコアと地域別スコア・採点件数、Passed/messages。
- asia1の補助worker別CPUとpool接続待ち。既存pprofが補助workerを含むとは扱わない。
- friends feedの遅延、502/timeoutと他経路の退行。

ベンチID・group・対象head SHA・取り込んだmain SHA・計測条件を対応付ける。
pool待ち等の計測がない項目は未確認として記録し、累積SQL時間をベンチ1回の待ち時間と同一視しない。
低負荷の合成試験を本番の改善率や容量の保証には使わない。

## 反映と切り戻し

デプロイ・初期化・ベンチはユーザーが実施する。
担当版のTaskfileに従い `DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/regional-relationship-writes`、`task status` で反映SHAを確認する。
`task deploy` はサービス再起動とログtruncateを伴うため、全体管理担当と順番を調整して必要なログを保全してから実行する。
asia1の通常サービスとeurope/america補助2サービスがactive、8081/8082が待受、両edgeの `nginx -t` が成功することを確認する。
その後、ポータルのベンチ一覧でEnqueueを押す。`task bench` はデプロイもするため併用しない。

切り戻しは、この変更コミットをrevertして同じ手順でデプロイするか、追加した4つのlocationだけを両edgeから削除して `nginx -t` 後に反映する。
DBの復元・DDLは不要。既存の地域転送snippet・補助サービス・friends feedの経路は維持する。
