
"""
Audit ABSA category predictions on exported Shopee reviews.

Run:
    python -m backend.audit_categories reviews.csv

Requirements:
    - FastAPI running at 127.0.0.1:8000
    - CSV exported by the Chrome Extension
    - backend/main.py returning aspects + aspects_merged

No external packages required.
"""

import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_URL = "http://127.0.0.1:8000/predict/batch"
BATCH_SIZE = 10
SOURCE = "unified"

# Audit giữ riêng SER&ACC và Service để đo mức trùng lặp giữa hai nhãn này.
CATEGORY_ALIASES = {
    "GENERAL": "General",
    "General": "General",
    "DESIGN": "Design",
    "Design": "Design",
    "PRICE": "Price",
    "Price": "Price",
}

SUSPICIOUS_CATEGORIES = {
    "SCREEN",
    "BATTERY",
    "FEATURES",
    "PERFORMANCE",
}

SENTIMENTS = {"positive", "neutral", "negative"}


def normalize_category(value):
    value = str(value or "UNKNOWN").strip()
    return CATEGORY_ALIASES.get(value, value)


def normalize_sentiment(value):
    return str(value or "").strip().lower()


def get_span(aspect):
    start = aspect.get("start")
    end = aspect.get("end")

    if (
        type(start) is int
        and type(end) is int
        and 0 <= start < end
    ):
        return start, end

    return None


def get_sources(aspect):
    sources = aspect.get("sources", [])

    if isinstance(sources, str):
        return [sources]

    if isinstance(sources, list):
        return [
            str(source)
            for source in sources
            if source
        ]

    return []


def load_reviews(csv_path):
    with open(
        csv_path,
        "r",
        # Chấp nhận cả CSV có BOM để tên cột đầu tiên vẫn được đọc đúng.
        encoding="utf-8-sig",
        newline="",
    ) as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError("CSV không có header.")

        if "text" not in reader.fieldnames:
            raise ValueError(
                "CSV phải có cột 'text'."
            )

        rows = []

        for row in reader:
            text = (row.get("text") or "").strip()

            if not text:
                continue

            if len(text) > 3000:
                print(
                    "SKIP: Bình luận dài hơn 3000 ký tự"
                )
                continue

            rows.append({
                "product_id": row.get(
                    "product_id", ""
                ),
                "review_id": row.get(
                    "review_id", ""
                ),
                "text": text,
            })

    return rows


def call_backend(reviews):
    payload = {
        "source": SOURCE,
        "reviews": [
            review["text"]
            for review in reviews
        ],
    }

    product_ids = {
        review["product_id"]
        for review in reviews
        if review["product_id"]
    }

    # Chỉ gắn product_id chung khi các ID có dữ liệu trong batch đều trùng nhau.
    if len(product_ids) == 1:
        payload["product_id"] = next(
            iter(product_ids)
        )

    body = json.dumps(
        payload,
        ensure_ascii=False
    ).encode("utf-8")

    request = Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": "application/json"
        },
        method="POST",
    )

    try:
        with urlopen(
            request,
            timeout=180
        ) as response:
            return json.load(response)

    except HTTPError as error:
        raise RuntimeError(
            f"HTTP {error.code}: "
            f"{error.read().decode('utf-8', errors='replace')}"
        ) from error

    except URLError as error:
        raise RuntimeError(
            f"Không kết nối được Backend: {error}"
        ) from error


def run_predictions(reviews):
    results = []
    rejected = []

    for index in range(
        0,
        len(reviews),
        BATCH_SIZE,
    ):
        chunk = reviews[
            index:index + BATCH_SIZE
        ]

        print(
            f"Đang phân tích "
            f"{index + 1}-"
            f"{min(index + BATCH_SIZE, len(reviews))}"
            f"/{len(reviews)}..."
        )

        response = call_backend(chunk)

        results.extend(
            response.get("results", [])
        )

        rejected.extend(
            response.get("rejected", [])
        )

    return results, rejected


