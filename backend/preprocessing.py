"""Review validation/deduplication for ABSA inference.

NB01 provenance:
- Cell 9.2, normalize_for_comparison(): re.sub(r'\\s+', ' ', text).strip()
- Cell 9.3: preserve source text, compare via separate key, keep audit records.

TRAIN/DEV/TEST priority and annotation-signature dedup from Cell 9.3 are
NOT used for user reviews. Distinct review IDs may have identical text.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Iterable, Mapping
import re


def normalize_for_comparison(text: str) -> str:
    """Exact text comparison logic from NB01, Cell 9.2 (not model input)."""
    return re.sub(r"\s+", " ", text).strip()


def prepare_reviews(
    items: Iterable[Mapping[str, Any] | str],
    *,
    product_id: str | None = None,
    dedup_text_without_id: bool = False,
) -> dict[str, Any]:
    """Preserve input text and its offsets; dedup by stable review ID.

    String input is supported for manually supplied reviews. Text-only
    deduplication is opt-in and only affects reviews without an ID.
    Audit rejected records without storing their potentially sensitive text.
    """
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen_ids: set[tuple[str, str]] = set()
    seen_anonymous: set[tuple[str, str]] = set()
    original_count = 0

    for index, raw in enumerate(items):
        original_count += 1
        row = {"text": raw} if isinstance(raw, str) else raw
        if not isinstance(row, Mapping):
            rejected.append({"index": index, "reason": "invalid_record"})
            continue
        text = row.get("text", row.get("comment"))
        if not isinstance(text, str) or not normalize_for_comparison(text):
            rejected.append({"index": index, "reason": "empty_text"})
            continue
        if "\x00" in text:
            rejected.append({"index": index, "reason": "null_character"})
            continue

        raw_rating = row.get("rating")
        if raw_rating is not None and (type(raw_rating) is not int or not 1 <= raw_rating <= 5):
            rejected.append({"index": index, "reason": "invalid_rating"})
            continue

        raw_id = row.get("review_id", row.get("rating_id"))
        review_id = str(raw_id).strip() if raw_id is not None else None
        review_id = review_id or None
        raw_product_id = row.get("product_id", product_id)
        pid = str(raw_product_id).strip() if raw_product_id is not None else ""

        if review_id is not None:
            key = (pid, review_id)
            if key in seen_ids:
                rejected.append({"index": index, "reason": "duplicate_review_id"})
                continue
            seen_ids.add(key)
        elif dedup_text_without_id:
            key = (pid, normalize_for_comparison(text))
            if key in seen_anonymous:
                rejected.append({"index": index, "reason": "duplicate_text_without_id"})
                continue
            seen_anonymous.add(key)

        accepted.append({
            "text": text,  # never normalized: ABSA start/end offsets refer to this string
            "review_id": review_id,
            "product_id": pid or None,
            "rating": raw_rating,
        })

    counts = Counter(record["reason"] for record in rejected)
    return {
        "reviews": accepted,
        "stats": {
            "input": original_count,
            "accepted": len(accepted),
            "rejected": len(rejected),
            "reasons": dict(counts),
        },
        "rejected": rejected,
    }
