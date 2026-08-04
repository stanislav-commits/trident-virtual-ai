#!/usr/bin/env python3
"""DNV rules for classification — Yachts and Ships.

A different source shape from R4Y: not one file per section but eight
monolithic PDFs per rule set, each with a full bookmark tree. The tree is read
from those bookmarks — Part → Chapter → Section — and each section carries the
text of its own pages.

The point of loading Ships alongside Yachts is the cross-references. The yacht
rules defer to the ship rules 359 times, 231 of them in Part 4 alone
("DNV-RU-SHIP Pt.4 Ch.5 shall be applied"), so half the yacht rulebook is
unreadable on its own. Every node is therefore numbered in exactly the form
DNV cites — "Pt.4 Ch.5 Sec.2" — so a reference in the yacht text and the
section it points at are the same string, and search connects them.

  python3 load_dnv.py --base http://localhost:3001/api --token … --set YACHT
  python3 load_dnv.py … --set all --dry-run
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
from pathlib import Path

import fitz

import r4y_tree as t

SRC = Path.home() / "Downloads" / "dnv-class_2026-07" / "docs"

PUBLICATION = "DNV"

# One publication, and the rail splits it the way the rules themselves do:
# Yachts and Ships. The Part becomes a branch inside, because a yacht question
# starts with "which rulebook" and only then with "which part".
SETS = {
    "YACHT": ("Yachts", "DNV-RU-YACHT"),
    "SHIP": ("Ships", "DNV-RU-SHIP"),
}

PART = re.compile(r"^Part (\d+)\s+(.*)$", re.I)
CHAPTER = re.compile(r"^Chapter (\d+)\s+(.*)$", re.I)
SECTION = re.compile(r"^Section (\d+)\s+(.*)$", re.I)


def clean(title: str) -> str:
    """DNV writes some headings with non-breaking spaces — "Section\xa01\xa0General"
    — and only in some Parts, so Part 1 silently produced no sections at all."""
    return re.sub(r"\s+", " ", title.replace("\xa0", " ")).strip()


def page_markdown(page) -> str:
    """One page as text, with its tables kept as tables.

    Plain extraction walks a table cell by cell and leaves a stream —
    "Symbol / Description / Units / L / rule length / m" — where nothing says
    which value belongs to which row. In a class rulebook that is not a
    cosmetic loss: a scantling table read that way can pair the wrong number
    with the wrong parameter, and the answer looks confident either way.
    """
    tables = page.find_tables().tables
    boxes = [fitz.Rect(t.bbox) for t in tables]
    pieces: list[tuple[float, str]] = []
    for x0, y0, x1, y1, text, *_ in page.get_text("blocks"):
        middle = fitz.Point((x0 + x1) / 2, (y0 + y1) / 2)
        if any(box.contains(middle) for box in boxes):
            continue
        if text.strip():
            pieces.append((y0, text.strip()))
    for table, box in zip(tables, boxes):
        try:
            pieces.append((box.y0, table.to_markdown().strip()))
        except Exception:  # noqa: BLE001 — a malformed table is not worth a crash
            continue
    return "\n\n".join(text for _, text in sorted(pieces, key=lambda x: x[0]))


def page_text(doc, first: int, last: int) -> str:
    """Text of a page range, 1-based inclusive."""
    out = [page_markdown(doc[n]) for n in range(first - 1, min(last, doc.page_count))]
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip()


def build_part(path: Path, code: str) -> dict | None:
    """One Part PDF → {category, chapters[]} read off its bookmarks."""
    doc = fitz.open(path)
    toc = doc.get_toc()
    part = next(((lvl, ttl, pg) for lvl, ttl, pg in toc if lvl == 1), None)
    if not part:
        doc.close()
        return None
    m = PART.match(clean(part[1]))
    part_no, part_name = (m.group(1), m.group(2)) if m else ("?", clean(part[1]))
    category = f"Part {part_no} {part_name}".strip()

    # Where each section ends: the page before whatever bookmark comes next at
    # section level or above.
    marks = [(lvl, clean(ttl), pg) for lvl, ttl, pg in toc if lvl <= 3]
    chapters: list[dict] = []
    current: dict | None = None
    for i, (lvl, title, page) in enumerate(marks):
        if lvl == 2 and CHAPTER.match(title):
            c = CHAPTER.match(title)
            current = {"number": f"Ch.{c.group(1)}", "title": c.group(2).strip(),
                       "children": []}
            chapters.append(current)
            continue
        if lvl != 3 or not SECTION.match(title) or current is None:
            continue
        s = SECTION.match(title)
        end = doc.page_count
        for nlvl, _, npage in marks[i + 1:]:
            if nlvl <= 3:
                end = max(page, npage - 1)
                break
        text = page_text(doc, page, end)
        current["children"].append({
            # The citation form DNV itself uses, so a reference in the yacht
            # rules and this node are the same string.
            "number": f"Pt.{part_no} {current['number']} Sec.{s.group(1)}",
            "title": s.group(2).strip(),
            "contentText": text or None,
            "textQuality": t.text_quality(text) if text else 0.0,
            "sourceRef": f"{path.name} p.{page}-{end}",
        })
    doc.close()
    chapters = [c for c in chapters if c["children"]]
    return {"category": category, "chapters": chapters} if chapters else None


def build(code: str) -> list[dict]:
    """One document per Part: Part → Chapter → Section."""
    trees = []
    for path in sorted(SRC.glob(f"{code}-Pt*.pdf")):
        part = build_part(path, code)
        if not part:
            continue
        m = PART.match(part["category"])
        trees.append({
            "number": f"Pt.{m.group(1)}" if m else None,
            "title": m.group(2).strip() if m else part["category"],
            "children": part["chapters"],
        })
    return trees


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--set", required=True, help="YACHT | SHIP | all")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for name in (list(SETS) if args.set == "all" else [args.set]):
        category, code = SETS[name]
        print(f"\n════════ {PUBLICATION} › {category} ════════", flush=True)
        trees = build(code)
        def count(nodes):
            return sum(1 + count(n.get("children") or []) for n in nodes)
        print(f"{len(trees)} parts · {count(trees)} nodes", flush=True)
        for part in trees:
            sec = sum(len(c.get("children") or []) for c in part["children"])
            print(f"   {part['number']} {part['title'][:46]:46} "
                  f"{len(part['children']):3} ch, {sec:4} sec")
        if args.dry_run:
            continue

        created = failed = 0
        t0 = time.time()
        for i, chapter in enumerate(trees, 1):
            try:
                t.post_json(args.base, "documents/publications/tree/import", args.token, {
                    "category": PUBLICATION,
                    "nodeType": category,
                    "jurisdiction": "class:DNV",
                    "nodes": [chapter],
                })
                created += 1
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"FAIL {chapter['title'][:50]}: {e.code} {e.read()[:160]!r}",
                      flush=True)
            if i % 4 == 0:
                print(f"{i}/{len(trees)} ok={created} fail={failed} "
                      f"({i / (time.time() - t0):.1f}/s)", flush=True)
        print(f"DONE parts={created} failed={failed}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
