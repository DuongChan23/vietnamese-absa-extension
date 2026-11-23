"""Tests for source-preserving ABSA category normalization and merging."""

import unittest

from backend.category_normalizer import (
    MERGE_POLICY,
    enrich_batch_response,
    merge_aspects,
    normalize_category,
    normalize_sources,
)


class CategoryMergeTests(unittest.TestCase):
    def test_exact_duplicates_merge_and_keep_provenance(self):
        aspects = [
            {
                "start": 0, "end": 12, "aspect": "thiết kế đẹp",
                "category": "DESIGN", "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
            {
                "start": 0, "end": 12, "aspect": "thiết kế đẹp",
                "category": "DESIGN", "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(aspects, source="vicloabsa")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["category"], "DESIGN")
        self.assertEqual(result[0]["sentiment"], "positive")
        self.assertEqual(result[0]["merged_count"], 2)
        self.assertEqual(result[0]["sources"], ["vicloabsa"])
        self.assertEqual(result[0]["original_categories"], ["DESIGN"])

    def test_seracc_and_service_are_never_aliased_or_merged(self):
        aspects = [
            {
                "start": 0, "end": 10, "aspect": "giao hàng",
                "category": "SER&ACC", "sentiment": "positive",
                "sources": ["visd4sa"],
            },
            {
                "start": 0, "end": 10, "aspect": "giao hàng",
                "category": "Service", "sentiment": "positive",
                "sources": ["vicloabsa"],
            },
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 2)
        self.assertEqual(
            [item["category"] for item in result],
            ["SER&ACC", "Service"],
        )

    def test_case_variants_remain_distinct(self):
        aspects = [
            {"start": 0, "end": 8, "category": "GENERAL", "sentiment": "positive"},
            {"start": 0, "end": 8, "category": "General", "sentiment": "positive"},
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 2)
        self.assertEqual(
            {item["category"] for item in result},
            {"GENERAL", "General"},
        )

    def test_different_spans_and_sentiments_remain_distinct(self):
        aspects = [
            {"start": 0, "end": 4, "category": "PRICE", "sentiment": "positive"},
            {"start": 0, "end": 4, "category": "PRICE", "sentiment": "negative"},
            {"start": 5, "end": 9, "category": "PRICE", "sentiment": "positive"},
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 3)
        self.assertEqual(
            [item["sentiment"] for item in result],
            ["positive", "negative", "positive"],
        )

    def test_invalid_spans_are_not_merged(self):
        aspects = [
            {"start": -1, "end": 4, "category": "GENERAL", "sentiment": "positive"},
            {"start": -1, "end": 4, "category": "GENERAL", "sentiment": "positive"},
            {"start": True, "end": 4, "category": "GENERAL", "sentiment": "positive"},
            {"start": 4, "end": 4, "category": "GENERAL", "sentiment": "positive"},
        ]

        result = merge_aspects(aspects)

        self.assertEqual(len(result), 4)
        self.assertTrue(all(item["merged_count"] == 1 for item in result))

    def test_invalid_sentiment_is_not_merged(self):
        aspects = [
            {"start": 0, "end": 4, "category": "GENERAL", "sentiment": "unknown"},
            {"start": 0, "end": 4, "category": "GENERAL", "sentiment": "unknown"},
        ]

        self.assertEqual(len(merge_aspects(aspects)), 2)

    def test_source_is_added_without_mutating_raw_predictions(self):
        aspects = [
            {
                "start": 0, "end": 3, "aspect": "vải",
                "category": "Material", "sentiment": "POSITIVE",
            }
        ]

        result = merge_aspects(aspects, source="vicloabsa")

        self.assertEqual(result[0]["sources"], ["vicloabsa"])
        self.assertEqual(result[0]["sentiment"], "positive")
        self.assertNotIn("sources", aspects[0])
        self.assertNotIn("merged_count", aspects[0])
        self.assertEqual(aspects[0]["category"], "Material")
        self.assertEqual(aspects[0]["sentiment"], "POSITIVE")

    def test_unified_mode_does_not_add_a_fake_source(self):
        result = merge_aspects(
            [{"start": 0, "end": 2, "category": "BATTERY", "sentiment": "positive"}],
            source="unified",
        )

        self.assertEqual(result[0]["sources"], [])

    def test_normalize_sources_deduplicates_and_discards_empty_values(self):
        self.assertEqual(
            normalize_sources(["vicloabsa", "visd4sa", "vicloabsa", "", None]),
            ["vicloabsa", "visd4sa"],
        )
        self.assertEqual(normalize_sources("vicloabsa"), ["vicloabsa"])
        self.assertEqual(normalize_sources(None), [])

    def test_normalize_category_preserves_taxonomy_label(self):
        self.assertEqual(normalize_category("SER&ACC", "visd4sa"), "SER&ACC")
        self.assertEqual(normalize_category("Service", "vicloabsa"), "Service")
        self.assertEqual(normalize_category("  "), "UNKNOWN")

    def test_batch_response_adds_merged_view_and_keeps_raw_data(self):
        response = {
            "results": [
                {
                    "status": "ok",
                    "aspects": [
                        {
                            "start": 0, "end": 4, "category": "SER&ACC",
                            "sentiment": "positive", "sources": ["visd4sa"],
                        },
                        {
                            "start": 0, "end": 4, "category": "Service",
                            "sentiment": "positive", "sources": ["vicloabsa"],
                        },
                    ],
                }
            ],
            "rejected": [],
        }

        result = enrich_batch_response(response, source="visd4sa")

        self.assertEqual(result["category_merge_policy"], MERGE_POLICY)
        self.assertEqual(len(result["results"][0]["aspects"]), 2)
        self.assertEqual(len(result["results"][0]["aspects_merged"]), 2)
        self.assertEqual(
            [item["category"] for item in result["results"][0]["aspects_merged"]],
            ["SER&ACC", "Service"],
        )
        self.assertNotIn("aspects_merged", response["results"][0])
        self.assertNotIn("sources", response["results"][0]["aspects"][0])

    def test_batch_response_requires_results_list(self):
        with self.assertRaisesRegex(ValueError, "results list"):
            enrich_batch_response({"rejected": []})


if __name__ == "__main__":
    unittest.main()
