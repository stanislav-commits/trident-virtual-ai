#!/usr/bin/env python3
"""Two books: the Code of Safe Working Practices, and the Medical Guide.

Both are single works, so — as with SOLAS and MARPOL — the rail's second level
is the book's own division rather than a "Laws and codes" shelf that says
nothing. CoSWP splits into its 34 chapters and 4 appendices; the Medical Guide
into its six parts.

CoSWP numbers its sections inside the chapter (01.01, 01.02) and its annexes
the same way (Annex 01.01), which is what the tree keeps.

  python3 load_books.py --base http://localhost:3001/api --token … --book CoSWP
  python3 load_books.py … --book all
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

COSWP = re.compile(r"^Code of Safe Working Practices for Merc\s*-\s*", re.I)
GUIDE = re.compile(r"^The Ship Captain_?s Medical Guide \(24th\s*-\s*", re.I)


def coswp_category(name: str) -> str | None:
    rest = COSWP.sub("", name)
    if rest.lower().startswith("appendix"):
        return "Appendices"
    if rest.lower().startswith(("index", "contents")):
        return "Front matter"
    return "Chapters"


# "Chapter 01 - Managing Occupational Heal... - 01.01 - Introduction": the
# chapter and its name are two crumbs, and the parser only treats an axis as an
# axis from the second crumb on — so the chapter name fell into the leaf and
# each chapter came apart into several documents. Join them into one crumb.
COSWP_HEAD = re.compile(r"^((?:Chapter|Appendix)\s+\d+)\s*-\s*", re.I)


def coswp_rename(name: str) -> str:
    return COSWP_HEAD.sub(r"\1 — ", COSWP.sub("", name)) or name


def guide_category(name: str) -> str | None:
    rest = GUIDE.sub("", name)
    return "Parts" if rest.lower().startswith("part") else "Front matter"


def guide_rename(name: str) -> str:
    return GUIDE.sub("", name) or name


BOOKS = {
    "CoSWP": t.Spec(
        publication="Code of Safe Working Practices (CoSWP)",
        folder="Code of Safe Working Practices for Merchant Seafarers (CoSWP)",
        jurisdiction="flag:GB",
        category_of=coswp_category,
        rename=coswp_rename,
        # "01.01", "Annex 01.02" — a section number and nothing else.
        code_only=re.compile(r"^(Annex\s+)?\d{2}\.\d{2}$", re.I),
    ),
    "Medical Guide": t.Spec(
        publication="Ship Captain's Medical Guide",
        folder="The Ship Captain_s Medical Guide (24th Edition)",
        jurisdiction="flag:GB",
        category_of=guide_category,
        rename=guide_rename,
    ),
}


if __name__ == "__main__":
    book = None
    for i, a in enumerate(sys.argv):
        if a == "--book":
            book = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
    if not book:
        print("give --book CoSWP|'Medical Guide'|all", file=sys.stderr)
        sys.exit(2)
    rc = 0
    for name in (list(BOOKS) if book == "all" else [book]):
        print(f"\n════════ {name} ════════", flush=True)
        rc |= t.run(BOOKS[name])
    sys.exit(rc)
