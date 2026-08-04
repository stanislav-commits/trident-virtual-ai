#!/usr/bin/env python3
"""RINA rules — the member area's own sections, minus the cargo-ship half.

The rail mirrors membermarine.rina.org: REP, RES, NC, NAS, GUI, GEN. Inside a
section each rule is a document, and a rule issued in parts (RES.31 Yachts,
REP Ships, NAS.19 racing yachts) carries those parts as branches, then
Chapter → Section from the PDF bookmarks.

Not loaded, by the operator's rule: REP.7 Common Structural Rules (bulk
carriers and oil tankers), NC/C.37 containers, NC/C.48 inert gas systems, the
offshore sets RES.11/17/25, the naval and special-service sets REM and
RES.19/20/24/29, everything marked Withdrawn, and the Italian-only editions of
documents that have no English text.

Sixty-five of the 135 files carry no bookmarks at all — mostly short
certification rules — and those load as one document each.

  python3 load_rina.py --base http://localhost:3001/api --token …
  python3 load_rina.py … --dry-run
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
from collections import defaultdict
from pathlib import Path

import fitz

import pdf_outline
import pdf_pages
import r4y_tree as t

SRC = Path.home() / "Downloads" / "RINA"
PUBLICATION = "RINA"

# The rail is the member area's OWN top level — four sections. What used to be
# the shelf here (REP, RES, NC, …) is one level down, exactly as on the site:
# those are the sub-sections of Rules & Guides, not sections of their own.
RULES_AND_GUIDES = "Rules & Guides"

# In the site's own order. Naming them also keeps this loader off the three
# other sections, which are downloaded into folders beside these and belong to
# load_rina_extra.py.
# NAS12 exists only in Italian; the member area publishes no English edition.
SKIP = re.compile(r"^NAS12\b", re.I)

SUBSECTIONS = [
    "REP - Rules for Classification of Ships",
    "RES - Rules for Special Ships and Units",
    "NC - Complementary Rules for Testing and Certification",
    "NAS - Rules for the Application of Governmental Regulations",
    "GUI - Guides",
    "GEN - General Conditions of the Rules",
]

PART_IN_NAME = re.compile(r"\bPart\s+([A-F])\b", re.I)
PART_BOOKMARK = re.compile(r"^Part\s+([A-F])\s*[-–]\s*(.*)$", re.I)
CITATION = re.compile(r"^\s*(Pt\s+[A-F],\s*Ch\s+\d+,\s*Sec\s+\d+)", re.I)
# "RES31 Rules for Yachts - Part A 1.7.2026" → RES31; "NCC13 - 1.7.2022" → NCC13
RULE_CODE = re.compile(r"^([A-Z]{2,4}\.?\d+[A-Z]?)", re.I)


# The file names carry no subject at all — "GUI10-ENG.pdf", "NCC13 - 1.7.2022"
# — so the titles come from the member area's own listing, harvested with the
# links and kept beside this script.
TITLES = {}
_titles_file = Path(__file__).with_name("rina_titles.tsv")
if _titles_file.exists():
    for _line in _titles_file.read_text().splitlines():
        if "\t" in _line:
            _code, _title = _line.split("\t", 1)
            TITLES[_code.strip().upper()] = _title.strip()


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def rule_of(name: str) -> str:
    m = RULE_CODE.match(name)
    return m.group(1).upper().replace(".", "") if m else name


def nice_title(name: str) -> str:
    """The subject from RINA's own listing; the file name only as a fallback."""
    known = TITLES.get(rule_of(name))
    if known:
        return known
    s = re.sub(r"\.pdf$", "", name, flags=re.I)
    s = RULE_CODE.sub("", s, count=1)
    s = re.sub(r"\bPart\s+[A-F]\b", "", s, flags=re.I)
    s = re.sub(r"\b(EIF|Corr\d*)\b", "", s, flags=re.I)
    s = re.sub(r"\d{1,2}\.\d{1,2}\.\d{2,4}", "", s)
    s = re.sub(r"[-–_]+", " ", s)
    s = re.sub(r"\b(ENG|ITA)\b", "", s)
    return clean(s).strip(" -–") or rule_of(name)


# Some bookmarks are a file name: "RINAPREAMBLE_6_FINAL_ENG".
FILENAMEY = re.compile(r"^[A-Z0-9_]+$")
NOISE = re.compile(r"\b(ENG|ITA|FINAL|DEF|REV|V?\d+)\b", re.I)


