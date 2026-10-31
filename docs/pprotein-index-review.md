# #15226のスコア低下と索引の再評価

2026-10-31、ユーザー報告: ベンチ #15226、4322点。
関連: #18、PR #42。pproteinの終了済み計測のみを読み取り、SQLはexecute/statementを1回ずつ集計した。
rawログや実データはIssueへ転載しない。

## 比較条件

| | 前 | 後 |
|---|---|---|
| group | 2026-10-31_04-26-20.074603 | 2026-10-31_04-59-50.145572 |
| 日本時間 | 13:26:20〜13:28:20 | 13:59:50〜14:01:50 |
| 3アプリのHTTP計測SHA | ab01887 | f4247f3 |
| SQLログ | dmiqlwhm18cg-slowlog.log | dmirbjwjfe6b-slowlog.log |
| asia1 HTTP | dmiqlwhlmcyg-httplog.log | dmirbjwgvget-httplog.log |
| europe1 HTTP | dmiqlwhm3dbf-httplog.log | dmirbjwioa8j-httplog.log |
| america1 HTTP | dmiqlwhlural-httplog.log | dmirbjwihb9c-httplog.log |

**索引だけの比較ではない。** ab01887は画像ファイルキャッシュ＋X-Accel-Redirect配信を含むが、f4247f3はその実装を含まない。
コード差分に加え、SQLログで `NULL::bytea` を選択する画像キャッシュヒットが前124回/後0回、画像本体を選択する有効性照会が前719回/後846回と確認した。
ユーザーから画像書き出し中との情報もあった。調査中に長時間FETCHを観測したが、比較ログに完了したFETCHは記録されておらず、書き出しの正確な開始終了・ベンチ中のI/O/CPU寄与は未確定。

## 観測した時間

3台HTTPを合算。平均はステータス混在で、失敗理由別の値ではない。SSEの待機時間を通常APIの処理時間と混ぜない。

| 処理 | 前 | 後 |
|---|---:|---:|
| login HTTP平均 | 0.534秒 | 0.979秒 |
| profile-image HTTP平均 | 1.652秒 | 3.351秒 |
| posts HTTP平均 | 1.903秒 | 2.120秒 |
| 投稿成功数 | 172 | 134 |
| session認証SQL平均 | 0.062ms | 0.030ms |
| 投稿INSERT平均 | 0.940ms | 1.897ms |
| 投稿済み判定SQL平均 | 0.203ms | 0.193ms |
| 投稿枠件数SQL平均 | 0.165ms | 0.248ms |
| users全体ロック平均 | 783.645ms | 1106.889ms |
| 投稿枠FOR SHARE平均 | 1.832ms | 81.033ms |

投稿INSERTの追加費用は観測されたが、平均増は約0.96msであり、スコア低下全体を説明するとは断定しない。
users全体ロックは累計50.153→68.627秒、投稿枠FOR SHAREは累計0.317→11.669秒。並行処理の時間合算でありCPU時間ではない。
認証SQLは速くなってもHTTP loginは遅くなっており、索引以外の待ち・CPU・配信条件も切り分けが必要。

## 索引の扱い

読み取り時の累積idx_scan（作成後からの累積で、#15226だけの回数ではない）:

| 索引 | idx_scan |
|---|---:|
| login_sessions_active_token_idx | 2727 |
| posts_active_author_window_idx | 2560 |
| posts_active_image_author_idx | 1641 |
| posts_author_window_counts_idx | 18107 |
| follows_followee_updated_idx | 54 |

5本とも利用されている。未使用という理由で一括撤去しない。
ただし `posts_active_author_window_idx` は、同じ検索キーとdeleted_atを持つ `posts_author_window_counts_idx` で代用できる。
新規PG16の合成データで部分索引を撤去し、代替索引の利用、前後結果一致、active/deleted件数、再接続、snapshot/reset後の4索引維持、部分索引の復元と全撤去後の結果一致を確認した。
この重複部分索引1本（62MB）だけを本番撤去し、既存の4索引を維持した。容量と書込保守を減らすためであり、スコア回復を実証したわけではない。

通常のCONCURRENTLY撤去は他処理検知でDDL前に中止。続いて別対象FETCHのみ、postsの他接続ロックなしを確認できる場合に限定し、maintenance-up.sqlでACCESS EXCLUSIVE NOWAITを即時取得して通常DROPを実行した。読書きの待機を伴い得るが、即時ロック不可なら変更しない。DROPとCOMMITが成功。
撤去後に対象索引が存在せず、残り4本がvalid/ready=trueと確認した。
本番generic計画では、投稿済み判定がposts_author_window_counts_idxのIndex Only Scan、Memoriesが同索引のIndex Scanで取得可能。計画原本は手元 `/tmp/isu15-query-indexes-post-removal.json`。

## 現在の定義と手順

新規DB用001-schema.sqlの最終構成は4本。
既存DBで過去の適用手順を順に使う場合は、auth-post-lookup → api-lookup → drop-redundant-post-indexのup.sqlを実行する。
最後の撤去SQLは代替索引がvalid/readyであることを事前確認する。ロールバックはdrop-redundant-post-index.down.sqlで部分索引だけを復元できる。
古いスナップショットが残る場合は、対象表の利用と書込・計測がないことを確認したmaintenance-up手順を使う。通常デプロイからのDDL自動実行は追加しない。

画像書き出し終了後、同じ画像配信実装・同じ計測条件で再ベンチするのが次の比較。
今回、アプリのデプロイ・再起動・本番初期化・追加ベンチは実行していない。画像配信実装の統合もこの索引PRには含めない。
