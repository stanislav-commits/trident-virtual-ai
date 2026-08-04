#!/usr/bin/env python3
"""IACS — the class societies' common requirements, minus the cargo-ship half.

1938 files arrive; roughly a third never reaches the tree, for three reasons
that have nothing to do with yachts:

  * 323 are marked Deleted / Withdrawn / Superseded in their own file name.
    A requirement that IACS itself has withdrawn is not guidance any more, and
    in a library the model searches it reads exactly like one that stands.
  * 448 are "(UL)" twins — the same document with change bars. One copy is
    enough; the clean one is it.
  * 46 are Common Structural Rules, which by their own scope apply to bulk
    carriers of 90 m and over and oil tankers of 150 m and over. Not a yacht
    document in the folder.

Then the ship-type filter the operator asked for: bulk carriers, tankers, gas
carriers, container ships, ro-ro. What is left is general ship engineering —
anchoring, machinery, electrical, welding, surveys — plus anything naming
yachts directly.

IACS cites by code (UR A3, UI SC123, Rec 10) and the codes are printed inside
the documents rather than in most file names, so each one is read from its
first page.

  python3 load_iacs.py --base http://localhost:3001/api --token …
  python3 load_iacs.py … --dry-run
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
import urllib.error
from pathlib import Path

import r4y_tree as t

SRC = Path.home() / "Downloads" / "IACS"
PUBLICATION = "IACS"

FOLDERS = {
    "Unified Requirements": "Unified Requirements",
    "Unified Interpretations": "Unified Interpretations",
    "Recommendations": "Recommendations",
    "Procedural Requirements": "Procedural Requirements",
    # Common Structural Rules is bulk carriers and oil tankers by definition.
}

# Also the redirect stubs: a one-line file whose whole content is "re-categorised
# as UR Z16". It answers no question and outranks nothing — it just adds a hit.
DEAD = re.compile(r"\b(Deleted|Withdrawn|Superseded)\b|"
                  r"Re-?categoris|Renumbered|Incorporated in(to)?\b|Replaced by\b", re.I)
UL_TWIN = re.compile(r"\(\s*(?:Forthcoming,\s*)?UL\s*\)\s*$", re.I)

# The merchant-fleet specialities to leave out. Yacht material overrides — a
# document that names yachts stays whatever else it mentions.
SHIP_TYPE = re.compile(
    r"bulk carrier|bulk-carrier|ore carrier|corrugated bulkhead|cargo hold|"
    r"\btankers?\b|oil tanker|chemical tanker|crude oil|cargo oil|inert gas|"
    r"\bLNG\b|\bLPG\b|liquefied gas|IGC Code|IGF Code|gas carrier|"
    r"container ship|containership|lashing|"
    r"\bro-ro\b|roro|vehicle deck|"
    r"IMSBC|solid bulk|\bgrain\b", re.I)
YACHTS = re.compile(r"yacht|pleasure (craft|vessel)", re.I)

# "UR A3", "UI SC123", "Rec 10" — the code sits on the first page, usually as
# the first line, repeated in the running head.
CODE = re.compile(r"^\s*((?:[A-Z]{1,3}\d{1,3}(?:\.\d+)?|SC\d{1,3}|Rec\.?\s?\d{1,3}))\b")


def document_code(path: Path) -> str | None:
    try:
        out = subprocess.run(["pdftotext", "-f", "1", "-l", "1", str(path), "-"],
                             capture_output=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None
    for line in out.stdout.decode("utf8", "replace").splitlines():
        m = CODE.match(line)
        if m:
            return re.sub(r"\s+", " ", m.group(1)).strip()
    return None


def title_of(stem: str) -> str:
    """Drop the revision tail the file name carries after the subject."""
    title = re.sub(r"\s*[–-]\s*(Rev\.?\s?\d[^–-]*|New\b[^–-]*|Corr\.?\s?\d[^–-]*)"
                   r"(\s*[–-]\s*Clean)?\s*$", "", stem, flags=re.I)
    title = re.sub(r"\s*[–-]\s*Clean\s*$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip() or stem


def collect(verbose: bool = False) -> tuple[list[tuple[Path, str, str]], dict]:
    kept: list[tuple[Path, str, str]] = []
    stats = {"dead": 0, "ul": 0, "csr": 0, "ship_type": 0, "kept": 0}
    for folder, category in FOLDERS.items():
        for path in sorted((SRC / folder).iterdir()):
            if not path.is_file() or path.name.startswith("."):
                continue
            stem = path.stem
            if DEAD.search(stem):
                stats["dead"] += 1
                continue
            if UL_TWIN.search(stem):
                stats["ul"] += 1
                continue
            if SHIP_TYPE.search(stem) and not YACHTS.search(stem):
                stats["ship_type"] += 1
                continue
            kept.append((path, category, stem))
    stats["csr"] = sum(1 for p in (SRC / "Common Structural Rules").iterdir()
                       if p.is_file() and not p.name.startswith("."))
    stats["kept"] = len(kept)
    return kept, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files, stats = collect()
    print(f"отброшено: {stats['dead']} удалённых, {stats['ul']} (UL)-копий, "
          f"{stats['csr']} CSR, {stats['ship_type']} по типу судна", flush=True)
    print(f"загружается: {stats['kept']}", flush=True)

    by_category: dict[str, list[dict]] = {}
    for i, (path, category, stem) in enumerate(files, 1):
        text = ""
        try:
            out = subprocess.run(["pdftotext", str(path), "-"],
                                 capture_output=True, timeout=90)
            text = out.stdout.decode("utf8", "replace").strip()
        except (subprocess.TimeoutExpired, OSError):
            pass
        by_category.setdefault(category, []).append({
            "number": document_code(path),
            "title": title_of(stem),
            "contentText": text or None,
            "textQuality": t.text_quality(text) if text else 0.0,
            "sourceRef": f"{path.parent.name}/{path.name}",
        })
        if args.dry_run and i >= 40:
            break

    for category, nodes in by_category.items():
        print(f"   {category:26} {len(nodes):4}")
    if args.dry_run:
        for n in by_category.get("Unified Requirements", [])[:6]:
            print(f"      [{n['number'] or '—'}] {n['title'][:66]}")
        return 0

    created = failed = 0
    t0 = time.time()
    for category, nodes in by_category.items():
        for chunk in (nodes[i:i + 40] for i in range(0, len(nodes), 40)):
            try:
                t.post_json(args.base, "documents/publications/tree/import", args.token, {
                    "category": PUBLICATION,
                    "nodeType": category,
                    "jurisdiction": "international",
                    "nodes": chunk,
                })
                created += len(chunk)
            except urllib.error.HTTPError as e:
                failed += len(chunk)
                print(f"FAIL {category}: {e.code} {e.read()[:160]!r}", flush=True)
            print(f"   {category}: {created} ok, {failed} fail "
                  f"({created / max(time.time() - t0, 1):.1f}/s)", flush=True)
    print(f"DONE documents={created} failed={failed}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
