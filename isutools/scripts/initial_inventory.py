#!/usr/bin/env python3
"""Collect initial Linux server inventory over SSH; save Markdown and JSON locally."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import partial
import glob
from itertools import product
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


MARKDOWN_ESCAPES = str.maketrans({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;",
    "\n": " ", "\r": " ",
})


def run(command, timeout=10, env=None):
    """Keep stderr in memory: raw errors may contain configuration or credentials."""
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                errors="replace", timeout=timeout, check=False, env=env)
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
    if result[0] == 0:
        return result
    sudo = executable("sudo")
    return run([sudo, "-n", "--", *command], timeout) if sudo else result


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
    code, output, _ = run(["systemd-detect-virt"])
    virtualization = (output.strip() or None) if code in (0, 1) else None
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


def node_executables(processes, warnings):
    nodes = {}
    for name in ("node", "nodejs"):
        binary = executable(name)
        if binary:
            nodes[os.path.realpath(binary)] = "installed"
    for binary in glob.glob("/home/isucon/local/*/bin/node"):
        nodes[os.path.realpath(binary)] = "installed"
    for process in processes or []:
        if process["name"] not in ("node", "nodejs"):
            continue
        for pid in process["pids"]:
            try:
                binary = os.readlink(f"/proc/{pid}/exe")
                if Path(binary).is_file():
                    nodes[binary] = "running-process"
            except OSError:
                warnings.append(f"PID {pid}のNode実行ファイルは未取得です。")
    return nodes


def collect_software(processes, warnings):
    versions = []
    for name, flag, pattern in (("nginx", "-v", r"nginx/[\w.+~-]+"),
                                ("mysql", "--version", r"(?:Ver|Distrib)\s+[^\s,]+"),
                                ("psql", "--version", r"psql \(PostgreSQL\)\s+[^\s]+")):
        binary = executable(name)
        if not binary:
            continue
        code, out, err = run([binary, flag])
        match = re.search(pattern, out + err)
        if code == 0 and match:
            versions.append({"name": name, "version": match[0], "path": binary,
                             "source": "installed"})
        else:
            warnings.append(f"{name}のバージョンは未取得です。")
    for binary, source in sorted(node_executables(processes, warnings).items()):
        code, out, _ = run([binary, "--version"])
        version = out.strip()
        if code == 0 and re.fullmatch(r"v\d+[\w.+~-]*", version):
            versions.append({"name": "node", "version": version, "path": binary,
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
        if not match:
            continue
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


def quote_identifiers(*names, quote='"'):
    return ".".join(quote + name.replace(quote, quote * 2) + quote for name in names)


def count_query(database, table, version):
    # This connection only. If the limit cannot be set, the client stops before COUNT.
    limit = "max_statement_time = 5" if "mariadb" in version.lower() else "max_execution_time = 5000"
    quoted = quote_identifiers(database, table, quote="`")
    return f"SET SESSION {limit}; SELECT COUNT(*) FROM {quoted};"


def parse_row_count(code, output):
    """Accept one non-negative integer; treat malformed COUNT output as unavailable."""
    value = output.strip()
    if code != 0 or not re.fullmatch(r"[0-9]+", value):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def collect_mysql(args, warnings):
    if args.no_db or getattr(args, "db_type", "auto") == "postgresql":
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
        version = output.strip()
        if code == 0 and version:
            break
    else:
        warnings.append("ローカルDBに接続できませんでした（既存のクライアント設定・権限を確認してください）。")
        return {"status": "unavailable", "tables": []}
    code, output, _ = run([*command, "--execute", mysql_metadata_query(args.database)], timeout=15)
    try:
        tables = parse_mysql_tables(output) if code == 0 else None
    except ValueError:
        tables = None
    if tables is None:
        warnings.append("DBテーブル統計は未取得です。")
        return {"status": "unavailable", "version": version, "tables": []}
    if args.exact_counts:
        for table in tables:
            query = count_query(table["database"], table["table"], version)
            code, output, _ = run([*command, "--execute", query], timeout=10)
            table["exact_rows"] = parse_row_count(code, output)
            if table["exact_rows"] is None:
                warnings.append(f"{table['database']}.{table['table']}の正確な件数は未取得です（時間上限または権限）。")
    return {"status": "ok", "version": version, "tables": tables,
            "row_count_mode": "exact-requested" if args.exact_counts else "estimated"}


def postgres_sockets():
    """Find standard local sockets; collect only the first reachable cluster."""
    sockets = set()
    for directory in ("/var/run/postgresql", "/tmp"):
        for path in glob.glob(directory + "/.s.PGSQL.*"):
            match = re.fullmatch(r"\.s\.PGSQL\.(\d+)", Path(path).name)
            if match:
                sockets.add((os.path.realpath(directory), int(match[1])))
    return sorted(sockets) or [("/var/run/postgresql", 5432), ("/tmp", 5432)]


def postgres_query(command, endpoint, database, query, user=None):
    # A raw dbname containing '=' would be interpreted as another connection string.
    # Explicit hostaddr plus a clean service environment prevent remote redirection.
    parameters = {"host": endpoint[0], "hostaddr": "", "port": str(endpoint[1]),
                  "dbname": database, "connect_timeout": "3", "client_encoding": "UTF8",
                  "options": "-c statement_timeout=5000 -c default_transaction_read_only=on "
                             "-c search_path=pg_catalog -c row_security=off"}
    if user:
        parameters["user"] = user
    conninfo = " ".join(key + "='" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
                        for key, value in parameters.items())
    env = {key: value for key, value in os.environ.items()
           if key not in ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR")}
    return run([*command, "--dbname", conninfo, "--command", query], timeout=10, env=env)


def postgres_metadata_query():
    # Physical tables include partition leaves; omit storage-free partition parents.
    return ("SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ("
            "SELECT n.nspname AS schema, c.relname AS table, "
            "CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows, "
            "pg_total_relation_size(c.oid) AS size_bytes "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind = 'r' AND c.relpersistence <> 't' "
            "AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' "
            "AND has_table_privilege(c.oid, 'SELECT') "
            "ORDER BY n.nspname, c.relname) t;")


def find_postgres_connection(binary, databases):
    """Try each user's endpoints and databases in order, stopping at first success."""
    base = [binary, "-X", "--no-password", "--quiet", "--tuples-only", "--no-align",
            "--set=ON_ERROR_STOP=1"]
    candidates = [(base, None)]
    sudo = executable("sudo")
    if sudo:
        candidates.append(([sudo, "-n", "-u", "postgres", "--", *base], "postgres"))
    endpoints = postgres_sockets()
    initial_databases = list(dict.fromkeys([*databases, "postgres", "template1"]))
    for (command, user), endpoint, database in product(candidates, endpoints, initial_databases):
        code, output, _ = postgres_query(command, endpoint, database, "SHOW server_version;", user)
        version = output.strip()
        if code == 0 and version:
            return command, user, endpoint, database, version
    return None