def audit(results, rejected):
    raw_categories = Counter()
    merged_categories = Counter()

    raw_sentiments = Counter()
    merged_sentiments = Counter()

    categories_by_source = defaultdict(Counter)

    same_span_pairs = Counter()
    overlap_pairs = Counter()
    sentiment_conflicts = Counter()

    duplicated_examples = []
    overlap_examples = []
    conflict_examples = []
    suspicious_examples = []
    missing_span_examples = []

    source_loss_examples = []

    successful = 0
    reviews_with_aspects = 0
    raw_total = 0
    merged_total = 0

    for index, result in enumerate(results, 1):
        if result.get("status") != "ok":
            continue

        successful += 1

        text = str(
            result.get("text", "")
        )

        raw = result.get("aspects", [])
        merged = result.get(
            "aspects_merged", None
        )

        if not isinstance(raw, list):
            raw = []

        if not isinstance(merged, list):
            raise ValueError(
                "Backend chưa trả aspects_merged. "
                "Hãy kiểm tra main.py."
            )

        if raw:
            reviews_with_aspects += 1

        raw_total += len(raw)
        merged_total += len(merged)

        for aspect in raw:
            category = str(
                aspect.get("category") or "UNKNOWN"
            )

            sentiment = normalize_sentiment(
                aspect.get("sentiment")
            )

            raw_categories[category] += 1
            raw_sentiments[sentiment] += 1

            for source in get_sources(aspect):
                categories_by_source[
                    normalize_category(category)
                ][source] += 1

            if get_span(aspect) is None:
                missing_span_examples.append({
                    "review": index,
                    "text": text,
                    "aspect": aspect,
                })

            if category in SUSPICIOUS_CATEGORIES:
                suspicious_examples.append({
                    "review": index,
                    "text": text,
                    "prediction": aspect,
                })

        for aspect in merged:
            category = normalize_category(
                aspect.get("category")
            )

            sentiment = normalize_sentiment(
                aspect.get("sentiment")
            )

            merged_categories[category] += 1
            merged_sentiments[sentiment] += 1

            raw_count = aspect.get(
                "merged_count", 1
            )

            if raw_count > 1:
                duplicated_examples.append({
                    "review": index,
                    "text": text,
                    "aspect": aspect,
                })

                # Check whether original sources
                # were preserved after merging.
                same_span = get_span(aspect)

                if same_span is not None:
                    expected_sources = set()

                    for original in raw:
                        if (
                            get_span(original)
                            == same_span
                            and normalize_category(
                                original.get("category")
                            ) == category
                            and normalize_sentiment(
                                original.get("sentiment")
                            ) == sentiment
                        ):
                            expected_sources.update(
                                get_sources(original)
                            )

                    actual_sources = set(
                        get_sources(aspect)
                    )

                    missing_sources = (
                        expected_sources - actual_sources
                    )

                    if missing_sources:
                        source_loss_examples.append({
                            "review": index,
                            "category": category,
                            "missing_sources": sorted(
                                missing_sources
                            ),
                            "expected_sources": sorted(
                                expected_sources
                            ),
                            "actual_sources": sorted(
                                actual_sources
                            ),
                        })

        # Compare pairs within the same review.
        for i in range(len(raw)):
            first = raw[i]
            first_span = get_span(first)

            if first_span is None:
                continue

            for j in range(i + 1, len(raw)):
                second = raw[j]
                second_span = get_span(second)

                if second_span is None:
                    continue

                cat1 = normalize_category(
                    first.get("category")
                )
                cat2 = normalize_category(
                    second.get("category")
                )

                sent1 = normalize_sentiment(
                    first.get("sentiment")
                )
                sent2 = normalize_sentiment(
                    second.get("sentiment")
                )

                pair = tuple(
                    sorted([cat1, cat2])
                )

                if first_span == second_span:
                    same_span_pairs[pair] += 1

                    # Specifically inspect ambiguous
                    # service categories.
                    if set(pair) == {
                        "SER&ACC", "Service"
                    }:
                        duplicated_example = {
                            "review": index,
                            "text": text,
                            "first": first,
                            "second": second,
                        }

                        overlap_examples.append(
                            duplicated_example
                        )

                    if sent1 != sent2:
                        sentiment_conflicts[pair] += 1

                        conflict_examples.append({
                            "review": index,
                            "text": text,
                            "first": first,
                            "second": second,
                        })

                else:
                    a, b = first_span
                    c, d = second_span

                    # Span là [start, end): hai đoạn chỉ chạm đầu mút không giao nhau.
                    if max(a, c) < min(b, d):
                        overlap_pairs[pair] += 1

    report = {
        "input": {
            "successful_reviews": successful,
            "rejected_reviews": len(rejected),
            "reviews_with_aspects": reviews_with_aspects,
        },

        "counts": {
            "raw_aspects": raw_total,
            "merged_aspects": merged_total,
            "removed_duplicates": (
                raw_total - merged_total
            ),
        },

        "raw_categories": dict(
            raw_categories.most_common()
        ),

        "merged_categories": dict(
            merged_categories.most_common()
        ),

        "raw_sentiments": dict(
            raw_sentiments
        ),

        "merged_sentiments": dict(
            merged_sentiments
        ),

        "categories_by_source": {
            category: dict(counter)
            for category, counter
            in categories_by_source.items()
        },

        "same_span_category_pairs": {
            " | ".join(pair): count
            for pair, count
            in same_span_pairs.most_common()
        },

        "overlapping_span_category_pairs": {
            " | ".join(pair): count
            for pair, count
            in overlap_pairs.most_common()
        },

        "sentiment_conflict_pairs": {
            " | ".join(pair): count
            for pair, count
            in sentiment_conflicts.most_common()
        },

        "examples": {
            "merged_duplicates": (
                duplicated_examples[:15]
            ),
            "service_pair_same_span": (
                overlap_examples[:15]
            ),
            "sentiment_conflicts": (
                conflict_examples[:15]
            ),
            "suspicious_categories": (
                suspicious_examples[:20]
            ),
            "missing_offsets": (
                missing_span_examples[:15]
            ),
            "lost_sources": (
                source_loss_examples[:15]
            ),
        },

        "warnings": {
            "missing_offsets": len(
                missing_span_examples
            ),
            "suspicious_predictions": len(
                suspicious_examples
            ),
            "lost_source_attribution": len(
                source_loss_examples
            ),
        },
    }

    return report


