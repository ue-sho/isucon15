# 海外の投稿作成を既存のDB近傍アプリへ転送する

2026-10-31。最新main `589f52d2ed9e2deb79dd4090c751771c310b706d` を含む、PR #58の `70e2c4094bbd8b14679f6f3afecc82d69be5b027` が基点。本PRは #58 に重ねた投稿経路だけの差分で、#58のベンチ後に追加比較する。

## 問題と変更

Europe/Americaのfriendsフィード・現在投稿・現在投稿期間・関係更新はasia1の地域別アプリへ転送されるが、`POST /api/posts` は地域内のアプリから共有DBへ複数回往復している。投稿は認証・入力/JPEG検証後、ユーザー行と投稿期間の共有ロック、投稿/削除回数、画像INSERT、投稿INSERT、COMMITを順に行う。リージョン間RTTが各往復に加わり、ロック保持時間にも通信待ちが入る。

europe1/america1のnginxに `location = /api/posts` を追加し、POSTだけを既存のregion対応アプリへ送る。

- Europeは既存の `asia1:8081`、Americaは `asia1:8082`。既存のupstream・keepalive・転送snippetを再利用する。
- POST以外は`limit_except`で従来のlocal APIへ送る。他の投稿更新/削除・画像・Memoriesなどの経路は変更しない。
- URI・multipart本文・認証・X-Client-IP・X-Country-Codeを維持する。画像/JPEG・権限・投稿枠・重複制限・永続化は既存の実ハンドラーで行う。
- `proxy_next_upstream off`により、失敗した書き込みを別アプリへ再試行しない。
- 新しいサービス・DB接続枠・依存・DDLは追加しない。既存の地域別アプリは各1 worker、pool2の設定を使用する。

通常投稿は、その期間が終わる前のfriendsフィード検証まで通ると通常10点/最終期間20点、Europe/Americaは1.5倍となる。HTTP201の件数を採点件数とは扱わない。

## 実nginx・実アプリの検証

`REGIONAL_POST_TEST=1 node --test test/regional-post-db.test.ts`。
隔離PG16、実サイト設定とsnippetを使うnginx:1.24、`newServer`によるAsia・海外local・海外nearアプリを使用する。本番env・外部DBは参照しない。

Europe/Americaについて、200KiBを超える実JPEGのmultipart、Unicode caption、保存画像と取得画像の全バイト、他地域のfriendsフィードと現在投稿への即時反映を確認した。未認証・不正token・地域違い・IP ban・不正JPEG、POST以外の405/OPTIONS/HEAD、同時投稿の201/409、upstream停止時の502と非再試行を確認し、7件成功。テストのbackend識別ヘッダーはテストserverだけが追加する。

## 代表画像による配置比較

`REGIONAL_POST_TEST=1 REGIONAL_POST_BENCH_RTT_MS=100 node --test test/regional-post-db.test.ts`。
追加比較を含め8件成功。Node26.12.1、PG16.13、同じMac、合成の512×512 JPEG（365941 B）、模擬RTT100ms、各1回warmup後4回。順序は交互、画像は同じバイト列を使う。

変更前は地域内アプリから遅延付きDB接続を使用。変更後は実nginxから遅延付きHTTPでnearアプリへ送る。**friendsフィードは既存mainの転送を反映し、変更前後とも同じnear経路を使う。**

| 指標（4回の平均） | 地域内アプリ＋remote SQL | nginxからnearアプリへPOST転送 |
|---|---:|---:|
| 投稿応答 | 998ms | 181ms |
| 直後のfriendsフィード確認 | 115ms | 110ms |
| 両経路を合計した模擬WANへの送信量 | 366976 B | 366994 B |
| 模擬WANからの受信量 | 3058 B | 1456 B |

画像は変更前もDBへ送るため、この条件では送信量はほぼ同じだった。全サンプルで画像の保存バイトと、friendsフィードに投稿が出ることを確認した。

模擬遅延はTCP chunkへ片道ずつ加える方式であり、本番ルーターや帯域制限、別ホストのCPU競合を再現したものではない。通信量は遅延proxyで実際に転送したバイト数。公式スコアへの効果は未確認。

## 採用判断・反映

asia1に投稿のJPEG・署名・リクエスト処理が集まる。pool2をfriends読み取りや関係更新と共有するため、asia1 CPU、対象サービスの待ち、投稿p95と期間内friends確認、Asiaの退行を実負荷で確認する。局所比較だけで採用を確定しない。

標準テスト・型チェック・diff確認の結果はPRへ記載する。デプロイ、共有DB変更、再起動、公式ベンチは実施していない。追加DDLは不要。切り戻しは2つのnginx locationをrevertして再反映するだけでよく、DBや画像の復元は不要。

`task deploy`で全ホストへ反映した後、`task status`とasia1の `isureal-nodejs-europe.service` / `isureal-nodejs-america.service` がactiveであることを確認し、ポータルでEnqueueする。スコアは同じmain・同じ条件と比較する。
