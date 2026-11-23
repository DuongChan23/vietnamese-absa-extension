"""Source-aware normalization and exact-duplicate merging for ABSA outputs.

The category namespace is part of the prediction: labels from ViCloABSA and
ViSD4SA must not be aliased into a shared label. Raw predictions are never
mutated; the merged view is derived separately for the Extension UI.
"""

from copy import deepcopy
from typing import Any, Mapping

VALID_SENTIMENTS = frozenset({"positive", "neutral", "negative"})
MERGE_POLICY = "source_preserving_exact_duplicate_v1"


def normalize_category(label: Any, source: str | None = None) -> str:
    """Keep the source taxonomy label; do not apply cross-domain aliases.

    The source argument is accepted so callers can make the taxonomy context
    explicit. It is deliberately not used to rewrite the category string.
    """
    value = str(label or "UNKNOWN").strip()
    return value or "UNKNOWN"


def normalize_sources(value: Any) -> list[str]:
    """Return unique, non-empty source names while preserving input order."""
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, set):
        values = sorted(value, key=lambda item: str(item))
    elif isinstance(value, (list, tuple)):
        values = list(value)
    else:
        values = []

    result: list[str] = []
    for source in values:
        name = str(source or "").strip()
        if name and name not in result:
            result.append(name)
    return result


def merge_unique(first: list[Any], second: list[Any]) -> list[Any]:
    """Append values not already present, retaining their original order."""
    result = list(first)
    for value in second:
        if value not in result:
            result.append(value)
    return result


def merge_aspects(
    aspects: list[dict[str, Any]],
    source: str | None = None,
) -> list[dict[str, Any]]:
    """Create a display-ready list by merging exact duplicate predictions.

    Two predictions merge only when start, end, the unchanged category string,
    and normalized sentiment are identical. Invalid spans remain separate.
    The input list and its dictionaries are not modified.
    """
    merged: list[dict[str, Any]] = []
    key_to_position: dict[tuple[int, int, str, str], int] = {}

    for aspect in aspects:
        if not isinstance(aspect, dict):
            continue

        item = deepcopy(aspect)
        original_category = str(item.get("category") or "UNKNOWN").strip()
        category = normalize_category(original_category, source)
        sentiment = str(item.get("sentiment") or "").strip().lower()
        sources = normalize_sources(item.get("sources"))

        item["category"] = category
        item["sentiment"] = sentiment
        if source and source != "unified" and source not in sources:
            sources.append(source)
        item["sources"] = sources
        item["original_categories"] = [original_category]
        item["merged_count"] = 1

        start = item.get("start")
        end = item.get("end")
        valid_span = (
            type(start) is int
            and type(end) is int
            and 0 <= start < end
            and sentiment in VALID_SENTIMENTS
        )

        if not valid_span:
            merged.append(item)
            continue

        key = (start, end, category, sentiment)
        if key not in key_to_position:
            key_to_position[key] = len(merged)
            merged.append(item)
            continue

        previous = merged[key_to_position[key]]
        previous["merged_count"] += 1
        previous["sources"] = merge_unique(previous["sources"], sources)
        previous["original_categories"] = merge_unique(
            previous["original_categories"],
            [original_category],
        )

    return merged


def enrich_batch_response(
    response: Mapping[str, Any],
    source: str | None = None,
) -> dict[str, Any]:
    """Add aspects_merged while preserving every raw aspects value."""
    updated = deepcopy(dict(response))
    results = updated.get("results")

    if not isinstance(results, list):
        raise ValueError("Batch response must contain a results list.")

    for result in results:
        if not isinstance(result, dict):
            continue
        aspects = result.get("aspects")
        if isinstance(aspects, list):
            result["aspects_merged"] = merge_aspects(aspects, source=source)

    updated["category_merge_policy"] = MERGE_POLICY
    return updated
