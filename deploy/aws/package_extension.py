"""Build a production Extension ZIP without modifying the local source tree."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EXTENSION = ROOT / "extension"
ALLOWED_SUFFIXES = frozenset({
    ".css", ".html", ".ico", ".js", ".json", ".otf", ".png",
    ".svg", ".ttf", ".webp", ".woff", ".woff2",
})
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def normalize_api_url(value: str) -> str:
    """Accept only a public HTTPS origin; API paths and credentials are forbidden."""
    raw = str(value or "").strip()
    if not raw or any(ord(char) < 32 for char in raw):
        raise ValueError("API URL must be a public HTTPS origin.")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("API URL contains an invalid hostname or port.") from exc

    if (
        parsed.scheme.lower() != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.netloc.endswith(":")
        or port not in (None, 443)
    ):
        raise ValueError("API URL must be an HTTPS origin without credentials, path, query, or non-standard port.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("API URL must include a hostname.")
    try:
        hostname = hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError("API URL hostname is invalid.") from exc
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass  # DNS hostnames are expected; literal IP addresses are not.
    else:
        raise ValueError("API URL must use a DNS hostname, not an IP address.")
    labels = hostname.split(".")
    if len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise ValueError("API URL hostname is invalid.")
    if hostname in LOCAL_HOSTS or hostname.endswith(".localhost"):
        raise ValueError("API URL must not point to localhost.")
    return f"https://{hostname}"


def _safe_extension_files(source: Path) -> list[Path]:
    files: list[Path] = []
    for path in source.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Extension source contains a symlink: {path.relative_to(source)}")
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.suffix.lower() in ALLOWED_SUFFIXES:
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(source).as_posix())


def package_extension(
    api_url: str,
    output: str | Path,
    source: str | Path = DEFAULT_EXTENSION,
) -> Path:
    """Create a ZIP containing allow-listed Extension assets and production API config."""
    api_origin = normalize_api_url(api_url)
    raw_source = Path(source).expanduser()
    if raw_source.is_symlink():
        raise ValueError("Extension source must not be a symlink.")
    source_root = raw_source.resolve(strict=True)
    if not source_root.is_dir():
        raise NotADirectoryError(source_root)

    output_path = Path(output).expanduser().resolve()
    if output_path == source_root or source_root in output_path.parents:
        raise ValueError("Output ZIP must be outside the extension source directory.")
    if output_path.exists() and output_path.is_dir():
        raise IsADirectoryError(output_path)

    files = _safe_extension_files(source_root)
    required = {Path("manifest.json"), Path("services/api_config.js")}
    relative_files = {path.relative_to(source_root) for path in files}
    missing = required - relative_files
    if missing:
        raise FileNotFoundError("Extension package is missing required files: " + ", ".join(sorted(p.as_posix() for p in missing)))

    manifest_path = source_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Extension manifest.json is not valid UTF-8 JSON.") from exc
    if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
        raise ValueError("Only a Manifest V3 Extension can be packaged.")

    name = str(manifest.get("name") or "Vietnamese ABSA Analyzer")
    manifest["name"] = re.sub(r"\s*\(Local\)\s*$", "", name).strip() or "Vietnamese ABSA Analyzer"
    permissions = manifest.get("host_permissions", [])
    if not isinstance(permissions, list) or any(not isinstance(item, str) for item in permissions):
        raise ValueError("manifest.json host_permissions must be a list of strings.")
    permissions = [
        item for item in permissions
        if urlsplit(item).hostname not in LOCAL_HOSTS
    ]
    api_host_permission = f"https://{urlsplit(api_origin).hostname}/*"
    manifest["host_permissions"] = sorted(set([*permissions, api_host_permission]))

    api_config_path = source_root / "services" / "api_config.js"
    api_config = api_config_path.read_text(encoding="utf-8")
    pattern = r"(?m)^(\s*export\s+const\s+API_URL\s*=\s*)\"(?:[^\"\\]|\\.)*\"(\s*;\s*)$"
    if len(re.findall(pattern, api_config)) != 1:
        raise ValueError("services/api_config.js must contain exactly one exported API_URL string.")
    api_config = re.sub(
        pattern,
        lambda match: f"{match.group(1)}{json.dumps(api_origin)};",
        api_config,
        count=1,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent, delete=False
    )
    temporary_path = Path(temporary.name)
    temporary.close()
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in files:
                relative = path.relative_to(source_root)
                if relative == Path("manifest.json"):
                    payload = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                elif relative == Path("services/api_config.js"):
                    payload = api_config.encode("utf-8")
                else:
                    payload = path.read_bytes()
                archive.writestr(relative.as_posix(), payload)
        with zipfile.ZipFile(temporary_path, "r") as archive:
            bad_file = archive.testzip()
            if bad_file is not None:
                raise ValueError(f"Generated ZIP failed integrity validation at {bad_file}.")
        temporary_path.replace(output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", required=True, help="Public HTTPS API origin, e.g. https://absa.example.com")
    parser.add_argument("--output", required=True, type=Path, help="Output ZIP path outside extension/")
    args = parser.parse_args()
    try:
        result = package_extension(args.api_url, args.output)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(result)


if __name__ == "__main__":
    main()
