#!/usr/bin/env python3
"""Lloyd's Register — six folders, one class society.

`Rules and Regulations`, `Notices`, `LR MQPS`, `LR ShipRight`, `LR TASTS` and
`LR Recommended Practices` are all LR: the first holds the class rules
(LR-RU-*, LR-CO-*, LR-FR-*), and `Notices` holds the numbered notices TO those
rules — the mechanism by which they are amended, which is the whole reason the
library is kept updatable.

MQPS and TASTS are spelled out from the operator, not from the corpus — no
document in the library expands either code, so these came from someone who
knows LR: Materials and Qualification Procedures, and Type Approval Test
Specifications.

This is by far the largest publication — about 3 900 files, and 1 000 of them
are page images with no text layer at all, which is 83% of the whole library's
parsing bill.

  python3 load_lloyds.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

FOLDERS = {
    "Rules and Regulations": "Rules and regulations",
    "Notices": "Notices",
    "LR ShipRight": "ShipRight",
    "LR MQPS": "MQPS — Materials and Qualification Procedures",
    "LR TASTS": "TASTS — Type Approval Test Specifications",
    "LR Recommended Practices": "Recommended practices",
    # LR-GN — Lloyd's own guidance notes, confirmed on lr.org, which publishes
    # them under lloyds-register-rules/guidance-notes with these very codes.
    "Guidance Notes": "Guidance notes",
}

def category_of(name: str) -> str | None:
    """The titles sheet is the key to the library, not part of it."""
    return None if name.lower().startswith("rules and regs titles") else "Rules and regulations"


SPEC = t.Spec(
    publication="Lloyd's Register",
    category_of=category_of,
    folder="Rules and Regulations",
    jurisdiction="class:LR",
    folder_categories=FOLDERS,
    # "LR-RU-001", "LR-SR-ADP-001", "LR-TS-01" — an identifier with the title
    # in the crumb after it.
    code_only=re.compile(r"^LR-[A-Z]{2,3}(-[A-Z]{2,4})?-\d+[A-Za-z]?$", re.I),
    series=[
        # ShipRight runs eight procedure families and two of them are most of
        # the shelf. SDA is spelled out inside its own procedures ("the
        # ShipRight Structural Design Assessment"); the rest keep their codes,
        # which no document in the library expands.
        ("ShipRight", re.compile(r"^LR-SR-ADP\b", re.I), "ADP procedures"),
        ("ShipRight", re.compile(r"^LR-SR-SDA\b", re.I),
         "SDA — Structural Design Assessment"),
        ("ShipRight", re.compile(r"^LR-SR-OFF\b", re.I), "OFF procedures"),
        ("ShipRight", re.compile(r"^LR-SR-LSS\b", re.I), "LSS procedures"),
        ("ShipRight", re.compile(r"^LR-SR-RBC\b", re.I), "RBC procedures"),
        ("ShipRight", re.compile(r"^LR-SR-FDA\b", re.I), "FDA procedures"),
    ],
    series_roots=[
        # The notices are one file each and belong to the rule set they amend;
        # until that link is drawn they at least sit in one run.
        (re.compile(r"^(?P<code>Notice No\.\s*\d+)\s*[-–]?\s*(?P<title>.*)$", re.I),
         "Notices to the Rules"),
    ],
)


# "LR-RU-001 Rules and Regulations for the" — code and title share one crumb
# here, unlike everywhere else, so the split happens after the tree is built.
LR_CODE = re.compile(r"^(LR-[A-Z]{2,3}(?:-[A-Z]{2,4})?-\d+\s*[A-Za-z]?)\s+(.+)$", re.I)

# The export cut every rule-set name mid-word, and the library carries the key
# to them: "Rules and Regs titles.png" lists the full designations. Read off
# that sheet — the file itself is not a rule and does not belong in the tree.
LR_TITLES = {
    "LR-RU-001": "Rules and Regulations for the Classification of Ships",
    "LR-RU-002": "Rules for the Manufacture, Testing and Certification of Materials",
    "LR-RU-004": "Rules and Regulations for the Classification of Naval Ships",
    "LR-RU-005": "Rules and Regulations for the Classification of Special Service Craft",
    "LR-RU-006": "Rules and Regulations for the Classification of Inland Waterways Ships",
    "LR-RU-008": "Rules and Regulations for the Construction and Classification of "
                 "Ships for the Carriage of Liquefied Gases in Bulk",
    "LR-RU-012": "Rules and Regulations for the Classification of Ships using Gases "
                 "or other Low-flashpoint Fuels",
    "LR-RU-014": "Rules for the Classification of Trimarans",
}


# Titles read off lr.org, which spells out what the export cut. Only the ones
# actually seen there — the rest keep the truncated name rather than a guess.
LR_GN_TITLES = {
    "LR-GN-001": "Guidance Notes for Technology Qualification",
    "LR-GN-008": "Guidance Notes for the Classification of Special Service Craft",
    "LR-GN-009": "Guidance Notes for Certification of Metallic Powders for Additive Manufacturing",
    "LR-GN-010": "Guidance for Approval, Manufacture, Testing and Certification of High "
                 "Manganese Austenitic Steel for Low Temperature Service",
    "LR-GN-015": "Guidance Notes for Liquid Hydrogen Systems",
    "LR-GN-017": "Guidance Notes for Air Lubrication Systems",
    "LR-GN-019": "Guidance Notes for Machinery Survey Arrangements",
    "LR-GN-026": "Guidance Notes for Class and Statutory Approval and Use of Marine Biofuels",
    "LR-GN-027": "Guidance Notes for Life Extension of Floating Offshore Installations "
                 "at a Fixed Location",
    "LR-GN-032": "Guidance Notes for Calculation Procedures for Composite Construction",
}


def build(files, spec):
    trees = t.build_documents(files, spec)
    for root in trees:
        m = LR_CODE.match(root["title"])
        if m and not root.get("number"):
            code = m.group(1).strip()
            root["number"] = code
            key = code.split()[0]
            root["title"] = (LR_TITLES.get(key) or LR_GN_TITLES.get(key)
                             or m.group(2).strip())

    # The export cut one rule set at two different widths, so LR-RU-012 arrived
    # as two roots; giving both their real name made them identical, and the
    # import then folded one into the other and lost the overlap. Merge them
    # here, where the children can be combined instead of overwritten.
    merged: dict[tuple, dict] = {}
    out = []
    for root in trees:
        key = (root["category"], root.get("number"), root["title"])
        first = merged.get(key)
        if first is None:
            merged[key] = root
            out.append(root)
            continue
        first.setdefault("children", []).extend(root.get("children") or [])
    for root in out:
        if root.get("children"):
            root["children"] = t.sort_tree(t.dissolve_single_leaf(root["children"]))
    return out


if __name__ == "__main__":
    sys.exit(t.run(SPEC, build))
