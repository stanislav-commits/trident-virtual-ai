#!/usr/bin/env python3
"""ILO and WHO — two small publications sharing one contaminated folder pair.

Thirty-five files sit in BOTH source folders and belong to neither: IMO
resolutions, a Malta legal notice, Gibraltar notices, UK surveyor
instructions, piracy reports. Twelve of them are copies of files already
filed correctly elsewhere and are simply dropped here; the rest are handled by
whichever publication owns them (the IMO loader takes its own).

What is left is genuinely theirs — ILO's conventions and the MLC amendments,
WHO's sanitation and drinking-water guidance.

  python3 load_ilo_who.py --base http://localhost:3001/api --token … --body ILO
  python3 load_ilo_who.py … --body all
"""
from __future__ import annotations

import os
import re
import sys

import r4y_tree as t


def shared_files() -> set[str]:
    """Names present in both folders — the bundle that belongs to neither."""
    ilo = {os.path.splitext(f)[0] for f in os.listdir(t.SRC / "ILO")
           if not f.startswith(".")}
    who = {os.path.splitext(f)[0] for f in os.listdir(t.SRC / "WHO")
           if not f.startswith(".")}
    return ilo & who


SHARED = shared_files()


def ilo_category(name: str) -> str | None:
    if name in SHARED:
        return None
    if re.match(r"^C\d+\b", name):
        return "Conventions"
    if "Maritime Labour Convention" in name:
        return "MLC 2006 amendments"
    if re.match(r"^R\d+\b", name) or "Recommendation" in name:
        return "Recommendations"
    return "Guidance"


def who_category(name: str) -> str | None:
    return None if name in SHARED else "Guidance"


BODIES = {
    "ILO": t.Spec(
        publication="ILO",
        folder="ILO",
        jurisdiction="international",
        category_of=ilo_category,
        # "C130 - Medical Care and Sickness Benefits Convention, 1969" — the
        # code becomes the number on its own; no series branch, because the
        # shelf is already called Conventions and a branch of the same name
        # inside it is one click that leads nowhere.
        code_only=re.compile(r"^[CR]\d+$"),
    ),
    "WHO": t.Spec(
        publication="WHO",
        folder="WHO",
        jurisdiction="international",
        category_of=who_category,
    ),
}


if __name__ == "__main__":
    body = None
    for i, a in enumerate(sys.argv):
        if a == "--body":
            body = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
    if not body:
        print("give --body ILO|WHO|all", file=sys.stderr)
        sys.exit(2)
    rc = 0
    for name in (list(BODIES) if body == "all" else [body]):
        print(f"\n════════ {name} ════════", flush=True)
        rc |= t.run(BODIES[name])
    sys.exit(rc)
