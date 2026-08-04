#!/usr/bin/env python3
"""STCW — training and certification, loaded into the publications tree.

Two instruments live in this folder. The Manila 2010 STCW is the one a yacht
answers to, and it splits the way the book does: the Convention and the Code.
STCW-F is a separate convention for fishing vessels — kept, but on one shelf of
its own rather than doubling the rail for material no yacht is certified under.
The conference resolutions and the note verbale go together as the paperwork
that brought the amendments into force.

  python3 load_stcw.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

MANILA = re.compile(r"^STCW Manila 2010\s*-\s*(Convention|Code)\s*-?\s*", re.I)
FISHING = re.compile(r"^STCW-F\s*-\s*", re.I)
CONFERENCE = re.compile(r"^(STCW_CONF|Note Verbale)", re.I)
# Every Manila Convention chapter repeats the attachment it arrived in.
ATTACHMENT = re.compile(r"^Attachment \d+ to the Final[^-]*-\s*", re.I)


def category_of(name: str) -> str | None:
    m = MANILA.match(name)
    if m:
        return m.group(1).capitalize()
    if FISHING.match(name):
        return "STCW-F — fishing vessels"
    if CONFERENCE.match(name):
        return "Conference resolutions"
    return "Other"


# "Part A - Mandatory Standards reg… - Chapter I - …" and "Part A - Mandatory
# Standards reg… - Introduction" are the same Part; left apart, the second one
# became a document of its own beside the first.
PART_TITLE = re.compile(r"^(Part [A-Z])\s*-\s*", re.I)


def rename(name: str) -> str:
    rest = ATTACHMENT.sub("", MANILA.sub("", name)).strip(" -")
    if rest == name or not rest:
        rest = FISHING.sub("", name) or name
    return PART_TITLE.sub(r"\1 — ", rest)


SPEC = t.Spec(
    publication="STCW",
    folder="STCW",
    jurisdiction="international",
    category_of=category_of,
    rename=rename,
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
