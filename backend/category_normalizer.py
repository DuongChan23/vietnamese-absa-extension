
"""Normalize ABSA categories and merge equivalent predictions."""

from copy import deepcopy
from typing import Any, Mapping


# Unified reporting labels.
# SER&ACC -> Service is a reporting-level decision
# based on audited overlapping Shopee predictions.
# Original model predictions remain unchanged.
CATEGORY_ALIASES = {
    "GENERAL": "General",
    "General": "General",
    "DESIGN": "Design",
    "Design": "Design",
    "PRICE": "Price",
    "Price": "Price",
    "SER&ACC": "Service",
    "Service": "Service",
}

VALID_SENTIMENTS = {
    "positive",
    "neutral",
    "negative",
}

MERGE_POLICY = "unified_category_alias_exact_span_v2"


def normalize_category(label: Any) -> str:
    value = str(label or "UNKNOWN").strip()
    return CATEGORY_ALIASES.get(value, value or "UNKNOWN")


def normalize_sources(value: Any) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = []

    result = []

    for source in values:
        name = str(source or "").strip()

        if name and name not in result:
            result.append(name)

    return result


def merge_unique(first: list, second: list) -> list:
    result = list(first)

    for value in second:
        if value not in result:
            result.append(value)

    return result


def merge_aspects(
    aspects: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Create normalized ABSA predictions.

    Merge only when:
      - start and end are identical
      - normalized categories are identical
      - sentiments are identical

    Preserve:
      - raw prediction objects (input unchanged)
      - original category labels
      - all contributing sources

    Predictions without valid offsets stay separate.
    """
    merged = []
    key_to_position = {}

    for aspect in aspects:
        if not isinstance(aspect, dict):
            continue

        item = deepcopy(aspect)

        original_category = str(
            item.get("category") or "UNKNOWN"
        ).strip()

        category = normalize_category(original_category)

        sentiment = str(
            item.get("sentiment") or ""
        ).strip().lower()

        sources = normalize_sources(
            item.get("sources")
        )

        item["category"] = category
        item["sentiment"] = sentiment
        item["sources"] = sources
        item["original_categories"] = [original_category]
        item["merged_count"] = 1

        start = item.get("start")
        end = item.get("end")

        # Dùng type(...) is int để loại cả bool (vốn là lớp con của int trong Python).
        valid_span = (
            type(start) is int
            and type(end) is int
            and 0 <= start < end
            and sentiment in VALID_SENTIMENTS
        )

        if not valid_span:
            merged.append(item)
            continue

        # Giữ riêng các dự đoán khác cảm xúc, kể cả khi cùng vị trí và category.
        key = (
            start,
            end,
            category,
            sentiment,
        )

        if key not in key_to_position:
            key_to_position[key] = len(merged)
            merged.append(item)
            continue

        previous = merged[key_to_position[key]]

        previous["merged_count"] += 1

        # Gộp nguồn và nhãn gốc để vẫn truy vết được các dự đoán trước chuẩn hóa.
        previous["sources"] = merge_unique(
            previous.get("sources", []),
            sources,
        )

        previous["original_categories"] = merge_unique(
            previous.get("original_categories", []),
            [original_category],
        )

    return merged


def enrich_batch_response(
    response: Mapping[str, Any],
) -> dict[str, Any]:
    """Add aspects_merged without replacing raw aspects."""
    updated = deepcopy(dict(response))

    results = updated.get("results")

    if not isinstance(results, list):
        raise ValueError(
            "Batch response must contain a results list."
        )

    for result in results:
        if not isinstance(result, dict):
            continue

        aspects = result.get("aspects")

        if isinstance(aspects, list):
            result["aspects_merged"] = merge_aspects(
                aspects
            )

    updated["category_merge_policy"] = MERGE_POLICY

    return updated
