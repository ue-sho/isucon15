import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "initial_inventory.py"
SPEC = importlib.util.spec_from_file_location("initial_inventory", SCRIPT)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


def report():
    return {
        "schema_version": 1, "hostname": "isucon", "collected_at": "2026-10-28T05:00:00+00:00",
        "hardware": {"os": "Ubuntu", "architecture": "x86_64", "vcpus": 2,
                     "cpu_model": "Example CPU", "virtualization": "kvm",
                     "memory_bytes": 4 * 1024**3, "swap_bytes": 0,
                     "root_disk": {"total_bytes": 15 * 1024**3,
                                   "used_bytes": 5 * 1024**3, "available_bytes": 9 * 1024**3}},
        "software": [{"name": "node", "version": "v22.11.0", "path": "/usr/bin/node", "source": "running-process"}],
        "processes": [{"name": "node", "pids": [42]}],
        "services": ["nginx.service"],
        "listening_ports": ["tcp LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*"],
        "nginx": {"status": "ok", "directives": []},
        "mysql": {"status": "ok", "version": "8.0.46", "row_count_mode": "estimated",
                  "tables": [{"database": "isuride", "table": "rides", "engine": "InnoDB",
                              "estimated_rows": 700, "size_bytes": 1048576}]},
        "warnings": [],
    }


def options():
    return argparse.Namespace(database=["isuride"], exact_counts=False, no_db=False, timeout=5)


class NginxTests(unittest.TestCase):
    def test_filters_secrets_and_preserves_source(self):
        config = '''# configuration file /etc/nginx/conf.d/app.conf:
server {
    listen 443 ssl;
    location /api/ {
        proxy_pass "https://alice:password@backend:8080/api?token=secret";
        proxy_set_header Authorization "Bearer header-secret";
        set $private "set-secret";
    }
}
'''
        result = inventory.parse_nginx_config(config)
        encoded = json.dumps(result)
        for secret in ("alice", "password", "token=secret", "header-secret", "set-secret"):
            self.assertNotIn(secret, encoded)
        proxy = next(item for item in result if item["directive"] == "proxy_pass")
        self.assertEqual(proxy["file"], "/etc/nginx/conf.d/app.conf")
        self.assertEqual(proxy["line"], 4)
        self.assertIn("backend:8080/api", proxy["value"])
        self.assertEqual(len(result), 3)

    def test_quotes_regex_and_inline_directives(self):
        result = inventory.parse_nginx_config('''location ~ ^/api/[0-9]{1,5}$ {
root "/srv/a;b#c"; set $secret "hidden";
location / { set $secret "also-hidden"; }
''')
        self.assertEqual(result[0]["value"], "~ ^/api/[0-9]{1,5}$")
        self.assertEqual(result[1]["value"], '"/srv/a;b#c"')
        self.assertEqual(result[2]["value"], "/")
        self.assertNotIn("hidden", json.dumps(result))


class DatabaseTests(unittest.TestCase):
    @staticmethod
    def metadata(rows="700", size="1048576"):
        return f"{'isuride'.encode().hex()}\t{'rides'.encode().hex()}\tInnoDB\t{rows}\t{size}\n"

    def test_unknown_metadata_does_not_become_zero(self):
        table = inventory.parse_mysql_tables(self.metadata("NULL", "NULL"))[0]
        self.assertIsNone(table["estimated_rows"])
        self.assertIsNone(table["size_bytes"])
        self.assertEqual(inventory.parse_mysql_tables(self.metadata("0", "0"))[0]["estimated_rows"], 0)

    def test_database_filter_and_identifiers_are_escaped(self):
        name = "競技' OR 1=1 --"
        query = inventory.mysql_metadata_query([name])
        self.assertNotIn(name, query)
        self.assertIn(name.encode().hex(), query)
        query = inventory.count_query("my`db", "ride`table", "8.0.46")
        self.assertIn("FROM `my``db`.`ride``table`", query)
        self.assertIn("SET SESSION max_execution_time = 5000;", query)
        self.assertIn("max_statement_time = 5", inventory.count_query("db", "table", "10.11-MariaDB"))

    def collect_with_responses(self, responses, exact=False):
        args = options()
        args.exact_counts = exact
        warnings = []
        with patch.object(inventory, "executable", side_effect=lambda name: "/usr/bin/mysql" if name == "mysql" else None):
            with patch.object(inventory, "run", side_effect=responses) as runner:
                result = inventory.collect_mysql(args, warnings)
                return result, warnings, runner.call_args_list

    def test_default_does_not_count(self):
        result, warnings, calls = self.collect_with_responses([
            (0, "8.0.46\n", ""), (0, self.metadata(), "")])
        self.assertEqual(result["tables"][0]["estimated_rows"], 700)
        self.assertNotIn("exact_rows", result["tables"][0])
        self.assertFalse(warnings)
        self.assertNotIn("COUNT(*)", str(calls))
        self.assertIn("--protocol=SOCKET", calls[0].args[0])
        self.assertIn("--skip-force", calls[0].args[0])

    def test_failed_count_keeps_metadata_without_error_output(self):
        result, warnings, _ = self.collect_with_responses([
            (0, "8.0.46\n", ""), (0, self.metadata(), ""),
            (1, "", "password=secret, time limit exceeded")], exact=True)
        self.assertEqual(result["tables"][0]["estimated_rows"], 700)
        self.assertIsNone(result["tables"][0]["exact_rows"])
        self.assertTrue(warnings)
        self.assertNotIn("secret", json.dumps([result, warnings]))

    def test_exact_count_is_separate_from_estimate(self):
        result, warnings, _ = self.collect_with_responses([
            (0, "8.0.46\n", ""), (0, self.metadata(), ""), (0, "774\n", "")], exact=True)
        self.assertEqual(result["tables"][0]["exact_rows"], 774)
        self.assertEqual(result["tables"][0]["estimated_rows"], 700)
        self.assertFalse(warnings)

    def test_privilege_fallback_is_noninteractive(self):
        warnings = []
        with patch.object(inventory, "executable", side_effect=lambda name: f"/usr/bin/{name}" if name in ("mysql", "sudo") else None):
            with patch.object(inventory, "run", side_effect=[
                (1, "", "access denied secret"), (0, "8.0.46\n", ""), (0, "", "")]) as runner:
                result = inventory.collect_mysql(options(), warnings)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(runner.call_args_list[1].args[0][:3], ["/usr/bin/sudo", "-n", "--"])
        self.assertFalse(warnings)


