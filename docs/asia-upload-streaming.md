# Asiaプロフィール画像の受信ストリーミング比較

**採用非推奨・Draft。** 一時ファイルI/Oは減るが、遅い送信が現行JPEGDecoderの実行枠を保持し、後続の正常画像を待たせる退行を実nginxで再現した。アプリ側の変更はこのPRに含めない。試験が通ることは性能上の採用判定を意味しない。

## 基準・変更

基準mainは `053af6eca4400864c62269ca6188d6701dd8a7a3`。別の投稿期間転送PRと同じ基準から作った独立ブランチ `perf/asia-upload-streaming` である。Nodeコード、他地域、Memories、画像配信、サービス、DB、32MiB本文上限は変更していない。

完全一致の `/api/me/profile-image` でPUTだけをnamed locationへ渡し、HTTP/1.1、`proxy_request_buffering off`、`proxy_next_upstream off` を使う。named locationへの内部遷移はメソッド・本文・元のURI/queryを維持する。PUT以外は従来のlocal APIと本文バッファ・再送設定を保つ。認証・abuse分類・JPEG全体検証は現行アプリが行う。

[調査記録](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540905647) のベンチ27678（計測版589f52d）の活動期間では、asia1ホスト全体の書込み平均58406.6KiB/s、system CPU平均16.2%、プロフィール画像400が136件・平均3.099秒だった。nginxやこのAPIの書込みと断定できず、workerの累積I/Oカウンタとも区別する。本PRの合成試験はその原因を確定するものではない。

[nginx公式: request buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering) と [body buffer](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_body_buffer_size) に基づく受信層の比較。既存の `proxy_max_temp_file_size 0` は応答側である。大容量body buffer、tmpfs、制限引下げ、検査省略は追加しない。

## 再現方法・実測

Node v26.12.1、既存lockfileのHono 4.13.14 / adapter 2.1.5、Docker nginx 1.24、PostgreSQL 16。実機は読み取りでnginx 1.24.0 Ubuntuを確認。ローカルDBは試験が専用コンテナ内に新規作成し、空DB確認後に既存schemaと合成データを入れ、終了時に破棄する。実データ、env.sh、共有DBは使用しない。

```sh
cd webapp/nodejs
npm ci --no-audit --no-fund
ASIA_UPLOAD_TEST=1 node --test test/asia-upload-streaming/upload.test.ts
npm run check
```

比較対象は同じ現行アプリに対し、基準mainのnginx siteと変更後siteを切り替えたもの。fixtureは実 `newServer` とHono adapterを独立プロセスで起動する。試験用echo/切断分岐は経路・再送試験だけに使い、業務応答・保存・JPEG試験は現行ハンドラーを通す。Node RSSは20msサンプル、nginx RSSは計測点の値でありピークではない。`/proc/*/io` は試験内の差分、`wchar`はsocket等も含み、`write_bytes`も物理ディスク完了量ではない。Docker Desktopの共有FS・仮想ネットワークを含むため本番値へ換算しない。

8MiBの合成JPEG（1px画像＋末尾ゼロ、保存全bytes一致）をABBA各1回で比較。

| 順序 | nginx受信一時ファイル警告 | nginx write_bytes差分 | HTTP ms | nginx RSS KiB |
|---|---:|---:|---:|---:|
| baseline | 1 | 8,388,888 B | 165.7 | 10112 |
| streaming | 0 | 65 B | 133.8 | 10128 |
| streaming | 0 | 65 B | 141.8 | 10128 |
| baseline | 1 | 8,388,888 B | 159.9 | 10112 |

1.4秒の送信停止を先行PUTに入れ、250ms後に正常画像を送ると、後続の応答は **25.9 → 1172.1ms**。同時の投稿期間GETは13.7 → 9.7msだった。正常画像の待ちを大きく増やすため、I/O削減だけでは採用しない。

新品のNodeプロセスで2.5秒の遅いPUTと8本×16MiBのアップロードを重ねた各1回の比較:

