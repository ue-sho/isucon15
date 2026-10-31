# 初期構成: asia1

取得時刻（UTC）: 2026-10-31T01:16:04.448966+00:00

## ハードウェア・ソフトウェア

| 項目 | 内容 |
|---|---|
| OS | Ubuntu 24.04.5 LTS |
| CPU | Intel(R) Xeon(R) Platinum 8275CL CPU @ 3.00GHz |
| vCPU | 2 |
| アーキテクチャ | x86_64 |
| 仮想化 | amazon |
| メモリ | 3.70 GiB |
| Swap | 0.00 GiB |
| ルート領域 | 57.08 GiB |
| ルート領域の使用量 | 23.71 GiB |
| ルート領域の空き（一般ユーザー） | 33.35 GiB |
| nginx | nginx/1.24.0 / /usr/sbin/nginx / installed |
| psql | psql (PostgreSQL) 16.15 / /usr/bin/psql / installed |
| node | v26.12.1 / /home/isucon/local/node/bin/node / installed |

installed は検出したバイナリの版、running-process は実行中Nodeの実体から取得した版です。
DBのサーバーバージョンは各DB欄を参照してください。

## 稼働サービス

- acpid.service
- chrony.service
- cron.service
- dbus.service
- getty@tty1.service
- irqbalance.service
- isureal-go.service
- isureal-guard.service
- ModemManager.service
- multipathd.service
- networkd-dispatcher.service
- nginx.service
- packagekit.service
- polkit.service
- rsyslog.service
- serial-getty@ttyS0.service
- snap.amazon-ssm-agent.amazon-ssm-agent.service
- snapd.service
- ssh.service
- systemd-journald.service
- systemd-logind.service
- systemd-networkd.service
- systemd-resolved.service
- systemd-udevd.service
- udisks2.service
- unattended-upgrades.service
- user@1100.service

## プロセス（引数・環境変数は収集しません）

| 名前 | PID |
|---|---|
| (sd-pam) | 1627 |
| ModemManager | 775 |
| acpid | 607 |
| agetty | 662, 758 |
| amazon-ssm-agen | 623 |
| bash | 1693 |
| chronyd | 690, 707 |
| cpuhp/0 | 22 |
| cpuhp/1 | 23 |
| cron | 611 |
| dbus-daemon | 612 |
| ecryptfs-kthread | 57 |
| idle_inject/0 | 21 |
| idle_inject/1 | 24 |
| irq/9-acpi | 46 |
| irqbalance | 618 |
| isureal | 1466 |
| isureal-guard | 1258 |
| jbd2/nvme0n1p1-8 | 81 |
| jbd2/nvme0n1p16-8 | 286 |
| journalctl | 1374 |
| kauditd | 33 |
| kcompactd0 | 39 |
| kdevtmpfs | 29 |
| khugepaged | 41 |
| khungtaskd | 34 |
| kprobe-optimizer | 20 |
| ksmd | 40 |
| ksoftirqd/0 | 14 |
| ksoftirqd/1 | 26 |
| kswapd0 | 56 |
| kthreadd | 2 |
| kworker/0:0-events | 1620 |
| kworker/0:0H-kblockd | 10 |
| kworker/0:1H-kblockd | 110 |
| kworker/0:2-cgroup_free | 65 |
| kworker/0:3-events | 995 |
| kworker/1:0-events | 27 |
| kworker/1:0H-kblockd | 28 |
| kworker/1:1-cgroup_free | 45 |
| kworker/1:1H-kblockd | 194 |
| kworker/1:2-cgroup_free | 2027 |
| kworker/R-acpi_thermal_pm | 59 |
| kworker/R-ata_sff | 48 |
| kworker/R-blkcg_punt_bio | 43 |
| kworker/R-cfg80211 | 472 |
| kworker/R-charger_manager | 80 |
| kworker/R-devfreq_wq | 53 |
| kworker/R-edac-poller | 52 |
| kworker/R-ena | 262 |
| kworker/R-ext4-rsv-conversion | 82, 287 |
| kworker/R-inet_frag_wq | 30 |
| kworker/R-ipv6_addrconf | 66 |
| kworker/R-kblockd | 42 |
| kworker/R-kintegrityd | 44 |
| kworker/R-kmpath_handlerd | 167 |
| kworker/R-kmpathd | 166 |
| kworker/R-kstrp | 67 |
| kworker/R-kthrotld | 58 |
| kworker/R-kvfree_rcu_reclaim | 6 |
| kworker/R-md_bitmap | 49 |
| kworker/R-md_llbitmap_io | 50 |
| kworker/R-md_llbitmap_unplug | 51 |
| kworker/R-mld | 64 |
| kworker/R-mm_percpu_wq | 13 |
| kworker/R-netns | 8 |
| kworker/R-nfit | 280 |
| kworker/R-nvme-auth-wq | 63 |
| kworker/R-nvme-delete-wq | 62 |
| kworker/R-nvme-reset-wq | 61 |
| kworker/R-nvme-wq | 60 |
| kworker/R-quota_events_unbound | 55 |
| kworker/R-rcu_gp | 4 |
| kworker/R-slub_flushwq | 7 |
| kworker/R-sync_wq | 5 |
| kworker/R-tls-strp | 1451 |
| kworker/R-tpm_dev_wq | 47 |
| kworker/R-writeback | 38 |
| kworker/u8:0-events_power_efficient | 12 |
| kworker/u8:1-events_power_efficient | 36 |
| kworker/u8:2-flush-259:0 | 2583 |
| kworker/u8:3-events_power_efficient | 242 |
| kworker/u9:0 | 69 |
| migration/0 | 19 |
| migration/1 | 25 |
| multipathd | 186 |
| networkd-dispat | 620 |
| nginx | 1202, 1203, 1204 |
| oom_reaper | 35 |
| packagekitd | 2100 |
| polkitd | 621 |
| pool_workqueue_release | 3 |
| pr/ttyS0 | 15 |
| ps | 3150 |
| psimon | 208, 2614 |
| python3 | 3148 |
| rcu_exp_gp_kthread_worker | 18 |
| rcu_exp_par_gp_kthread_worker/0 | 17 |
| rcu_sched | 16 |
| rcu_tasks_kthread | 31 |
| rcu_tasks_rude_kthread | 32 |
| rsyslogd | 701 |
| snapd | 627 |
| sshd | 639, 1621, 1692, 3091, 3147 |
| systemd | 1, 1626 |
| systemd-journal | 128 |
| systemd-logind | 631 |
| systemd-network | 538 |
| systemd-resolve | 334 |
| systemd-udevd | 192 |
| udisksd | 634 |
| unattended-upgr | 691 |
| watchdogd | 54 |

