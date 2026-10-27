
import unittest

from backend.category_normalizer import (
    merge_aspects,
    enrich_batch_response,
)


class CategoryMergeTests(unittest.TestCase):

    # ========================================================
    # TEST 1: MERGE SAME SPAN, CATEGORY AND SENTIMENT
    # ========================================================

    def test_merge_same_span_and_sentiment(self):
        data = [
            {
                "aspect": "đẹp",
                "start": 0,
                "end": 3,
                "category": "DESIGN",
                "sentiment": "positive",
                "sources": ["visd4sa"],
            },
            {
                "aspect": "đẹp",
                "start": 0,
                "end": 3,
                "category": "Design",
                "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(data)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["category"], "Design")
        self.assertEqual(result[0]["merged_count"], 2)

        self.assertEqual(
            set(result[0]["original_categories"]),
            {"DESIGN", "Design"},
        )

        # Original model output must not be modified.
        self.assertEqual(data[0]["category"], "DESIGN")

    # ========================================================
    # TEST 2: KEEP DIFFERENT SPANS AND SENTIMENTS
    # ========================================================

    def test_keep_different_spans_and_sentiments(self):
        data = [
            {
                "start": 0,
                "end": 4,
                "category": "PRICE",
                "sentiment": "positive",
            },
            {
                "start": 0,
                "end": 4,
                "category": "Price",
                "sentiment": "negative",
            },
            {
                "start": 5,
                "end": 9,
                "category": "Price",
                "sentiment": "positive",
            },
            {
                "start": 10,
                "end": 14,
                "category": "General",
                "sentiment": "neutral",
            },
        ]

        result = merge_aspects(data)

        # No predictions should be merged.
        self.assertEqual(len(result), 4)

        self.assertEqual(
            [item["sentiment"] for item in result],
            [
                "positive",
                "negative",
                "positive",
                "neutral",
            ],
        )

    # ========================================================
    # TEST 3: PRESERVE RAW BATCH PREDICTIONS
    # ========================================================

    def test_preserve_raw_batch_predictions(self):
        response = {
            "results": [
                {
                    "status": "ok",
                    "aspects": [
                        {
                            "start": 0,
                            "end": 4,
                            "category": "GENERAL",
                            "sentiment": "positive",
                            "sources": ["visd4sa"],
                        },
                        {
                            "start": 0,
                            "end": 4,
                            "category": "General",
                            "sentiment": "positive",
                            "sources": ["vicloabsa"],
                        },
                    ],
                }
            ],
            "rejected": [],
        }

        result = enrich_batch_response(response)

        self.assertEqual(
            len(result["results"][0]["aspects"]),
            2,
        )

        self.assertEqual(
            len(result["results"][0]["aspects_merged"]),
            1,
        )

        self.assertEqual(
            result["results"][0]["aspects_merged"][0]["category"],
            "General",
        )

        # The original response must remain unchanged.
        self.assertNotIn(
            "aspects_merged",
            response["results"][0],
        )

        self.assertEqual(
            response["results"][0]["aspects"][0]["category"],
            "GENERAL",
        )

    # ========================================================
    # TEST 4: PRESERVE ALL SOURCES AFTER MERGING
    # ========================================================

    def test_merge_preserves_all_sources(self):
        aspects = [
            {
                "start": 0,
                "end": 8,
                "aspect": "thiết kế",
                "category": "DESIGN",
                "sentiment": "positive",
                "sources": ["visd4sa"],
            },
            {
                "start": 0,
                "end": 8,
                "aspect": "thiết kế",
                "category": "Design",
                "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 1)

        self.assertEqual(
            result[0]["sources"],
            ["visd4sa", "vicloabsa"],
        )

        self.assertEqual(
            result[0]["merged_count"],
            2,
        )

        self.assertEqual(
            set(result[0]["original_categories"]),
            {"DESIGN", "Design"},
        )

        # Ensure input predictions are unchanged.
        self.assertEqual(
            aspects[0]["sources"],
            ["visd4sa"],
        )

        self.assertEqual(
            aspects[1]["category"],
            "Design",
        )

    # ========================================================
    # TEST 5: KEEP SER&ACC AND SERVICE SEPARATE
    # ========================================================

    def test_service_labels_remain_separate(self):
        aspects = [
            {
                "start": 0,
                "end": 10,
                "aspect": "giao hàng",
                "category": "SER&ACC",
                "sentiment": "positive",
                "sources": ["visd4sa"],
            },
            {
                "start": 0,
                "end": 10,
                "aspect": "giao hàng",
                "category": "Service",
                "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 2)

        self.assertEqual(
            {item["category"] for item in result},
            {"SER&ACC", "Service"},
        )


if __name__ == "__main__":
    unittest.main()
