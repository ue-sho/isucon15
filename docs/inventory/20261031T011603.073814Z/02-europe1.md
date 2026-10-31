# 初期構成: europe1

取得時刻（UTC）: 2026-10-31T01:16:04.449773+00:00

## ハードウェア・ソフトウェア

| 項目 | 内容 |
|---|---|
| OS | Ubuntu 24.04.5 LTS |
| CPU | Intel(R) Xeon(R) Platinum 8488C |
| vCPU | 2 |
| アーキテクチャ | x86_64 |
| 仮想化 | amazon |
| メモリ | 3.72 GiB |
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
| (sd-pam) | 1536 |
| ModemManager | 911 |
| acpid | 645 |
| agetty | 862, 915 |
| amazon-ssm-agen | 661 |
| bash | 1644 |
| chronyd | 746, 756 |
| cpuhp/0 | 22 |
| cpuhp/1 | 23 |
| cron | 649 |
| dbus-daemon | 650 |
| ecryptfs-kthread | 56 |
| idle_inject/0 | 21 |
| idle_inject/1 | 24 |
| irq/24-pciehp | 58 |
| irq/25-pciehp | 59 |
| irq/26-pciehp | 60 |
| irq/27-pciehp | 61 |
| irq/28-pciehp | 62 |
| irq/29-pciehp | 63 |
| irq/30-pciehp | 64 |
| irq/31-pciehp | 65 |
| irq/32-pciehp | 66 |
| irq/33-pciehp | 67 |
| irq/34-pciehp | 68 |
| irq/35-pciehp | 69 |
| irq/36-pciehp | 70 |
| irq/37-pciehp | 71 |
| irq/38-pciehp | 72 |
| irq/39-pciehp | 73 |
| irq/40-pciehp | 74 |
| irq/41-pciehp | 75 |
| irq/42-pciehp | 76 |
| irq/43-pciehp | 77 |
| irq/44-pciehp | 78 |
| irq/45-pciehp | 79 |
| irq/46-pciehp | 80 |
| irq/47-pciehp | 81 |
| irq/48-pciehp | 82 |
| irq/49-pciehp | 83 |
| irq/50-pciehp | 84 |
| irq/51-pciehp | 85 |
| irq/52-pciehp | 86 |
| irq/53-pciehp | 87 |
| irq/54-pciehp | 88 |
| irq/55-pciehp | 89 |
| irq/56-pciehp | 90 |
| irq/57-pciehp | 91 |
| irq/58-pciehp | 92 |
| irq/59-pciehp | 93 |
| irq/60-pciehp | 94 |
| irq/61-pciehp | 95 |
| irq/9-acpi | 45 |
| irqbalance | 656 |
| isureal | 1511 |
| isureal-guard | 1302 |
| jbd2/nvme0n1p1-8 | 122 |
| jbd2/nvme0n1p16-8 | 334 |
| journalctl | 1364 |
| kauditd | 33 |
| kcompactd0 | 39 |
| kdevtmpfs | 29 |
| khugepaged | 41 |
| khungtaskd | 34 |
| kprobe-optimizer | 20 |
| ksmd | 40 |
| ksoftirqd/0 | 14 |
| ksoftirqd/1 | 26 |
| kswapd0 | 55 |
| kthreadd | 2 |
| kworker/0:0-events | 1529 |
| kworker/0:0H-kblockd | 10 |
| kworker/0:1-cgwb_release | 11 |
| kworker/0:1H-kblockd | 369 |
| kworker/0:2 | 2925 |
| kworker/1:0-cgroup_free | 27 |
| kworker/1:0H-kblockd | 28 |
| kworker/1:1-cgroup_free | 1734 |
| kworker/1:1H-kblockd | 151 |
| kworker/1:2-cgroup_free | 124 |
| kworker/1:3 | 2926 |
| kworker/R-acpi_thermal_pm | 96 |
| kworker/R-ata_sff | 47 |
| kworker/R-blkcg_punt_bio | 43 |
| kworker/R-cfg80211 | 510 |
| kworker/R-charger_manager | 121 |
| kworker/R-devfreq_wq | 52 |
| kworker/R-edac-poller | 51 |
| kworker/R-ena | 295 |
| kworker/R-ext4-rsv-conversion | 123, 335 |
| kworker/R-inet_frag_wq | 30 |
| kworker/R-ipv6_addrconf | 104 |
| kworker/R-kblockd | 42 |
| kworker/R-kintegrityd | 44 |
| kworker/R-kmpath_handlerd | 208 |
| kworker/R-kmpathd | 207 |
| kworker/R-kstrp | 106 |
| kworker/R-kthrotld | 57 |
| kworker/R-kvfree_rcu_reclaim | 6 |
| kworker/R-md_bitmap | 48 |
| kworker/R-md_llbitmap_io | 49 |
| kworker/R-md_llbitmap_unplug | 50 |
| kworker/R-mld | 102 |
| kworker/R-mm_percpu_wq | 13 |
| kworker/R-netns | 8 |
| kworker/R-nfit | 318 |
| kworker/R-nvme-auth-wq | 100 |
| kworker/R-nvme-delete-wq | 99 |
| kworker/R-nvme-reset-wq | 98 |
| kworker/R-nvme-wq | 97 |
| kworker/R-quota_events_unbound | 54 |
| kworker/R-rcu_gp | 4 |
| kworker/R-slub_flushwq | 7 |
| kworker/R-sync_wq | 5 |
| kworker/R-tls-strp | 1492 |
| kworker/R-tpm_dev_wq | 46 |
| kworker/R-writeback | 38 |
| kworker/u8:0-events_power_efficient | 12 |
| kworker/u8:1-flush-259:0 | 36 |
| kworker/u8:2-flush-259:0 | 37 |
| kworker/u8:4-events_power_efficient | 107 |
| kworker/u9:0 | 110 |
| migration/0 | 19 |
| migration/1 | 25 |
| multipathd | 226 |
| networkd-dispat | 658 |
| nginx | 1246, 1247, 1248 |
| oom_reaper | 35 |
| packagekitd | 2034 |
| polkitd | 659 |
| pool_workqueue_release | 3 |
| pr/ttyS0 | 15 |
| ps | 2986 |
| psimon | 248, 2547 |
| python3 | 2984 |
| rcu_exp_gp_kthread_worker | 18 |
| rcu_exp_par_gp_kthread_worker/0 | 17 |
| rcu_sched | 16 |
| rcu_tasks_kthread | 31 |
| rcu_tasks_rude_kthread | 32 |
| rsyslogd | 698 |
| snapd | 665 |
| sshd | 690, 1530, 1643, 2927, 2983 |
| systemd | 1, 1535 |
| systemd-journal | 169 |
| systemd-logind | 669 |
| systemd-network | 576 |
| systemd-resolve | 430 |
| systemd-udevd | 231 |
| udisksd | 686 |
| unattended-upgr | 749 |
| watchdogd | 53 |

## TCP/UDP待受

| ss -H -lntu |
|---|
| udp UNCONN 0      0                127.0.0.54:53   0.0.0.0:* |
| udp UNCONN 0      0             127.0.0.53%lo:53   0.0.0.0:* |
| udp UNCONN 0      0      192.168.2.10%enp39s0:68   0.0.0.0:* |
| udp UNCONN 0      0                 127.0.0.1:323  0.0.0.0:* |
| udp UNCONN 0      0                     [::1]:323     [::]:* |
| tcp LISTEN 0      511                 0.0.0.0:80   0.0.0.0:* |
| tcp LISTEN 0      4096                0.0.0.0:22   0.0.0.0:* |
| tcp LISTEN 0      4096          127.0.0.53%lo:53   0.0.0.0:* |
| tcp LISTEN 0      4096             127.0.0.54:53   0.0.0.0:* |
| tcp LISTEN 0      4096                   [::]:22      [::]:* |
| tcp LISTEN 0      4096                      *:8080       *:* |

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
