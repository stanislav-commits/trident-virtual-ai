#!/usr/bin/env python3
"""RINA — the three sections of the member area that are not rulebooks.

The site's top level is four sections and the rail is the same four. Three of
them are published as a running series rather than as rules, and they load
here:

  * Marine Notice (MNO) — 245 numbered issues, 2007 to date. An issue is one
    node: RINA's own notice carries the text, and whatever it circulates with
    (an IMO resolution, an EU regulation, a flag circular) hangs under it as an
    enclosure, because the enclosure is the thing the notice is about.
  * IMO Conventions, Codes and Amendments — the entry-into-force table. The
    section lists seventeen items, but sixteen are last year's editions of the
    same table; only the edition in force is loaded.
  * Technical circulars — 114 circulars, same shape as the notices: the
    circular states the change, the enclosures are the amended rule text.

Cargo-ship material is left out on the operator's rule, by subject: bulk
carriers, tankers, gas and container ships, ro-ro, IMSBC, the Common Structural
Rules — 67 of 930 files, unless the document also names yachts.

  python3 load_rina_extra.py --base http://localhost:3001/api --token …
  python3 load_rina_extra.py … --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
from pathlib import Path

import fitz

import pdf_outline
import pdf_pages
import r4y_tree as t

SRC = Path.home() / "Downloads" / "RINA"
PUBLICATION = "RINA"
TITLES = Path.home() / "Downloads" / "rina_extra_titles.tsv"

SECTIONS = [
    "Marine Notice (MNO)",
    "IMO Conventions, Codes and Amendments",
    "Technical circulars",
]

# "ISSUE NO. 248 - May 2026 - MAIN DECISIONS OF MSC 111"
MNO = re.compile(r"^ISSUE\s+NO\.?\s*(\d+)\s*[-–]\s*([^-–]+?)\s*[-–]\s*(.*)$", re.I)
# "Circular No. 3850/A 29 Jun 2026 - Rule Variation RV/2026/05: …"
CIRC = re.compile(r"^Circular\s+No\.?\s*([\w/]+)\s+(\d{1,2}\s+\w+\s+\d{4})\s*[-–]\s*(.*)$", re.I)


# RES.20 and RES.29 are not loaded as rulebooks, and they must not come back
# in through the circulars that amend them.
EXCLUDED_RULES = re.compile(r"\bRES\.?(20|29)\b", re.I)

# The only Italian-only material in the section, and neither is about a yacht:
# circular 3760/A carries the rulebook for the Italian Coast Guard's own
# vessels, and one enclosure of 3754/A amends NAS12, the fishing-vessel rules
# that are not loaded either.
ITALIAN_ONLY = re.compile(r"^(C3760|RV-MESEC-2020-10|Emendamenti alla NAS12)", re.I)


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def read_titles() -> dict[str, str]:
    """`section/file → the title the member area lists it under`."""
    out: dict[str, str] = {}
    if TITLES.exists():
        for line in TITLES.read_text().splitlines():
            if "\t" in line:
                key, title = line.split("\t", 1)
                out[key] = clean(title)
    return out


pretty = t.pretty


def fit(title: str, limit: int = 400) -> str:
    """The column holds 400 characters; one circular lists its amendments in
    the title and runs to 880, which the backend answers with a 500."""
    if len(title) <= limit:
        return title
    cut = title[:limit - 1]
    return cut[:cut.rfind(" ")].rstrip(" ,;-–") + "…"


def label(title: str) -> tuple[str | None, str]:
    """The site's own listing line → (citation number, subject)."""
    m = MNO.match(title)
    if m:
        return f"MNO {m.group(1)}", fit(pretty(clean(m.group(3))) + f" ({clean(m.group(2))})")
    m = CIRC.match(title)
    if m:
        return f"Circular {m.group(1)}", fit(pretty(clean(m.group(3))) + f" ({clean(m.group(2))})")
    return None, fit(title)


def is_main(name: str, number: str | None) -> bool:
    """The notice or circular itself, as opposed to what it encloses."""
    if not number:
        return False
    digits = re.sub(r"\D", "", number)
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    return bool(re.match(rf"^(MNO|C)\s*{digits}\b", stem, re.I)
                or re.search(rf"issue\s*_?{digits}\b", stem, re.I))


