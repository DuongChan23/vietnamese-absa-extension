import unittest
from backend.preprocessing import normalize_for_comparison, prepare_reviews

class PreprocessingTests(unittest.TestCase):
    def test_nb01_exact_whitespace_key(self):
        self.assertEqual(normalize_for_comparison('  Pin\t tốt\n lắm  '), 'Pin tốt lắm')

    def test_original_text_preserved_and_offsets(self):
        text = '  Pin  yếu\nnhưng màn hình đẹp. '
        result = prepare_reviews([{"text": text, "review_id": 1}])
        self.assertEqual(result['reviews'][0]['text'], text)
        self.assertEqual(text[2:5], 'Pin')

    def test_duplicate_ids_same_product(self):
        rows = [{"text": 'A', "review_id": 7}, {"text": 'B', "review_id": 7}]
        result = prepare_reviews(rows, product_id='p1')
        self.assertEqual(result['stats']['accepted'], 1)
        self.assertEqual(result['rejected'][0]['reason'], 'duplicate_review_id')

    def test_distinct_review_ids_same_text_kept(self):
        rows = [{"text": 'Good', "review_id": 7}, {"text": 'Good', "review_id": 8}]
        self.assertEqual(prepare_reviews(rows)['stats']['accepted'], 2)

    def test_missing_ids_kept_by_default(self):
        self.assertEqual(prepare_reviews(['Good', 'Good'])['stats']['accepted'], 2)

    def test_optional_anonymous_text_dedup(self):
        output = prepare_reviews([' A \n B ', 'A B'], dedup_text_without_id=True)
        self.assertEqual(output['stats']['accepted'], 1)

    def test_invalid_records(self):
        output = prepare_reviews([' ', {'text': 'Hi', 'rating': 6}, {'text': 'OK\x00'}])
        self.assertEqual(output['stats']['rejected'], 3)

    def test_product_scope(self):
        rows = [{'product_id':'p1', 'review_id': 1, 'text':'A'}, {'product_id':'p2','review_id':1,'text':'B'}]
        self.assertEqual(prepare_reviews(rows)['stats']['accepted'], 2)

if __name__ == '__main__':
    unittest.main()
