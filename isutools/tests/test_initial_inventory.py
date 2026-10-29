import io
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from isutools.scripts import initial_inventory as inventory


def arguments(**overrides):
    values = dict(no_db=False, db_type="auto", database=[], exact_counts=False, timeout=120)
    values.update(overrides)
    return SimpleNamespace(**values)


def report():
    return {
        "schema_version": 1, "hostname": "host", "collected_at": "2026-10-28T00:00:00Z",
        "hardware": {}, "software": [], "processes": [], "services": [],
        "listening_ports": [], "nginx": {"status": "not-found", "directives": []},
        "mysql": {"status": "not-found", "tables": []}, "warnings": [],
    }


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.run = self.mock("run")
        self.mock("executable", side_effect=lambda name: "/usr/bin/" + name)
        self.sockets = [("/socket-a", 5432), ("/socket-b", 5433)]
        self.mock("postgres_sockets", return_value=self.sockets)

    def mock(self, name, **kwargs):
        patcher = patch.object(inventory, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def test_postgres_tries_all_normal_user_candidates_before_sudo(self):
        self.run.side_effect = [(1, "", "")] * 6 + [
            (0, "18.0\n", ""), (0, '["app"]', ""), (0, "[]", ""),
        ]
        warnings = []
        result = inventory.collect_postgresql(arguments(database=["app", "app", "postgres"]), warnings)
        attempts = []
        for call in self.run.call_args_list[:7]:
            command = call.args[0]
            conninfo = command[command.index("--dbname") + 1]
            attempts.append((command[0].endswith("sudo"),
                             re.search(r"host='([^']*)'", conninfo)[1],
                             re.search(r"dbname='([^']*)'", conninfo)[1]))
        self.assertEqual(attempts, [
            (False, socket, database) for socket, _ in self.sockets
            for database in ("app", "postgres", "template1")
        ] + [(True, "/socket-a", "app")])
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["databases"], ["app"])
        self.assertEqual(len(warnings), 1)

    def test_postgres_continues_after_missing_database_bad_metadata_and_count(self):
        tables = [dict(schema="public", table=name, estimated_rows=2, size_bytes=1024)
                  for name in ("first", "second")]
        self.run.side_effect = [
            (0, "18.0", ""), (0, '["bad", "good"]', ""),
            (0, '[{"schema": "public", "table": "broken", "size_bytes": "wrong"}]', ""),
            (0, json.dumps(tables), ""), (0, "1\n2\n", ""), (0, "7\n", ""),
        ]
        warnings = []
        result = inventory.collect_postgresql(
            arguments(database=["missing", "bad", "good", "good"], exact_counts=True), warnings)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["databases"], ["bad", "good"])
        self.assertEqual([table["database"] for table in result["tables"]], ["good", "good"])
        self.assertEqual([table["exact_rows"] for table in result["tables"]], [None, 7])
        self.assertEqual(len(warnings), 3)
        count_commands = [call.args[0][-1] for call in self.run.call_args_list[-2:]]
        self.assertEqual(count_commands, [
            'SELECT COUNT(*) FROM ONLY "public"."first";',
            'SELECT COUNT(*) FROM ONLY "public"."second";',
        ])

    def test_postgres_rejects_invalid_database_lists(self):
        for output in ("invalid JSON", "{}", '["app", 1]', "null"):
            with self.subTest(output=output):
                self.run.side_effect = [(0, "18.0", ""), (0, output, "")]
                warnings = []
                result = inventory.collect_postgresql(arguments(), warnings)
                self.assertEqual(result, {
                    "status": "unavailable", "version": "18.0", "databases": [], "tables": [],
                })
                self.assertEqual(len(warnings), 1)

    def test_postgres_keeps_connection_local_and_escapes_database_names(self):
        database = "app'\\name=host=remote"
        self.run.return_value = (1, "", "")
        with patch.dict(inventory.os.environ, {
            "PGSERVICE": "remote", "PGSERVICEFILE": "/remote.conf", "PGHOSTADDR": "203.0.113.1",
            "PGUSER": "existing-user",
        }):
            inventory.collect_postgresql(arguments(database=[database]), [])
        first_call = self.run.call_args_list[0]
        command = first_call.args[0]
        conninfo = command[command.index("--dbname") + 1]
        for flag in ("-X", "--no-password", "--set=ON_ERROR_STOP=1"):
            self.assertIn(flag, command)
        self.assertIn("host='/socket-a'", conninfo)
        self.assertIn("hostaddr=''", conninfo)
        self.assertIn("dbname='app\\'\\\\name=host=remote'", conninfo)
        for setting in ("statement_timeout=5000", "default_transaction_read_only=on",
                        "search_path=pg_catalog", "row_security=off"):
            self.assertIn(setting, conninfo)
        environment = first_call.kwargs["env"]
        self.assertTrue({"PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR"}.isdisjoint(environment))
        self.assertEqual(environment["PGUSER"], "existing-user")

    def test_mysql_count_failures_do_not_discard_other_tables(self):
        metadata = "617070\t6669727374\tInnoDB\t2\t1024\n617070\t7365636f6e64\tInnoDB\tNULL\tNULL\n"
        for code, output in ((0, ""), (0, "-1"), (0, "１２"), (0, "1\n2"), (1, "3")):
            with self.subTest(code=code, output=output):
                self.run.side_effect = [
                    (0, "8.4.0", ""), (0, metadata, ""), (code, output, ""), (0, "0\n", ""),
                ]
                warnings = []
                result = inventory.collect_mysql(arguments(database=["app"], exact_counts=True), warnings)
                self.assertEqual(result["status"], "ok")
                self.assertEqual([table["exact_rows"] for table in result["tables"]], [None, 0])
                self.assertIsNone(result["tables"][1]["estimated_rows"])
                self.assertIsNone(result["tables"][1]["size_bytes"])
                self.assertEqual(len(warnings), 1)

    def test_mysql_uses_sudo_fallback_and_mariadb_statement_limit(self):
        self.run.side_effect = [
            (1, "", ""), (0, "11.4.0-MariaDB", ""),
            (0, "617070\t7461626c65\tInnoDB\t1\t100\n", ""), (0, "1", ""),
        ]
        result = inventory.collect_mysql(arguments(database=["app"], exact_counts=True), [])
        commands = [call.args[0] for call in self.run.call_args_list]
        self.assertEqual(commands[0][0], "/usr/bin/mysql")
        self.assertEqual(commands[1][:3], ["/usr/bin/sudo", "-n", "--"])
        self.assertTrue(all("--protocol=SOCKET" in command and "--skip-force" in command
                            for command in commands))
        self.assertEqual(commands[-1][-1],
                         "SET SESSION max_statement_time = 5; SELECT COUNT(*) FROM `app`.`table`;")
        self.assertEqual(result["tables"][0]["exact_rows"], 1)

    def test_disabled_database_collectors_do_not_run_commands(self):
        for collect, args in (
            (inventory.collect_mysql, arguments(db_type="postgresql")),
            (inventory.collect_postgresql, arguments(db_type="mysql")),
            (inventory.collect_mysql, arguments(no_db=True)),
            (inventory.collect_postgresql, arguments(no_db=True)),
        ):
            self.assertEqual(collect(args, [])["status"], "skipped")
        self.run.assert_not_called()


