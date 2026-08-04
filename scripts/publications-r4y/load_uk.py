#!/usr/bin/env python3
"""United Kingdom — what the MCA publishes, loaded into the publications tree.

Everything structural lives in r4y_tree; this file is only the vocabulary of
one flag: which name means an Act, which means a form, and which numbered runs
deserve a branch of their own.

  python3 load_uk.py --base http://localhost:3001/api --token …
  python3 load_uk.py … --dry-run
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t


def category_of(name: str) -> str | None:
    """None means the file is not ours — EU acts belong to EU Legislation."""
    if re.match(r"^\d{4}_\d{4} \((Regulation|Decision|Directive)\)", name):
        return None
    if re.match(r"^(MGN|MSN|MIN)\b", name):
        return "M Notices"
    if re.match(r"^MSIS", name):
        return "Instructions to surveyors"
    if re.match(r"^MSF\b", name) or re.match(r"^(Declaration of Maritime Labour)", name):
        return "Forms"
    # Two Acts lost the word "Act" when the export truncated their names —
    # "Merchant Shipping and Maritime Security - Extension of Powers…" is the
    # 1997 Act split by section, not guidance.
    if re.match(r"^(Merchant Shipping and Maritime Security|Shipping and Trading Interests)\b", name):
        return "Acts and regulations"
    if re.search(r"\bAct\b|Regulations|\bOrder\b|^SI \d{4}|\bRules \d{4}", name):
        return "Acts and regulations"
    return "Guidance and codes"


SPEC = t.Spec(
    publication="United Kingdom",
    folder="United Kingdom",
    jurisdiction="flag:GB",
    # The standalone M Notices and Instructions to Surveyors folders are copies
    # of what this one already holds — 122 of 122 and 209 of 210 by name. Only
    # the missing MSIS is worth pulling across.
    also=["Instructions to Surveyors"],
    category_of=category_of,
    # The letter suffix may be attached or spaced — "MSF 5623 A" is still a code.
    code_only=re.compile(
        r"^(SI \d{4} No\. \d+|MSIS \d+ ?[A-Za-z]?|MSF \d+ ?[A-Za-z]?|REG-UI \d+"
        r"|Safety Bulletin \d+|Marine Safety Alert \d+|Technical Safety Alert \d+"
        r"|REG Guidance Note \d+|Advice Note \d+_\d+)$",
        re.I,
    ),
    # The three MCA notice series, spelled out — "MGN" alone means nothing to a
    # captain reading the rail. Confirmed against the notices themselves.
    series_roots=[
        (re.compile(r"^(?P<code>MGN\s+\d+\s*(\([^)]*\))?)\s*[-–]?\s*(?P<title>.*)$"),
         "MGN — Marine Guidance Notes"),
        (re.compile(r"^(?P<code>MSN\s+\d+\s*(\([^)]*\))?)\s*[-–]?\s*(?P<title>.*)$"),
         "MSN — Merchant Shipping Notices"),
        (re.compile(r"^(?P<code>MIN\s+\d+\s*(\([^)]*\))?)\s*[-–]?\s*(?P<title>.*)$"),
         "MIN — Marine Information Notes"),
    ],
    # Runs of numbered one-pagers that belong together on the shelf. Left flat
    # they are dozens of neighbouring rows saying nothing; as a branch they are
    # one row that opens into a series.
    series=[
        ("Guidance and codes", re.compile(r"^Advice Note\b", re.I), "Advice Notes"),
        ("Guidance and codes", re.compile(r"^Safety Bulletin\b", re.I), "Safety Bulletins"),
        ("Guidance and codes", re.compile(r"^REG-UI\b", re.I),
         "REG-UI — Red Ensign Group Unified Interpretations"),
        ("Guidance and codes", re.compile(r"^Technical Safety Alert\b", re.I),
         "Technical Safety Alerts"),
        ("Guidance and codes", re.compile(r"^Marine Safety Alert\b", re.I),
         "Marine Safety Alerts"),
    ],
)

SI_YEAR = re.compile(r"^SI (\d{4}) No\.")


def build(files, spec):
    """Statutory instruments get a year level; everything else is standard."""
    trees = t.build_documents(files, spec)
    return t.group_by_year(trees, "Acts and regulations", SI_YEAR,
                           "Statutory Instruments")


if __name__ == "__main__":
    sys.exit(t.run(SPEC, build))
