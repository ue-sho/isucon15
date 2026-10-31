from pathlib import Path
import runpy
import unittest


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
