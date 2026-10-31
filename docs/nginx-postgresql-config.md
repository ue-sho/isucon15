# nginx・PostgreSQL設定と得点低下への対応

## 終了前の追加変更：WAL容量（反映済み・ベンチ未検証）

2026-10-31 17:35 JST、ブランチ `perf/pg-checkpoint-headroom`、起点 `053af6e`。
asia2の読み取りでshared_buffers=512MB、effective_cache_size=2GB、work_mem=4MB、
max_connections=100、max_wal_size=1GB、checkpoint_timeout=300秒、
checkpoint_completion_target=0.9、永続化3設定on、SQL計測停止を確認した。
asia1のnginxはkeepalive・gzip・sendfile・アクセスログ停止が有効だった。

DB累積統計は定期checkpoint55回・要求checkpoint102回、統計起点は10/30 11:59 UTC。
要求分には初期化や明示実行も含み、WAL容量超過だけとは断定できない。
08:35:31.701→08:35:45.491 UTCのWAL増分は37,789,847 bytes（約2.6MiB/秒）。
同区間のcheckpoint件数は不変。ディスク空き30GB、MemAvailable約2.1GB。
一時ファイルは累積386件/約1.35GBで、今回ベンチの発生量とは区別する。

比較候補は `max_wal_size='2GB'` のみ。WAL量によるcheckpointを減らす仮説で、
スコア向上は未確認。WAL保持量と障害復旧時間が増える可能性があり、2GBは厳密な上限ではない。
[PostgreSQL 16公式説明](https://www.postgresql.org/docs/16/wal-configuration.html)を参照。
work_memやplanner、保存の同期設定を同時変更しない。

本番反映はueshoとベンチ終了・対象asia2・実施順序を確認してから行う。
反映する場合は既存設定を保存してこの設定ファイルのみを配置し、
`pg_file_settings`で構文エラーがないことを確認後、`pg_reload_conf()`を実行する。
`SHOW max_wal_size`が2GB、pending_restart=false、永続化3設定onを確認する。
通常のtask deployは再起動・ログ操作を伴うため、この比較には使わない。
比較前後のベンチID・SHA・スコア・成否・checkpoint/WAL統計の差分を記録する。
改善しなければ元ファイルを復元しreload、`SHOW max_wal_size`が1GBに戻ることを確認する。
ユーザーの「良さそうと思うものをやって」の許可で17:37 JSTにasia2へ反映した。
直前はdeploy.lockなし、DB接続はguardのidleと調査psqlのみ。
実機checkoutは `bd247ba` で、ローカル起点とは異なる。対象設定は変更前に一致を確認した。
元ファイルは `/etc/postgresql/16/main/conf.d/zzz-isureal-performance.conf.before-checkpoint-20261031`
へ保存。対象ファイルのみ配置し、pg_file_settingsのエラー0件を確認してreload成功。
別接続でmax_wal_size=2048MB、shared_buffers=512MB、永続化3設定on、
pending_restart=false、PostgreSQL active、リポジトリとのファイル一致を確認した。
反映直後のcheckpoint基準は定期55/要求102（08:37:27 UTC）。
ベンチ・push・マージは未実施。戻す場合は上記バックアップを元のパスにコピーしてreloadする。

2026-10-31。[Issue #34](https://github.com/ue-sho/isucon15/issues/34)。
参照は [private-isu-2026 PR #9](https://github.com/ue-sho/private-isu-2026/pull/9)。MySQL設定の移植ではなく、PostgreSQL 16と今回の3.7GiB/2vCPU構成へ合わせた。
ブランチは `perf/nginx-postgresql-config`、起点は稼働版 `cfa6cb8`。

## 前後の観測

| ベンチ | スコア | group ID | 収集SHA |
|---|---:|---|---|
| #6467 | 4700 | 2026-10-31_03-03-15.009618 | 84806f5 |
| #7731 | 3275 | 2026-10-31_03-21-18.387638 | cfa6cb8 |

ユーザー実行の適用後ベンチ **#8934は5747点**。#7731から2472点増、#6467から1047点増。
適用版は全4台 `05eec2d`。asia2→アプリ3台の順でtask deployし、本番のnginx構文・未認証API401疎通・PG有効設定・pprotein200・ロック解除を確認した。
スコアとベンチIDはユーザー提供。ポータルの詳細判定/messages・新グループとの照合と設定別寄与は未確認。
適用前ログと旧設定は手元 `/tmp/isu15-config-deploy.AXvncf/*-before.tar.gz`、実行ログは同ディレクトリに保存した。
以下の#7731の悪化分析と設定比較は、この改善を選んだ根拠である。

#7731はPassedだが、最終グランプリはAsia0人/Europe6人/America5人。
europeの投稿枠取得で502が2件あり、nginxはasia1:8081からのrecv() failedを記録した。補助サービスNRestarts=0、OOM記録なし。
Nodeの新規HTTPServerの既定keepAliveTimeoutが5000msであることを実機確認。
nginxとNodeのidle接続切断の競合は候補だが、この記録だけで502の原因確定とはしない。

| 地域 | 投稿201の平均：前→後 | friends feed成功の平均：前→後 |
|---|---|---|
| asia | 2.640→3.883秒 | 0.746→2.126秒 |
| europe | 1.848→3.140秒 | 0.858→0.319秒 |
| america | 1.728→2.650秒 | 0.814→0.292秒 |

SQL execute累計は183.26→142.10秒、件数は26,158→22,347。並行分合算でCPU時間ではなく、処理量も異なるためDBが改善したとも断定しない。
Asiaへの投稿/JPEG処理集中や補助pool2の待ちは仮説で、ベンチ期間のCPU/pool待ちは未計測。
ログは手元 `/tmp/isu15-score-regression/` で集計した。

| ベンチ | asia1 HTTP | europe1 HTTP | america1 HTTP | asia2 SQL |
|---|---|---|---|---|
| #6467 | dmiouadrzfxp-httplog.log | dmiouadr41s1-httplog.log | dmiouadr0lzx-httplog.log | dmiouadqk8oa-slowlog.log |
| #7731 | dmip842tposp-httplog.log | dmip842tkxve-httplog.log | dmip842t3sjr-httplog.log | dmip842sz99h-slowlog.log |

## 今回の変更

- 投稿 `/api/posts` のexact転送だけを外し、JPEGデコードと投稿を元の各地域へ戻す。速くなったfriends feedと現在投稿枠・自分の現在投稿の3パスはasia1への転送を維持する。
- 3台のローカルNode用upstreamを追加し、HTTP/1.1・Connectionヘッダー解除・keepalive32にする。地域間upstreamも含めidle期限は1秒、1接続1000リクエストまでとし、Nodeの既定5秒より早く再利用を終了する。
- nginxのworker_connectionsを768→2048。JSON/CSS/JS/SVGはgzip level1・1KiB以上で圧縮する。JPEGは対象外。SSE通知は明示的にbuffering/gzipを無効化する。
- 通常APIのproxy bufferを8×16KiB、header16KiB、busy32KiBへ設定し、proxy一時ファイルへの退避を止める。レスポンスキャッシュではなく、認証・署名・削除状態の応答は毎回アプリで判定する。遅いクライアントではupstreamへのbackpressureが増える可能性がある。
- 全4台のPG計測設定にlog_parameter_max_length=0、同on_error=0を明記。SQL形状・時間は引き続き収集し、画像bytea等の文字列化とログ出力を省く。
- 共有DBのasia2だけshared_buffers=512MB（現128MB）、effective_cache_size=2GB（現4GB）。後者はメモリ確保ではなくplannerの見積り。pproteinとOSのキャッシュ余力も残す。
- work_mem、max_connections、WAL、fsync、synchronous_commit、full_page_writesは変えない。参照PRの接続上限1000・同期書込無効化は採用しない。

仕様の根拠：
[nginx upstream](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)、[gzip](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)、[PGメモリ](https://www.postgresql.org/docs/16/runtime-config-resource.html)、[PG bind値ログ](https://www.postgresql.org/docs/16/runtime-config-logging.html#GUC-LOG-PARAMETER-MAX-LENGTH)。

## 手元検証

nginx1.24で3台のnginx.conf全体が構文検査に成功。実転送テストで投稿の地域内処理・残る3パスの転送・認証/本文保持・失敗POST非再送・JSON gzip・SSE非圧縮を確認した。
手元PG16で提案設定を読み込んで起動し、shared_buffers512MB/effective_cache_size2GB/log_parameter_max_length0と永続化設定onを確認。
合成1MiB byteaの単発SELECTはログ増分がparameter=-1で4,194,775bytes、0で343bytesだった。SQL結果の長さは両方1,048,576bytes。
これは合成ログ量の確認で、スコア改善・本番CPU削減率の実測ではない。

## 比較・戻し方

ユーザー依頼により今回は変更をまとめてdeployする。個別の寄与はこの1回では分離できない。
ベンチはユーザーが実行する。成否・各地域の期間内feed検証・最終グランプリ人数、投稿/フィードp95、502、CPU/pool待ち、SQLログ量を比較する。
次に分離するなら投稿転送の有無→接続/圧縮→ログ→メモリの順に1条件ずつ比較する。

nginx設定は元のコミットへ戻してnginx -t後にreloadする。追加した `isureal-local-api.conf` はrsyncだけでは削除されないので明示撤去が必要。
PGログ設定は元の値へ戻してreloadできる。asia2の追加 `zzz-isureal-performance.conf` もGit削除だけでは消えないため、撤去と再起動でshared_buffersを元へ戻す。
初期化SQL・保存方式・追加キャッシュ/複製先は変更しない。初期化60秒・再起動後取得・実スコアは本番確認が必要。
