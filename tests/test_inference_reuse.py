"""Output-contract tests without loading checkpoints or optional ML packages."""

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.category_normalizer import merge_aspects
from backend.benchmark_inference import run_once
from backend.inference_reuse import ExactPredictionCache
from backend.preprocessing import prepare_reviews


def load_predictor_class():
    # Stub imports only; test the actual orchestration methods. Neural forward
    # passes must additionally be checked with backend.benchmark_inference.
    torch = SimpleNamespace(
        nn=SimpleNamespace(Module=object),
        cuda=SimpleNamespace(is_available=lambda: False),
        device=lambda name: name,
        inference_mode=lambda: lambda method: method,
    )
    transformers = SimpleNamespace(
        AutoConfig=object, AutoModel=object, AutoTokenizer=object,
        AutoModelForSequenceClassification=object,
    )
    path = Path(__file__).resolve().parents[1] / 'backend' / 'inference.py'
    spec = importlib.util.spec_from_file_location('backend._inference_reuse_test', path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        'torch': torch,
        'transformers': transformers,
        'py_vncorenlp': SimpleNamespace(),
    }):
        spec.loader.exec_module(module)
    module.log_event = Mock()
    return module.ABSAPredictor


ABSAPredictor = load_predictor_class()


class SentimentReuseTests(unittest.TestCase):
    def make_model(self):
        model = ABSAPredictor.__new__(ABSAPredictor)
        model.categories = {'clothes': [], 'phones': []}
        proposals = {
            'clothes': {(0, 3, 'General'), (0, 3, 'Price')},
            'phones': {(0, 3, 'General'), (0, 3, 'PRICE'), (8, 11, 'BATTERY')},
        }
        model._extract_candidates = Mock(side_effect=lambda text, source: proposals[source])
        model._classify_span = Mock(side_effect=lambda text, s, e: 'negative' if s == 8 else 'positive')
        return model

    def test_unified_matches_reference_and_reduces_asc_calls(self):
        model = self.make_model()
        text = 'Giá tốt pin yếu'
        reference = model.predict_unified(text, reuse_sentiments=False)
        self.assertEqual(model._classify_span.call_count, 3)
        model._classify_span.reset_mock()
        model._extract_candidates.reset_mock()
        optimized = model.predict_unified(text)
        self.assertEqual(optimized, reference)
        self.assertEqual(merge_aspects(optimized), merge_aspects(reference))
        self.assertEqual(model._classify_span.call_count, 2)
        self.assertEqual(model._extract_candidates.call_count, 2)
        duplicate = next(row for row in optimized if row['category'] == 'General')
        self.assertEqual(duplicate['sources'], ['clothes', 'phones'])
        self.assertEqual(len(optimized), 4)

    def test_cache_is_not_shared_between_reviews_or_calls(self):
        model = self.make_model()
        for text in ['Giá tốt pin yếu', 'Giá xấu pin tốt', 'Giá tốt pin yếu']:
            model.predict_unified(text)
        self.assertEqual(model._classify_span.call_count, 6)

    def test_rejected_asc_span_stays_absent(self):
        model = self.make_model()
        model._classify_span.side_effect = lambda text, s, e: None if s == 0 else 'negative'
        reference = model.predict_unified('Giá tốt pin yếu', reuse_sentiments=False)
        model._classify_span.reset_mock()
        self.assertEqual(model.predict_unified('Giá tốt pin yếu'), reference)
        self.assertEqual(model._classify_span.call_count, 2)
        self.assertEqual([row['category'] for row in reference], ['BATTERY'])

    def test_source_specific_predictions_are_unchanged(self):
        model = self.make_model()
        expected = [
            {'start': 0, 'end': 3, 'aspect': 'Giá', 'category': category, 'sentiment': 'positive'}
            for category in ['General', 'Price']
        ]
        self.assertEqual(model.predict('Giá tốt', 'clothes'), expected)
        self.assertEqual(model._classify_span.call_count, 1)
        with self.assertRaises(ValueError):
            model.predict('Giá tốt', 'unknown')

    def test_full_batch_comparison_preserves_raw_and_merged_outputs(self):
        model = self.make_model()
        texts = ['Giá tốt pin yếu', 'Giá tốt pin yếu', 'Giá xấu pin tốt']
        reference = run_once(model, texts, 'unified', False)
        self.assertEqual(model._extract_candidates.call_count, 6)
        self.assertEqual(model._classify_span.call_count, 9)
        model._extract_candidates.reset_mock()
        model._classify_span.reset_mock()
        optimized = run_once(model, texts, 'unified', True)
        self.assertEqual(optimized, reference)
        self.assertEqual(len(optimized), 3)
        self.assertEqual(model._extract_candidates.call_count, 4)
        self.assertEqual(model._classify_span.call_count, 4)


class ExactPredictionCacheTests(unittest.TestCase):
    def test_identical_reviews_keep_metadata_order_and_independent_results(self):
        prepared = prepare_reviews([
            {'review_id': 'r1', 'text': 'Giá tốt', 'rating': 5},
            {'review_id': 'r2', 'text': 'Giá tốt', 'rating': 3},
            {'review_id': 'r3', 'text': 'Giá  tốt', 'rating': 4},
        ])
        predict = Mock(return_value=[{'start': 0, 'end': 3, 'sources': ['phones']}])
        cache = ExactPredictionCache(predict)
        results = [
            {**row, 'aspects': cache.predict(row['text'], 'unified')}
            for row in prepared['reviews']
        ]
        self.assertEqual(predict.call_count, 2)
        self.assertEqual([row['review_id'] for row in results], ['r1', 'r2', 'r3'])
        self.assertEqual([row['rating'] for row in results], [5, 3, 4])
        self.assertEqual(results[0]['aspects'], results[1]['aspects'])
        results[0]['aspects'][0]['sources'].append('changed')
        self.assertEqual(results[1]['aspects'][0]['sources'], ['phones'])
        self.assertEqual(cache.predict('Giá tốt', 'unified')[0]['sources'], ['phones'])

    def test_empty_outputs_are_cached_but_sources_are_distinct(self):
        predict = Mock(return_value=[])
        cache = ExactPredictionCache(predict)
        for source in ['unified', 'unified', 'clothes']:
            self.assertEqual(cache.predict('Giá tốt', source), [])
        self.assertEqual(predict.call_count, 2)

    def test_errors_are_retried_and_new_requests_start_empty(self):
        predict = Mock(side_effect=[RuntimeError('temporary'), [], []])
        cache = ExactPredictionCache(predict)
        with self.assertRaises(RuntimeError):
            cache.predict('Giá tốt', 'unified')
        self.assertEqual(cache.predict('Giá tốt', 'unified'), [])
        self.assertEqual(ExactPredictionCache(predict).predict('Giá tốt', 'unified'), [])
        self.assertEqual(predict.call_count, 3)


if __name__ == '__main__':
    unittest.main()