## TCP/UDP待受

| ss -H -lntu |
|---|
| udp UNCONN 0      0             127.0.0.54:53   0.0.0.0:* |
| udp UNCONN 0      0          127.0.0.53%lo:53   0.0.0.0:* |
| udp UNCONN 0      0      192.168.1.10%ens5:68   0.0.0.0:* |
| udp UNCONN 0      0              127.0.0.1:323  0.0.0.0:* |
| udp UNCONN 0      0                  [::1]:323     [::]:* |
| tcp LISTEN 0      4096          127.0.0.54:53   0.0.0.0:* |
| tcp LISTEN 0      511              0.0.0.0:80   0.0.0.0:* |
| tcp LISTEN 0      4096             0.0.0.0:22   0.0.0.0:* |
| tcp LISTEN 0      4096       127.0.0.53%lo:53   0.0.0.0:* |
| tcp LISTEN 0      4096                [::]:22      [::]:* |
| tcp LISTEN 0      4096                   *:8080       *:* |

## nginx設定の抜粋

取得状態: ok

設定ファイル上の値です。server/locationの対応、実際の疎通、DB・決済先は別途確認してください。
行単位の抜粋であり、複数行のディレクティブを完全には解釈しません。

| ファイル:行 | ディレクティブ | 値 |
|---|---|---|
| /etc/nginx/sites-enabled/isureal.conf:2 | listen | 80 default_server |
| /etc/nginx/sites-enabled/isureal.conf:3 | server_name | _ |
| /etc/nginx/sites-enabled/isureal.conf:6 | root | /home/isucon/webapp/public |
| /etc/nginx/sites-enabled/isureal.conf:8 | location | /api/ |
| /etc/nginx/sites-enabled/isureal.conf:10 | proxy_pass | http://127.0.0.1:8080 |
| /etc/nginx/sites-enabled/isureal.conf:13 | location | / |

## ローカルMySQL / MariaDB

取得状態: not-found
サーバーバージョン: 未取得

概算件数は information_schema.TABLES.TABLE_ROWS、サイズは DATA_LENGTH + INDEX_LENGTH です。
接続ユーザーから見えるBASE TABLEのみ対象です。全テーブルの同時刻スナップショットではありません。

| DB | テーブル | Engine | 件数（概算） | 件数（COUNT） | サイズ（MiB・概算） |
|---|---|---|---:|---:|---:|

## ローカルPostgreSQL

取得状態: unavailable
サーバーバージョン: 未取得
socket: 未取得 / port: 未取得

概算件数は pg_class.reltuples（未解析は未取得）、容量は pg_total_relation_size（インデックス・TOAST含む）です。
物理テーブルを対象とし、パーティションの親は除外、子は個別に表示します。COUNTはONLYで継承先を除外します。
接続・SELECT権限のある対象のみ取得します。全テーブルの同時刻スナップショットではありません。

DB一覧: 対象なしまたは未取得

| DB | スキーマ | テーブル | 件数（概算） | 件数（COUNT） | サイズ（MiB） |
|---|---|---|---:|---:|---:|

## 未取得・確認事項

- ローカルPostgreSQLに接続できませんでした（socket・既存の認証設定・権限を確認してください）。