class MarkdownTests(unittest.TestCase):
    def test_partial_data_and_exact_estimated_counts_are_distinct(self):
        data = report()
        data["processes"] = None
        data["mysql"]["tables"][0].update(exact_rows=None, size_bytes=None, estimated_rows=None)
        data["warnings"] = ["プロセス一覧は未取得です。"]
        markdown = inventory.render_markdown(data)
        self.assertIn("件数（概算）", markdown)
        self.assertIn("件数（COUNT）", markdown)
        self.assertIn("| isuride | rides | InnoDB | 未取得 | 未取得 | 未取得 |", markdown)
        self.assertIn("プロセス一覧は未取得です。", markdown)
        self.assertIn("0.00 GiB", markdown)

    def test_remote_strings_do_not_break_markdown_table(self):
        data = report()
        data["hardware"]["cpu_model"] = "CPU|<script>`\nnew"
        markdown = inventory.render_markdown(data)
        self.assertIn("CPU&#124;&lt;script&gt;&#96; new", markdown)
        self.assertNotIn("<script>", markdown)


class CliTests(unittest.TestCase):
    def invoke(self, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, env=env, timeout=15)

    def test_rejects_unbounded_exact_counts_and_unsafe_hosts(self):
        for args in (("s1", "--exact-counts"), ("s1", "--database", "db", "--exact-counts", "--no-db"),
                     ("s1;touch /tmp/no",), ("s1", "--timeout", "0")):
            with self.subTest(args=args):
                self.assertEqual(self.invoke(*args).returncode, 2)

    def test_multiple_hosts_partial_failure_keeps_successful_report(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "fixture.json").write_text(json.dumps(report()))
            ssh = directory / "ssh"
            ssh.write_text(textwrap.dedent(f"""\
                #!{sys.executable}
                import json, os, pathlib, shlex, sys
                source = sys.stdin.read()
                assert 'def collect(' in source
                args = sys.argv[1:]
                host = args[-2]
                remote = shlex.split(args[-1])
                assert remote[:3] == ['python3', '-', '--collect']
                assert '--database=競技 db' in remote
                assert 'BatchMode=yes' in args
                if host == 'fail':
                    print('PRIVATE-ERROR', file=sys.stderr)
                    sys.exit(255)
                if host == 'invalid':
                    print(json.dumps({{'schema_version': 1}}))
                    sys.exit(0)
                print(pathlib.Path(os.environ['INVENTORY_FIXTURE']).read_text())
                """))
            ssh.chmod(0o755)
            env = {**os.environ, "PATH": str(directory) + os.pathsep + os.environ["PATH"],
                   "INVENTORY_FIXTURE": str(directory / "fixture.json")}
            result = self.invoke("s1", "fail", "invalid", "s1", "--database", "競技 db",
                                 "--output", str(directory / "output"), env=env)
            self.assertEqual(result.returncode, 1, result.stderr)
            output = next((directory / "output").iterdir())
            self.assertEqual(len(list(output.glob("*.json"))), 3)
            self.assertIn("isuride", (output / "01-s1.md").read_text())
            self.assertIn("取得失敗", (output / "02-fail.md").read_text())
            self.assertIn("取得失敗", (output / "03-invalid.md").read_text())
            index = (output / "README.md").read_text()
            self.assertIn("01-s1.md", index)
            self.assertIn("03-invalid.md", index)
            for path in output.iterdir():
                self.assertNotIn("PRIVATE-ERROR", path.read_text())
            success = self.invoke("s1", "--database", "競技 db",
                                  "--output", str(directory / "success"), env=env)
            self.assertEqual(success.returncode, 0, success.stderr)

    def test_ssh_timeout_is_saved_as_failure(self):
        args = options()
        with patch.object(inventory.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 5)):
            result = inventory.collect_host("s1", args, "source")
        self.assertIn("タイムアウト", result["error"])


class CollectionTests(unittest.TestCase):
    def test_missing_commands_still_preserve_linux_hardware(self):
        files = {
            "/proc/cpuinfo": "model name\t: Example CPU\n",
            "/proc/meminfo": "MemTotal: 4194304 kB\nSwapTotal: 0 kB\n",
            "/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04 LTS"\n',
        }
        with patch.object(inventory, "read_text", side_effect=lambda path: files.get(path, "")):
            with patch.object(inventory, "run", return_value=(-1, "", "private-error")):
                with patch.object(inventory, "executable", return_value=None):
                    with patch.object(inventory.glob, "glob", return_value=[]):
                        result = inventory.collect(options())
        self.assertEqual(result["hardware"]["memory_bytes"], 4 * 1024**3)
        self.assertEqual(result["hardware"]["swap_bytes"], 0)
        self.assertIsNone(result["processes"])
        self.assertIsNone(result["listening_ports"])
        self.assertTrue(result["warnings"])
        markdown = inventory.render_markdown(result)
        self.assertIn("Ubuntu 24.04 LTS", markdown)
        self.assertNotIn("private-error", markdown)


if __name__ == "__main__":
    unittest.main()
