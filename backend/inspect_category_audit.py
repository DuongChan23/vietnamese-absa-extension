
import json
from pathlib import Path

REPORT_PATH = Path("category_audit_report.json")


def show_prediction(aspect):
    if not isinstance(aspect, dict):
        return

    print("  Aspect:", aspect.get("aspect"))
    print("  Category:", aspect.get("category"))
    print("  Sentiment:", aspect.get("sentiment"))
    print("  Span:", aspect.get("start"), aspect.get("end"))
    print("  Sources:", aspect.get("sources"))


def main():
    if not REPORT_PATH.exists():
        print("Không tìm thấy:", REPORT_PATH)
        return

    with REPORT_PATH.open(encoding="utf-8") as f:
        report = json.load(f)

    examples = report.get("examples", {})

    print("\n" + "=" * 65)
    print("1. SER&ACC / Service — CÁC SPAN CHỒNG LẤN")
    print("=" * 65)

    service_cases = examples.get(
        "service_pair_same_span", []
    )

    for i, case in enumerate(service_cases, 1):
        print(f"\nTrường hợp {i}")
        print("Review:", case.get("review"))
        print("Nội dung:", case.get("text"))
        show_prediction(case.get("first"))
        show_prediction(case.get("second"))

    print("\n" + "=" * 65)
    print("2. CATEGORY BẤT THƯỜNG")
    print("=" * 65)

    suspicious = examples.get(
        "suspicious_categories", []
    )

    for i, case in enumerate(suspicious, 1):
        print(f"\nTrường hợp {i}")
        print("Review:", case.get("review"))
        print("Nội dung:", case.get("text"))
        show_prediction(case.get("prediction"))

    print("\n" + "=" * 65)
    print("3. THỐNG KÊ CATEGORY SAU HỢP NHẤT")
    print("=" * 65)

    for category, count in report.get(
        "merged_categories", {}
    ).items():
        print(f"{category}: {count}")

    print("\n" + "=" * 65)
    print("4. CÁC CẶP CATEGORY CÙNG SPAN")
    print("=" * 65)

    for pair, count in report.get(
        "same_span_category_pairs", {}
    ).items():
        print(f"{pair}: {count}")

    print("\n" + "=" * 65)
    print("5. CẢNH BÁO")
    print("=" * 65)

    for key, value in report.get(
        "warnings", {}
    ).items():
        print(f"{key}: {value}")

    print("\nHoàn thành kiểm tra. Không chạy lại AI.")


if __name__ == "__main__":
    main()
