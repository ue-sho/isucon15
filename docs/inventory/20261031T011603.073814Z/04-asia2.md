# 初期構成: asia2

取得時刻（UTC）: 2026-10-31T01:16:04.629700+00:00

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
| ルート領域の使用量 | 23.74 GiB |
| ルート領域の空き（一般ユーザー） | 33.33 GiB |
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
- ModemManager.service
- multipathd.service
- networkd-dispatcher.service
- packagekit.service
- polkit.service
- postgresql@16-main.service
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
| (sd-pam) | 4078 |
| ModemManager | 813 |
| acpid | 607 |
| agetty | 726, 794 |
| amazon-ssm-agen | 625 |
| chronyd | 712, 727 |
| cpuhp/0 | 22 |
| cpuhp/1 | 23 |
| cron | 611 |
| dbus-daemon | 612 |
| ecryptfs-kthread | 57 |
| idle_inject/0 | 21 |
| idle_inject/1 | 24 |
| irq/9-acpi | 45 |
| irqbalance | 618 |
| jbd2/nvme0n1p1-8 | 81 |
| jbd2/nvme0n1p16-8 | 265 |
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
| kworker/0:0-cgroup_free | 1434 |
| kworker/0:0H-kblockd | 10 |
| kworker/0:1 | 5356 |
| kworker/0:1H-kblockd | 193 |
| kworker/0:2 | 5357 |
| kworker/0:4-mm_percpu_wq | 327 |
| kworker/1:0-mm_percpu_wq | 4058 |
| kworker/1:0H-kblockd | 28 |
| kworker/1:1 | 5355 |
| kworker/1:1H-kblockd | 110 |
| kworker/1:2-cgwb_release | 64 |
| kworker/1:3-inode_switch_wbs | 146 |
| kworker/R-acpi_thermal_pm | 59 |
| kworker/R-ata_sff | 48 |
| kworker/R-blkcg_punt_bio | 43 |
| kworker/R-cfg80211 | 472 |
| kworker/R-charger_manager | 80 |
| kworker/R-devfreq_wq | 53 |
| kworker/R-edac-poller | 52 |
| kworker/R-ena | 271 |
| kworker/R-ext4-rsv-conversion | 82, 266 |
| kworker/R-inet_frag_wq | 30 |
| kworker/R-ipv6_addrconf | 66 |
| kworker/R-kblockd | 42 |
| kworker/R-kintegrityd | 44 |
| kworker/R-kmpath_handlerd | 170 |
| kworker/R-kmpathd | 169 |
| kworker/R-kstrp | 67 |
| kworker/R-kthrotld | 58 |
| kworker/R-kvfree_rcu_reclaim | 6 |
| kworker/R-md_bitmap | 49 |
| kworker/R-md_llbitmap_io | 50 |
| kworker/R-md_llbitmap_unplug | 51 |
| kworker/R-mld | 65 |
| kworker/R-mm_percpu_wq | 13 |
| kworker/R-netns | 8 |
| kworker/R-nfit | 273 |
| kworker/R-nvme-auth-wq | 63 |
| kworker/R-nvme-delete-wq | 62 |
| kworker/R-nvme-reset-wq | 61 |
| kworker/R-nvme-wq | 60 |
| kworker/R-quota_events_unbound | 55 |
| kworker/R-rcu_gp | 4 |
| kworker/R-slub_flushwq | 7 |
| kworker/R-sync_wq | 5 |
| kworker/R-tls-strp | 1395 |
| kworker/R-tpm_dev_wq | 47 |
| kworker/R-writeback | 38 |
| kworker/u8:0-events_power_efficient | 12 |
| kworker/u8:1-flush-259:0 | 36 |
| kworker/u8:2-events_power_efficient | 37 |
| kworker/u8:3-events_power_efficient | 147 |
| kworker/u9:0 | 69 |
| migration/0 | 19 |
| migration/1 | 25 |
| multipathd | 187 |
| networkd-dispat | 620 |
| oom_reaper | 35 |
| packagekitd | 4403 |
| polkitd | 621 |
| pool_workqueue_release | 3 |
| postgres | 1196, 1197, 1198, 1200, 1201, 1202, 1626, 3648, 3800 |
| pr/ttyS0 | 15 |
| ps | 5417 |
| psimon | 207, 4943 |
| python3 | 5415 |
| rcu_exp_gp_kthread_worker | 18 |
| rcu_exp_par_gp_kthread_worker/0 | 17 |
| rcu_sched | 16 |
| rcu_tasks_kthread | 31 |
| rcu_tasks_rude_kthread | 32 |
| rsyslogd | 673 |
| snapd | 627 |
| sshd | 645, 5358, 5414 |
| systemd | 1, 4077 |
| systemd-journal | 128 |
| systemd-logind | 631 |
| systemd-network | 538 |
| systemd-resolve | 424 |
| systemd-udevd | 191 |
| udisksd | 635 |
| unattended-upgr | 669 |
| watchdogd | 54 |

## TCP/UDP待受

