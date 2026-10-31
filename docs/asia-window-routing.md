# Asiaの投稿期間GETを既存asia2アプリへ分離

Asiaの完全一致 `GET /api/posting-window/current` だけを、既存Memories upstream（192.168.4.10:8080、region=asia）へ渡す。実nginxと現行Honoで基準との応答一致を確認したが、本番ベンチは未実施で、採用判断は保留する。

## 基準・変更理由

基準mainは `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`、独立ブランチは `perf/asia-window-routing`。画像アップロードの変更は含まない。

[調査記録](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540905647) のベンチ27678（計測版589f52d）では当該GETはAsia96件・平均743ms・p95 3124ms、Europe平均124ms、America平均135ms。対応SQLの全地域平均は0.198msだった。HTTP時間からNode実行待ち・pool待ちの内訳は特定できない。重い処理と実行場所を分ける仮説であり、SQLが短いことだけでは効果を保証しない。

既存asia2サービスを読み取り確認し、active/running、region=asia、port8080、worker1、DB pool2、DB host127.0.0.1だった。新しいサービス・worker・接続数は追加しない。MemoriesのSQL改善は取り込んでいない。asia2はMemoriesとDBを担うため、転送先が常に空いているとは扱わない。

完全一致location内のGETだけをnamed locationへ内部遷移し、既存 `isureal-memories-api.conf` snippetのHTTP/1.1・keepalive・ヘッダー・応答バッファ・再送禁止をそのまま利用する。HEADを含むGET以外は従来のlocal APIと再送設定を維持する。URI/queryとAuthorization・X-Client-IP・X-Country-Codeを変更せず、認証・地域・IP BANは現行アプリが判定する。レスポンスキャッシュはない。

投稿POST、期間開始POST、通知、他GET、既存Memories・画像配信、Europe/America、アプリ処理、DBスキーマ、サービス設定は変更しない。

## 再現方法・実測

Node v26.12.1、既存lockfileのHono 4.13.14 / adapter 2.1.5、Docker nginx1.24、隔離PostgreSQL16。試験が空の専用DBを作って現行schemaと合成データを入れ、終了時にコンテナを破棄する。共有DB、実データ、env.shは使わない。

```sh
cd webapp/nodejs
npm ci --no-audit --no-fund
ASIA_WINDOW_TEST=1 node --test test/asia-window-routing/routing.test.ts
npm run check
```

同じアプリ版の独立Nodeプロセス2本（各pool2）に対し、基準mainと候補のnginx siteを実行する。fixtureのecho/切断分岐は経路・再送確認用で、業務応答試験は実newServer・現行middleware・ハンドラー・DBを通る。

4クライアント（当該GET×2、Memories×2）、各10回、1回warmup後のABBA。同時実行試験は画像試験と重ねず直列実施した。

| 順序 | GET平均 / p95 ms | Memories平均 / p95 ms | local / asia2 Node CPU ms | local / asia2 最大RSS MiB |
|---|---:|---:|---:|---:|
| baseline | 2.31 / 3.84 | 3.96 / 5.58 | 12.00 / 31.63 | 118.6 / 136.7 |
| routing | 2.48 / 3.90 | 3.92 / 5.33 | 0.28 / 28.25 | 118.6 / 137.0 |
| routing | 2.05 / 2.78 | 3.72 / 5.00 | 0.26 / 25.08 | 118.6 / 137.1 |
| baseline | 2.49 / 5.05 | 3.90 / 7.48 | 10.02 / 20.47 | 109.9 / 137.2 |

当該GET平均は基準2.31–2.49ms、転送2.05–2.48msで差は小さい。Memoriesも基準3.90–3.96ms、転送3.72–3.92ms。安定した性能向上を示す結果ではなく、本番の待機隔離効果・MemoriesやDBへの悪影響は未確認。

専用試験7件成功・skipなし、型チェック成功。検証内容:

- 完全一致GETだけasia2。HEAD/POST/PUT/DELETE/PATCH/OPTIONS、末尾slash・子パス・類似パスは従来経路・status/body/Allow。投稿・期間開始・通知・画像・Memoriesの既存経路も確認。
- URI/queryのescapeと重複パラメータ、Host、Authorization、地域/IP、POST本文を保持。
- 無効形式・存在しない・失効session、地域不一致、IP BANのstatus/bodyが基準と一致。
- 期間なし、開始前／開始後、投稿済み、削除0/1/2回、切替のcommit前後でJSON一致。未commitの次期間を先取りせず、commit後すぐ次期間を返す。
- 上流切断は1回のみ到達して502。asia2停止時も502でasia1へfallbackせず、他メソッドはasia1で従来応答。
- 現行Memoriesと当該GETを同時に実行し、双方の遅延と各NodeのCPU/RSSを計測。Memoriesのハンドラー・SQLは変更していない。

ローカルの同一Mac上の比較で、WAN、実機CPU飽和、公式データ規模、他地域からのDB負荷を再現していない。Memoriesは単一合成ユーザー・50投稿/50画像を反復し、署名cacheはwarm。CPU値はNode2本だけでDB/nginxを含まず、RSSは20msサンプル最大値。GCや実行順の揺れもあり、これを本番改善率や得点へ換算しない。

## 単独での反映・切戻し

共有環境への配置、reload、再起動、ベンチ、マージは未実施。DB変更なし。画像ストリーミングPRは重ねず、同じmain基準とこのブランチ単独を比較する。

```sh
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/asia-window-routing &&
DISCORD_WEBHOOK_URL= task status
ssh asia1 'sudo nginx -t && systemctl is-active nginx isureal-nodejs.service'
ssh asia2 'systemctl is-active isureal-nodejs.service'
```

`task deploy` は指定ブランチを全4台へ反映し、enabledサービス再起動・DB再起動・ログ切詰めも行うため、計測保全と反映順を調整する。statusの4台のSHAがPR headに一致し、asia2のappもactiveであることを確認する。PR本文のhash照合と401疎通確認後、[ポータル](https://portal.isucon.net/contestant/benchmark_jobs) でEnqueueを1回実行。API実動作は未確認なので `task bench` は案内しない（同コマンドにもデプロイがある）。

公式比較では当該GETとMemories双方の件数・p95・エラー、asia1/asia2の実worker CPU/RSS、DB負荷、投稿/通知の退行と総点を確認する。単独のSQL時間や軽負荷の応答短縮だけで採用しない。

切戻しはPR headから別のrollbackブランチを作り、本PR実装コミットだけをrevert・pushしてdeployする。SHAと具体的コマンドはPR本文に掲載。DB操作やasia2停止は不要。unused snippetが実機に残っても参照されない。他方がmainへ入ったら最新mainを本ブランチへ取り込み実試験を再実行する。本PRもmainへ入った後の切戻しは最新mainから本PRだけをrevertし、既存Memories・画像・他変更を維持する。