def parse_json_list(code, output, valid_item):
    if code != 0:
        return None
    try:
        items = json.loads(output)
        if isinstance(items, list) and all(valid_item(item) for item in items):
            return items
    except (ValueError, TypeError):
        pass
    return None


def valid_postgres_table(table):
    return (isinstance(table, dict) and isinstance(table.get("schema"), str)
            and isinstance(table.get("table"), str)
            and (table.get("estimated_rows") is None or isinstance(table["estimated_rows"], int))
            and isinstance(table.get("size_bytes"), int))


def collect_postgres_tables(execute, database, exact_counts, warnings):
    code, output, _ = execute(database, postgres_metadata_query())
    tables = parse_json_list(code, output, valid_postgres_table)
    if tables is None:
        warnings.append(f"PostgreSQLのDB {database} のテーブル統計は未取得です。")
        return [], "partial"
    status = "ok"
    for table in tables:
        table["database"] = database
        if not exact_counts:
            continue
        quoted = quote_identifiers(table["schema"], table["table"])
        code, output, _ = execute(database, f"SELECT COUNT(*) FROM ONLY {quoted};")
        table["exact_rows"] = parse_row_count(code, output)
        if table["exact_rows"] is None:
            warnings.append(f"PostgreSQLの{database}.{table['schema']}.{table['table']}の正確な件数は未取得です（時間上限・権限・行セキュリティ）。")
            status = "partial"
    return tables, status


def collect_postgresql(args, warnings):
    if args.no_db or getattr(args, "db_type", "auto") == "mysql":
        return {"status": "skipped", "databases": [], "tables": []}
    binary = executable("psql")
    if not binary:
        return {"status": "not-found", "databases": [], "tables": []}
    connection = find_postgres_connection(binary, args.database)
    if not connection:
        warnings.append("ローカルPostgreSQLに接続できませんでした（socket・既存の認証設定・権限を確認してください）。")
        return {"status": "unavailable", "databases": [], "tables": []}
    command, user, endpoint, initial_database, version = connection
    execute = partial(postgres_query, command, endpoint, user=user)
    query = ("SELECT COALESCE(json_agg(datname ORDER BY datname), '[]'::json) "
             "FROM pg_database WHERE datallowconn AND NOT datistemplate "
             "AND has_database_privilege(oid, 'CONNECT');")
    code, output, _ = execute(initial_database, query)
    databases = parse_json_list(code, output, lambda name: isinstance(name, str))
    if databases is None:
        warnings.append("PostgreSQLのDB一覧は未取得です。")
        return {"status": "unavailable", "version": version, "databases": [], "tables": []}
    available_databases = set(databases)
    selected = list(dict.fromkeys(args.database)) if args.database else databases
    result = {"status": "ok", "version": version, "socket_directory": endpoint[0],
              "port": endpoint[1], "databases": [name for name in selected if name in available_databases],
              "tables": [], "row_count_mode": "exact-requested" if args.exact_counts else "estimated"}
    for database in selected:
        if database not in available_databases:
            warnings.append(f"PostgreSQLのDB {database} は存在しないか、接続権限がありません。")
            result["status"] = "partial"
            continue
        tables, status = collect_postgres_tables(execute, database, args.exact_counts, warnings)
        result["tables"].extend(tables)
        if status == "partial":
            result["status"] = "partial"
    return result


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
            "postgresql": collect_postgresql(args, warnings),
            "warnings": warnings}


