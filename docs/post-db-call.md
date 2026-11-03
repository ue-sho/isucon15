# 投稿作成のDB往復とロック保持時間を減らす

基点・提出直前にfetch/mergeで確認したmain: `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`（更新なし）。取り込み確認後も型チェック・標準テスト・隔離PG投稿試験を再実行した。関連: [Issue #11](https://github.com/ue-sho/isucon15/issues/11#issuecomment-6540744615)。

ここにある初回の局所計測とベンチ31590は初版 `e752f2c` の結果。追加した投稿準備の実行順制御と混雑再現の結果は [投稿とfriends feedの裾の遅延](post-db-call-fairness.md) を参照。追加版の共有環境ベンチは未実施。

## 変更理由と採時の制約

ベンチ27678は計測版 `589f52d`、7361点、Passed。投稿成功182件のBEGIN〜COMMIT平均967.62ms、SQL実行ログ合計平均18.91ms、ユーザーロックSELECT完了〜COMMIT平均813.43msという観測がある。SQL間には通信、Nodeの実行待ち、スケジューリング等が含まれる。差分全量を削減可能時間とは扱わない。この結果は開始時mainや現在のデプロイの計測ではない。

第一候補の「専用VOLATILE関数をautocommitで1回呼び、保存まで終える」方式は採用していない。旧ハンドラーはユーザーロック・期間取得・件数確認の**後**にアプリの `now()` を呼ぶ。通常のDB関数には、その途中でNodeプロセスの時計を呼び戻す手段がない。先に渡した時刻、DBの `clock_timestamp()`、アプリとDBの推定時差による補正はこの契約と等価ではない。

[当日マニュアル](manual-2026-10-31.md)は `onTimeDeadline` 以下を時間内、期限後の経過秒を切捨てて `lateSeconds` とするが、時計の置換や採時点の前倒しの根拠にはならない。今回は意味を維持して次の4往復にする。

| アプリ→DBの呼出し | 旧版 | 変更後 |
|---|---|---|
| トランザクション開始 | BEGIN | BEGIN |
| 投稿準備 | usersロック、期間ロック、件数確認の3往復 | `isureal_prepare_post` の1往復 |
| アプリ採時 | `now()`、投稿枠判定 | 同じ順序と時計 |
| 保存 | 画像INSERT、投稿INSERTの2往復 | 画像→投稿の依存を持つCTEの1往復 |
| 終了 | COMMIT | COMMIT |
| 通常成功時合計 | **7** | **4** |

期間の再読取が必要なとき、旧版は8往復、変更後は関数内部で再読取するので4往復。認証・接続確立はこの数に含めない。DB内部のロック・検査自体を省略する変更ではない。

**外側のBEGIN/COMMITと、採時・保存呼出し・COMMITまでのアプリ待ちは残る。** autocommit化を達成したと主張しない。JPEG・署名・nginx・feed・関係ロックの共通helperは変更しない。

## 保つ契約

- `users` のactive条件つき `FOR NO KEY UPDATE` で、同時投稿・削除・地域変更・退会を直列化する。認証時のユーザーを再利用せず、ロック後の現在のregionを使う。
- `posting_windows` の現在期間を `FOR SHARE` で保持し、期間終了のUPDATEをCOMMITまで待たせる。投稿同士の共有は維持する。
- 待った期間が終了していたら、別のSQL文でもう一度検索する。件数確認もロック文と別のSQL文で実行する。
- [PG16のVOLATILE関数](https://www.postgresql.org/docs/16/xfunc-volatility.html)は内部の各SQLに新しいsnapshotを取る。[Read Committed](https://www.postgresql.org/docs/16/transaction-iso.html)を前提とし、ロックと件数を同じCTEへ押し込まない。より強い分離レベルへ変更する場合は別途検証が必要。
- 同一ユーザー・同一local_dateのactive件数、地域をまたぐ削除2回の上限を同じ条件で確認する。未来のstarts_atは409のまま。
- 画像bytes、caption、visibility、位置情報、投稿者・期間を保持する。画像created_atと投稿posted_atには同じアプリ時刻を渡す。画像RETURNINGに投稿INSERTを依存させ、エラー時にはトランザクション全体をrollbackする。
- 400 `invalid_post`、409 `post_slot_unavailable` と既存のエラー経路を保持する。認証後に退会が先にcommitした場合の `must()` / NoRowsError（500）も旧版どおり。ここを別のエラーへ直す変更は含めない。
- `newPostResponse`、署名、onTimeの境界（期限と同時を含む）、lateSecondsの計算は変更しない。

関数は `SECURITY INVOKER`、固定search_pathで、動的SQL・追加依存・常設接続・データ移行を持たない。使うのは投稿作成だけ。

## 実PostgreSQLでの確認

2026-10-31、Node v26.12.1 / PostgreSQL 16.13、MacのDocker、READ COMMITTED、合成ユーザー・画像のみ。専用コンテナを127.0.0.1の動的ポートに公開し、終了時に停止する。本番設定・データ・ログを使用しない。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-post-db-call/webapp/nodejs
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
POST_WINDOW_LOCK_TEST=1 node --test test/post-window-lock.test.ts
```

- 型チェック成功。標準テスト116件: 102成功、14スキップ、失敗0。
- 投稿・期間ロックの隔離PG試験28件: 全成功（親テストを含む）。ロック待ちは `pg_blocking_pids` / `pg_locks` で実際のblockerを確認してから解放する。
- 同時投稿、投稿削除、地域変更、退会、期間切替の両順序。期間切替先行では、最初の期間SELECTがロック待ちした後に終了行を除外し、新しい期間を取り直すことを確認。次の期間終了を止め、別ユーザー投稿は進むことも確認。
- 同日投稿・削除上限の地域移動後の維持、ユーザー不在・期間不在・未来期間、異なるユーザーの同時成功、保存中の外部不可視性、friends feedへの即時反映。
- 画像保存後に投稿INSERTを実DB triggerで失敗させ、画像・投稿がどちらも残らず、次の投稿が成功することを確認。
- 3公開範囲×3位置指定の保存値と画像全bytesを旧版と比較。アプリ時計をprepare完了後に進め、採時の順序、期限同時・1µs後・999999µs後・1秒後・2秒超を確認。
- migration再適用、`003-initial-snapshot.sql`→投稿→`reset.sql`→再投稿、テーブル再作成後の呼出し、down後の旧ハンドラー、up復帰を確認。非superuserの権限でも関数を呼び出せる。関数に独自の初期化状態はない。

認証・権限および3地域アプリは以下で別途確認（7件成功、432通りの権限比較を含む）。使うDBはこのコマンドで作成する空DBだけ。

```sh
test_container="isucon15-post-db-call-integration-$RANDOM"
docker run -d --rm --name "$test_container" --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=isureal_regional_api_test postgres:16 >/dev/null || exit
trap 'docker stop --time 1 "$test_container" >/dev/null' EXIT
for attempt in {1..60}; do
  docker exec "$test_container" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.1
done
test_port=$(docker port "$test_container" 5432/tcp | awk -F: '{print $NF}')
AUTH_PERMISSION_TEST_PG_PORT="$test_port" REGIONAL_API_TEST_PG_PORT="$test_port" \
  node --test test/auth-permission-db.test.ts test/regional-api-db.test.ts
```

### 旧版との局所比較

旧作成ハンドラーはmain `993e1b0` からテスト専用fixtureへ保存し、両方が同じJPEG検証・レスポンス生成を使う。Honoのin-processリクエストで比較する。各モード1回warmup後、旧→新→新→旧を2巡、各4サンプル。同じDB・画像・投稿者を使い、各回の後に合成データを消す。

テストだけで、ユーザーロック直後に計測行を1行保存する。旧版はmaterializedユーザーロック結果に依存する計測INSERT、変更後は関数内のロックSELECT直後のINSERT。DBの `transaction_timestamp()`〜`pg_xact_commit_timestamp()` と、ロック直後のDB時刻〜commitを測る。`track_commit_timestamp=on` は隔離コンテナだけ。観測用backend PID取得も両版に同じ1往復あるが、7/4の本体呼出し数には含めない。計測用SQLの負担を含む。

| SQL戻りごとの追加待ち | 版 | 本体往復 | DB Tx平均ms | ユーザーロック直後〜commit平均ms | Honoリクエスト平均ms |
|---|---|---:|---:|---:|---:|
| 0ms | 旧 | 7 | 1.766 | 1.283 | 3.046 |
| 0ms | 新 | 4 | 1.087 | 0.628 | 2.289 |
| 30ms | 旧 | 7 | 198.796 | 164.828 | 236.005 |
| 30ms | 新 | 4 | 98.727 | 65.741 | 134.119 |

追加待ちは各アプリ側SQL完了後のタイマーで、通信RTTやCPU競合の完全な再現ではない。ロック保持時間の起点も27678のログ集計（SELECT完了）とは異なる。この小さいローカル計測は削減構造の確認であり、本番HTTP時間・CPU時間・SQL累積時間・競技得点の改善率には換算しない。PR62の転送や署名/JPEG改善後は待ちの内訳が変わり、効果を加算できない。

## DB適用・デプロイ・ベンチ

共有環境の操作は未実施。ユーザーが実施順を調整し、前回の必要なログを保存してから行う。

`Taskfile.yml` / `isutools/lib/controller.py` / `remote.py` を確認した。`task deploy` はpush済み版をasia1/europe1/america1/asia2へ反映し、依存導入、設定されたビルド、対象ホストで有効なDB・nginx・アプリ等の再起動、計測ログのtruncateを含む。今回BUILD_CMDは空で、NodeはTS直接実行。専用ビルド・依存追加は不要。migrationの自動適用はない。

1. **アプリ更新より先に**asia2の `isureal` DBへ関数を適用する。既存関数があれば定義を確認し、一致する適用済みmigrationは再実行しない。不一致なら別作業との重複を調べてから進める。

```sh
cd /Users/yk/Documents/private/isu-con/isucon15-post-db-call
git switch perf/post-db-call

ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' <<'SQL'
SELECT p.oid::regprocedure, p.provolatile, p.prosecdef, p.proconfig,
       md5(p.prosrc) AS body_md5,
       has_function_privilege('isureal', p.oid, 'EXECUTE') AS app_can_execute
FROM pg_proc p WHERE p.oid = to_regprocedure('public.isureal_prepare_post(text)');
SQL

# 上の結果が0行（未適用）のときだけ実行
ssh asia2 'sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d isureal' \
  < webapp/sql/migrations/20261031-post-db-call.up.sql
```

適用後に同じ確認SQLを再実行する。期待は `provolatile=v` / `prosecdef=f` / `search_path=public, pg_temp` / `app_can_execute=t` / body_md5=`f8e8866296d58a830c04d8bb5385f562`。実環境のDB名・ロール権限と関数の適用状態は未確認なので、異なる場合はそのままデプロイしない。

2. デプロイと確認（`DISCORD_WEBHOOK_URL=` はconfig読み込み後も空値を優先するため、外部通知を送らない）。asia1の補助2サービスは `PartOf=isureal-nodejs.service` で本体再起動へ追従する。

```sh
DISCORD_WEBHOOK_URL= task deploy BRANCH=perf/post-db-call &&
DISCORD_WEBHOOK_URL= task status
ssh asia1 'systemctl is-active isureal-nodejs.service isureal-nodejs-europe.service isureal-nodejs-america.service'
```

全4台のcheckoutがPR headに一致し、各ホストで有効なサービスとasia1の本体・補助2サービスがactive、deploy lockが残っていないことを確認する。`task status` だけでは実際の応答や関数定義の確認は代用できない。

3. ポータルAPI認証・起動の動作はこの作業では未確認。[ベンチ一覧](https://portal.isucon.net/contestant/benchmark_jobs)で **Enqueue** を押す。`task bench` はデプロイを内包するため、この手順へ追加しない。

ベンチではPassed/messages、地域別投稿の201/409/5xxとp95、期間内friends確認、期間切替・関係更新の待ち、DB接続待ち・CPU、他経路の退行を比較する。旧版と同じ条件のDB Tx・ロック保持時間も再確認する。本番得点への効果は未確認。

## 切戻し

先に旧ハンドラーを含む採用ブランチを全アプリへ再デプロイする。追加関数は旧版から呼ばれないので、そのまま残してもよい。全プロセスが旧版に戻ったことを確認してから、必要なら `20261031-post-db-call.down.sql` を同じpsql経路で適用する。関数を先に消すと新版の投稿が失敗する。データ・索引の変更やバックフィルはない。
