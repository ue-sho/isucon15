# 計測停止の構成

`ops/disable-profiling`。`PROFILING_ENABLED=0`で次回デプロイ時に以下を適用する。

- 全4台のnginxアクセスログを停止。
- 全4台のPostgreSQLのSQL計測を停止（`log_min_duration_statement=-1`）。エラーログ・保存方式は維持。
- 全アプリの計測環境変数を`UnsetEnvironment`で除去し、自動収集・Node profilerを停止。EnvironmentFile由来の値も除去し、asia1の欧米用補助サービスも対象。
- initializeのpprotein収集呼び出しを除去。
- 存在するpprotein本体/agentを`systemctl disable --now`。起動待ち・設定POST・profiler依存導入を省略。
- 計測ログのtruncateを省略し、既存データと`/var/lib/pprotein/data`を保持する。

不正アクセス検知に使うアクションログ、IP BAN、nginx/アプリ/DBのエラーログは変更しない。
運営用のサービス・アカウント・接続設定も変更しない。

本番への反映はユーザーが対象と順序を確認して通常のデプロイ手順で行う。
通常のtask deployはDB/アプリ/nginxの再起動も伴うため、他の作業・ベンチと重ねない。
反映後はnginx -t、SQL閾値=-1、pprotein/agentのinactive・disabled、全アプリの正常応答を確認する。
Node profilerの6060待受が消えていることと、初期化後もpproteinが起動しないことを確認する。

戻す場合は停止変更をrevertし、アプリと設定を反映後、必要なpprotein/agentだけを明示的にenable/startする。
`PROFILING_ENABLED=1`だけでは手動で無効化したサービスを再enableしない。
