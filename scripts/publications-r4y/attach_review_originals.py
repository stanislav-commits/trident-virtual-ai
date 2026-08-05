#!/usr/bin/env python3
"""Give every row in the review queue an original to be checked against.

Asking someone to judge extracted text without the page it came from is asking
them to guess. RINA, Bureau Veritas, DNV and IACS were imported as text — the
loaders recorded which file each node came from in `sourceRef` but never
uploaded it — so the review screen shows "no original on the platform" exactly
where the doubt is.

This walks the queue, resolves each row's `sourceRef` (its own or the nearest
ancestor's) against the download archives, and attaches the file to the node
that names it. One upload serves every row under that node: a rulebook is
attached once and all its sections inherit it.

    python3 attach_review_originals.py --base … --token …            # dry run
    python3 attach_review_originals.py --base … --token … --commit
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# Where the loaders read from. A sourceRef is "<folder>/<file>", and the folder
# is the archive's own — "Technical circulars/C3850.pdf", "IMO Circulars/…".
ARCHIVES = [
    Path.home() / "Downloads" / "RINA",
    Path.home() / "Downloads" / "BV",
    Path.home() / "Downloads" / "IACS",
    Path.home() / "Downloads" / "R4Y",
    Path.home() / "Downloads" / "dnv-class_2026-07" / "docs",
]


def get(base: str, path: str, token: str | None):
    req = urllib.request.Request(f"{base.rstrip('/')}/{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def post_file(base: str, node_id: str, token: str | None, path: Path) -> None:
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{path.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode(),
        path.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        f"{base.rstrip('/')}/documents/publications/tree/nodes/{node_id}/content",
        data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    urllib.request.urlopen(req, timeout=600).read()


def bv_local_name(ref: str) -> str | None:
    """A Bureau Veritas sourceRef is one of two URLs, and the download sits
    beside both as "<book>_<edition>.pdf":

      …-docs.bureauveritas.com/documents/ni537/apr2008/537-NI_2008-04.pdf
      rulesexplorer.bureauveritas.com/nr467/jul2025          (read by API)
    """
    parts = [p for p in ref.split("/") if p]
    if "documents" in parts:
        at = parts.index("documents")
        if len(parts) >= at + 3:
            return f"{parts[at + 1]}_{parts[at + 2]}.pdf"
        return None
    if len(parts) >= 3 and "bureauveritas.com" in parts[0]:
        return f"{parts[1]}_{parts[2]}.pdf"
    return None


def index_archives() -> dict[str, Path]:
    """`folder/file` and bare `file` → the path on disk."""
    index: dict[str, Path] = {}
    for root in ARCHIVES:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_file() and not path.name.startswith("."):
                index.setdefault(f"{path.parent.name}/{path.name}", path)
                index.setdefault(path.name, path)
    return index


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()

    files = index_archives()
    print(f"в архивах: {len(files) // 2} файлов", flush=True)

    # The queue, one page at a time; only rows that carry text can be reviewed
    # against a page at all.
    wanted: dict[str, Path] = {}      # node id → file to attach
    missing: list[str] = []
    offset = 0
    seen = 0
    while True:
        page = get(args.base,
                   f"documents/publications/tree/review?limit=100&offset={offset}",
                   args.token)
        for node in page["nodes"]:
            seen += 1
            if not (node.get("text") or "").strip():
                continue                      # a photo: vision, not a comparison
            if node.get("originalDocumentId"):
                continue                      # already has one, its own or inherited
            # The file is named by this row or by the nearest branch above it —
            # a RINA section says nothing, the rule it belongs to says the PDF.
            owner_id = node.get("sourceOwnerId") or node["id"]
            ref = node.get("sourceOwnerRef") or node.get("sourceRef")
            if not ref:
                continue
            path = (files.get(ref) or files.get(ref.split("/")[-1])
                    or files.get(bv_local_name(ref) or ""))
            if path:
                wanted[owner_id] = path       # one upload serves every row under it
            else:
                missing.append(ref)
        offset += 100
        if offset >= page["total"]:
            break

    print(f"строк в очереди: {seen} · к загрузке: {len(wanted)} · "
          f"файлов не нашлось: {len(set(missing))}", flush=True)
    for ref in sorted(set(missing))[:5]:
        print(f"   нет файла: {ref}", flush=True)
    if not args.commit:
        for node_id, path in list(wanted.items())[:5]:
            print(f"   {node_id[:8]} ← {path.name[:60]}")
        print("это разведка; чтобы приложить, добавьте --commit", flush=True)
        return 0

    done = failed = 0
    total_mb = 0.0
    for node_id, path in wanted.items():
        try:
            post_file(args.base, node_id, args.token, path)
            done += 1
            total_mb += path.stat().st_size / 1e6
        except urllib.error.HTTPError as e:
            failed += 1
            print(f"   FAIL {path.name[:44]}: {e.code} {e.read()[:100]!r}", flush=True)
        if done % 20 == 0:
            print(f"   {done}/{len(wanted)} · {total_mb:.0f} MB", flush=True)
    print(f"приложено {done}, ошибок {failed}, {total_mb:.0f} MB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
