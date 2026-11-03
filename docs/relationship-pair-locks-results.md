# ペアロック隔離実験の結果

2026-10-31、`research/relationship-pair-locks`。
開始時と提出前に取得・取り込み確認したmainは `993e1b0dd58d68d7b63e77bff26d046d2a0173b3`。
本番アプリ、DDL、サービス、共有DBを変更していない。候補は[設計書](relationship-pair-locks.md)の研究用コードのみ。

## 環境と再現方法

- Node v26.12.1、PostgreSQL 16.13（Debian 16.13-1.pgdg13+1）、READ COMMITTED。
- ローカルDocker `postgres:16`、実行image ID `sha256:71e27bf60b70bded003791b5573f8b808365613f341df20ffcf0c1ed7bc13ddf`。
  tagは可変なので別環境の結果にはそのimage ID/バージョンを記録する。
- 各実行専用コンテナ、tmpfs、loopbackの自動割当port、合成ユーザーA/B/C/D、既存schema。
  observerと独立した3セッションを用意。statement timeout 6秒、deadlock検出200ms。
- `node webapp/nodejs/research/relationship-pair-locks/run.mjs` で初期化・試験・専用コンテナ破棄まで行う。
  テストコード、seed、試作のロック処理はすべて同じPRに含む。生ログ、計測データ、認証情報は含めない。

最終検証は **99件成功、失敗0、skip 0**（Nodeの集計には親テスト5件を含み、個別ケースは94件）。
一度成功後、最新main取得・取り込み確認後に同じ99件を再実行して成功した。
設計上の不十分な案を「成功」とするケースは、その危険な挙動を期待どおり検出できたという意味。

## 確認した結果

| 条件 | 現行NKU | 候補S＋graph＋pair | 根拠 |
| --- | --- | --- | --- |
| A–B / A–C、両順序 | 共通Aで待機 | 先行が未commitのまま後続が書込・commit可能 | 現行は実blocker PIDとLock waitを観測。候補は最終friendship 2行も検査 |
| A–B / B–A、両順序 | 直列化 | 直列化 | 後続がpendingを再読取し、逆方向申請の承認でfriendship 1行・pending 0行 |
| block / 承認・申請・follow、両順序 | 直列化・状態整合 | 同左 | block先行なら拒否。後行ならfriend/follow除去・pending取消 |
| block / コメント・RealMoji、両順序 | 直列化・状態整合 | 同左 | 先行interactionは保存されるが、block後は実権限関数で閲覧拒否。block先行なら保存なし |
| 退会 / 関係変更、両順序 | active再検査 | 同左 | 退会先行なら関係作成拒否。関係先行なら関係は残り、退会が後続 |
| プロフィール変更 / interaction、両順序 | 直列化 | 同左 | region/display_nameの変更がusers Sと競合 |
| 対象投稿削除、viewer自身の投稿削除、公開範囲変更 / コメント、両順序 | 直列化・再検査 | 同左 | 変更先行なら実権限関数で拒否、コメント先行なら変更後も既存行は保持 |
| 申請の拒否/取消 vs 承認、両順序 | 先行遷移だけ成功 | 同左 | terminal statusを上書きせず、friendship件数も確認 |
| 友達解除 vs friends投稿へのコメント、両順序 | 直列化 | 同左 | 解除先行ならコメント拒否 |
| unfollow vs block、unblock vs follow、両順序 | 直列化 | 同左 | 先行処理に応じた行数・成功可否。unblock後も削除済み関係を復元しない |
| RealMoji置換同士、両順序 | active一件 | 同左 | 2回成功、旧一件がreplaced・現行一件 |
| FoF A–C–BのA–CまたはB–C解除 vs 権限判定、両順序 | 直列化 | graph排他により直列化 | 解除先行は閲覧拒否。判定先行は解除が待機。FoF-onlyコメントは拒否 |

### 不十分な案と故障時の挙動

| 実験 | 観測・判断 |
| --- | --- |
| users S＋A/B pairのみ、graphなし | FoFを許可したTxが未終了でもA–C/B–Cを削除でき、同じTxで再読取すると許可が消える。解除先行でも未commit中の古い辺を読める。両辺・両順序で再現。採用不可 |
| users KEY SHARE | statusをdeletedへUPDATEしてcommitでき、その後に関係INSERTもcommitできた。FKはactive状態を保証しない。採用不可 |
| 複数pairを逆順取得する故障例 | 先行wait edgeを観測後に循環を作り、PGの`40P01` deadlockを検出。テストが競合を実際に起こせることを確認 |
| 候補の複数pair、逆順の入力 | hash後の取得順を統一して直列化、3行INSERT後に後続で3行DELETE。失敗なし |
| 複数pair更新・FoF RealMoji・blockの3セッション | 観測済み待機を挟んで完了。A–Bはblockで除去、A–Cは保持。取得順を逆入力にしても同じ整合性 |
| hashを強制衝突 | A–BとC–Dが余分に待つが、両関係を正しく保存。排他は失われない |
| unique違反・rollback、存在しないuser | 部分書込なし、advisory lock残存0、次の取得とusers更新が成功 |
| COMMIT / SAVEPOINT rollback | transaction advisoryの解放と別セッションの取得成功を確認。session lockは不使用 |

## その他の検証と限界

- `npm exec tsc -- -p research/relationship-pair-locks/tsconfig.json`: 成功。
- `npm run check`: 成功。
- `node --test test/relationship-api.test.ts test/post-window-lock.test.ts`: 13成功、失敗0、1 skip。
  skipは既存のpost-window DB試験で、専用の実行フラグを設定していないため。今回の隔離99件とは別。
- 作成途中にrunnerの初期待機（Unix socketの一時PG）、schema相対パス、prepared statementへの複文、合成署名キー形式の不備で失敗した。
  それぞれTCP readiness、パス修正、schemaだけsimple query、正しい長さの合成hashへ修正して再実行した。失敗を候補方式の性能結果として扱っていない。

これは同時実行スケジュールと状態遷移の局所実験であり、所要時間を競技処理の短縮率へ換算しない。
CPU負荷、HTTP応答時間、全経路の入力/認証/地域/署名/abuse、完全なハンドラー、初期化・再起動、
混在旧版、多接続の長時間負荷は未検証。deadlock検出例以外の全実行にdeadlockが存在しないという証明でもない。
投稿期間切替の同期や中間ユーザー退会の扱いは現行の権限条件をそのまま使い、本案だけで強化したとはしない。

判定: **設計候補として保持し、本実装・公式ベンチは保留**。
A/C採用後の実blocker/waiter、保持時間、地域別HTTP、deadlock/graph待ち、全体scoreを再評価してから判断する。
