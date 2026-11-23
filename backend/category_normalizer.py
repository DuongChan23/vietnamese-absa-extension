"""Preserve source taxonomy labels and merge exact duplicate predictions only."""
from copy import deepcopy
from typing import Any, Mapping

VALID_SENTIMENTS = {"positive", "neutral", "negative"}
MERGE_POLICY = "source_preserving_exact_duplicate_v1"


def normalize_category(label: Any, source: str | None = None) -> str:
    """Trim a category label without translating or aliasing its taxonomy."""
    return str(label or "UNKNOWN").strip() or "UNKNOWN"


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


def merge_aspects(aspects: list[dict[str, Any]], source: str | None = None) -> list[dict[str, Any]]:
    """Merge only identical span + category string + sentiment predictions.

    Category strings are case-sensitive and taxonomy-preserving. SER&ACC and
    Service remain separate categories.
    """
    merged: list[dict[str, Any]] = []
    key_to_position: dict[tuple, int] = {}
    for aspect in aspects:
        if not isinstance(aspect, dict):
            continue
        item = deepcopy(aspect)
        original_category = str(item.get("category") or "UNKNOWN").strip()
        item["category"] = normalize_category(original_category, source)
        item["sentiment"] = str(item.get("sentiment") or "").strip().lower()
        item["sources"] = normalize_sources(item.get("sources"))
        if source and source != "unified" and source not in item["sources"]:
            item["sources"].append(source)
        item["original_categories"] = [original_category]
        item["merged_count"] = 1

        start, end = item.get("start"), item.get("end")
        valid_span = (
            type(start) is int and type(end) is int and 0 <= start < end
            and item["sentiment"] in VALID_SENTIMENTS
        )
        if not valid_span:
            merged.append(item)
            continue

        key = (start, end, item["category"], item["sentiment"])
        if key not in key_to_position:
            key_to_position[key] = len(merged)
            merged.append(item)
            continue
        previous = merged[key_to_position[key]]
        previous["merged_count"] += 1
        previous["sources"] = merge_unique(previous["sources"], item["sources"])
        previous["original_categories"] = merge_unique(
            previous["original_categories"], [original_category]
        )
    return merged


def enrich_batch_response(response: Mapping[str, Any], source: str | None = None) -> dict[str, Any]:
    """Add merged results without replacing raw model predictions."""
    updated = deepcopy(dict(response))
    results = updated.get("results")
    if not isinstance(results, list):
        raise ValueError("Batch response must contain a results list.")
    for result in results:
        if isinstance(result, dict) and isinstance(result.get("aspects"), list):
            result["aspects_merged"] = merge_aspects(result["aspects"], source)
    updated["category_merge_policy"] = MERGE_POLICY
    return updated