| ss -H -lntu |
|---|
| udp UNCONN 0      0             127.0.0.54:53   0.0.0.0:* |
| udp UNCONN 0      0          127.0.0.53%lo:53   0.0.0.0:* |
| udp UNCONN 0      0      192.168.4.10%ens5:68   0.0.0.0:* |
| udp UNCONN 0      0              127.0.0.1:323  0.0.0.0:* |
| udp UNCONN 0      0                  [::1]:323     [::]:* |
| tcp LISTEN 0      200              0.0.0.0:5432 0.0.0.0:* |
| tcp LISTEN 0      4096       127.0.0.53%lo:53   0.0.0.0:* |
| tcp LISTEN 0      4096          127.0.0.54:53   0.0.0.0:* |
| tcp LISTEN 0      4096             0.0.0.0:22   0.0.0.0:* |
| tcp LISTEN 0      200                 [::]:5432    [::]:* |
| tcp LISTEN 0      4096                [::]:22      [::]:* |

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

取得状態: ok
サーバーバージョン: 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
socket: /run/postgresql / port: 5432

概算件数は pg_class.reltuples（未解析は未取得）、容量は pg_total_relation_size（インデックス・TOAST含む）です。
物理テーブルを対象とし、パーティションの親は除外、子は個別に表示します。COUNTはONLYで継承先を除外します。
接続・SELECT権限のある対象のみ取得します。全テーブルの同時刻スナップショットではありません。

DB一覧: isureal, postgres

| DB | スキーマ | テーブル | 件数（概算） | 件数（COUNT） | サイズ（MiB） |
|---|---|---|---:|---:|---:|
| isureal | public | administrator_sessions | 未取得 | 未実行 | 0.03 |
| isureal | public | administrators | 未取得 | 未実行 | 0.03 |
| isureal | public | block_relations | 252 | 未実行 | 0.16 |
| isureal | public | comments | 546011 | 未実行 | 160.50 |
| isureal | public | follows | 10034 | 未実行 | 3.63 |
| isureal | public | friend_requests | 28981 | 未実行 | 6.90 |
| isureal | public | friendships | 24994 | 未実行 | 10.05 |
| isureal | public | image_objects_202409 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202410 | 未取得 | 未実行 | 0.16 |
| isureal | public | image_objects_202411 | 200 | 未実行 | 0.66 |
| isureal | public | image_objects_202412 | 218 | 未実行 | 0.70 |
| isureal | public | image_objects_202501 | 214 | 未実行 | 0.73 |
| isureal | public | image_objects_202502 | 174 | 未実行 | 0.59 |
| isureal | public | image_objects_202503 | 214 | 未実行 | 0.70 |
| isureal | public | image_objects_202504 | 198 | 未実行 | 0.64 |
| isureal | public | image_objects_202505 | 217 | 未実行 | 0.70 |
| isureal | public | image_objects_202506 | 215 | 未実行 | 0.69 |
| isureal | public | image_objects_202507 | 209 | 未実行 | 0.66 |
| isureal | public | image_objects_202508 | 213 | 未実行 | 0.68 |
| isureal | public | image_objects_202509 | 199 | 未実行 | 0.66 |
| isureal | public | image_objects_202510 | 19054 | 未実行 | 155.65 |
| isureal | public | image_objects_202511 | 150273 | 未実行 | 1211.73 |
| isureal | public | image_objects_202512 | 153901 | 未実行 | 1242.49 |
| isureal | public | image_objects_202601 | 154984 | 未実行 | 1248.88 |
| isureal | public | image_objects_202602 | 141545 | 未実行 | 1140.95 |
| isureal | public | image_objects_202603 | 154867 | 未実行 | 1250.94 |
| isureal | public | image_objects_202604 | 150384 | 未実行 | 1211.24 |
| isureal | public | image_objects_202605 | 155262 | 未実行 | 1251.10 |
| isureal | public | image_objects_202606 | 149322 | 未実行 | 1206.19 |
| isureal | public | image_objects_202607 | 153703 | 未実行 | 1241.98 |
| isureal | public | image_objects_202608 | 154966 | 未実行 | 1247.76 |
| isureal | public | image_objects_202609 | 150783 | 未実行 | 1214.67 |
| isureal | public | image_objects_202610 | 135605 | 未実行 | 1090.53 |
| isureal | public | image_objects_20261028 | 130 | 未実行 | 63.96 |
| isureal | public | image_objects_202611 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202612 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202701 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202702 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202703 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202704 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202705 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_202706 | 未取得 | 未実行 | 0.02 |
| isureal | public | image_objects_default | 未取得 | 未実行 | 0.02 |
| isureal | public | initial_block_relations | 250 | 未実行 | 0.06 |
| isureal | public | initial_data_boundary | 未取得 | 未実行 | 0.01 |
| isureal | public | initial_follows | 10020 | 未実行 | 1.54 |
| isureal | public | initial_friend_requests | 28970 | 未実行 | 4.66 |
| isureal | public | initial_friendships | 24985 | 未実行 | 5.03 |
| isureal | public | initial_users | 5000 | 未実行 | 1.24 |
| isureal | public | ip_bans | 45 | 未実行 | 0.06 |
| isureal | public | login_sessions | 256 | 未実行 | 0.15 |
| isureal | public | notifications | 1824946 | 未実行 | 643.86 |
| isureal | public | posting_windows | 1095 | 未実行 | 0.34 |
| isureal | public | posts | 625111 | 未実行 | 210.53 |
| isureal | public | realmojis | 1199348 | 未実行 | 505.59 |
| isureal | public | users | 5000 | 未実行 | 2.26 |

## 未取得・確認事項

- 自動取得項目の失敗なし。構成の意味・疎通は別途確認してください。
