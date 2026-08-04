#!/usr/bin/env python3
"""Malta — the flag's own library, loaded into the publications tree.

Malta is almost entirely flat: 240 of 284 files are `CODE - Title`, with no
Parts or Chapters below. What it does have is series — Information Notices, MS
Notices, Port Notices, CY Notices, Legal Notices, and a technical circular per
convention (MARPOL, BWM, SLS, IRO…) — so the work here is naming those series
and putting each on the right shelf.

  python3 load_malta.py --base http://localhost:3001/api --token …
  python3 load_malta.py … --dry-run
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

# Malta's technical circulars: a short convention code, a number, a title.
# They implement a convention for Maltese ships, which makes them notices
# rather than law of their own.
CIRCULAR = re.compile(r"^(MARPOL|BWM|SLS|IRO|SL|ITC|LL|HSC|DSC)\.\d+\b")


def category_of(name: str) -> str | None:
    if re.match(r"^(Information Notice|MS Notice|Port Notice|CY Notice|Y Notice)\b", name):
        return "Notices"
    if CIRCULAR.match(name):
        return "Notices"
    if re.match(r"^LN\.\d", name):
        return "Laws and codes"
    if re.match(r"^MSD-", name) or re.match(
            r"^(Application|Declaration|Request|Checklist|Questionnaire|Form)\b", name) \
            or re.search(r"\bForm [AB]?$|\bForm\b.*\(Rev", name):
        return "Forms"
    if re.search(r"\bAct\b|Regulations|\bRules\b|\bCode\b|Chapter \d|Legal Notice", name):
        return "Laws and codes"
    return "Other"


SPEC = t.Spec(
    publication="Malta",
    folder="Malta",
    jurisdiction="flag:MT",
    category_of=category_of,
    code_only=re.compile(
        r"^(LN\.\d+\.\d+|MSD-[A-Z0-9\-]+|"
        r"(MARPOL|BWM|SLS|IRO|SL|ITC|LL|HSC|DSC)\.\d+)$", re.I),
    # Each notice is a single file; the series is what deserves the branch.
    series_roots=[
        (re.compile(r"^(?P<code>Information Notice\s+\d+[A-Za-z]?)\s*[-–]?\s*(?P<title>.*)$"),
         "Information Notices"),
        (re.compile(r"^(?P<code>MS Notice No\.\s*\d+[A-Za-z]?)\s*[-–]?\s*(?P<title>.*)$"),
         "MS Notices — Merchant Shipping"),
        (re.compile(r"^(?P<code>Port Notice No\.\s*\d+[A-Za-z]?)\s*[-–]?\s*(?P<title>.*)$"),
         "Port Notices"),
        (re.compile(r"^(?P<code>(CY|Y) Notice No\.\s*\d+[A-Za-z]?)\s*[-–]?\s*(?P<title>.*)$"),
         "CY Notices — Commercial Yachting"),
        (re.compile(r"^(?P<code>LN\.\d+\.\d+)\s*[-–]?\s*(?P<title>.*)$"),
         "Legal Notices"),
    ],
    series=[
        # The convention circulars are one run per convention — four Ballast
        # Water items on the shelf beside sixteen MARPOL ones read as noise.
        ("Notices", re.compile(r"^MARPOL\.\d", re.I), "MARPOL circulars"),
        ("Notices", re.compile(r"^BWM\.\d", re.I), "Ballast Water circulars"),
        ("Notices", re.compile(r"^SLS\.\d", re.I), "SOLAS circulars"),
        ("Notices", re.compile(r"^IRO\.\d", re.I), "Registration circulars"),
        ("Notices", re.compile(r"^(SL|ITC|LL|HSC|DSC)\.\d", re.I), "Other circulars"),
        ("Forms", re.compile(r"^MSD-", re.I), "MSD forms"),
        # Four editions of the yacht code, 2010 through 2025 — one row that
        # opens onto the editions, not four rows with the same name.
        ("Laws and codes", re.compile(r"^Commercial Yacht Code \(\d{4}\)", re.I),
         "Commercial Yacht Code"),
    ],
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
