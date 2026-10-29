import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from isutools.scripts import portal_bench as bench


def integer(number, value):
    return bench.encode_varint(number << 3) + bench.encode_varint(value)


def message(number, value):
    return bench.encode_varint((number << 3) | 2) + bench.encode_varint(len(value)) + value


def response(status, passed=True):
    job = integer(1, 123) + integer(4, status)
    if status == 4:
        job += integer(9, 456) + message(18, integer(1, 1) + integer(2, int(passed)))
    data = io.BytesIO(message(1, job))
    data.headers = {'Content-Type': 'application/vnd.google.protobuf'}
    return data


class PortalBenchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name) / 'state.json'
        self.environment = patch.dict(os.environ, {
            'PORTAL_TARGET_ID': '1', 'PORTAL_COOKIE': 'dummy',
            'PORTAL_CSRF_TOKEN': 'dummy', 'ISUTOOLS_BENCH_STATE': str(self.state),
            'PORTAL_URL': 'https://portal.invalid',
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.opener_patch = patch.object(bench.urllib.request, 'build_opener')
        self.opener = self.opener_patch.start().return_value
        self.addCleanup(self.opener_patch.stop)
        self.sleep_patch = patch.object(bench.time, 'sleep')
        self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)
        self.output = io.StringIO()

    def run_bench(self):
        with contextlib.redirect_stdout(self.output):
            return bench.main()

    def test_posts_once_polls_same_job_and_releases_after_finished(self):
        for passed in (True, False):
            with self.subTest(passed=passed):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [response(0), response(1), response(4, passed)]
                self.assertEqual(self.run_bench(), 0 if passed else 1)
                requests = [call.args[0] for call in self.opener.open.call_args_list]
                self.assertEqual([r.get_method() for r in requests], ['POST', 'GET', 'GET'])
                self.assertEqual(requests[0].data, b'\x08\x01')
                self.assertTrue(all(r.full_url.endswith('/123') for r in requests[1:]))
                self.assertFalse(self.state.exists())
                self.assertIn('"score": 456', self.output.getvalue())

    def test_timeout_keeps_active_job_for_operator(self):
        self.opener.open.side_effect = [response(0)]
        with patch.object(bench.time, 'monotonic', side_effect=[0, 601]):
            with self.assertRaisesRegex(RuntimeError, '10分'):
                self.run_bench()
        self.assertEqual(json.loads(self.state.read_text()), {'job_id': 123, 'status': 'active'})
        self.assertEqual(self.opener.open.call_count, 1)

    def test_lost_post_response_keeps_submission_unknown(self):
        def lost_response(*args, **kwargs):
            self.assertEqual(json.loads(self.state.read_text())['status'], 'submission-unknown')
            raise OSError('response lost')
        self.opener.open.side_effect = lost_response
        with self.assertRaises(OSError):
            self.run_bench()
        self.assertTrue(self.state.exists())

    def test_poll_failure_keeps_active_state(self):
        self.opener.open.side_effect = [response(1), OSError('connection lost')]
        with self.assertRaises(OSError):
            self.run_bench()
        self.assertEqual(json.loads(self.state.read_text())['job_id'], 123)

    def test_terminal_failures_release_state_but_unknown_status_does_not(self):
        for status in (2, 3, 5):
            with self.subTest(status=status):
                self.opener.open.side_effect = [response(status)]
                if status == 5:
                    with self.assertRaisesRegex(RuntimeError, '終了を確認'):
                        self.run_bench()
                    self.assertTrue(self.state.exists())
                else:
                    self.assertEqual(self.run_bench(), 1)
                    self.assertFalse(self.state.exists())


if __name__ == '__main__':
    unittest.main()
