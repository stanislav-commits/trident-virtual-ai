#!/usr/bin/env python3
"""R4Y phase 3: load merged publications into the platform catalog via the
normal REST API — one file per request (multi-file batches are the flaky
path), resumable (slots that already hold a file are skipped).

Also reconciles the ORIGINAL hand-made expected-list: placeholders the R4Y
library now covers (SOLAS, MARPOL, COSWP, M-notices…) are retired so the
catalog does not show an empty "SOLAS — Consolidated Edition" next to the
real SOLAS chapters; the remaining placeholders (Admiralty/ITU/ICS products
the library does not carry) move to the "Reference shelf" category.

Usage:
  python3 load.py --base http://localhost:3001/api --user admin --password …
  python3 load.py … --categories SOLAS Malta      # sample
  python3 load.py … --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
MD = OUT / "md"
SRC = Path.home() / "Downloads" / "R4Y"

MIME = {
    ".pdf": "application/pdf", ".md": "text/markdown", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".tif": "image/tiff", ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

# Old expected-list placeholders now covered by the library → retire (they
# are empty; deleting loses nothing). Everything matched must ALSO have its
# covering category present in the load, else the placeholder stays.
RETIRE_WHEN_COVERED: list[tuple[str, str]] = [
    (r"^SOLAS — Consolidated", "SOLAS"),
    (r"^MARPOL — Consolidated", "MARPOL"),
    (r"^COSWP", "Code of Safe Working Practices for Merchant Seafarers (CoSWP)"),
    (r"^MCA MGN / MSN / MIN", "MCA M Notices"),
    (r"^International Medical Guide", "WHO"),
    (r"^Ship Captain's Medical Guide", "The Ship Captain_s Medical Guide (24th Edition)"),
    (r"^Load Line Convention", "Misc (International)"),
    (r"^MLC 2006", "ILO"),
    (r"^STCW Convention", "STCW"),
    (r"^Tonnage Convention", "Misc (International)"),
    (r"^HSC Code", "Codes"),
    (r"^Flag State Marine Notices", "Malta"),
    (r"^National Maritime Regulations", "Malta"),
    (r"^WHO International Health Regulations", "WHO"),
    (r"^Commercial Yacht Code \(CYC\)", "Malta"),
]
REFERENCE_SHELF = "Reference shelf (to acquire)"


def api(base: str, path: str, token: str | None = None, data: bytes | None = None,
        content_type: str | None = None, method: str | None = None):
    req = urllib.request.Request(f"{base}/{path}", data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read() or b"null")


def multipart(field: str, filename: str, payload: bytes, mime: str,
              extra: dict[str, str] | None = None) -> tuple[bytes, str]:
    boundary = "----r4yload"
    parts = b""
    for k, v in (extra or {}).items():
        parts += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
        ).encode()
    parts += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    return parts, f"multipart/form-data; boundary={boundary}"


def reconcile_placeholders(base: str, token: str, loaded_categories: set[str]) -> None:
    existing = api(base, "documents/publications/catalog", token)
    retired = kept = 0
    for e in existing:
        if e.get("category") is not None:
            continue
        title = e["title"]
        matched = next(
            (cat for rx, cat in RETIRE_WHEN_COVERED
             if re.match(rx, title) and cat in loaded_categories),
            None,
        )
        if matched and not e.get("fileName"):
            api(base, f"documents/publications/catalog/{e['id']}", token,
                method="DELETE")
            retired += 1
        else:
            api(base, f"documents/publications/catalog/{e['id']}", token,
                data=json.dumps({"category": REFERENCE_SHELF}).encode(),
                content_type="application/json", method="PATCH")
            kept += 1
    print(f"placeholders: retired {retired} covered, moved {kept} to '{REFERENCE_SHELF}'")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--categories", nargs="*", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    plan = json.load(open(OUT / "merge-plan.json"))
    manifest = json.load(open(OUT / "update-manifest.json"))

    docs: dict[str, dict] = {}
    for src, m in manifest.items():
        g = plan[m["group"]]
        if m.get("original"):
            docs[f"original::{src}"] = {
                "title": m["title"], "category": g["category"],
                "jurisdiction": g["jurisdiction"], "series": g["identity"],
                "anchors": [m["title"]], "original": src,
            }
            continue
        md_rel = m["md"]
        if md_rel not in docs:
            docs[md_rel] = {
                "title": m.get("title") or Path(md_rel).stem,
                "category": g["category"], "jurisdiction": g["jurisdiction"],
                "series": g["identity"], "anchors": [],
            }
        docs[md_rel]["anchors"].append(m["anchor"])
    for v in docs.values():
        v["contents"] = "\n".join(v.pop("anchors"))[:19900] or None

    items = sorted(docs.items())
    if args.categories:
        wanted = set(args.categories)
        items = [(k, v) for k, v in items if v["category"] in wanted]
    if args.limit:
        items = items[: args.limit]
    print(f"{len(items)} documents to load", flush=True)
    if args.dry_run:
        for k, v in items[:20]:
            print(f"  {v['category']} :: {v['title'][:80]}")
        return 0

    login = api(args.base, "auth/login",
                data=json.dumps({"userId": args.user, "password": args.password}).encode(),
                content_type="application/json")
    token = login["access_token"]

    reconcile_placeholders(args.base, token, {v["category"] for _, v in items})

    existing = api(args.base, "documents/publications/catalog", token)
    have_file = {(e.get("category"), e["title"]): bool(e.get("fileName")) for e in existing}
    slot_id = {(e.get("category"), e["title"]): e["id"] for e in existing}

    ok = skip = fail = 0
    t0 = time.time()
    for i, (md_rel, meta) in enumerate(items, 1):
        key = (meta["category"], meta["title"])
        try:
            if have_file.get(key):
                skip += 1
                continue
            cat_id = slot_id.get(key)
            if not cat_id:
                created = api(args.base, "documents/publications/catalog", token,
                              data=json.dumps({
                                  "title": meta["title"],
                                  "category": meta["category"],
                                  "jurisdiction": meta["jurisdiction"],
                                  "series": meta["series"],
                                  "contents": meta["contents"],
                              }).encode(),
                              content_type="application/json")
                cat_id = created["id"]
                slot_id[key] = cat_id
            if meta.get("original"):
                fpath = SRC / meta["original"]
                mime = MIME.get(fpath.suffix.lower(), "application/octet-stream")
            else:
                fpath = MD / md_rel
                mime = "text/markdown"
            payload = fpath.read_bytes()
            body, ctype = multipart("file", fpath.name, payload, mime)
            api(args.base, f"documents/publications/catalog/{cat_id}/file", token,
                data=body, content_type=ctype)
            ok += 1
        except urllib.error.HTTPError as e:
            fail += 1
            print(f"FAIL {md_rel}: {e.code} {e.read()[:200]!r}", flush=True)
        except Exception as e:  # noqa: BLE001 — log and continue
            fail += 1
            print(f"FAIL {md_rel}: {e}", flush=True)
        if i % 25 == 0:
            rate = i / (time.time() - t0)
            print(f"{i}/{len(items)} ok={ok} skip={skip} fail={fail} ({rate:.1f}/s)", flush=True)
    print(f"DONE ok={ok} skip={skip} fail={fail}", flush=True)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
