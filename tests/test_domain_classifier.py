import unittest
from unittest.mock import patch

from backend.domain_classifier import AUTO_THRESHOLD, CONFIRM_THRESHOLD, detect_product_domain


class DomainClassifierTests(unittest.TestCase):
    def test_shopee_breadcrumb_maps_clothing_domain_automatically(self):
        result = detect_product_domain({
            "name": "Áo thun Coolmate Excool",
            "category_path": ["Thời Trang Nam", "Áo", "Áo Thun"],
        })
        self.assertEqual(result["source"], "vicloabsa")
        self.assertEqual(result["status"], "auto_detected")
        self.assertEqual(result["method"], "shopee_category")
        self.assertGreaterEqual(result["confidence"], AUTO_THRESHOLD)

    def test_shopee_breadcrumb_maps_phone_domain_automatically(self):
        result = detect_product_domain({
            "name": "Samsung Galaxy S26",
            "category_path": ["Điện Thoại", "Điện Thoại Thông Minh"],
        })
        self.assertEqual(result["source"], "visd4sa")
        self.assertEqual(result["status"], "auto_detected")

    def test_product_name_rules_detect_clear_products_without_breadcrumb(self):
        clothing = detect_product_domain({"name": "Áo thun Coolmate Excool"})
        phone = detect_product_domain({"name": "iPhone 17 Pro Max 256GB"})
        self.assertEqual(clothing["source"], "vicloabsa")
        self.assertEqual(clothing["method"], "product_name_rules")
        self.assertEqual(phone["source"], "visd4sa")
        self.assertEqual(phone["status"], "auto_detected")

    def test_brand_only_requires_user_confirmation(self):
        result = detect_product_domain({"name": "Coolmate"})
        self.assertEqual(result["suggested_source"], "vicloabsa")
        self.assertEqual(result["source"], "vicloabsa")
        self.assertEqual(result["status"], "confirmation_required")
        self.assertGreaterEqual(result["confidence"], CONFIRM_THRESHOLD)
        self.assertLess(result["confidence"], AUTO_THRESHOLD)

    def test_ambiguous_or_unrelated_product_stays_unknown(self):
        for product in ({"name": "Sản phẩm mới"}, {"name": "Bình giữ nhiệt inox"}):
            result = detect_product_domain(product)
            self.assertIsNone(result["source"])
            self.assertEqual(result["status"], "unknown")

    def test_conflicting_category_and_product_name_stays_unknown(self):
        result = detect_product_domain({
            "name": "iPhone 17 Pro Max",
            "category_path": ["Thời Trang Nam", "Áo Thun"],
        })
        self.assertIsNone(result["source"])
        self.assertEqual(result["method"], "metadata_text_conflict")

    def test_category_id_mapping_can_be_configured_without_guessing_ids(self):
        with patch.dict("os.environ", {"ABSA_DOMAIN_CATEGORY_ID_MAP": '{"verified-123":"visd4sa"}'}):
            result = detect_product_domain({"name": "Thiết bị", "category_ids": ["verified-123"]})
        self.assertEqual(result["source"], "visd4sa")
        self.assertEqual(result["method"], "shopee_category")


if __name__ == "__main__":
    unittest.main()
