from pathlib import Path
import runpy
import unittest
import io


MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'pprotein/bin/slp'))


class PproteinSlpTests(unittest.TestCase):
    def test_pprotein_invocation_uses_postgresql_columns_and_preserves_options(self):
        args = ['my', '--config', '/data/slp.yml', '--output', 'standard',
                '--format', 'tsv', '--file', '/data/profile.log']
        converted = MODULE['postgres_args'](args)
        self.assertEqual(converted, ['pg', '--config', '/data/slp.yml', '--output',
                                    MODULE['PG_COLUMNS'], '--format', 'tsv', '--file',
                                    '/data/profile.log', '--log-line-prefix', '%m [%p] '])
        self.assertEqual(args[0], 'my')

    def test_equals_output_is_converted(self):
        self.assertIn('--output=' + MODULE['PG_COLUMNS'],
                      MODULE['postgres_args'](['my', '--output=standard']))

    def test_other_commands_are_preserved(self):
        for args in [[], ['--help'], ['pg', '--file', 'pg.log'], ['diff', 'a', 'b']]:
            self.assertEqual(MODULE['postgres_args'](args), args)

    def test_multiline_execute_is_counted_once_without_parse_bind_or_parameters(self):
        data = (b'2026-10-31 02:00:00.000 UTC [12] LOG:  duration: 0.1 ms  parse <unnamed>: SELECT 1\n'
                b'2026-10-31 02:00:00.001 UTC [12] LOG:  duration: 0.2 ms  bind <unnamed>: SELECT 1\n'
                b'2026-10-31 02:00:00.002 UTC [12] LOG:  duration: 3.5 ms  execute stmt_1: \n'
                b'\tSELECT *\n\tFROM posts WHERE id = $1\n'
                b'2026-10-31 02:00:00.002 UTC [12] DETAIL:  parameters: $1 = 42\n')
        rows = list(MODULE['normalize_log'](io.BytesIO(data)))
        self.assertEqual(rows, [b'2026-10-31 02:00:00.002 UTC [12] LOG:  duration: 3.5 ms  statement: SELECT * FROM posts WHERE id = $1\n'])

    def test_statement_and_execute_from_multiple_sessions_are_retained(self):
        data = (b'2026-10-31 02:00:00.000 UTC [12] LOG:  duration: 1 ms  statement: BEGIN\n'
                b'2026-10-31 02:00:00.001 UTC [13] LOG:  duration: 2 ms  execute <unnamed>: DELETE\n'
                b'\tFROM posts\n'
                b'2026-10-31 02:00:00.002 UTC [12] LOG:  duration: 3 ms  statement: COMMIT\n')
        rows = list(MODULE['normalize_log'](io.BytesIO(data)))
        self.assertEqual(len(rows), 3)
        self.assertIn(b'statement: DELETE FROM posts\n', rows[1])
        self.assertTrue(rows[-1].endswith(b'statement: COMMIT\n'))