def md(value):
    return str(value if value is not None else "未取得").translate(MARKDOWN_ESCAPES)


def gib(value):
    return f"{value / 1024**3:.2f} GiB" if value is not None else "未取得"


def render_database_rows(tables, columns):
    lines = []
    for table in tables:
        size = table["size_bytes"]
        values = [table[column] for column in columns]
        values += [table["estimated_rows"], table.get("exact_rows", "未実行"),
                   f"{size / 1024**2:.2f}" if size is not None else "未取得"]
        lines.append("| " + " | ".join(md(value) for value in values) + " |")
    return lines


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
              "DBのサーバーバージョンは各DB欄を参照してください。", "", "## 稼働サービス", ""]
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
    lines += render_database_rows(database["tables"], ("database", "table", "engine"))
    database = report.get("postgresql", {"status": "not-collected", "databases": [], "tables": []})
    lines += ["", "## ローカルPostgreSQL", "", f"取得状態: {md(database['status'])}",
              f"サーバーバージョン: {md(database.get('version'))}",
              f"socket: {md(database.get('socket_directory'))} / port: {md(database.get('port'))}", "",
              "概算件数は pg_class.reltuples（未解析は未取得）、容量は pg_total_relation_size（インデックス・TOAST含む）です。",
              "物理テーブルを対象とし、パーティションの親は除外、子は個別に表示します。COUNTはONLYで継承先を除外します。",
              "接続・SELECT権限のある対象のみ取得します。全テーブルの同時刻スナップショットではありません。", "",
              "DB一覧: " + (", ".join(md(name) for name in database["databases"]) or "対象なしまたは未取得"), "",
              "| DB | スキーマ | テーブル | 件数（概算） | 件数（COUNT） | サイズ（MiB） |", "|---|---|---|---:|---:|---:|"]
    lines += render_database_rows(database["tables"], ("database", "schema", "table"))
    lines += ["", "## 未取得・確認事項", ""]
    lines += [f"- {md(warning)}" for warning in report["warnings"]] or ["- 自動取得項目の失敗なし。構成の意味・疎通は別途確認してください。"]
    return "\n".join(lines) + "\n"


def host_error(host, message):
    return {"target": host, "collected_at": datetime.now(timezone.utc).isoformat(), "error": message}


def collect_host(host, args, source):
    remote = ["python3", "-", "--collect", "--db-type=" + getattr(args, "db_type", "auto")]
    remote.extend(f"--database={database}" for database in args.database)
    if args.exact_counts:
        remote.append("--exact-counts")
    if args.no_db:
        remote.append("--no-db")
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               host, shlex.join(remote)]
    try:
        result = subprocess.run(command, input=source, capture_output=True, text=True,
                                errors="replace", timeout=args.timeout, check=False,
                                env=getattr(args, "environment", None))
        if result.returncode != 0:
            return host_error(host, "SSH接続またはリモート収集に失敗しました。SSH設定と接続先のpython3を確認してください。")
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
    return host_error(host, error)


def parse_args(argv=None, default_hosts=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hosts", nargs="*", help="SSH接続先（例: s1 s2 s3）")
    parser.add_argument("--output", type=Path, default=Path("docs/inventory"))
    parser.add_argument("--database", action="append", default=[], help="対象DB名。複数回指定可")
    parser.add_argument("--db-type", choices=("auto", "mysql", "postgresql"), default="auto",
                        help="調査するDBの種類。autoはMySQL/MariaDBとPostgreSQLを調査")
    parser.add_argument("--exact-counts", action="store_true", help="COUNT(*)も実行（各表5秒上限）")
    parser.add_argument("--no-db", action="store_true", help="DBへの接続を省略")
    parser.add_argument("--timeout", type=int, default=120, help="ホストごとの収集上限秒数")
    parser.add_argument("--collect", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.exact_counts and (not args.database or args.no_db):
        parser.error("--exact-countsには--databaseが必要です。--no-dbとは併用できません。")
    if any(not database for database in args.database) or args.timeout <= 0:
        parser.error("DB名は空にできません。--timeoutは正の整数で指定してください。")
    if args.collect:
        return args
    if not args.hosts:
        args.hosts = list(default_hosts or [])
    if not args.hosts:
        parser.error("SSH接続先を指定してください（例: s1 s2 s3）。")
    if any(host.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.@:%\[\]-]+", host) for host in args.hosts):
        parser.error("SSH接続先にはHost名、user@host、IPアドレスを指定してください。")
    return args


def main(argv=None, default_hosts=None, environment=None):
    args = parse_args(argv, default_hosts)
    args.environment = environment
    if args.collect:
        print(json.dumps(collect(args), ensure_ascii=False))
        return 0
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
