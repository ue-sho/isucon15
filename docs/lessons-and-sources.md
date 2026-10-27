# 練習と公開実践からの知見

確認日：2026-10-27。目的は、既存のチームの仕組みを生かし、AIも含めた本番の改善サイクルを速くすることです。以下の適用方針を[本番の運用](competition-workflow.md)とAGENTS.mdへ反映しました。操作の実装・通し確認はIssue #1で進めます。

## ISUCON14で既にあるものと補う部分

参照したリポジトリのmasterは `cf638131af13434ddec779c410c078a18652ea28`。以下はコード・記録を読んだ結果で、今回サーバー操作や再ベンチはしていません。

| 根拠 | 確認したこと | 引き継ぐこと・補うこと |
| --- | --- | --- |
| [Taskfile.yml](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/Taskfile.yml) | ソースと設定を配置・検査してサービスを再起動する。`bench` はログ退避後に `bench.py` を呼ぶ | 新しく同等品を作り直さず、接続先・配置先・サービス・言語・ベンチ受付を差し替える。設定反映にも再起動が含まれる副作用を明記する |
| [ログ退避](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/scripts/rotate-analysis-logs.sh) | ログを日時付きで移し、nginx再オープンとMySQLのslow log再オープンを行う | 既存の退避を生かし、試行ID・開始終了・退避先を対応させる。「現在のログ全体」という文言だけで混在と決めない |
| [bench.py](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/scripts/bench.py)、[Discord集計](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/scripts/report_discord.py) | 結果・ログ・alp・SQL集計を通知する。Webhook未設定では通知を省く。これらの処理内に試行ごとの永続保存・稼働版照合・環境ロックはない | まず原本を保存し、通知には要点と詳細先を載せる。エラー内訳も残し、反映から採取まで同じロックで管理する。通知失敗時に秘密URLを出さない既存の配慮を保つ |
| [アプリ負荷の改善記録](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/docs/perf-app-load.md) | 変更前だけpt-query-digestが重なり、スコア差をログ停止だけの効果と判断できないと記録されている | 解析を負荷走行から外し、並行作業を記録する。初期化後にも索引を再現する |
| [通知SSEの設計・検証記録](https://github.com/ue-sho/isucon14/blob/cf638131af13434ddec779c410c078a18652ea28/docs/design-notification-sse.md) | ローカル動作確認とs1の性能比較を区別。SSEの接続時間は従来レスポンスの時間と直接比較できない | 動作確認・稼働反映・得点効果を別に記す。仕様に合う指標を選ぶ |

Discordの共有記録には、残ったslow logを反映の問題と読み違えた例、pass=trueでもエラーのある通知、理由を理解しながらAIを使うという方針がありました。10月24日の議事録も現状の設定をGit管理して反映する方針と整合します。議事録は一部のみ・音声未照合のため、担当名や完了状態は補いません。認証値・連絡先・会話原文は転載していません。

## private-isuで実測したこと

2026-10-25のローカルDocker実験に基づきます。app・MySQL各1 CPU／1 GiBで、詳細はprivate-isuの `docs/autonomous-practice-20261025.md`（ローカルコミット `89cee7f`、未push）に保存しています。本番での改善率を示すものではありません。

| 観測 | 本番へ持ち込む判断 |
| --- | --- |
| 固定20投稿のSQLを121→5回へ削減。総合点は変動した | 呼出し回数・HTTP・SQL・総合点を分け、最高点1回だけで採否を決めない |
| プロフィール用の索引追加でトップ・一覧のJOINも変わり、対策が必要になった | 上位の別経路も確認し、アプリとDBの依存する変更を一組で記録・反映する |
| キャッシュで負荷が移り内部接続が枯渇。pass=trueでも大量の失敗が出た | 成功判定だけで終えず、エラーと次の資源制約を確認する |
| ログOFFではSQL時間が未観測。ソース以外に生成JS・全テンプレート・設定・実索引も照合した | 欠損を0で埋めず、観測条件と実際の稼働物を試行に対応させる |

## AIを使った公開実践と事前整備の例

別大会・別環境の参加者の報告です。手法の候補として読み、このチームの運用では個別に検証します。

| 資料 | 参考にする点 | 適用する範囲 |
| --- | --- | --- |
| [mazrean：ISUNARABE合同演習2026](https://zenn.dev/mazrean/articles/27fc724fde1b88) | Go前提の環境整備、実装が二重に存在してAIが迷う問題、分析メモの出力・セッション間の往復による時間消費を報告 | 編集・ビルド・反映の対象を一本化。観測ツールの上位だけに偏らず仕様・コード・SQLも照合し、短い引き継ぎにする |
| [trasta：CodexでのISUNARABE実践](https://trasta.dev/blog/20260509) | ログ解析とベンチループをSkillへ分離。大きいログを一括保持する解析も修正したと報告 | ベンチ受付と解析を分け、大きい原本を必要な範囲・集計で読む。他大会の受付API・Cookie方式を流用しない |
| [ichyo：ISUNARABEでの準備](https://blog.ichyo.jp/posts/isunarabe2026) | 本人の準備節で、コード・設定をrepository経由で反映し、成果物と同時デプロイを管理したと説明 | 稼働状態の対応と排他を重視する。専用管理サービスの導入自体を目標にしない |
| [akirago：ISUCON13参加記](https://qiita.com/akirago/items/0f7fa56da0c68745d6bc) | 環境整備の事前自動化と、ビルド・アップロードやローカル確認の改善余地を記録 | 初動・反映・失敗時の確認を事前に練習し、3人が使えるか確かめる |

trasta記事はAIの草稿を本人が編集し、英語版は機械翻訳と明記されています。ichyo記事は準備節の後をCodex執筆と明記しています。AIによる自己評価を参加者本人の証言と同じ独立証拠として数えません。Discordで紹介されたXの投稿はFxTwitter API・X oEmbed・Jina Readerで原文を取得できず、今回の採用根拠には含めていません。

AIの数や言語変更を先に固定せず、編集の速さに加えて、反映・待ち時間・計測・説明を含む一周の時間で運用を選びます。複数のAIを使う場合も、人を含む作業分担と共有環境の実行順が必要です。

## 公式文書との対応

- [OpenAI：AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：作業場所に応じて読まれる指示に、常時守る原則と必要な文書の入口を置く。
- [OpenAI：Skills](https://learn.chatgpt.com/docs/build-skills)：繰り返す手順をまとめ、必要時に詳細を読む仕組み。既存の操作を安定させてから切り出し、規則・手順を重複させない。
- [GitHub：concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)：制御対象はworkflow・job。手元からの操作もあるため、共通の環境ロックを別途使う設計にする。
- [ISUCON2026 レギュレーション](https://isucon.net/archives/59966826.html)：AIによる開発の利用と、再起動後の動作・データ取得等の条件を確認する。競技当日は優先される当日マニュアル・公式回答も確認する。