def enclosure_title(name: str) -> str:
    """The file name as a heading: no extension, no ordering prefix, no
    underscores — "12_Copertina Sez_I" is a cover page, not a title."""
    s = re.sub(r"\.pdf$", "", name, flags=re.I)
    s = re.sub(r"^(Encl(osure)?|Allegato)\s*[-–_]?\s*", "", s, flags=re.I)
    s = re.sub(r"^\d{1,2}[_\-\s]+(?=[A-Za-z])", "", s)
    return clean(s.replace("_", " ")) or name


EIF_DATE = re.compile(r"^(\d{1,2})([A-Za-z]{3,9})(\d{4})$")
# The running head of a RINA rulebook is the citation of the section below it.
CITATION_HEAD = re.compile(r"^(Pt\s+[A-Z], Ch\s+\d+, Sec\s+\d+)")


# Ten of them means the document is organised by date, not that a date is
# mentioned; a two-page notice cannot reach it.
DATED_ENOUGH = 10


def by_effective_date(path: Path) -> list[dict]:
    """The entry-into-force table, split the way it is written: by the date.

    Its running head is the date the requirements below it enter into force —
    "1 July 2024", "1 January 2026" — which is also the axis the question comes
    in on. Everything before the first date is the contents and the legend.
    """
    pages = pdf_pages.pages_of(path)
    marks: list[tuple[int, str]] = []
    for i, text in enumerate(pages, 1):
        for line in [l for l in text.splitlines() if l.strip()][:3]:
            m = EIF_DATE.match(re.sub(r"\s+", "", line))
            if m:
                date = f"{m.group(1)} {m.group(2).title()} {m.group(3)}"
                if not marks or marks[-1][1] != date:
                    marks.append((i, date))
                break
    if len(marks) < DATED_ENOUGH:
        return []

    out: list[dict] = []

    def node(title: str, first: int, last: int) -> None:
        text = pdf_pages.text_of(path, first, last)
        if text:
            out.append({"title": title, "contentText": text,
                        "textQuality": t.text_quality(text)})

    node("Contents and legend", 1, marks[0][0] - 1)
    for i, (page, date) in enumerate(marks):
        end = marks[i + 1][0] - 1 if i + 1 < len(marks) else len(pages)
        node(f"In force from {date}", page, end)
    return out


def polish(nodes: list[dict]) -> list[dict]:
    """Ordinary case for every heading in the tree, not only the top one."""
    for n in nodes:
        n["title"] = fit(pretty(n["title"]))
        if n.get("children"):
            polish(n["children"])
    return nodes


def read(path: Path) -> dict:
    """The file's own outline when it has one, otherwise the whole text.

    The entry-into-force table is 115 pages with 262 bookmarks; as one node it
    answers "which requirement applies from 2027" with the whole book. The same
    holds for the rule amendments circulars enclose — one of them is 238 000
    characters.
    """
    out: dict = {"sourceRef": f"{path.parent.name}/{path.name}"}
    # A document whose running head is the entry-into-force date is organised
    # by that date, and its bookmarks are the links of its own contents list:
    # 262 of them, pointing into three pages, every "section" a fragment with a
    # year mistaken for a section number.
    children = by_effective_date(path)
    if children:
        out["_dated"] = True
    doc = fitz.open(path)
    if not children:
        children = pdf_outline.split_oversized(
            pdf_outline.outline_tree(doc, t.text_quality), t.text_quality
        ) if doc.get_toc() else []
        if len(children) == 1 and children[0].get("children"):
            children = children[0]["children"]
    doc.close()
    if children:
        out["children"] = polish(t.make_unique(children))
        return out
    sections = pdf_outline.by_running_head(path, CITATION_HEAD, t.text_quality)
    if sections:
        out["children"] = polish(pdf_outline.split_oversized(sections, t.text_quality))
        return out
    text = pdf_pages.text_of(path, 1, 10_000)
    out["contentText"] = text or None
    out["textQuality"] = t.text_quality(text) if text else 0.0
    pdf_outline.split_oversized([out], t.text_quality)
    return out


