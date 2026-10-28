#!/usr/bin/env python3
"""Collect initial Linux server inventory over SSH; save Markdown and JSON locally."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import glob
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys


def run(command, timeout=10):
    """Keep stderr in memory: raw errors may contain configuration or credentials."""
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                errors="replace", timeout=timeout, check=False)
        return result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired):
        return -1, "", ""


def executable(name):
    found = shutil.which(name)
    if found:
        return found
    for directory in ("/usr/sbin", "/usr/bin", "/sbin", "/bin"):
        path = Path(directory) / name
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


def privileged_read(command, timeout=10):
    result = run(command, timeout)
    sudo = executable("sudo")
    if result[0] != 0 and sudo:
        result = run([sudo, "-n", "--", *command], timeout)
    return result


def read_text(path):
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return ""


def collect_hardware(warnings):
    model = re.search(r"^(?:model name|Hardware)\s*:\s*(.+)$", read_text("/proc/cpuinfo"), re.M)
    memory = {key: int(value) * 1024 for key, value in
              re.findall(r"^(\w+):\s+(\d+) kB$", read_text("/proc/meminfo"), re.M)}
    os_release = re.search(r'^PRETTY_NAME=(.+)$', read_text("/etc/os-release"), re.M)
    virt = run(["systemd-detect-virt"])
    virtualization = virt[1].strip() if virt[0] in (0, 1) and virt[1].strip() else None
    if model is None:
        warnings.append("CPUモデルは未取得です。")
    if not memory:
        warnings.append("メモリ情報は未取得です（Linuxの/procが必要です）。")
    if virtualization is None:
        warnings.append("仮想化方式は未取得です。")
    try:
        disk = os.statvfs("/")
        root_disk = {"total_bytes": disk.f_blocks * disk.f_frsize,
                     "used_bytes": (disk.f_blocks - disk.f_bfree) * disk.f_frsize,
                     "available_bytes": disk.f_bavail * disk.f_frsize}
    except OSError:
        root_disk = None
        warnings.append("ルート領域の容量は未取得です。")
    return {"os": os_release[1].strip('"') if os_release else platform.system(),
            "architecture": platform.machine(), "vcpus": os.cpu_count(),
            "cpu_model": model[1] if model else None, "virtualization": virtualization,
            "memory_bytes": memory.get("MemTotal"), "swap_bytes": memory.get("SwapTotal"),
            "root_disk": root_disk}


def collect_processes(warnings):
    code, output, _ = run(["ps", "-eo", "pid=,comm="])
    if code:
        warnings.append("プロセス一覧は未取得です。")
        return None
    groups = defaultdict(list)
    for line in output.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            groups[fields[1]].append(int(fields[0]))
    return [{"name": name, "pids": pids} for name, pids in sorted(groups.items())]


def collect_software(processes, warnings):
    versions = []
    for name, flag, pattern in (("nginx", "-v", r"nginx/[\w.+~-]+"),
                                ("mysql", "--version", r"(?:Ver|Distrib)\s+[^\s,]+")):
        binary = executable(name)
        if binary:
            code, out, err = run([binary, flag])
            match = re.search(pattern, out + err)
            if code == 0 and match:
                versions.append({"name": name, "version": match[0], "path": binary,
                                 "source": "installed"})
            else:
                warnings.append(f"{name}のバージョンは未取得です。")
    nodes = {}
    for name in ("node", "nodejs"):
        binary = executable(name)
        if binary:
            nodes[os.path.realpath(binary)] = "installed"
    for binary in glob.glob("/home/isucon/local/*/bin/node"):
        nodes[os.path.realpath(binary)] = "installed"
    for process in processes or []:
        if process["name"] in ("node", "nodejs"):
            for pid in process["pids"]:
                try:
                    binary = os.readlink(f"/proc/{pid}/exe")
                    if Path(binary).is_file():
                        nodes[binary] = "running-process"
                except OSError:
                    warnings.append(f"PID {pid}のNode実行ファイルは未取得です。")
    for binary, source in sorted(nodes.items()):
        code, out, _ = run([binary, "--version"])
        if code == 0 and re.fullmatch(r"v\d+[\w.+~-]*", out.strip()):
            versions.append({"name": "node", "version": out.strip(), "path": binary,
                             "source": source})
        else:
            warnings.append("検出したNodeのバージョンを取得できませんでした。")
    return versions


def nginx_value(text):
    """Take one directive value, respecting quoted semicolons and regex braces."""
    quote, escaped = None, False
    for index, char in enumerate(text):
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char in ";#" or (char == "{" and (index == 0 or text[index - 1].isspace())):
            return text[:index].strip()
    return text.strip()


def redact_url(value):
    value = re.sub(r"(?i)(https?://)[^/\s\"']*@", r"\1[REDACTED]@", value)
    return re.sub(r"\?[^\s\"']*", "?[REDACTED]", value)


def parse_nginx_config(text):
    """Extract selected directives in file order, without inferring connectivity."""
    directives = []
    filename, line_number = "unknown", 0
    for line in text.splitlines():
        header = re.fullmatch(r"# configuration file (.+):", line)
        if header:
            filename, line_number = header[1], 0
            continue
        line_number += 1
        match = re.match(r"^\s*(listen|server_name|location|proxy_pass|root|alias|upstream|server)\s+(.+)$", line)
        if match:
            value = nginx_value(match[2])
            if value:
                directives.append({"file": filename, "line": line_number,
                                   "directive": match[1], "value": redact_url(value)})
    return directives


def collect_nginx(warnings):
    binary = executable("nginx")
    if not binary:
        return {"status": "not-found", "directives": []}
    code, output, _ = privileged_read([binary, "-T"])
    if code:
        warnings.append("nginx設定は未取得です（権限または設定検査を確認してください）。")
        return {"status": "unavailable", "directives": []}
    return {"status": "ok", "directives": parse_nginx_config(output)}


def mysql_metadata_query(databases):
    condition = ""
    if databases:
        literals = ", ".join("CONVERT(0x" + name.encode().hex() + " USING utf8mb4)"
                             for name in databases)
        condition = f" AND TABLE_SCHEMA IN ({literals})"
    return ("SELECT HEX(TABLE_SCHEMA), HEX(TABLE_NAME), COALESCE(ENGINE, ''), "
            "TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES "
            "WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN "
            "('mysql', 'information_schema', 'performance_schema', 'sys')" + condition +
            " ORDER BY TABLE_SCHEMA, TABLE_NAME;")


def parse_mysql_tables(text):
    tables = []
    for line in text.splitlines():
        schema, table, engine, rows, size = line.split("\t")
        tables.append({"database": bytes.fromhex(schema).decode(),
                       "table": bytes.fromhex(table).decode(), "engine": engine,
                       "estimated_rows": None if rows == "NULL" else int(rows),
                       "size_bytes": None if size == "NULL" else int(size)})
    return tables


def count_query(database, table, version):
    # This connection only. If the limit cannot be set, the client stops before COUNT.
    limit = "max_statement_time = 5" if "mariadb" in version.lower() else "max_execution_time = 5000"
    quoted = ".".join("`" + name.replace("`", "``") + "`" for name in (database, table))
    return f"SET SESSION {limit}; SELECT COUNT(*) FROM {quoted};"


def collect_mysql(args, warnings):
    if args.no_db:
        return {"status": "skipped", "tables": []}
    binary = executable("mysql") or executable("mariadb")
    if not binary:
        return {"status": "not-found", "tables": []}
    # Force local socket access; do not inherit a remote host from client defaults.
    base = [binary, "--protocol=SOCKET", "--skip-force", "--batch", "--raw",
            "--skip-column-names", "--connect-timeout=3"]
    candidates = [base]
    sudo = executable("sudo")
    if sudo:
        candidates.append([sudo, "-n", "--", *base])
    for command in candidates:
        code, output, _ = run([*command, "--execute", "SELECT VERSION();"])
        if code == 0 and output.strip():
            break
    else:
        warnings.append("ローカルDBに接続できませんでした（既存のクライアント設定・権限を確認してください）。")
        return {"status": "unavailable", "tables": []}
    version = output.strip()
    code, output, _ = run([*command, "--execute", mysql_metadata_query(args.database)], timeout=15)
    try:
        tables = parse_mysql_tables(output) if code == 0 else None
    except (ValueError, UnicodeError):
        tables = None
    if tables is None:
        warnings.append("DBテーブル統計は未取得です。")
        return {"status": "unavailable", "version": version, "tables": []}
    if args.exact_counts:
        for table in tables:
            query = count_query(table["database"], table["table"], version)
            code, output, _ = run([*command, "--execute", query], timeout=10)
            table["exact_rows"] = int(output.strip()) if code == 0 and output.strip().isdigit() else None
            if table["exact_rows"] is None:
                warnings.append(f"{table['database']}.{table['table']}の正確な件数は未取得です（時間上限または権限）。")
    return {"status": "ok", "version": version, "tables": tables,
            "row_count_mode": "exact-requested" if args.exact_counts else "estimated"}


def collect(args):
    warnings = []
    hardware = collect_hardware(warnings)
    processes = collect_processes(warnings)
    services = run(["systemctl", "list-units", "--type=service", "--state=running",
                    "--no-legend", "--plain", "--no-pager"])
    if services[0]:
        warnings.append("systemdの稼働サービス一覧は未取得です。")
    ports = run(["ss", "-H", "-lntu"])
    if ports[0]:
        warnings.append("TCP/UDPの待受ポート一覧は未取得です。")
    return {"schema_version": 1, "collected_at": datetime.now(timezone.utc).isoformat(),
            "hostname": socket.gethostname(), "hardware": hardware,
            "software": collect_software(processes, warnings), "processes": processes,
            "services": [line.split()[0] for line in services[1].splitlines() if line.strip()]
            if services[0] == 0 else None,
            "listening_ports": ports[1].splitlines() if ports[0] == 0 else None,
            "nginx": collect_nginx(warnings), "mysql": collect_mysql(args, warnings),
            "warnings": warnings}


def md(value):
    value = str(value if value is not None else "未取得")
    for before, after in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"),
                          ("|", "&#124;"), ("`", "&#96;"), ("\n", " "), ("\r", " ")):
        value = value.replace(before, after)
    return value


def gib(value):
    return f"{value / 1024**3:.2f} GiB" if value is not None else "未取得"


def render_markdown(report):
    lines = [f"# 初期構成: {md(report.get('target', report.get('hostname')))}", "",
             f"取得時刻（UTC）: {md(report.get('collected_at'))}", ""]
    if report.get("error"):
        return "\n".join([*lines, f"取得失敗: {md(report['error'])}", ""])
    hardware = report["hardware"]
    disk = hardware.get("root_disk") or {}
    lines += ["## ハードウェア・ソフトウェア", "", "| 項目 | 内容 |", "|---|---|"]
    fields = (("OS", hardware.get("os")), ("CPU", hardware.get("cpu_model")),
              ("vCPU", hardware.get("vcpus")), ("アーキテクチャ", hardware.get("architecture")),
              ("仮想化", hardware.get("virtualization")), ("メモリ", gib(hardware.get("memory_bytes"))),
              ("Swap", gib(hardware.get("swap_bytes"))), ("ルート領域", gib(disk.get("total_bytes"))),
              ("ルート領域の使用量", gib(disk.get("used_bytes"))),
              ("ルート領域の空き（一般ユーザー）", gib(disk.get("available_bytes"))))
    lines += [f"| {key} | {md(value)} |" for key, value in fields]
    for software in report["software"]:
        lines.append(f"| {md(software['name'])} | {md(software['version'])} / {md(software['path'])} / {md(software['source'])} |")
    lines += ["", "installed は検出したバイナリの版、running-process は実行中Nodeの実体から取得した版です。",
              "MySQLのサーバーバージョンはDB欄を参照してください。", "", "## 稼働サービス", ""]
    lines += [f"- {md(service)}" for service in report["services"] or []] or ["未取得または対象なし"]
    lines += ["", "## プロセス（引数・環境変数は収集しません）", "", "| 名前 | PID |", "|---|---|"]
    for process in report["processes"] or []:
        lines.append(f"| {md(process['name'])} | {', '.join(map(str, process['pids']))} |")
    if report["processes"] is None:
        lines.append("| 未取得 | 未取得 |")
    lines += ["", "## TCP/UDP待受", "", "| ss -H -lntu |", "|---|"]
    lines += [f"| {md(port)} |" for port in report["listening_ports"] or []] or ["| 未取得または対象なし |"]
    lines += ["", "## nginx設定の抜粋", "", f"取得状態: {md(report['nginx']['status'])}", "",
              "設定ファイル上の値です。server/locationの対応、実際の疎通、DB・決済先は別途確認してください。",
              "行単位の抜粋であり、複数行のディレクティブを完全には解釈しません。", "",
              "| ファイル:行 | ディレクティブ | 値 |", "|---|---|---|"]
    for directive in report["nginx"]["directives"]:
        lines.append(f"| {md(directive['file'])}:{directive['line']} | {md(directive['directive'])} | {md(directive['value'])} |")
    database = report["mysql"]
    lines += ["", "## ローカルMySQL / MariaDB", "", f"取得状態: {md(database['status'])}",
              f"サーバーバージョン: {md(database.get('version'))}", "",
              "概算件数は information_schema.TABLES.TABLE_ROWS、サイズは DATA_LENGTH + INDEX_LENGTH です。",
              "接続ユーザーから見えるBASE TABLEのみ対象です。全テーブルの同時刻スナップショットではありません。", "",
              "| DB | テーブル | Engine | 件数（概算） | 件数（COUNT） | サイズ（MiB・概算） |", "|---|---|---|---:|---:|---:|"]
    for table in database["tables"]:
        size = table["size_bytes"]
        size_text = f"{size / 1024**2:.2f}" if size is not None else "未取得"
        lines.append(f"| {md(table['database'])} | {md(table['table'])} | {md(table['engine'])} | {md(table['estimated_rows'])} | {md(table.get('exact_rows', '未実行'))} | {size_text} |")
    lines += ["", "## 未取得・確認事項", ""]
    lines += [f"- {md(warning)}" for warning in report["warnings"]] or ["- 自動取得項目の失敗なし。構成の意味・疎通は別途確認してください。"]
    return "\n".join(lines) + "\n"


def collect_host(host, args, source):
    remote = ["python3", "-", "--collect"]
    for database in args.database:
        remote.append(f"--database={database}")
    if args.exact_counts:
        remote.append("--exact-counts")
    if args.no_db:
        remote.append("--no-db")
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               host, shlex.join(remote)]
    try:
        result = subprocess.run(command, input=source, capture_output=True, text=True,
                                errors="replace", timeout=args.timeout, check=False)
        if result.returncode != 0:
            error = "SSH接続またはリモート収集に失敗しました。SSH設定と接続先のpython3を確認してください。"
        else:
            report = json.loads(result.stdout)
            if not isinstance(report, dict) or report.get("schema_version") != 1:
                raise ValueError("invalid report")
            report["target"] = host
            # Reject incomplete output here so one bad host cannot break saving the others.
            render_markdown(report)
            return report
    except subprocess.TimeoutExpired:
        error = f"収集が{args.timeout}秒でタイムアウトしました。"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        error = "SSHを実行できないか、収集結果の形式が不正です。"
    return {"target": host, "collected_at": datetime.now(timezone.utc).isoformat(), "error": error}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hosts", nargs="*", help="SSH接続先（例: s1 s2 s3）")
    parser.add_argument("--output", type=Path, default=Path("reports/inventory"))
    parser.add_argument("--database", action="append", default=[], help="対象DB名。複数回指定可")
    parser.add_argument("--exact-counts", action="store_true", help="COUNT(*)も実行（各表5秒上限）")
    parser.add_argument("--no-db", action="store_true", help="DBへの接続を省略")
    parser.add_argument("--timeout", type=int, default=120, help="ホストごとの収集上限秒数")
    parser.add_argument("--collect", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.exact_counts and (not args.database or args.no_db):
        parser.error("--exact-countsには--databaseが必要です。--no-dbとは併用できません。")
    if any(not database for database in args.database) or args.timeout <= 0:
        parser.error("DB名は空にできません。--timeoutは正の整数で指定してください。")
    if args.collect:
        print(json.dumps(collect(args), ensure_ascii=False))
        return 0
    if not args.hosts:
        parser.error("SSH接続先を指定してください（例: s1 s2 s3）。")
    if any(host.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.@:%\[\]-]+", host) for host in args.hosts):
        parser.error("SSH接続先にはHost名、user@host、IPアドレスを指定してください。")
    hosts = list(dict.fromkeys(args.hosts))
    directory = args.output / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    directory.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).read_text()
    with ThreadPoolExecutor(max_workers=min(len(hosts), 4)) as executor:
        reports = list(executor.map(lambda host: collect_host(host, args, source), hosts))
    index = ["# 初期構成一覧", "", "| 接続先 | 状態 | 詳細 |", "|---|---|---|"]
    for number, report in enumerate(reports, 1):
        stem = f"{number:02d}-" + re.sub(r"[^A-Za-z0-9_.-]", "_", report["target"])
        (directory / f"{stem}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (directory / f"{stem}.md").write_text(render_markdown(report), encoding="utf-8")
        status = "取得失敗" if report.get("error") else "一部未取得" if report["warnings"] else "取得済み"
        index.append(f"| {md(report['target'])} | {status} | [{stem}]({stem}.md) |")
        print(f"{report['target']}: {status} -> {directory / (stem + '.md')}")
    (directory / "README.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    return 1 if any(report.get("error") or report.get("warnings") for report in reports) else 0


if __name__ == "__main__":
    sys.exit(main())
