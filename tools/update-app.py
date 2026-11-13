#!/usr/bin/env python3
"""Fetch/update the official nRF Connect Power Profiler app for the web build.

Reads Nordic's official source.json feed (the same one the launcher uses),
finds the pc-nrfconnect-ppk entry, compares with what is already published
under site/app/, and downloads + sha1-verifies + extracts the newest tarball
into the site tree, then rewrites site/manifest.json so the loader picks it
up. Old versions are pruned, keeping --keep newest.

stdlib only. Works on any OS.
    update-app.py --check   # only report what would happen
    update-app.py           # fetch + install into site/app
"""
import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

SOURCE_JSON_URL = (
    "https://files.nordicsemi.com/artifactory/swtools/external/ncd/"
    "apps/official/source.json"
)
APP_NAME = "pc-nrfconnect-ppk"
DISPLAY_NAME = "Power Profiler"
SITE_DIR = Path(__file__).resolve().parent.parent / "site"
APP_DIR = SITE_DIR / "app"
MANIFEST = SITE_DIR / "manifest.json"


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode())


def fetch_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def find_app_meta(source_url: str) -> dict:
    source = fetch_json(source_url)
    for entry in source.get("apps", []):
        if entry.rstrip("/").endswith(APP_NAME + ".json"):
            return fetch_json(entry)
    raise SystemExit(f"{APP_NAME} not found in {source_url}")


def download_and_extract(meta: dict, check_only: bool) -> tuple[str, str]:
    latest = meta["latestVersion"]
    versioned_dir = APP_DIR / f"{APP_NAME}-{latest}"
    marker = versioned_dir / ".ok"
    if marker.exists():
        print(f"already published: {latest} ({versioned_dir})")
        return latest, versioned_dir.name

    version = meta["versions"][latest]
    url = version["tarballUrl"]
    expected = version.get("shasum")
    print(f"downloading {latest} ...")
    blob = fetch_bytes(url)
    got = hashlib.sha1(blob).hexdigest()
    if expected and got != expected:
        raise SystemExit(f"sha1 mismatch: expected {expected}, got {got}")
    if check_only:
        shutil.rmtree  # no-op reference to keep flake quiet
        print(f"verified sha1 of {latest}: OK (would publish)")
        return latest, versioned_dir.name

    tmpdir = Path(tempfile.mkdtemp(prefix="ppkweb-"))
    try:
        tgz = tmpdir / "app.tgz"
        tgz.write_bytes(blob)
        extract_dir = tmpdir / "x"
        extract_dir.mkdir()
        with tarfile.open(tgz) as tf:
            tf.extractall(extract_dir)
        pkg = extract_dir / APP_NAME
        if not (pkg / "package.json").exists():
            pkg = extract_dir / "package"
        if not (pkg / "package.json").exists():
            raise SystemExit("unexpected tarball layout")
        pkg_json = json.loads((pkg / "package.json").read_text())
        pins = pkg_json.get("nrfConnectForDesktop", {}).get("nrfutil", {})
        # only dist/ is served in the browser; keep the tree small
        if not (pkg / "dist" / "bundle.js").exists():
            raise SystemExit("dist/bundle.js missing from tarball")
        if versioned_dir.exists():
            shutil.rmtree(versioned_dir)
        versioned_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(pkg / "dist", versioned_dir)
        marker.write_text(f"sha1:{got}\nversion:{latest}\n")
        print(f"published {latest} -> {versioned_dir}")
        print(f"nrfutil pins: {json.dumps(pins)}")
        return latest, versioned_dir.name
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def write_manifest(version: str, app_dir_name: str) -> None:
    MANIFEST.write_text(json.dumps({"version": version, "app": app_dir_name}, indent=1) + "\n")
    print(f"wrote {MANIFEST} (version {version}, app dir {app_dir_name})")


def prune_old(keep: str, keep_n: int) -> None:
    dirs = sorted(
        (d for d in APP_DIR.iterdir() if d.is_dir() and d.name.startswith(APP_NAME)),
        key=lambda d: d.name,
    )
    for d in dirs[:-keep_n] if keep_n else []:
        if keep in d.name:
            continue
        print(f"removing old {d.name}")
        shutil.rmtree(d)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE_JSON_URL, help="source.json url")
    ap.add_argument("--check", action="store_true", help="only report")
    ap.add_argument("--keep", type=int, default=2, help="versions to keep")
    args = ap.parse_args()

    meta = find_app_meta(args.source)
    latest = meta["latestVersion"]
    print(f"{DISPLAY_NAME} latest on official feed: {latest}")
    published, dirname = download_and_extract(meta, args.check)
    if not args.check:
        write_manifest(published, dirname)
        prune_old(published, args.keep)
    if published != latest:
        print(f"NOTE: published {published}, newer {latest} available")
    # manifest must exist even when nothing new was installed
    if not args.check and MANIFEST.exists() is False:
        write_manifest(published, dirname)


if __name__ == "__main__":
    main()
