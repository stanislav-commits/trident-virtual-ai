#!/usr/bin/env python3
"""SOLAS — one convention, so its own divisions go on the rail.

Every other publication is a shelf of separate documents, and its rail reads
Laws / Notices / Forms. SOLAS is a single work: shelving it under "Laws and
codes" adds a level that says nothing and hides the only structure a reader
wants. The rail's second level is therefore the convention's own — Foreword,
Part 1, Part 2 — and the chapters sit inside.

  python3 load_solas.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

# "SOLAS - Part 1 - Chapter II-1 - Construction… - Regulation 1 - Application"
PREFIX = re.compile(r"^SOLAS\s*-\s*(Foreword|Part \d+)\s*-?\s*", re.I)


def category_of(name: str) -> str | None:
    m = PREFIX.match(name)
    if m:
        return m.group(1)
    # The foreword has no part after it — "SOLAS - Foreword".
    return "Foreword" if re.fullmatch(r"SOLAS\s*-\s*Foreword", name, re.I) else "Other"


def rename(name: str) -> str:
    """Drop the two crumbs already spent on the rail, keep the rest as the tree."""
    return PREFIX.sub("", name) or name


SPEC = t.Spec(
    publication="SOLAS",
    folder="SOLAS",
    jurisdiction="international",
    category_of=category_of,
    rename=rename,
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