class SoftwareTests(unittest.TestCase):
    def test_node_process_detection_continues_after_unreadable_pid(self):
        processes = [{"name": "python3", "pids": [1]}, {"name": "node", "pids": [10, 11]}]
        warnings = []
        with patch.object(inventory, "executable", return_value=None), \
                patch.object(inventory.glob, "glob", return_value=[]), \
                patch.object(inventory.os, "readlink", side_effect=[OSError(), "/node/bin/node"]), \
                patch.object(inventory.Path, "is_file", return_value=True), \
                patch.object(inventory, "run", return_value=(0, "v22.0.0\n", "")):
            versions = inventory.collect_software(processes, warnings)
        self.assertEqual(versions, [{
            "name": "node", "version": "v22.0.0", "path": "/node/bin/node", "source": "running-process",
        }])
        self.assertEqual(warnings, ["PID 10のNode実行ファイルは未取得です。"])


class ReportTests(unittest.TestCase):
    def test_markdown_escapes_names_and_preserves_missing_counts(self):
        data = report()
        data["mysql"]["tables"] = [{
            "database": "app|&", "table": "<table>`\n", "engine": "InnoDB",
            "estimated_rows": None, "size_bytes": 1048576,
        }]
        data["postgresql"] = {"status": "ok", "databases": ["app"], "tables": [{
            "database": "app", "schema": "public", "table": "items", "estimated_rows": 2,
            "exact_rows": None, "size_bytes": None,
        }]}
        rendered = inventory.render_markdown(data)
        self.assertIn("| app&#124;&amp; | &lt;table&gt;&#96;  | InnoDB | 未取得 | 未実行 | 1.00 |", rendered)
        self.assertIn("| app | public | items | 2 | 未取得 | 未取得 |", rendered)
        self.assertTrue(rendered.endswith("\n"))

    def test_host_collection_quotes_remote_arguments_and_validates_report(self):
        data = report()
        args = arguments(database=["db name;$(command)"], db_type="postgresql", exact_counts=True)
        result = SimpleNamespace(returncode=0, stdout=json.dumps(data))
        with patch.object(inventory.subprocess, "run", return_value=result) as run:
            collected = inventory.collect_host("s1", args, "source")
        self.assertEqual(collected, dict(data, target="s1"))
        self.assertEqual(shlex.split(run.call_args.args[0][-1]), [
            "python3", "-", "--collect", "--db-type=postgresql",
            "--database=db name;$(command)", "--exact-counts",
        ])
        self.assertEqual(run.call_args.kwargs["input"], "source")

    def test_host_collection_reports_incomplete_output_and_timeout(self):
        outcomes = [
            SimpleNamespace(returncode=0, stdout='{"schema_version": 1}'),
            SimpleNamespace(returncode=1, stdout=""),
            subprocess.TimeoutExpired("ssh", 120),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=outcome):
                options = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                with patch.object(inventory.subprocess, "run", **options):
                    result = inventory.collect_host("s1", arguments(), "source")
                self.assertEqual(result["target"], "s1")
                self.assertTrue(result["error"])
                self.assertIn("collected_at", result)


