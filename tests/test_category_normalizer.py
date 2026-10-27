
import unittest

from backend.category_normalizer import (
    merge_aspects,
    enrich_batch_response,
)


class CategoryMergeTests(unittest.TestCase):

    # ========================================================
    # TEST 1: MERGE SAME SPAN AND SENTIMENT
    # ========================================================

    def test_merge_same_span_and_sentiment(self):
        aspects = [
            {
                "aspect": "thiết kế đẹp",
                "start": 0,
                "end": 12,
                "category": "DESIGN",
                "sentiment": "positive",
                "sources": ["visd4sa"],
            },
            {
                "aspect": "thiết kế đẹp",
                "start": 0,
                "end": 12,
                "category": "Design",
                "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["category"], "Design")
        self.assertEqual(result[0]["merged_count"], 2)

        self.assertEqual(
            result[0]["sources"],
            ["visd4sa", "vicloabsa"],
        )

        self.assertEqual(
            set(result[0]["original_categories"]),
            {"DESIGN", "Design"},
        )

        # Không thay đổi dữ liệu AI gốc.
        self.assertEqual(aspects[0]["category"], "DESIGN")
        self.assertEqual(
            aspects[0]["sources"],
            ["visd4sa"],
        )

    # ========================================================
    # TEST 2: KEEP DIFFERENT SPANS AND SENTIMENTS
    # ========================================================

    def test_keep_different_spans_and_sentiments(self):
        aspects = [
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

        result = merge_aspects(aspects)

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
    # TEST 3: PRESERVE ORIGINAL BATCH PREDICTIONS
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

        merged = result["results"][0]["aspects_merged"]

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["category"], "General")
        self.assertEqual(merged[0]["merged_count"], 2)

        self.assertEqual(
            merged[0]["sources"],
            ["visd4sa", "vicloabsa"],
        )

        self.assertEqual(
            set(merged[0]["original_categories"]),
            {"GENERAL", "General"},
        )

        # Response đầu vào không được thay đổi.
        self.assertNotIn(
            "aspects_merged",
            response["results"][0],
        )

        self.assertEqual(
            response["results"][0]["aspects"][0]["category"],
            "GENERAL",
        )

    # ========================================================
    # TEST 4: PRESERVE ALL MODEL SOURCES
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

        # Không làm thay đổi dữ liệu đầu vào.
        self.assertEqual(
            aspects[0]["sources"],
            ["visd4sa"],
        )

        self.assertEqual(
            aspects[1]["category"],
            "Design",
        )

    # ========================================================
    # TEST 5: MERGE SER&ACC AND SERVICE
    # ========================================================

    def test_service_labels_are_merged(self):
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

        self.assertEqual(len(result), 1)

        self.assertEqual(
            result[0]["category"],
            "Service",
        )

        self.assertEqual(
            result[0]["merged_count"],
            2,
        )

        self.assertEqual(
            result[0]["sources"],
            ["visd4sa", "vicloabsa"],
        )

        self.assertEqual(
            set(result[0]["original_categories"]),
            {"SER&ACC", "Service"},
        )

        # Nhãn gốc vẫn được bảo toàn.
        self.assertEqual(
            aspects[0]["category"],
            "SER&ACC",
        )


if __name__ == "__main__":
    unittest.main()
