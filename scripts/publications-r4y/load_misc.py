#!/usr/bin/env python3
"""`Misc (International)` — three publications, not one.

The folder is a bin, but two conventions were sitting in it. The Load Line
Convention and UNCLOS are instruments in their own right, on the level of SOLAS
and MARPOL, and neither belongs on a shelf called miscellaneous; each becomes
its own publication with its own divisions on the rail.

What genuinely is miscellaneous — safety alerts, accident bulletins, awareness
material, cyber-security codes — stays together under one publication, sorted
by the run it belongs to.

Two runs are NOT loaded: `REG Unified Interpretations` and the REG Yacht Code
already sit in United Kingdom under their own names. The copies here carry an
extra prefix crumb and nothing else.

  python3 load_misc.py --base http://localhost:3001/api --token … --part all
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

FOLDER = "Misc (International)"

LOAD_LINE = re.compile(r"^Load Line Convention \(LL\)\s*-\s*", re.I)
# The convention TEXT sits in another folder entirely, away from its own
# unified interpretations. "International Convention on Load Lines, - Part 1 -
# International Convention on Lo... - Annex I - …" — two crumbs of the work's
# own name before anything specific starts.
LL_TEXT = re.compile(r"^International Convention on Load Lines,\s*-\s*"
                     r"(Part \d+\s*-\s*)?(International Convention on Lo[^-]*-\s*)?", re.I)
UNCLOS = re.compile(r"^United Nations Convention on the Law of\s*-\s*", re.I)
# Already loaded under United Kingdom, by their real names.
IN_UK = re.compile(r"^(REG Unified Interpretations|Red Ensign Group Yacht Code)\b", re.I)
# CISR is the Cayman Islands Shipping Registry — its flyers are that flag's
# own publications and are loaded with Cayman Islands, not as "miscellaneous
# international".
IN_CAYMAN = re.compile(r"^CISR\b", re.I)

# Four safety runs, each of which was a shelf holding exactly one branch —
# a click that only ever led to another click. They share one shelf now and
# stay separate runs inside it.
RUNS = [
    (re.compile(r"^Safety Alerts\b", re.I), "Safety alerts and bulletins"),
    (re.compile(r"^Safety Bulletins \(SB\)", re.I), "Safety alerts and bulletins"),
    (re.compile(r"^Maritime Safety Awareness Bulletin", re.I), "Safety alerts and bulletins"),
    (re.compile(r"^Safety Flyers \(SF\)", re.I), "Safety alerts and bulletins"),
]


def misc_category(name: str) -> str | None:
    if LOAD_LINE.match(name) or UNCLOS.match(name) or IN_UK.match(name) \
            or IN_CAYMAN.match(name):
        return None
    for pattern, category in RUNS:
        if pattern.match(name):
            return category
    return "Guidance and codes"


def load_line_category(name: str) -> str | None:
    if LL_TEXT.match(name):
        return "Convention text"
    if not LOAD_LINE.match(name):
        return None
    rest = LOAD_LINE.sub("", name)
    # "LL 01 - Application - Article (4)" are the unified interpretations;
    # "Article 6 - Exemptions" is the convention text itself.
    return "Unified interpretations" if rest.upper().startswith("LL ") else "Articles"


def unclos_category(name: str) -> str | None:
    if not UNCLOS.match(name):
        return None
    rest = UNCLOS.sub("", name)
    if rest.lower().startswith("annex"):
        return "Annexes"
    if rest.lower().startswith("part"):
        return "Parts"
    return "Front matter"


LL_CODE = re.compile(r"^(LL \d+)\s*[—-]\s*(.+)$", re.I)


def load_line_build(files, spec):
    """The LL number is what an interpretation is known by, not the regulation
    it points at — that reference belongs at the end of the title."""
    trees = t.build_documents(files, spec)
    for root in trees:
        m = LL_CODE.match(root["title"])
        if not m:
            continue
        reference = root.get("number")
        root["number"] = m.group(1)
        root["title"] = f"{m.group(2)} — {reference}" if reference else m.group(2)
    return trees


PARTS = {
    "Load Line": t.Spec(
        publication="International Convention on Load Lines",
        folder=FOLDER,
        jurisdiction="international",
        category_of=load_line_category,
        rename=lambda n: LL_TEXT.sub("", LOAD_LINE.sub("", n)) or n,
        code_only=re.compile(r"^LL \d+$", re.I),
        folder_categories={FOLDER: None, "Other Conventions": None},
        folder_filters={"Other Conventions":
                        re.compile(r"^International Convention on Load Lines", re.I)},
    ),
    "UNCLOS": t.Spec(
        publication="UNCLOS",
        folder=FOLDER,
        jurisdiction="international",
        category_of=unclos_category,
        rename=lambda n: UNCLOS.sub("", n) or n,
    ),
    "Misc": t.Spec(
        publication="Misc (International)",
        folder=FOLDER,
        jurisdiction="international",
        category_of=misc_category,
    ),
}


if __name__ == "__main__":
    part = None
    for i, a in enumerate(sys.argv):
        if a == "--part":
            part = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
    if not part:
        print("give --part 'Load Line'|UNCLOS|Misc|all", file=sys.stderr)
        sys.exit(2)
    rc = 0
    for name in (list(PARTS) if part == "all" else [part]):
        print(f"\n════════ {name} ════════", flush=True)
        rc |= t.run(PARTS[name], load_line_build if name == "Load Line" else None)
    sys.exit(rc)
