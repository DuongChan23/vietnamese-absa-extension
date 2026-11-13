"""Exercise API handlers with a stub predictor, without optional web/ML packages."""

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend import activity_log


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class FakeApp:
    def __init__(self, **kwargs):
        pass

    def add_middleware(self, *args, **kwargs):
        pass

    def get(self, *args, **kwargs):
        return lambda method: method

    post = get


def load_handlers():
    path = Path(__file__).resolve().parents[1] / 'backend' / 'main.py'
    spec = importlib.util.spec_from_file_location('backend._activity_api_test', path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        'backend.inference': SimpleNamespace(ABSAPredictor=object),
        'fastapi': SimpleNamespace(FastAPI=FakeApp, HTTPException=FakeHTTPException),
        'fastapi.middleware.cors': SimpleNamespace(CORSMiddleware=object),
        'pydantic': SimpleNamespace(BaseModel=object, Field=lambda **values: values.get('default')),
    }):
        spec.loader.exec_module(module)
    module.log_event = Mock(return_value=True)
    module.logger = Mock()
    return module


class APIActivityTests(unittest.TestCase):
    def test_batch_logs_review_timings_cache_hits_and_errors_with_correct_context(self):
        api = load_handlers()
        contexts = []
        def infer(text):
            contexts.append(dict(activity_log._context.get()))
            if text == 'fail':
                raise RuntimeError('test failure')
            return []
        model = SimpleNamespace(categories={'clothes': []}, predict_unified=Mock(side_effect=infer))
        api.predictor = model
        request = SimpleNamespace(run_id='run-1', product_id='1.10', source='unified', reviews=[
            {'review_id': 'r1', 'text': 'tốt', 'rating': 5},
            {'review_id': 'r2', 'text': 'tốt', 'rating': 3},
            {'review_id': 'r3', 'text': 'fail'},
            {'review_id': 'r4', 'text': 'x' * 3001},
            {'review_id': 'r2', 'text': 'duplicate id'},
        ])
        response = api.predict_batch(request)
        self.assertEqual([row['status'] for row in response['results']], ['ok', 'ok', 'error', 'error'])
        self.assertEqual(response['preprocessing']['rejected'], 1)
        self.assertEqual(model.predict_unified.call_count, 2)
        self.assertEqual([row['review_id'] for row in contexts], ['r1', 'r3'])
        self.assertTrue(all(row['run_id'] == 'run-1' for row in contexts))
        self.assertTrue(all(row['product_id'] == '1.10' for row in contexts))
        starts = [call.kwargs for call in api.log_event.call_args_list if call.args[0] == 'review_analysis_started']
        self.assertEqual([row['cache_hit'] for row in starts], [False, True, False])
        end = api.log_event.call_args_list[-1]
        self.assertEqual(end.args[0], 'batch_analysis_completed')
        self.assertEqual((end.kwargs['completed'], end.kwargs['failed']), (2, 2))
        self.assertGreaterEqual(end.kwargs['duration_ms'], 0)
        self.assertEqual(activity_log._context.get(), {})

    def test_single_analysis_logs_completion_without_changing_result(self):
        api = load_handlers()
        prediction = [{'start': 0, 'end': 3, 'aspect': 'Pin', 'category': 'BATTERY', 'sentiment': 'positive'}]
        api.predictor = SimpleNamespace(categories={'phones': []}, predict_unified=Mock(return_value=prediction))
        response = api.predict(SimpleNamespace(text='Pin tốt', source='unified', run_id='run1', product_id='1.10'))
        self.assertEqual(response['aspects'], prediction)
        self.assertEqual(api.log_event.call_args_list[-1].args[0], 'single_analysis_completed')

    def test_extension_events_are_saved_and_write_failures_are_reported(self):
        api = load_handlers()
        request = SimpleNamespace(event='collection_completed', run_id='run1', product_id='1.10',
                                  duration_ms=100, client_time=None, details={'collected': 40, 'pages': 8})
        self.assertEqual(api.record_activity(request), {'ok': True})
        self.assertEqual(api.log_event.call_args.kwargs['client_details']['pages'], 8)
        api.log_event.return_value = False
        with self.assertRaises(FakeHTTPException) as error:
            api.record_activity(request)
        self.assertEqual(error.exception.status_code, 503)

    def test_health_advertises_logging_and_queued_events_can_be_uploaded_in_batches(self):
        api = load_handlers()
        self.assertEqual(api.health()['activity_log']['batch_endpoint'], '/activity/log/batch')
        events = [SimpleNamespace(
            event='collection_page', run_id='run1', product_id='1.10', event_id=f'e{i}',
            duration_ms=i*100, client_time=None, details={'page': i}
        ) for i in range(1, 4)]
        self.assertEqual(api.record_activity_batch(SimpleNamespace(events=events)), {'ok': True, 'written': 3})
        self.assertEqual(api.log_event.call_count, 3)
        self.assertEqual(api.log_event.call_args.kwargs['client_event_id'], 'e3')


if __name__ == '__main__':
    unittest.main()
