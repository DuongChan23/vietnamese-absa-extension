"""Batch scheduling/padding contracts, without loading ML packages/checkpoints."""

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.inference_runtime import InputTooLongError, load_batch_size, save_profile
from test_inference_reuse import load_predictor_class


class Matrix(list):
    def __getitem__(self, index):
        if isinstance(index, tuple):
            rows, columns = index
            return Matrix([row[columns] for row in super().__getitem__(rows)])
        return super().__getitem__(index)

    def contiguous(self):
        return self


class Encoding(dict):
    def sequence_ids(self):
        return [None, 0] + [1] * (len(self['input_ids'])-3) + [None]


class BatchExtractionTests(unittest.TestCase):
    def setUp(self):
        cls = load_predictor_class()
        self.model = cls.__new__(cls)
        self.model.categories = {'clothes': ['short', 'long'], 'phones': ['medium']}
        self.model.max_len = 9
        self.model.encoder_batch_size = 4
        lengths = {'short': 5, 'long': 8, 'over_limit': 10, 'medium': 6}

        def tokenize(query, text, **options):
            length = lengths[query.split()[-1]]
            return Encoding(input_ids=list(range(10, 10+length)),
                            offset_mapping=[(i, i+1) for i in range(length)])
        self.model.tk = Mock(side_effect=tokenize)
        self.model.tk.pad_token_id = 1
        self.encoder = Mock(side_effect=lambda **inputs: SimpleNamespace(last_hidden_state=inputs['input_ids']))
        self.model.joint = SimpleNamespace(encoder=self.encoder)
        self.model._decode_query = Mock(side_effect=lambda h, offsets, category: {(2, len(offsets)-1, category)})
        self.torch = SimpleNamespace(tensor=lambda value, **kwargs: Matrix(value), OutOfMemoryError=MemoryError)
        self.globals = cls._extract_batched.__globals__
        self.environment = patch.dict(self.globals, {'torch': self.torch, 'DEVICE': SimpleNamespace(type='cpu', __str__=lambda: 'cpu')})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_cross_source_batch_right_padding_mask_and_original_lengths(self):
        result = self.model._extract_batched('text', ['clothes', 'phones'], 4)
        self.assertEqual(self.encoder.call_count, 1)
        inputs = self.encoder.call_args.kwargs
        self.assertEqual(inputs['attention_mask'], [
            [1]*5 + [0]*3, [1]*6 + [0]*2, [1]*8,
        ])
        self.assertEqual(inputs['input_ids'][0], list(range(10, 15)) + [1]*3)
        decoded = self.model._decode_query.call_args_list
        self.assertEqual([(call.args[2], len(call.args[0][0])) for call in decoded],
                         [('short', 5), ('medium', 6), ('long', 8)])
        self.assertEqual(result, {'clothes': {(2, 4, 'short'), (2, 7, 'long')},
                                  'phones': {(2, 5, 'medium')}})
        # Query tokens are never truncated or normalized.
        self.assertTrue(all(call.kwargs['truncation'] is False for call in self.model.tk.call_args_list))

    def test_oom_splits_preserve_queries_and_unrelated_errors_propagate(self):
        def encode(**inputs):
            if len(inputs['input_ids']) > 1:
                raise MemoryError('simulated allocation failure')
            return SimpleNamespace(last_hidden_state=inputs['input_ids'])
        self.encoder.side_effect = encode
        result = self.model._extract_batched('text', ['clothes', 'phones'], 4)
        self.assertEqual(sum(map(len, result.values())), 3)
        self.assertEqual(self.model._decode_query.call_count, 3)
        self.encoder.side_effect = RuntimeError('unrelated error')
        with self.assertRaisesRegex(RuntimeError, 'unrelated'):
            self.model._extract_batched('text', ['clothes'], 4)

    def test_over_limit_is_reported_in_serial_and_batched_paths(self):
        self.model.max_len = 1
        with self.assertRaises(InputTooLongError):
            self.model._extract_batched('text', ['clothes'], 4)
        with self.assertRaises(InputTooLongError):
            self.model._extract_candidates('text', 'clothes')
        self.encoder.assert_not_called()
        self.assertEqual(self.model._extract_batched('text', [], 4), {})

    def test_unified_uses_single_extraction_and_keeps_source_merge_order(self):
        self.model._extract_batched = Mock(return_value={
            'clothes': {(0, 2, 'General')}, 'phones': {(0, 2, 'General')},
        })
        self.model._classify_span = Mock(return_value='positive')
        result = self.model.predict_unified('áo đẹp')
        self.model._extract_batched.assert_called_once_with('áo đẹp', ['clothes', 'phones'], 4)
        self.model._classify_span.assert_called_once_with('áo đẹp', 0, 2)
        self.assertEqual(result[0]['sources'], ['clothes', 'phones'])
        with self.assertRaises(ValueError):
            self.model.predict('text', 'unknown')

    def test_source_specific_batch_and_explicit_serial_override(self):
        self.model._extract_batched = Mock(return_value={'clothes': {(0, 2, 'General')}})
        self.model._extract_candidates = Mock(return_value={(0, 2, 'General')})
        self.model._classify_span = Mock(return_value='positive')
        batched = self.model.predict('áo đẹp', 'clothes')
        self.model._extract_batched.assert_called_once_with('áo đẹp', ['clothes'], 4)
        self.assertEqual(self.model.predict('áo đẹp', 'clothes', encoder_batch_size=1), batched)
        self.model._extract_candidates.assert_called_once_with('áo đẹp', 'clothes')
        self.model._extract_batched.reset_mock()
        self.model.predict_unified('áo đẹp', encoder_batch_size=1)
        self.model._extract_batched.assert_not_called()


class RuntimeProfileTests(unittest.TestCase):
    def test_profile_validation_override_and_invalidation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            path = Path(directory)/'profile.json'
            signature = {'torch': 'test', 'threads': 12}
            self.assertEqual(load_batch_size(signature, path), (1, 'serial_default'))
            save_profile(signature, 8, Path('report.json'), path)
            self.assertEqual(load_batch_size(signature, path), (8, 'validated_profile'))
            self.assertEqual(load_batch_size({**signature, 'threads': 4}, path), (1, 'serial_default'))
            with patch.dict('os.environ', {'ABSA_ENCODER_BATCH_SIZE': '1'}):
                self.assertEqual(load_batch_size(signature, path), (1, 'environment'))
            with patch.dict('os.environ', {'ABSA_ENCODER_BATCH_SIZE': '0'}):
                with self.assertRaises(ValueError):load_batch_size(signature, path)
            data = json.loads(path.read_text())
            data['outputs_equal'] = False
            path.write_text(json.dumps(data))
            self.assertEqual(load_batch_size(signature, path), (1, 'serial_default'))
            path.write_text('{broken')
            self.assertEqual(load_batch_size(signature, path), (1, 'serial_default'))


if __name__ == '__main__':
    unittest.main()
