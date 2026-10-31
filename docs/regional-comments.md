# Europe/Americaのコメント作成をDB近傍へ転送する

2026-10-31。ブランチ `perf/regional-comments`。起点・取り込み済みmainは
`993e1b0dd58d68d7b63e77bff26d046d2a0173b3`。

## 根拠と変更

[Issue #11の追加調査](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540744615)の
対象はベンチ27678、7361点、Passed、計測版 `589f52d2ed9e2deb79dd4090c751771c310b706d`。
POST commentsのHTTP応答はEurope 11件・平均1.055秒、America 12件・平均1.149秒だった。
コメントの完了Tx 23件では、BEGIN〜COMMIT平均750.97ms、SQL実行ログ合計の平均37.56ms、
最初のユーザー行ロック取得完了〜COMMIT平均631.78msだった。
これらは異なる計測範囲であり、差の全量をWAN待ち・CPU時間・削減可能時間とは判断しない。
開始時のmainや現在のデプロイ状態に、このベンチの得点を対応させない。

変更はeurope1/america1のnginxに各1つのlocationを追加するだけ。
`POST /api/posts/:postId/comments` を既存のregional upstreamへ送る。

| 入口 | 転送先 | アプリの地域 |
| --- | --- | --- |
| europe1 | asia1 `192.168.1.10:8081` | europe |
| america1 | asia1 `192.168.1.10:8082` | america |

認証・投稿取得・権限確認・ユーザー行ロック・コメントINSERT・COMMITは既存実装のまま。
海外アプリからSQLごとに往復する経路を、HTTP転送とDB近傍のSQL処理へ変える仮説である。
共有DB、補助worker数、pool上限2、通知、署名、abuse判定の変更はない。

既存のregional snippetがURI・query・body・Authorization・X-Client-IP・X-Country-Codeを維持する。
Hostは既存どおり `$host`。ユーザー地域はsessionのDB情報とworkerの地域で判定し、外部ヘッダーで上書きしない。
`proxy_next_upstream off` を継承し、書込の自動再送・localへのfallbackをしない。
GET/HEAD/DELETE等、末尾slash、追加のpath要素、RealMoji、その他のAPIは従来の経路。
既存のlogin・関係更新・friends feed等のlocationも維持する。

開始時にPR #63はマージ済み、#58/#64は未マージ、#57は未マージでクローズ、#62は退行によりDraftで採用対象外だった。
#62の投稿作成転送は取り込んでいない。コメントはJPEG検証を移送しないが、同じ補助workerへのCPU集中リスクは残る。

## 検証と再現

Node.js 26.12.1、実nginx 1.24、隔離PostgreSQL 16を使用する。
追加依存はない。Dockerは手元の試験だけに使用する。
`REGIONAL_COMMENTS_TEST=1` がない通常の実行では専用統合試験をskipする。
専用試験はランダム名の一時PGコンテナ・tmpfs・合成データを作り、終了時に自分のコンテナだけ破棄する。
実サービスのDB接続情報や外部DB URLは受け付けない。

```sh
cd webapp/nodejs
npm ci --no-audit --no-fund
npm run check
REGIONAL_COMMENTS_TEST=1 REGIONAL_COMMENTS_RTT_MS=100 \
  node --test --test-concurrency=1 test/regional-comments.test.ts
cd ../..
ISUTOOLS_NGINX_PROXY_TEST=1 python3 -m unittest discover \
  -s isutools/tests -p test_regional_api_proxy.py -v
```

- 型チェック成功。
- コメント専用試験7件成功・失敗0・skip0（親とsubtestを含む）。
- 既存nginx回帰試験2件成功。3台の完全設定の `nginx -t` と既存regional APIの経路を確認。
- 両地域でPOSTだけの転送、GET/HEAD/DELETE/PUT/PATCH/OPTIONSのlocal経路、URIのescape・重複query、
  20KB超のUnicode JSON本文、Authorization、国コード、IP情報の維持を確認。
- 試験内だけ予備upstreamと `error timeout http_503 non_idempotent` を設定し、
  backend受信後の切断は502、503はそのまま503になり、いずれも送信は1回で予備/localへ流れないことを確認。
- `newServer` と実session/region/IPBan middleware、実DBで、通常の友達・自己投稿、権限なし、未投稿、
  双方向block、投稿者退会、投稿期間終了、不正/無効session、session保持中の退会、地域不一致、IP BANを確認。
- 旧新のHTTP status/bodyは一致。成功応答の生成IDとDB採時だけを比較時に正規化し、本文・authorは一致する。
  保存行の本文・投稿ID・authorを照合し、成功ごとに1行、拒否時0行を確認。
  成功直後のコメントGETも旧新経路で一致し、書いたコメントを即時取得できる。

## 模擬RTTの比較

双方とも実nginxを通す。旧版は今回追加したlocationだけを除去したsiteを使用し、
海外相当のNode→PGのTCPデータ配送に片道50msずつ加える。
新版はnginx→DB近傍NodeのHTTP接続に同じ遅延を加え、Node→PGは直接接続する。
既存regional APIの設定は両方に残す。DBは同じ、poolは両方2、同時実行数1、本文は同じUnicode JSON。
各方式1回のwarmup後にABBA ABBAで各4回。接続・prepared statementの初回処理をwarmupで除外する。

| 地域 | 旧経路のHTTP応答平均 | 新経路のHTTP応答平均 |
| --- | ---: | ---: |
| Europe | 1146ms | 116ms |
| America | 1143ms | 117ms |

main取り込み確認後の最終試験の値。旧/新の標本はEurope `[1148,1142,1153,1140]` / `[117,112,116,118]` ms、
America `[1141,1130,1149,1150]` / `[117,114,119,117]` ms。
全リクエスト201を確認した局所測定。TCPチャンク配送の遅延モデルであり、実WANの帯域制限・輻輳、
asia1のCPU競合、他APIとの並列負荷、補助workerのpool待ちを再現していない。
SQL実行累積時間・CPU時間・トランザクションのロック保持時間・競技得点を測った値ではない。
23件の観測から大幅な得点増は約束できず、本番の効果は未確認。Node全体テストは未実施。

## 本番での判断と切り戻し

追加DDL・DB設定変更・新しいビルド手順は不要。既存のデプロイでnginx設定検査とサービス反映を行う。
本変更の共有環境へのデプロイ・再起動・ベンチは未実施。
PRイベントからデプロイする既存CIを起動しないため、提出コミットには `[skip ci]` を付ける。

本番比較では地域別commentsの成功数・status・平均/p95と、Tx/ユーザー行ロック保持時間を確認する。
同時にasia1補助workerのCPU・pool待ち、friends feedの完了数/遅延、投稿・期間終了処理、502/503/timeout、
総スコア・Passed・messagesを照合する。補助workerは既存のfriends feed・関係更新・loginと資源を共有する。
pprofがcluster親だけの場合は補助workerのCPU証拠として扱わない。

切り戻しは本PRの2つのコメントlocationだけを除去し、nginx設定検査後に反映する。
既存のlogin・関係更新・フィードの経路は維持する。DB・キャッシュの復元は不要。
