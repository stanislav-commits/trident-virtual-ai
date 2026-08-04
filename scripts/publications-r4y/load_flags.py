#!/usr/bin/env python3
"""The other six flag states, loaded into the publications tree.

All six are flat libraries of numbered series — the same shape Malta has — so
they share one category vocabulary (Laws and codes / Notices / Forms / Other)
and differ only in which prefixes they use.

Series names are spelled out ONLY where the documents themselves say so: the
Bahamas headers read "INFORMATION NOTICE" and "TECHNICAL ALERT", Isle of Man
prints "Technical Advisory Notice" and "Statutory Document", Marshall Islands
"Marine Guideline", "Yacht Safety Advisory", "Ship Security Advisory". Codes
whose meaning is not written anywhere in the corpus (Gibraltar RA-/LMD-/GYR-,
Bermuda FREG/FSUR/FSEA) keep their bare code — a guessed expansion reads as
fact and would be worse than the code.

  python3 load_flags.py --base http://localhost:3001/api --token … --flag Bahamas
  python3 load_flags.py … --flag all --dry-run
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

LAW = re.compile(r"\bAct\b|\bRegulations?\b|\bOrder\b|\bRules\b|\bCode\b|\bOrdinance\b"
                 r"|\bLaw\b|Chapter \d", re.I)
FORM = re.compile(r"^(Application|Declaration|Request|Checklist|Questionnaire|Form|List of)\b"
                  r"|\bForm\b\s*\(|\bApplication Form\b", re.I)


def series_root(pattern: str, branch: str):
    """A run of single-file notices hanging under one named branch."""
    return (re.compile(rf"^(?P<code>{pattern})\s*[-–]?\s*(?P<title>.*)$", re.I), branch)


def flag_spec(publication: str, folder: str, jurisdiction: str,
              notices: list, forms: list, laws: list, code_only: str,
              series: list | None = None,
              extra: tuple | None = None) -> t.Spec:
    """Every flag shares the four shelves and differs only in its prefixes."""
    notice_pat = re.compile("|".join(p for p, _ in notices), re.I) if notices else t.NEVER
    form_pat = re.compile("|".join(forms), re.I) if forms else t.NEVER
    law_pat = re.compile("|".join(laws), re.I) if laws else t.NEVER

    extra_folder, extra_pat, extra_cat = extra or (None, None, None)

    def category_of(name: str) -> str | None:
        if law_pat.pattern and law_pat.match(name):
            return "Laws and codes"
        if notice_pat.pattern and notice_pat.match(name):
            return "Notices"
        if form_pat.pattern and form_pat.match(name):
            return "Forms"
        if FORM.match(name):
            return "Forms"
        if LAW.search(name):
            return "Laws and codes"
        return "Other"

    return t.Spec(
        publication=publication,
        folder=folder,
        folder_categories=({folder: None, extra_folder: extra_cat} if extra_folder else {}),
        folder_filters=({extra_folder: extra_pat} if extra_folder else {}),
        jurisdiction=jurisdiction,
        category_of=category_of,
        code_only=re.compile(code_only, re.I) if code_only else t.NEVER,
        series_roots=[series_root(p, b) for p, b in notices],
        series=list(series or []),
    )


FLAGS = {
    "Bahamas": flag_spec(
        "Bahamas", "Bahamas", "flag:BS",
        notices=[
            (r"MN\s+\d+[A-Za-z]?", "MN — Marine Notices"),
            (r"IN\s+\d+[A-Za-z]?", "IN — Information Notices"),
            (r"TA\s+\d+[-\d]*", "TA — Technical Alerts"),
            (r"YN\s+\d+[A-Za-z]?", "YN — Yacht Notices"),
            (r"YR\s+\d+[A-Za-z]?", "YR — Yacht Registration"),
            (r"Safety Alert\s+\d+[-\d]*", "Safety Alerts"),
        ],
        forms=[r"^Form R\b", r"^Form LRIT\b", r"^\d+ - Bahamas"],
        laws=[],
        code_only=r"^(MN|IN|TA|YN|YR)\s+\d+[A-Za-z]?$",
    ),
    "Bermuda": flag_spec(
        "Bermuda", "Bermuda", "flag:BM",
        notices=[(r"\d{4}-\d{2,3}", "Bermuda Shipping Notices")],
        forms=[r"^(FREG|FSUR|FSEA|ROSF)\b"],
        laws=[r"^Marine Board\b", r"^Marine and Ports Services\b"],
        code_only=r"^(FREG|FSUR|FSEA|ROSF)\.[A-Z0-9\.]+$",
    ),
    "Cayman Islands": flag_spec(
        "Cayman Islands", "Cayman Islands", "flag:KY",
        notices=[
            (r"Guidance Note\s+\d+[_/\d]*", "Guidance Notes"),
            # Numbered NN_YY with no prefix — the registry's shipping notices.
            (r"\d{2}_\d{2}", "Shipping Notices"),
        ],
        forms=[r"^CISR \d"],
        laws=[],
        code_only=r"^CISR[\s\-][A-Z0-9\-]+$",
        # CISR = Cayman Islands Shipping Registry. Twenty of its flyers to the
        # yachting industry were filed under "Misc (International)".
        extra=("Misc (International)", re.compile(r"^CISR - Flyer", re.I), "Notices"),
        series=[("Notices", re.compile(r"^CISR - Flyer", re.I), "CISR flyers")],
    ),
    "Gibraltar": flag_spec(
        "Gibraltar", "Gibraltar", "flag:GI",
        notices=[
            (r"Shipping Guidance Notice\s*\d*", "Shipping Guidance Notices"),
            (r"Shipping Information Notice\s*\d*", "Shipping Information Notices"),
            (r"Maritime Labour Notice\s*\d*", "Maritime Labour Notices"),
        ],
        forms=[r"^(RA|LMD)-"],
        laws=[],
        code_only=r"^(RA|LMD|GYR|GYRPR)-[A-Z0-9\-]+$",
    ),
    "Isle of Man": flag_spec(
        "Isle of Man", "Isle of Man", "flag:IM",
        notices=[
            (r"Manx Shipping Notice\s*\d*", "Manx Shipping Notices"),
            (r"Manx Registry Advice Note\s*\d*", "Manx Registry Advice Notes"),
            (r"TAN\s*\d+[-\d]*", "TAN — Technical Advisory Notices"),
            (r"MLN\s*\d+[-\d]*", "MLN — Maritime Labour Notices"),
            (r"\d{2}-\d{2}(?= - .*PSC Analysis)", "PSC analyses"),
        ],
        forms=[r"^(DCR|REG|OD)\d*\b"],
        laws=[r"^SD\s*\d"],
        code_only=r"^(TAN|MLN|DCR|REG|SD)\s*\d+[-\d]*$",
        # Fifteen yearly casualty summaries, one row.
        series=[("Other", re.compile(r"^Casualty Annual Summary Report", re.I),
                 "Casualty annual summary reports")],
    ),
    "Marshall Islands": flag_spec(
        "Marshall Islands", "Marshall Islands", "flag:MH",
        notices=[
            (r"MG-[\d\-]+", "MG — Marine Guidelines"),
            (r"YSA-[\d\-]+", "YSA — Yacht Safety Advisories"),
            (r"SSA\s*-?\s*[\d\-]+", "SSA — Ship Security Advisories"),
            (r"Yacht-TechCirc-[\d\-]+", "Yacht Technical Circulars"),
            (r"YCS\s*No\.\s*[\d\-]+", "YCS — Yacht Code Supplements"),
            (r"MARSEC-[\d\-]+", "MARSEC advisories"),
            (r"\d{2}-\d{2}\b", "Marine Notices"),
            (r"\d-\d{3}-\d{2}", "Marine Notices"),
        ],
        # MI-100 is a registration procedure and MI-101A an application form:
        # one numbered run of registration paperwork, kept whole rather than
        # split across two shelves by the wording of each title. It belongs on
        # Forms — as a notice series it buried 60 application forms among the
        # marine notices and left the Forms shelf empty.
        forms=[r"^MI-"],
        laws=[],
        series=[("Forms", re.compile(r"^MI-", re.I),
                 "MI — registration and certification series")],
        code_only=r"^(MG|YSA|SSA|MI|MARSEC)-[A-Z0-9\-]+$",
    ),
}


if __name__ == "__main__":
    flag = None
    for i, a in enumerate(sys.argv):
        if a == "--flag":
            flag = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
    if not flag:
        print("give --flag <name>|all", file=sys.stderr)
        sys.exit(2)
    names = list(FLAGS) if flag == "all" else [flag]
    rc = 0
    for name in names:
        print(f"\n════════ {name} ════════", flush=True)
        rc |= t.run(FLAGS[name])
    sys.exit(rc)
