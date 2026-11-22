"""Real FastAPI validation and HTTP contracts, with only the ML model stubbed."""

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from backend import main as api
from backend.category_normalizer import MERGE_POLICY
from backend.inference_runtime import InputTooLongError


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.model = SimpleNamespace(
            categories={'clothes': [], 'phones': []},
            predict_unified=Mock(return_value=[]), predict=Mock(return_value=[]),
            runtime_info=lambda: {'device': 'cpu', 'java_home': '/private/java'},
        )
        self.predictor_patch = patch.object(api, 'predictor', self.model)
        self.log_patch = patch.object(api, 'log_event', return_value=True)
        self.predictor_patch.start()
        self.log_patch.start()
        self.addCleanup(self.predictor_patch.stop)
        self.addCleanup(self.log_patch.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)

    def test_single_and_batch_preserve_predictions_and_agree_on_policy(self):
        raw = [{'start': 0, 'end': 3, 'aspect': 'Pin', 'category': 'BATTERY', 'sentiment': 'positive'}]
        self.model.predict_unified.return_value = raw
        response = self.client.post('/predict', json={'text': 'Pin tốt'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['aspects'], raw)
        self.assertEqual(response.json()['category_merge_policy'], MERGE_POLICY)
        batch = self.client.post('/predict/batch', json={'reviews': [
            {'review_id': '1', 'text': 'Pin tốt', 'rating': 5},
            {'review_id': '2', 'text': 'Pin tốt', 'rating': 3},
        ]})
        self.assertEqual(batch.status_code, 200)
        self.assertEqual([row['rating'] for row in batch.json()['results']], [5, 3])
        self.assertEqual(self.model.predict_unified.call_count, 2)

    def test_empty_null_and_oversized_text_are_rejected_before_model(self):
        for text in ('', ' \n\t ', 'ok\x00', 'x' * 3001):
            with self.subTest(text=text[:10]):
                self.assertEqual(self.client.post('/predict', json={'text': text}).status_code, 422)
        self.model.predict_unified.assert_not_called()
        self.assertEqual(self.client.post('/predict', json={'text': '  Pin\ntốt  '}).status_code, 200)
        self.model.predict_unified.assert_called_once_with('  Pin\ntốt  ')

    def test_unknown_source_and_large_batch_are_rejected(self):
        self.assertEqual(self.client.post('/predict', json={'text': 'tốt', 'source': 'wrong'}).status_code, 422)
        self.assertEqual(self.client.post('/predict/batch', json={'reviews': ['tốt'] * 31}).status_code, 422)
        self.model.predict_unified.assert_not_called()

    def test_errors_do_not_expose_private_paths(self):
        self.model.predict_unified.side_effect = RuntimeError('/private/checkpoint.pt')
        with patch.object(api.logger, 'exception'):
            result = self.client.post('/predict', json={'text': 'tốt'})
            batch = self.client.post('/predict/batch', json={'reviews': ['tốt']})
        self.assertEqual(result.status_code, 500)
        self.assertEqual(result.json()['detail'], 'inference_failed')
        self.assertEqual(batch.json()['results'][0]['error'], 'inference_failed')
        self.assertNotIn('/private', self.client.get('/health').text)
        with patch.object(api, 'predictor', None):
            self.assertEqual(self.client.post('/predict', json={'text': 'tốt'}).status_code, 503)

    def test_log_values_and_keys_are_bounded(self):
        for details in ({'key': 'x' * 201}, {'x' * 65: 1}):
            self.assertEqual(self.client.post('/activity/log', json={
                'event': 'test_event', 'details': details,
            }).status_code, 422)
        self.assertEqual(self.client.post('/activity/log', json={
            'event': 'test_event', 'details': {'pages': 5, 'elapsed': 0.5, 'cached': True},
        }).status_code, 200)

    def test_model_context_overflow_is_reported_instead_of_empty_success(self):
        self.model.predict_unified.side_effect = InputTooLongError('text_exceeds_model_context')
        result = self.client.post('/predict', json={'text': 'tốt'})
        self.assertEqual(result.status_code, 422)
        self.assertEqual(result.json()['detail'], 'text_exceeds_model_context')
        batch = self.client.post('/predict/batch', json={'reviews': ['tốt']})
        row = batch.json()['results'][0]
        self.assertEqual((row['status'], row['error']), ('error', 'text_exceeds_model_context'))

    def test_cors_and_post_origin_checks(self):
        origin = 'chrome-extension://' + 'a' * 32
        response = self.client.options('/predict', headers={
            'Origin': origin, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['access-control-allow-origin'], origin)
        self.assertEqual(self.client.post('/predict', json={'text': 'tốt'},
                                         headers={'Origin': 'https://evil.example'}).status_code, 403)
