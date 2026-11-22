import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from backend import activity_log


class ActivityLogTests(unittest.TestCase):
    def test_writes_jsonl_with_timing_and_context_without_review_text(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'activity.jsonl'
            logger = logging.Logger('test.activity')
            handler = RotatingFileHandler(path, encoding='utf-8')
            logger.addHandler(handler)
            try:
                with patch.object(activity_log, '_get_logger', return_value=logger):
                    with activity_log.activity_context(run_id='run1', product_id='1.10', review_id='r1'):
                        self.assertTrue(activity_log.log_event('review_analysis_completed', duration_ms=123.45678, aspects=2))
                    activity_log.log_event('collection_completed', run_id='run2', product_id='1.20', pages=7)
                records = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
                self.assertEqual(records[0]['duration_ms'], 123.457)
                self.assertEqual(records[0]['run_id'], 'run1')
                self.assertEqual(records[0]['details'], {'review_id': 'r1', 'aspects': 2})
                self.assertEqual(records[1]['run_id'], 'run2')
                self.assertNotIn('review_id', records[1]['details'])
                self.assertIn('+00:00', records[0]['timestamp'])
            finally:
                handler.close()

    def test_concurrent_requests_do_not_mix_run_contexts(self):
        records = []
        logger = unittest.mock.Mock()
        logger.info.side_effect = lambda line: records.append(json.loads(line))
        def emit(index):
            with activity_log.activity_context(run_id=f'run{index}', product_id=f'1.{index}'):
                activity_log.log_event('review_analysis_completed', index=index)
        with patch.object(activity_log, '_get_logger', return_value=logger):
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(emit, range(20)))
        self.assertEqual(len(records), 20)
        for row in records:
            index = row['details']['index']
            self.assertEqual(row['run_id'], f'run{index}')
            self.assertEqual(row['product_id'], f'1.{index}')

    def test_log_failure_does_not_break_inference(self):
        with patch.object(activity_log, '_get_logger', side_effect=OSError('disk unavailable')):
            self.assertFalse(activity_log.log_event('review_analysis_completed', duration_ms=1))

    def test_disk_write_failure_returns_false_instead_of_acknowledging_lost_event(self):
        with TemporaryDirectory() as directory:
            handler = activity_log.ActivityFileHandler(Path(directory)/'activity.jsonl', encoding='utf-8')
            logger = logging.Logger('test.disk_failure')
            logger.addHandler(handler)
            try:
                with patch.object(handler.stream, 'write', side_effect=OSError('disk full')), \
                     patch.object(activity_log, '_get_logger', return_value=logger):
                    self.assertFalse(activity_log.log_event('test_event'))
            finally:
                handler.close()


if __name__ == '__main__':
    unittest.main()