| 方式 | Node開始RSS MiB | 待機時RSS MiB | 待機までの最大RSS MiB | incoming最大buffer B | 8本平均ms | 他API ms |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 123.0 | 237.0 | 237.0 | 73,728 | 1395.3 | 189.5 |
| streaming | 123.2 | 125.5 | 125.5 | 130,775 | 3508.5 | 5.6 |

streamingで一部クライアントのwrite/drainが本文完了前に停止し、待機中に128MiB全量がNode RSSへ積み上がる挙動は観測しなかった。client側の書込済みbytesはOS/socket/Docker側の待機分を含み、Nodeで消費済みのbytesではない。buffer値は20msサンプルのためbaselineの短い受信を取り逃す場合がある。比較中の進行段階が異なり、この表を同量処理時のRSS削減率とは扱わない。

確認内容（専用試験11件成功、skipなし、型チェック成功）:

- Content-Lengthあり／chunkedの正常JPEGで204・空bodyと保存bytesの完全一致。
- 不正・途中で終わるJPEGは400/invalid_image、513pxは400・abuseなし、Content-Type不正415、無効session401、IP BAN403を基準と比較。
- 32MiBちょうどはアプリ判定へ到達し、32MiB+1はContent-Length／chunkedとも413。Content-Lengthもchunkedもない空本文、DELETE、未対応メソッド、類似パスも従来応答。
- Authorization、地域/IP、URI/query、本文の保持。Memoriesとinternal画像パスも維持。
- 早期401、本文途中切断（nginx400）、デコード枠待ちの切断（499）、途中保存なし。試験だけの1秒body timeoutはnginx408を記録し、クライアントはECONNRESETを観測。続く正常アップロードは成功した。実設定のtimeoutは変えていない。
- 上流が応答前に切断した際、候補PUTは1回のみ到達して502。基準のPUTはkeepalive接続の失敗で2回到達した試行があり、候補の再送禁止を独立に確認。

遅い送信の退行は、JPEGDecoderが実行枠取得後に `arrayBuffer()` を読む現行設計による。buffering onではnginxが本文受信を終えてからアプリへ渡すが、offでは遅い受信そのものが枠を保持する。限定試験で待機本文全量のNode RSSへの蓄積は観測しなかったが、任意の同時数や長期運転の安全性を保証しない。

## 単独での反映・切戻し

共有環境への配置、reload、再起動、ベンチ、マージは未実施。本番効果はベンチ未実施。退行があるため通常の採用・反映は勧めない。追加比較を行う場合だけ、他の作業者と対象版をそろえ、このブランチ単独を評価する。投稿期間転送PRを重ねない。DDL不要。

```sh
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/asia-upload-streaming &&
DISCORD_WEBHOOK_URL= task status
ssh asia1 'sudo nginx -t && systemctl is-active nginx isureal-nodejs.service'
```

`task deploy` は全4台を指定ブランチへ反映し、enabledサービス再起動・DB再起動を含む。必要な計測を保全してから実行する。statusの4台のSHAがPR headと一致し、asia2のappもactiveであることを確認。PR本文のファイルhash照合と401疎通確認に続き、[ポータル](https://portal.isucon.net/contestant/benchmark_jobs) のEnqueueを1回押す。API実動作未確認のためCLIベンチは案内しない。`task bench` 自体にもデプロイがある。

単独試験の切戻しは、確認済み基準mainから別のrollbackブランチを作り、pushしてdeployする。固定SHAとコマンドはPR本文に記載する。DB操作は不要。rsyncは削除済みsnippetを実機から削除しないが、locationがなくなれば参照されない。

他方のPRがmainへ入った場合は最新mainを本ブランチへ取り込み、上の実試験を再実行してからpushする。本PRもマージ済みの状態から戻す場合は最新mainを起点に本PRだけをrevertし、他の変更を保持する。

提出中に更新されたmainの計測停止（#72）を両候補へ取り込み、再検証した。業務処理と比較対象のlocationは同じで、試験用計測だけをfixture内で有効にしている。本番の計測停止設定は維持する。最新のdeployは計測停止modeではpproteinを停止し、既存ログの切詰めを省く。
