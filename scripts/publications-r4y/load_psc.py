#!/usr/bin/env python3
"""Port State Control — the regional MoUs and how they inspect.

Fifty-six flat files with no numbering of any kind, so the shelves come from
what each document IS: the MoU texts themselves, the procedures an inspector
follows, the appeal route after a detention, the deficiency code lists, and the
public performance lists that decide how often a ship is boarded.

Two documents here matter directly to a yacht — "Guidance on Eligibility of
Yachts to Port State Control" and "Recreational Vessels and Notices of
Arrival" — and both live under inspection guidance.

  python3 load_psc.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

RULES = [
    (re.compile(r"MoU on Port State Control|Memorandum of Understanding|"
                r"Text of the Vi|New Inspection Regime|Paris MoU on Port", re.I),
     "MoU agreements"),
    (re.compile(r"Appeal|Detention Review", re.I), "Appeals and detention"),
    (re.compile(r"Deficiency Codes|Definitions and Abbreviations", re.I),
     "Deficiency codes"),
    (re.compile(r"\bLists?\b|Performance of Recognized|Performance Table|"
                r"QUALSHIP|Matrix|List of Fees", re.I), "Lists and performance"),
    (re.compile(r"Guidance|Guidelines|Inspection|Code of Good Practi|"
                r"Questionnaire|Reporting Obligations|Letter of Warning|"
                r"Early Warning|Prohibition on the Carriage|Recreational Vessels", re.I),
     "Inspection guidance"),
]


def category_of(name: str) -> str | None:
    for pattern, category in RULES:
        if pattern.search(name):
            return category
    return "Other"


SPEC = t.Spec(
    publication="Port State Control",
    folder="PSC",
    jurisdiction="international",
    category_of=category_of,
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