def build_section(folder: Path, titles: dict[str, str]) -> list[dict]:
    """One node per listed document; its enclosures become its children."""
    groups: dict[str, list[Path]] = {}
    for path in sorted(folder.glob("*.pdf")):
        if EXCLUDED_RULES.search(path.stem) or ITALIAN_ONLY.match(path.stem):
            continue
        listed = titles.get(f"{folder.name}/{path.name}", path.stem)
        groups.setdefault(listed, []).append(path)

    documents = []
    promoted = True
    for listed, paths in groups.items():
        if not paths:
            continue
        number, title = label(listed)
        main = next((p for p in paths if is_main(p.name, number)), paths[0])
        body = read(main)
        node: dict = {"number": number, "title": title, **body}
        children = list(body.get("children") or [])
        children += [dict(title=fit(pretty(enclosure_title(p.name))), **read(p))
                     for p in paths if p != main]
        # A document that is only a wrapper round its own dates is not a
        # level: "Mandatory requirements entering into force between 2024 and
        # 2032" says nothing that its shelf does not already say. Its dates
        # become the shelf's own rows, in the order the document sets them.
        if body.pop("_dated", False) and len(children) == len(body.get("children") or []):
            # sourceRef only after the uniqueness pass: it drops repeats of a
            # file, and here every date comes from the same one.
            rows = polish(t.make_unique(children))
            for child in rows:
                child.setdefault("sourceRef", node.get("sourceRef"))
            documents.extend(rows)
            continue
        promoted = False
        if children:
            node["children"] = t.make_unique(children)
        documents.append(node)

    if promoted:
        return documents          # already chronological, oldest date first

    # Notices climb with their numbers; circulars are read newest first.
    newest_first = any((n.get("number") or "").startswith("Circular") for n in documents)

    def key(node: dict) -> tuple:
        digits = re.sub(r"\D", "", (node.get("number") or ""))
        n = int(digits) if digits else 0
        return (-n, node["title"]) if newest_first else (n, node["title"])
    return sorted(documents, key=key)


LIMIT = 8_000_000        # the backend accepts 15 MB; stay well inside it


def post_tree(args, section: str, node: dict, parent: str | None = None) -> None:
    """Import a document, splitting the request when the tree is too heavy.

    Circular 3830/A encloses seven amended rulebooks; once each is split by its
    own outline the document is 20 MB and the whole import comes back 413. So
    a node that does not fit goes in alone and its children follow underneath.
    """
    if len(json.dumps(node)) <= LIMIT:
        body = {"nodes": [node]}
        body.update({"parentId": parent} if parent else
                    {"category": PUBLICATION, "nodeType": section,
                     "jurisdiction": "class:RINA"})
        t.post_json(args.base, "documents/publications/tree/import", args.token, body)
        return

    children = node.get("children") or []
    alone = {k: v for k, v in node.items() if k != "children"}
    body = {"nodes": [alone]}
    body.update({"parentId": parent} if parent else
                {"category": PUBLICATION, "nodeType": section,
                 "jurisdiction": "class:RINA"})
    node_id = t.post_json(args.base, "documents/publications/tree/import",
                          args.token, body)["rootIds"][0]
    for child in children:
        post_tree(args, section, child, node_id)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--section", help="load one section only")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    titles = read_titles()
    for section in SECTIONS:
        folder = SRC / section
        if not folder.is_dir() or (args.section and args.section != section):
            continue
        files = sorted(folder.glob("*.pdf"))
        print(f"\n════ {section}  ({len(files)} файлов)", flush=True)
        pdf_pages.warm(files, label=f" · {section}")
        docs = build_section(folder, titles)
        refs = set()
        def collect(nodes):
            total = 0
            for n in nodes:
                total += 1 + collect(n.get("children") or [])
                if n.get("sourceRef"):
                    refs.add(n["sourceRef"])
            return total
        nodes_total = collect(docs)
        print(f"   {len(docs)} документов · {nodes_total} узлов · "
              f"файлов в дереве {len(refs)}", flush=True)
        if len(refs) != len(files):
            missing = {f"{folder.name}/{f.name}" for f in files} - refs
            print(f"   ВНИМАНИЕ: файлов {len(files)}, в дереве {len(refs)}; "
                  f"нет: {sorted(missing)[:5]}", flush=True)
        if args.dry_run:
            for d in docs[-4:]:
                kids = f"  +{len(d['children'])} прил." if d.get("children") else ""
                print(f"      [{d.get('number') or '—'}] {d['title'][:64]}{kids}")
            continue

        ok = failed = 0
        t0 = time.time()
        for doc in docs:
            try:
                post_tree(args, section, doc)
                ok += 1
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"   FAIL {doc.get('number')}: {e.code} {e.read()[:140]!r}", flush=True)
        print(f"   DONE {ok} ok, {failed} fail ({time.time() - t0:.0f}s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