def polish(nodes: list[dict]) -> list[dict]:
    """Ordinary case at every level, and no file names left in a heading."""
    for n in nodes:
        title = re.sub(r"\.pdf$", "", n["title"], flags=re.I).strip()
        if FILENAMEY.match(title):
            title = clean(NOISE.sub(" ", title.replace("_", " ")))
            for code in ("RINA", "IMO", "SOLAS", "MARPOL"):   # a glued prefix
                if title.upper().startswith(code) and len(title) > len(code):
                    title = f"{code} {title[len(code):]}"
                    break
        n["title"] = t.pretty(title) or title
        if n.get("children"):
            polish(n["children"])
    return nodes


def build_file(path: Path) -> dict:
    """One PDF → a node: its chapters, or the whole text when it has none."""
    doc = fitz.open(path)
    branches = pdf_outline.split_oversized(
        pdf_outline.outline_tree(doc, t.text_quality, CITATION), t.text_quality)
    node: dict = {"title": nice_title(path.name)}
    if branches:
        # A single top bookmark is the document's own title page, not a level:
        # "Part A - Classification and Surveys" IS this node. NAS13 stacks two
        # of them, both repeating the file name, so this unwraps until it finds
        # real structure — and the name from RINA's own listing wins over a
        # bookmark that only says "FP for Statutory Certificates mat div acc.pdf".
        while len(branches) == 1 and branches[0].get("children"):
            top = branches[0]
            m = PART_BOOKMARK.match(top["title"])
            if m:
                node["title"] = m.group(2).strip()
            branches = top["children"]
        node["children"] = t.make_unique(branches)
    else:
        # No bookmarks. Most such files are short certification rules and stay
        # whole; the big rulebooks are read off their running heads instead —
        # RES31 Part C is 585 pages and would otherwise be one node of 1.8 MB.
        sections = pdf_outline.by_running_head(path, CITATION, t.text_quality)
        if sections:
            node["children"] = pdf_outline.split_oversized(sections, t.text_quality)
        else:
            text = pdf_pages.text_of(path, 1, doc.page_count)
            node["contentText"] = text or None
            node["textQuality"] = t.text_quality(text) if text else 0.0
            pdf_outline.split_oversized([node], t.text_quality)
    letter = PART_IN_NAME.search(path.name)
    if letter:
        node["number"] = f"Pt {letter.group(1).upper()}"
    node["sourceRef"] = f"{path.parent.name}/{path.name}"
    doc.close()
    return node


def build_section(folder: Path) -> list[dict]:
    """Files grouped by rule; a rule issued in parts keeps them as branches."""
    by_rule: dict[str, list[Path]] = defaultdict(list)
    for path in sorted(folder.glob("*.pdf")):
        if SKIP.match(path.name):
            continue
        by_rule[rule_of(path.name)].append(path)

    documents = []
    for code, paths in sorted(by_rule.items()):
        nodes = [build_file(p) for p in paths]
        if len(nodes) == 1:
            node = nodes[0]
            node["number"] = code
            documents.append(node)
            continue
        documents.append({
            "number": code,
            "title": nice_title(paths[0].name),
            "children": sorted(nodes, key=lambda n: n.get("number") or ""),
        })
    return polish(t.make_unique(documents))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    def count(nodes):
        return sum(1 + count(n.get("children") or []) for n in nodes)

    for name in SUBSECTIONS:
        folder = SRC / name
        pdf_pages.warm(sorted(folder.glob("*.pdf")), label=f" · {name.split(' - ')[0]}")
        docs = build_section(folder)
        print(f"\n════ {folder.name}", flush=True)
        print(f"   {len(docs)} документов · {count(docs)} узлов", flush=True)
        if args.dry_run:
            for d in docs[:5]:
                print(f"      [{d.get('number') or '—'}] {d['title'][:52]}"
                      f"{'  ветвей ' + str(len(d['children'])) if d.get('children') else ''}")
            continue

        ok = failed = 0
        t0 = time.time()
        # One root per sub-section; the rules hang inside it.
        try:
            root = t.post_json(args.base, "documents/publications/tree/import", args.token, {
                "category": PUBLICATION,
                "nodeType": RULES_AND_GUIDES,
                "jurisdiction": "class:RINA",
                "nodes": [{"number": folder.name.split(" - ")[0],
                           "title": folder.name.split(" - ", 1)[-1]}],
            })["rootIds"][0]
        except Exception as e:  # noqa: BLE001
            print(f"   FAIL section root: {e}", flush=True)
            continue
        for doc in docs:
            try:
                t.post_json(args.base, "documents/publications/tree/import", args.token, {
                    "parentId": root,
                    "nodes": [doc],
                })
                ok += 1
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"   FAIL {doc.get('number')}: {e.code} {e.read()[:140]!r}", flush=True)
        print(f"   DONE {ok} ok, {failed} fail ({time.time() - t0:.0f}s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
