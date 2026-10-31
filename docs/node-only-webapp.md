# webappをNode.js実装に整理

2026-10-31、Node.js以外の言語実装を削除する依頼に対応した。

- 削除対象: `webapp/go`、`webapp/perl`、`webapp/php`、`webapp/python`、`webapp/ruby`、`webapp/rust`（Git管理下の301ファイル）。
- 維持: `webapp/nodejs`、共通の`webapp/sql`・`webapp/public`・`webapp/AGENTS.md`。
- Node.jsのソース・依存・起動・初期化の処理は変更しない。`src/initialize.ts`が呼ぶ`../sql/init.sh`も維持する。
- `isutools`はPythonやGo等も使う運用ツールのため、削除対象に含めない。`Taskfile.yml`の`test:python`はこの運用ツールのテスト。
- 公式マニュアル・過去のinventoryに残る他言語の説明は当時の記録として維持する。PHP用nginx設定等の配布設定も今回の削除対象外。他言語のサービスや構成へ戻す場合は、対応する実装を履歴から復元する。

## 参照・復元

削除前の基点は `614a3c9`。実装を比較するときは[削除前のwebapp](https://github.com/ue-sho/isucon15/tree/614a3c9/webapp)を参照できる。

必要な言語だけ手元へ復元する例:

```sh
git restore --source=614a3c9 -- webapp/go
```

共有サーバー上の削除、サービス停止、デプロイ、初期化、ベンチはこの整理では実行しない。サーバーへ適用する場合は、デプロイ時にGit管理外の生成物や依存ディレクトリが残り得る点も別途確認する。

## 検証

- Node.js v26.12.1で`npm ci --ignore-scripts --no-audit --no-fund`、`npm run check`が成功。
- Node.jsのソース・依存定義・共通SQL・静的ファイル・運用ツールが基点から変更されていないことを確認。
- `ISUREAL_TEST_DATABASE=0`で既存テストを実行。削除前の`614a3c9`を一時ディレクトリへ展開した環境と削除後の両方で、82件中57成功・21失敗・4スキップ。失敗したテスト名もすべて一致。
- 21件は`test/page-response.test.ts:102`のHMAC呼出し回数の期待値に関する既存の失敗。今回の整理ではテストや署名処理を変更していない。
- 実DBを使う4テストと共有環境での動作・ベンチは未実施。
