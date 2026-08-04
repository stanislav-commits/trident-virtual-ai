#!/usr/bin/env python3
"""R4Y bulk refresh: new/changed files in ~/Downloads/R4Y → only the affected
publications re-upload. (Single new articles are simpler to add from the
admin panel — the "Add article" button on the publication row.)

Deterministic stages + FIXED band labels mean a new notice lands in an
existing slot; this script re-runs the pipeline, diffs fingerprints against
the snapshot taken at the last upload, and re-uploads only what changed.

Usage:
  python3 update.py --base <api> --user admin --password …  [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
SNAPSHOT = OUT / "uploaded-snapshot.json"
HERE = Path(__file__).resolve().parent


def doc_fingerprints() -> dict[str, str]:
    manifest = json.load(open(OUT / "update-manifest.json"))
    src_root = Path.home() / "Downloads" / "R4Y"
    per_doc: dict[str, list[str]] = {}
    for src, m in sorted(manifest.items()):
        key = m["md"] or f"original::{m['original']}"
        stat = (src_root / src).stat()
        per_doc.setdefault(key, []).append(f"{src}|{m['anchor']}|{stat.st_size}")
    return {
        k: hashlib.sha256("\n".join(v).encode()).hexdigest()
        for k, v in per_doc.items()
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for step in ("extract.py", "build_plan.py", "merge_md.py"):
        print(f"── {step}")
        r = subprocess.run([sys.executable, str(HERE / step)])
        if r.returncode != 0:
            print(f"{step} failed — stopping before any upload")
            return 1

    fresh = doc_fingerprints()
    old = json.loads(SNAPSHOT.read_text()) if SNAPSHOT.exists() else {}
    changed = [k for k, h in fresh.items() if old.get(k) != h]
    print(f"{len(changed)} of {len(fresh)} documents changed since last upload")
    for k in changed[:20]:
        print("  ", k[:110])
    if args.dry_run or not changed:
        return 0

    sys.path.insert(0, str(HERE))
    import load as loader  # noqa: PLC0415

    manifest = json.load(open(OUT / "update-manifest.json"))
    plan = json.load(open(OUT / "merge-plan.json"))
    login = loader.api(
        args.base, "auth/login",
        data=json.dumps({"userId": args.user, "password": args.password}).encode(),
        content_type="application/json",
    )
    token = login["access_token"]
    existing = loader.api(args.base, "documents/publications/catalog", token)
    slot_id = {(e.get("category"), e["title"]): e["id"] for e in existing}

    changed_set = set(changed)
    ok = fail = 0
    for src, m in manifest.items():
        key = m["md"] or f"original::{m['original']}"
        if key not in changed_set:
            continue
        changed_set.discard(key)
        g = plan[m["group"]]
        title = m["title"]
        cat_key = (g["category"], title)
        try:
            cat_id = slot_id.get(cat_key)
            if not cat_id:
                created = loader.api(
                    args.base, "documents/publications/catalog", token,
                    data=json.dumps({
                        "title": title, "category": g["category"],
                        "jurisdiction": g["jurisdiction"], "series": g["identity"],
                    }).encode(),
                    content_type="application/json",
                )
                cat_id = created["id"]
            if m.get("original"):
                fpath = loader.SRC / m["original"]
                mime = loader.MIME.get(fpath.suffix.lower(), "application/octet-stream")
            else:
                fpath = OUT / "md" / m["md"]
                mime = "text/markdown"
            body, ctype = loader.multipart("file", fpath.name, fpath.read_bytes(), mime)
            loader.api(args.base, f"documents/publications/catalog/{cat_id}/file",
                       token, data=body, content_type=ctype)
            ok += 1
            print(f"updated: {title[:90]}")
        except Exception as e:  # noqa: BLE001
            fail += 1
            print(f"FAIL {title[:80]}: {e}")

    if not fail:
        SNAPSHOT.write_text(json.dumps(fresh))
        print(f"snapshot updated — {ok} documents refreshed")
    else:
        print(f"{fail} failures — snapshot NOT updated, rerun after fixing")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