def show_report(report):
    counts = report["counts"]

    print("\n" + "=" * 55)
    print("ABSA CATEGORY AUDIT")
    print("=" * 55)

    print(
        "Successful reviews:",
        report["input"]["successful_reviews"]
    )

    print(
        "Rejected reviews:",
        report["input"]["rejected_reviews"]
    )

    print(
        "Raw aspects:",
        counts["raw_aspects"]
    )

    print(
        "Merged aspects:",
        counts["merged_aspects"]
    )

    print(
        "Removed duplicates:",
        counts["removed_duplicates"]
    )

    print("\nCATEGORY AFTER MERGING")
    for name, count in report[
        "merged_categories"
    ].items():
        print(f"  {name:18s}: {count}")

    print("\nSOURCE ATTRIBUTION")
    for category, sources in report[
        "categories_by_source"
    ].items():
        print(
            f"  {category:18s}: {sources}"
        )

    print("\nSAME-SPAN CATEGORY PAIRS")
    for pair, count in report[
        "same_span_category_pairs"
    ].items():
        print(f"  {pair}: {count}")

    print("\nSENTIMENT CONFLICT PAIRS")
    for pair, count in report[
        "sentiment_conflict_pairs"
    ].items():
        print(f"  {pair}: {count}")

    print("\nWARNINGS")
    for name, value in report[
        "warnings"
    ].items():
        print(f"  {name}: {value}")

    print(
        "\nLưu ý: Trùng span chưa đủ để khẳng định "
        "hai category có cùng ý nghĩa."
    )


def main():
    if len(sys.argv) < 2:
        print(
            "Usage: python -m "
            "backend.audit_categories reviews.csv"
        )
        sys.exit(1)

    csv_path = Path(
        sys.argv[1]
    ).expanduser().resolve()

    if not csv_path.is_file():
        raise FileNotFoundError(csv_path)

    reviews = load_reviews(csv_path)

    if not reviews:
        raise ValueError(
            "Không có bình luận hợp lệ trong CSV."
        )

    print(
        f"Đã đọc {len(reviews)} bình luận."
    )

    results, rejected = run_predictions(
        reviews
    )

    report = audit(
        results,
        rejected
    )

    show_report(report)

    output = Path(
        "category_audit_report.json"
    )

    output.write_text(
        json.dumps(
            report,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(
        "\nĐã lưu báo cáo:",
        output.resolve()
    )


if __name__ == "__main__":
    main()
