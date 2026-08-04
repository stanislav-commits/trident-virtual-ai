#!/usr/bin/env python3
"""IMO — seven folders that are one publication.

R4Y files IMO material by kind, and those kinds are exactly the shelves: a
resolution, a circular, a circular letter, a guideline, a performance standard,
a manual, a code. The folder has to decide the shelf, because the numbering
cannot: A.918(22) is a manual, A.1087(28) a guideline and A.382(10) a
performance standard, and nothing in the number says which.

The Codes shelf is built from the separate `Codes` folder — the base texts of
the HSC, IGF, Polar, FSS, MODU and the rest — while `IMO Miscellaneous` holds
redactions of a few of them carrying the resolution that amended them
(MSC.573(110) and friends), most not in force before 2028.

  python3 load_imo.py --base http://localhost:3001/api --token …
"""
from __future__ import annotations

import re
import sys

import r4y_tree as t

FOLDERS = {
    "IMO Resolutions": "Resolutions",
    "IMO Circulars": "Circulars",
    "IMO Circular Letters": "Circular letters",
    "IMO Guidelines": "Guidelines",
    "IMO Performance Standards": "Performance standards",
    "IMO Manuals": "Manuals",
    "Codes": "Codes",
    "IMO Miscellaneous": "Codes",
    # Twenty IMO documents — the MEPC 84 resolutions, three MEPC circulars,
    # MSC.1/Circ.1706, STCW.2/Circ.147 and the MASS Code — exist ONLY inside
    # the ILO and WHO folders, where R4Y dropped a mixed bundle. They are read
    # from there; category_of keeps everything else out.
    "ILO": None,
    "WHO": None,
    # Fourteen conventions that arrive as one file each — COLREGS, BWM, AFS,
    # Tonnage, Salvage, SAR, CLC, Bunkers, LLMC, FAL, Hong Kong, Nairobi and
    # the two OPRC instruments. Every one is an IMO treaty, and a publication
    # per single PDF would be fourteen shelves holding one row.
    "Other Conventions": "Conventions",
}

STRAY = re.compile(r"^(MEPC|MSC|STCW|A|FAL|LEG)[\.\d_]", re.I)
STRAY_CODES = re.compile(r"^International Code (for the Construction and Equipment of Ships"
                         r" Carrying Liquefied|of Safety for Maritime Autonomous)", re.I)


def category_of(name: str) -> str | None:
    """Only the IMO material that the ILO/WHO folders are hiding."""
    if STRAY_CODES.match(name):
        return "Codes"
    if not STRAY.match(name):
        return None
    if re.search(r"_Circ|/Circ", name, re.I):
        return "Circulars"
    return "Resolutions"

# Torremolinos (fishing vessels) and the Load Line text are handled elsewhere.
OTHER_CONVENTIONS_SKIP = re.compile(
    r"^(Torremolinos|International Convention on Load Lines)", re.I)

SPEC = t.Spec(
    publication="IMO",
    folder="IMO Resolutions",
    jurisdiction="international",
    folder_categories=FOLDERS,
    folder_filters={"Other Conventions":
                    re.compile(r"^(?!Torremolinos|International Convention on Load Lines).", re.I)},
    category_of=category_of,
    # "A.1169(32)", "MSC.1_Circ.1310", "Circular Letter No. 4711" — an
    # identifier and nothing else, so it becomes the number and the name that
    # follows becomes the title.
    # An IMO identifier: a known body prefix, then its number, then an
    # optional Circ / Rev tail. Written out rather than as a loose pattern —
    # a generic one also swallowed "Code for Recognized Organizations (RO
    # Code)" and left that code with no title at all.
    code_only=re.compile(
        r"^(?:MSC-MEPC|MSC-FAL|FAL-LEG-MEPC-MSC|STCW-F|COMSAR|HKSRC|MEPC|MSC|"
        r"NCSR|STCW|BLG|CCC|COM|CSC|DSC|FAL|HTW|III|LEG|NAV|PPR|SAR|SDC|SLF|"
        r"SLS|SSE|STW|SN|TM|AFS|BWM|DE|FP|TC|A)"
        r"(?:[\.\- ]?\d+)?(?:[\._/ ]?Circ\.?\s*[\d\.]+)?"
        r"(?:[\._ ]?Rev\.?\s*[\d\.]*)?(?:\s*\(\d+\))?$"
        r"|^Circular Letter No\.?\s*\d[\d_\.A-Za-z]*$",
        re.I),
    series=[
        # Assembly, committee and sub-committee circulars are separate runs;
        # 449 rows on one shelf is not a list anybody reads. The prefixes come
        # from the folder itself, not from a guess at IMO's taxonomy.
        ("Circulars", re.compile(r"^MSC-MEPC", re.I), "MSC-MEPC — joint circulars"),
        ("Circulars", re.compile(r"^MSC[\._/ ]", re.I), "MSC — Maritime Safety Committee"),
        ("Circulars", re.compile(r"^MEPC[\._/ ]", re.I), "MEPC — Marine Environment Protection Committee"),
        ("Circulars", re.compile(r"^SN[\._/ ]", re.I), "SN — safety of navigation"),
        ("Circulars", re.compile(r"^SLS[\._/ ]", re.I), "SLS — SOLAS circulars"),
        ("Circulars", re.compile(r"^SAR[\._/ ]", re.I), "SAR — search and rescue"),
        ("Circulars", re.compile(r"^BWM[\._/ ]", re.I), "BWM — ballast water"),
        ("Circulars", re.compile(r"^(STCW|STCW-F)[\._/ ]", re.I), "STCW — training and certification"),
        ("Circulars", re.compile(r"^FAL[\._/ ]", re.I), "FAL — Facilitation Committee"),
        # Each sub-committee is its own run, and each name is the one printed
        # inside its own circulars — "Sub-Committee on Bulk Liquids and Gases"
        # and so on. CSC and TM are conventions rather than sub-committees and
        # nothing in the corpus spells them out, so they keep the bare code.
        ("Circulars", re.compile(r"^BLG[\._/ ]", re.I), "BLG — Bulk Liquids and Gases"),
        ("Circulars", re.compile(r"^CCC[\._/ ]", re.I), "CCC — Carriage of Cargoes and Containers"),
        ("Circulars", re.compile(r"^DSC[\._/ ]", re.I),
         "DSC — Dangerous Goods, Solid Cargoes and Containers"),
        ("Circulars", re.compile(r"^PPR[\._/ ]", re.I), "PPR — Pollution Prevention and Response"),
        ("Circulars", re.compile(r"^COMSAR[\._/ ]", re.I),
         "COMSAR — Radiocommunications and Search and Rescue"),
        ("Circulars", re.compile(r"^(DE|FP|NAV|STW|SLF|HTW|SDC|SSE|NCSR)[\._/ ]", re.I),
         "Other sub-committee circulars"),
        ("Circulars", re.compile(r"^CSC[\._/ ]", re.I), "CSC circulars"),
        ("Circulars", re.compile(r"^TM[\._/ ]", re.I), "TM circulars"),
        ("Resolutions", re.compile(r"^A\.", re.I), "A — Assembly resolutions"),
        ("Resolutions", re.compile(r"^MSC\.", re.I), "MSC — Maritime Safety Committee"),
        ("Resolutions", re.compile(r"^MEPC\.", re.I),
         "MEPC — Marine Environment Protection Committee"),
        ("Resolutions", re.compile(r"^(FAL|LEG|TC)\.", re.I), "FAL, LEG and TC resolutions"),
    ],
)


if __name__ == "__main__":
    sys.exit(t.run(SPEC))
