#!/usr/bin/env python3
"""Maritime security — the standing guidance out of the anti-piracy folder.

The folder is mostly a news feed: 89 of its 110 files are dated incident
alerts, ReCAAP weekly and annual reports, and one-off MARSEC level changes.
None of that is loaded. An alert about one 2019 boarding in the Singapore
Strait has no standing force, and in a library the model searches it reads
exactly like guidance that does — the worst kind of wrong answer.

What IS loaded is the guidance that stays true between incidents: BMP Maritime
Security, the IMO piracy guidance, the NCAGS guide, the regional counter-piracy
guides, and — the reason this folder is worth opening at all — two documents
written for yachts.

  python3 load_security.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

FOLDER = "?Anti-Piracy"

# The folder is two different things and the shelf says which is which. The
# standing guidance keeps its force between incidents; the rest is a feed —
# dated alerts, weekly and annual reports, one-off MARSEC level changes. Both
# are loaded, but an alert about one 2019 boarding must never read like the
# guidance it sits beside.
ALERTS = re.compile(r"^\d{4}-\d{2,3}\b|^\d{6} - |Weekly Report", re.I)
REPORTS = re.compile(r"Annual Report|Quarter Report|Executive Director_?s Report|"
                     r"WTS\) Report|Piracy and Sea Robbery Conference", re.I)
LEVELS = re.compile(r"MARSEC|Security [Ll]evel|"
                    r"^(Raise|Raised|Adjustment|Alerting|Maintaining|Following)\b|"
                    r"Missing Ship|^Update of |^The Situation in", re.I)


def category_of(name: str) -> str:
    if ALERTS.search(name):
        return "Incident alerts"
    if REPORTS.search(name):
        return "Reports"
    if LEVELS.search(name):
        return "Security level notices"
    # Everything durable on one shelf: split by kind it was four shelves of
    # two or three rows, which is a rail nobody reads.
    return "Guidance"


SPEC = t.Spec(
    publication="Maritime security",
    folder=FOLDER,
    jurisdiction="international",
    category_of=category_of,
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
