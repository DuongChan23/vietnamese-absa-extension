import unittest
from backend.category_normalizer import enrich_batch_response, merge_aspects


class CategoryMergeTests(unittest.TestCase):
    def test_seracc_and_service_remain_distinct(self):
        rows = [
            {"start": 0, "end": 9, "category": "SER&ACC", "sentiment": "positive"},
            {"start": 0, "end": 9, "category": "Service", "sentiment": "positive"},
        ]
        result = merge_aspects(rows, "visd4sa")
        self.assertEqual(len(result), 2)
        self.assertEqual({item["category"] for item in result}, {"SER&ACC", "Service"})

    def test_only_exact_same_category_label_merges(self):
        rows = [
            {"start": 0, "end": 8, "category": "GENERAL", "sentiment": "positive"},
            {"start": 0, "end": 8, "category": "GENERAL", "sentiment": "positive"},
            {"start": 0, "end": 8, "category": "General", "sentiment": "positive"},
        ]
        result = merge_aspects(rows)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["merged_count"], 2)
        self.assertEqual(result[1]["category"], "General")

    def test_different_spans_or_sentiments_do_not_merge(self):
        rows = [
            {"start": 0, "end": 4, "category": "Price", "sentiment": "positive"},
            {"start": 0, "end": 4, "category": "Price", "sentiment": "negative"},
            {"start": 5, "end": 9, "category": "Price", "sentiment": "positive"},
        ]
        self.assertEqual(len(merge_aspects(rows)), 3)

    def test_predictions_without_valid_offsets_stay_separate(self):
        rows = [
            {"category": "General", "sentiment": "positive"},
            {"category": "General", "sentiment": "positive"},
        ]
        self.assertEqual(len(merge_aspects(rows)), 2)

    def test_source_is_added_without_mutating_raw_predictions(self):
        rows = [{"start": 1, "end": 3, "category": "Material", "sentiment": "positive"}]
        result = merge_aspects(rows, "vicloabsa")
        self.assertEqual(result[0]["sources"], ["vicloabsa"])
        self.assertNotIn("sources", rows[0])

    def test_batch_enrichment_keeps_raw_results_unchanged(self):
        response = {"results": [{"aspects": [
            {"start": 0, "end": 4, "category": "SER&ACC", "sentiment": "positive"},
            {"start": 0, "end": 4, "category": "Service", "sentiment": "positive"},
        ]}]}
        enriched = enrich_batch_response(response, "visd4sa")
        self.assertEqual(len(enriched["results"][0]["aspects_merged"]), 2)
        self.assertNotIn("aspects_merged", response["results"][0])

    def test_invalid_batch_shape_is_rejected(self):
        with self.assertRaises(ValueError):
            enrich_batch_response({"results": None})


if __name__ == "__main__":
    unittest.main()
