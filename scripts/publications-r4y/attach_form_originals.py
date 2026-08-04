#!/usr/bin/env python3
"""Attach the source PDF to every Forms row, so a form can be handed over whole.

The R4Y loaders took the text out of each PDF and left the file behind: of the
forms on the shelves today, three of Marshall Islands' sixty-one have their
original, one of Gibraltar's forty-nine, none of the Bahamas'. Text is what the
model reads; the file is what a person has to fill in and sign, and no amount
of parsing substitutes for it.

This walks the Forms shelves, matches each row back to the file it was built
from, and posts that file to the node. Matching is by `sourceRef` — the loaders
record it — and falls back to the title, because rows imported before sourceRef
existed have nothing else.

    python3 attach_form_originals.py --base … --token …            # dry run
    python3 attach_form_originals.py --base … --token … --commit

Nothing is uploaded without --commit. Run it against production once the shelf
is agreed: the files are the same, the node ids are not.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import r4y_tree as t

SRC = Path.home() / "Downloads" / "R4Y"
FORMS = "Forms"


def get(base: str, path: str, token: str | None):
    req = urllib.request.Request(f"{base.rstrip('/')}/{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read())


def post_file(base: str, node_id: str, token: str | None, path: Path) -> None:
    """multipart/form-data by hand: one file, one field, no dependencies."""
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
    urllib.request.urlopen(req, timeout=300).read()


def key(text: str) -> str:
    """Titles and file names differ in punctuation only: the loader writes an
    em dash where the export wrote a hyphen, and drops the extension."""
    text = re.sub(r"\.(pdf|docx?|xlsx?)$", "", text, flags=re.I)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def source_files() -> dict[str, Path]:
    """Every file in the R4Y tree, under its path, its name and its shape."""
    index: dict[str, Path] = {}
    for path in SRC.rglob("*"):
        if path.is_file() and not path.name.startswith("."):
            index.setdefault(f"{path.parent.name}/{path.name}", path)
            index.setdefault(path.name, path)
            index.setdefault(key(path.name), path)
    return index


def walk(base: str, token: str | None, node: dict, out: list[dict]) -> None:
    out.append(node)
    if node.get("childCount"):
        for child in get(base, f"documents/publications/tree/nodes/{node['id']}/children",
                         token):
            walk(base, token, child, out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--publication", help="one publication only")
    ap.add_argument("--commit", action="store_true", help="actually upload")
    args = ap.parse_args()

    files = source_files()
    print(f"в {SRC}: {len(files) // 2} файлов", flush=True)

    rail = get(args.base, "documents/publications/tree/rail", args.token)
    shelves = [(entry["category"], shelf["nodeType"])
               for entry in rail for shelf in entry.get("types", [])
               if shelf["nodeType"] == FORMS
               and (not args.publication or entry["category"] == args.publication)]

    total = attached = missing = already = 0
    for publication, shelf in shelves:
        roots = get(args.base,
                    f"documents/publications/tree/roots?category="
                    f"{urllib.parse.quote(publication)}&type={urllib.parse.quote(shelf)}",
                    args.token)
        nodes: list[dict] = []
        for root in roots:
            walk(args.base, args.token, root, nodes)
        rows = [n for n in nodes if not n.get("childCount")]
        found = []
        for node in rows:
            total += 1
            if node.get("documentId"):
                already += 1
                continue
            ref = node.get("sourceRef") or ""
            path = (files.get(ref) or files.get(ref.split("/")[-1])
                    or files.get(key(ref)) or files.get(key(node["title"])))
            if path:
                found.append((node, path))
            else:
                missing += 1
        print(f"   {publication:24} {len(rows):4} строк · без файла {len(found)} "
              f"· уже есть {sum(1 for n in rows if n.get('documentId'))}", flush=True)
        if not args.commit:
            for node, path in found[:3]:
                print(f"      {node['title'][:46]:46} ← {path.name[:44]}")
            continue
        for node, path in found:
            try:
                post_file(args.base, node["id"], args.token, path)
                attached += 1
            except urllib.error.HTTPError as e:
                print(f"      FAIL {node['title'][:40]}: {e.code} {e.read()[:120]!r}",
                      flush=True)

    print(f"\nвсего строк {total} · уже с файлом {already} · "
          f"{'приложено' if args.commit else 'готово к загрузке'} {attached if args.commit else total - already - missing}"
          f" · не нашлось {missing}", flush=True)
    if not args.commit:
        print("это разведка; чтобы залить, добавьте --commit", flush=True)
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used in main only)
    sys.exit(main())
