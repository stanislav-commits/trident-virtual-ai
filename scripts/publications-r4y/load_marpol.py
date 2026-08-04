#!/usr/bin/env python3
"""MARPOL — a convention in annexes, so the annexes go on the rail.

Same shape as SOLAS: one work, and its own divisions are the second rail level
rather than a "Laws and codes" shelf that says nothing. Two crumbs are spent on
the rail and dropped from the tree — the convention's name, and the annex —
plus a third, the annex's own title ("Regulations for the Prevention of…"),
which repeats on every file inside that annex and would otherwise be a branch
wrapping the whole annex in itself.

Annexes II and III are not in the curated set; the rail shows what exists.

  python3 load_marpol.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

DIVISION = re.compile(
    r"^MARPOL\s*-\s*(Annex [IVX]+|Additional Information|Introduction|Articles"
    r"|Protocol[^-]*)\s*-?\s*", re.I)
# Every file inside an annex repeats the annex's own title as the next crumb.
ANNEX_TITLE = re.compile(r"^Regulations for the Preventi[^-]*-\s*", re.I)


def category_of(name: str) -> str | None:
    m = DIVISION.match(name)
    if not m:
        return "Other"
    division = m.group(1).strip()
    # Four separate protocol documents read better as one shelf.
    return "Protocols" if division.lower().startswith("protocol") else division


def rename(name: str) -> str:
    rest = ANNEX_TITLE.sub("", DIVISION.sub("", name)).strip(" -")
    if rest:
        return rest
    # "MARPOL - Protocol of 1997 to amend…" is division and title at once:
    # strip the division and nothing is left, so the division IS the document.
    m = DIVISION.match(name)
    return m.group(1).strip() if m else name


SPEC = t.Spec(
    publication="MARPOL",
    folder="MARPOL",
    jurisdiction="international",
    category_of=category_of,
    rename=rename,
    # An annex is a flat run of regulations, so each one is its own document
    # and its identifier belongs in `number` — that is also what puts
    # Regulation 9 above Regulation 10 instead of alphabetically below it.
    code_only=re.compile(
        r"^(Regulation|Appendix|Additional Information|Unified Interpretations)"
        r"\s+[IVXLC0-9\-]+$", re.I),
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
