#!/usr/bin/env python3
"""EU Legislation — sorted by the kind of act, and pulled back from the UK shelf.

Ten European acts were filed under `United Kingdom` in the source library —
the misfiling the operator spotted early on. They are read from there too, and
only they: everything else in that folder belongs to the UK.

Every act is one file named `YYYY_NNNN (Kind) - Title`, so the kind is the
shelf, the year and number are the identifier, and the title is what is left.
The years span 2004 to 2026, which is why the identifier leads with the year.

  python3 load_eu.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

ACT = re.compile(r"^(?P<year>\d{4})_(?P<num>\d{4})\s*\((?P<kind>[A-Za-z]+)\)\s*[-–]?\s*(?P<title>.*)$")

KINDS = {
    "regulation": "Regulations",
    "directive": "Directives",
    "decision": "Decisions",
    "recommendation": "Recommendations",
}


def category_of(name: str) -> str | None:
    m = ACT.match(name)
    if m:
        return KINDS.get(m.group("kind").lower(), "Other")
    # A corrigendum names the act it corrects rather than carrying its own
    # number; it is still EU law, just not filed like the rest.
    return "Other" if name.lower().startswith("corrigendum") else None


def rename(name: str) -> str:
    """`2024_3099 (Directive) - Amending…` → `2024/3099 - Amending…`."""
    m = ACT.match(name)
    if not m:
        return name
    return f"{m.group('year')}/{m.group('num')} - {m.group('title').strip() or name}"


SPEC = t.Spec(
    publication="EU Legislation",
    folder="EU Legislation",
    jurisdiction="eu",
    # Both folders defer to category_of, which keeps only the European acts
    # out of the United Kingdom one.
    folder_categories={"EU Legislation": None, "United Kingdom": None},
    category_of=category_of,
    rename=rename,
    code_only=re.compile(r"^\d{4}/\d{4}$"),
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