class CommandLineTests(unittest.TestCase):
    def test_main_validates_arguments_and_allows_collector_without_hosts(self):
        invalid_arguments = [
            [], ["bad;host"], ["s1", "--timeout=0"], ["s1", "--db-type=sqlite"],
            ["s1", "--exact-counts"], ["s1", "--database=app", "--exact-counts", "--no-db"],
        ]
        for argv in invalid_arguments:
            with self.subTest(argv=argv), patch.object(inventory.sys, "argv", ["inventory", *argv]), \
                    patch.object(inventory.sys, "stderr", io.StringIO()), \
                    self.assertRaises(SystemExit) as raised:
                inventory.main()
            self.assertEqual(raised.exception.code, 2)
        output = io.StringIO()
        with patch.object(inventory.sys, "argv", ["inventory", "--collect", "--no-db"]), \
                patch.object(inventory, "collect", return_value=report()), \
                patch.object(inventory.sys, "stdout", output):
            self.assertEqual(inventory.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), report())

    def test_main_saves_all_reports_and_sets_exit_status(self):
        for partial in (False, True):
            with self.subTest(partial=partial), tempfile.TemporaryDirectory() as temporary:
                responses = {"s1": dict(report(), target="s1")}
                hosts = ["s1", "s1"]
                if partial:
                    responses["s1"]["warnings"] = ["一部未取得"]
                    responses["user@s2"] = {"target": "user@s2", "error": "SSH failed"}
                    responses["s3"] = dict(report(), target="s3")
                    hosts += ["user@s2", "s3"]
                with patch.object(inventory.sys, "argv", ["inventory", "--output", temporary, *hosts]), \
                        patch.object(inventory, "collect_host", side_effect=lambda host, *_: responses[host]) as collect, \
                        patch.object(inventory.sys, "stdout", io.StringIO()):
                    self.assertEqual(inventory.main(), int(partial))
                self.assertEqual(collect.call_count, len(responses))
                directories = list(Path(temporary).iterdir())
                self.assertEqual(len(directories), 1)
                directory = directories[0]
                expected_stems = ["01-s1", "02-user_s2", "03-s3"] if partial else ["01-s1"]
                self.assertEqual(sorted(path.name for path in directory.iterdir()), sorted([
                    "README.md", *(stem + suffix for stem in expected_stems for suffix in (".md", ".json")),
                ]))
                for stem, data in zip(expected_stems, responses.values()):
                    self.assertEqual(json.loads((directory / (stem + ".json")).read_text()), data)
                    self.assertEqual((directory / (stem + ".md")).read_text(), inventory.render_markdown(data))
                index = (directory / "README.md").read_text()
                self.assertIn("一部未取得" if partial else "取得済み", index)
                if partial:
                    self.assertIn("| user@s2 | 取得失敗 | [02-user_s2](02-user_s2.md) |", index)
                    self.assertIn("| s3 | 取得済み | [03-s3](03-s3.md) |", index)


if __name__ == "__main__":
    unittest.main()
