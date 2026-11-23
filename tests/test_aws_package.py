"""Regression tests for the self-contained AWS Extension release packager."""

import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from deploy.aws.package_extension import ROOT, normalize_api_url, package_extension


class AwsPackageTests(unittest.TestCase):
    def test_release_rewrites_only_zip_configuration_and_permissions(self):
        source = ROOT / "extension"
        original = {
            name: (source / name).read_bytes()
            for name in (
                "manifest.json",
                "services/api_config.js",
                "services/batch_service.js",
            )
        }
        with tempfile.TemporaryDirectory() as directory:
            output = package_extension(
                "https://absa.example.com/",
                Path(directory) / "release.zip",
            )
            with zipfile.ZipFile(output) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                self.assertIn("https://absa.example.com/*", manifest["host_permissions"])
                self.assertIn("https://shopee.vn/*", manifest["host_permissions"])
                self.assertFalse(any("127.0.0.1" in item or "localhost" in item
                                     for item in manifest["host_permissions"]))
                self.assertNotIn("(Local)", manifest["name"])
                self.assertIn(
                    "https://absa.example.com",
                    archive.read("services/api_config.js").decode("utf-8"),
                )
                self.assertEqual(
                    archive.read("services/batch_service.js"),
                    original["services/batch_service.js"],
                )
                self.assertFalse(any(
                    name.startswith(("models/", "backend/", ".git/"))
                    for name in archive.namelist()
                ))
                self.assertIsNone(archive.testzip())
        self.assertEqual(
            original,
            {name: (source / name).read_bytes() for name in original},
        )

    def test_invalid_origins_cannot_produce_a_misconfigured_release(self):
        invalid = (
            "http://example.com",
            "example.com",
            "https://example.com/api",
            "https://user:password@example.com",
            "https://example.com?token=secret",
            "https://example.com/#fragment",
            "https://example.com:bad",
            "https://example.com:0",
            "https://example.com:8443",
            "https://*.example.com",
            "https://bad_host.example",
            "https://-bad.example",
            "https://bad..example",
            "https://example.com\\\\evil",
            "https://example.com" + chr(10),
            "https://example.com%0a.evil",
            "https://127.0.0.1",
            "https://localhost",
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_api_url(value)

    def test_output_inside_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "extension"
            source.mkdir()
            (source / "manifest.json").write_text('{"manifest_version":3}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "outside the extension"):
                package_extension(
                    "https://absa.example.com",
                    source / "release.zip",
                    source,
                )
            self.assertFalse((source / "release.zip").exists())

    def test_credentials_and_unexpected_files_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "extension"
            (source / "services").mkdir(parents=True)
            (source / "manifest.json").write_text(
                json.dumps({
                    "manifest_version": 3,
                    "name": "Test (Local)",
                    "host_permissions": ["http://127.0.0.1/*"],
                }),
                encoding="utf-8",
            )
            (source / "services/api_config.js").write_text(
                'export const API_URL = "http://127.0.0.1:8000";',
                encoding="utf-8",
            )
            for name in (".env", "secret.pem", "debug.log", "data.csv", "backup.zip"):
                (source / name).write_text("private", encoding="utf-8")
            output = package_extension(
                "https://absa.example.com",
                Path(directory) / "release.zip",
                source,
            )
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(
                    set(archive.namelist()),
                    {"manifest.json", "services/api_config.js"},
                )


if __name__ == "__main__":
    unittest.main()
