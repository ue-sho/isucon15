# 不正ログインのトランザクション省略

実測・採否は [Issue #59](https://github.com/ue-sho/isucon15/issues/59) に記録する。
`perf/login-failure-roundtrips`、起点はmain `589f52d`。

`loginHandler`でロックなしの認証SELECTを先に実行し、不正な鍵・存在しない名前・退会済みユーザーはトランザクションを開始せず401にする。
失敗時はBEGIN・SELECT・ROLLBACKの3往復からSELECTの1往復になる。

事前SELECTは認証成功の根拠には使わない。成功候補には従来のトランザクションを実行し、鍵とactive条件をFOR NO KEY UPDATE付きで再確認する。
応答のユーザー情報もロック後の行から作成する。同時ログイン、退会、セッション置換の排他を維持する。
成功時は4往復から5往復へ増えるため、正常ログインだけの負荷には不利になり得る。
IP BANの403、ログ、DBスキーマ、キャッシュ、初期化、永続化は変更しない。

## ローカル再現

本番と独立した一時PostgreSQLを用意し、Node.js 26で実行する。
以下は接続先クラスタに新しいテストDBを作成する。既存DBの削除は行わない。

```sh
cd webapp/nodejs
npm run check
AUTH_PERMISSION_TEST_PG_PORT=56873 node --test test/auth-permission-db.test.ts test/login-precheck.test.ts
LOGIN_BENCH_PG_PORT=56873 node test/login-precheck.bench.ts
```

比較スクリプトはlocalhost直接接続と設定RTT5msのローカルプロキシで、成功のみ・失敗のみ・成功1/失敗2の混在を各3回計測する。
beforeは起点コミットのログイン処理。実行順を交互にし、実際のDB・応答生成・セッション置換を含める。
代理遅延はtimer等の付加費用を含み、本番RTTやスコアの推定ではない。

採用前に同じmainとの競技ベンチを比較し、200/401/403別の件数・時間、正常利用者の完了数を確認する。
候補実装時点では本番未反映。戻す場合はloginHandlerの事前SELECTを除去し、従来のTx内認証だけに戻す。
