#!/usr/bin/env python3
"""Bureau Veritas — the Rules Explorer, in the site's own three sections.

The rail is what rulesexplorer.bureauveritas.com puts at its top level: Main
Rules (NR), Rule Notes (NR), Guidance Notes (NI). Its fourth tab, Former
(NR/NI), holds superseded editions and is left out for the same reason the
withdrawn IACS requirements are: in a library the model searches, a rule that
no longer stands reads exactly like one that does.

Inside a book the tree is BV's own — Part → Chapter → Section — and a section
carries the text of every requirement under it, numbered the way BV cites:
"Pt C, Ch 1, Sec 4". Cross-references inside the text use that same form, so a
reference and the section it points at are the same string.

The text comes from the API rather than the PDF, which is why the tables
survive as tables: BV publishes them as CALS markup and they convert straight
to markdown.

Cargo and non-yacht fleets are left out by subject, on the operator's rule:
bulk carriers, tankers, gas and container ships, ro-ro, offshore and subsea,
naval units, inland navigation, renewables and aquaculture. General-ship
engineering stays — a yacht is a ship for hull, machinery, electrics and
materials — and anything naming yachts stays whatever else it mentions.

  python3 load_bv.py --base http://localhost:3001/api --token …
  python3 load_bv.py … --dry-run
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fitz

import bv_api as bv
import pdf_outline
import pdf_pages
import r4y_tree as t

PUBLICATION = "Bureau Veritas"
DOCS = "https://rulesexplorer-docs.bureauveritas.com/"
PDFS = Path.home() / "Downloads" / "BV"

# The site's own tabs, in the site's own order.
SHELVES = {
    "CLASSIFICATION": "Main Rules (NR)",
    "NR": "Rule Notes (NR)",
    "NI": "Guidance Notes (NI)",
}

DROP = re.compile(
    r"bulk carrier|ore carrier|cargo hold|corrugated bulkhead|"
    r"\btankers?\b|oil tanker|chemical tanker|crude oil|cargo oil|inert gas|"
    r"\bLNG\b|\bLPG\b|liquefied|gas carrier|IGC Code|"
    r"container ?ship|lashing|\bro-?ro\b|IMSBC|solid bulk|bulk cargo|"
    r"cargo securing|cargo liquefaction|"
    r"inland (navigation|waterway)|naval|warship|submarine|"
    r"offshore|FPSO|FSRU|FLNG|drilling|jack-?up|semi-?submersible|riser|subsea|"
    r"mooring of floating|floating production|floating storage|"
    r"wind turbine|renewable|tidal|wave energy|aquaculture|fish farm", re.I)
YACHTS = re.compile(r"yacht|pleasure|sailing", re.I)

# The spine goes down to the sub-article, because the shelf is read by the
# model far more often than by a person. What is indexed is not a node but the
# markdown assembled from a subtree, split on its headings — so every level
# here is one more place a chunk can begin, and every heading is the citation
# BV itself uses. A section left whole is a single 89 000-character block
# ("Pt C, Ch 1, Sec 4"), and a chunk cut out of its middle carries no sign of
# which rule it belongs to.
#
# One level deeper — the individual requirement — is left out on purpose: it
# has no title of its own, so it would add headings that say nothing while
# cutting a rule away from the sentences that qualify it.
BRANCH = {"part", "chap", "appendix", "sect", "art", "sart"}
LEAF = {"sect", "art", "sart"}

CITE = [(re.compile(r"^Part\s+", re.I), "Pt "), (re.compile(r"^Chapter\s+", re.I), "Ch "),
        (re.compile(r"^Section\s+", re.I), "Sec "), (re.compile(r"^Appendix\s+", re.I), "App "),
        # BV writes an article reference in brackets: "see [6.4.3]"
        (re.compile(r"^Article\s+(.*)$", re.I), r"[\1]")]


def owner_of(position: str, at_position: dict) -> dict | None:
    """The deepest node that holds this requirement.

    A requirement is at "…, Section 2, Article 1.1.1"; the tree has the section
    and, under it, "Article 1" and "Article 1.1". Trim the tail a step at a
    time until one of them is found.
    """
    crumbs = position.split(", ")
    head, last = crumbs[:-1], crumbs[-1]
    m = re.match(r"^(Article|Sub-?article)\s+([\d.]+)$", last, re.I)
    if m:
        parts = m.group(2).rstrip(".").split(".")
        for cut in range(len(parts), 0, -1):
            candidate = ", ".join(head + [f"{m.group(1)} {'.'.join(parts[:cut])}"])
            if candidate in at_position:
                return at_position[candidate]
    return at_position.get(", ".join(head))


def cite(position: str) -> str:
    """"Part C, Chapter 1, Section 4" → "Pt C, Ch 1, Sec 4", the form BV cites."""
    out = []
    for crumb in position.split(", "):
        for pattern, short in CITE:
            crumb = pattern.sub(short, crumb)
        out.append(crumb)
    return ", ".join(out)


# BV tags a publication with every domain it touches, so "Offshore units" sits
# on documents that are plainly general — life-saving appliances, materials and
# welding. The subject decides; the tags only decide when every one of them is
# outside the ship domain.
OUTSIDE = {"Offshore units", "Offshore systems and equipment", "Naval Units",
           "Marine renewable energies", "Inland navigation and installations"}


# Three books whose titles carry no word the subject filter catches, and whose
# trade is not this one: NR490 ferries technicians to wind farms, NI649 lays up
# dynamically positioned offshore vessels (NI545 covers ships), and NI621
# assesses moonpools, which outside a drilling unit a yacht does not have.
BY_REFERENCE = {"nr490", "ni649", "ni621"}


def keep(pub: dict) -> bool:
    if pub["reference"].lower() in BY_REFERENCE:
        return False
    title = pub.get("title") or ""
    if YACHTS.search(title):
        return True
    if DROP.search(title):
        return False
    tags = set(pub.get("categories") or [])
    return not (tags and tags <= OUTSIDE)


def build_from_pdf(pub: dict, book: str, edition: str) -> dict | None:
    """Only eleven books are indexed article by article; the rest are PDFs.

    They are the older Guidance Notes, and among them sit the ones a yacht
    actually needs — the CAP for yachts, the life-saving appliances guidance,
    the windlass rules. So they are read the way every other publication in
    this library is: the outline for the tree, the pages for the text.
    """
    keys = [d.get("key") for d in (pub.get("documents") or []) if d.get("key")]
    keys = [k for k in keys if not re.search(r"MainChanges", k, re.I)] or keys
    if not keys:
        return None
    key = next((k for k in keys if re.search(r"consolidated", k, re.I)), keys[0])
    path = PDFS / f"{book}_{edition}.pdf"
    if not path.exists() or path.stat().st_size < 2000:
        PDFS.mkdir(parents=True, exist_ok=True)
        url = DOCS + urllib.parse.quote(key)
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                path.write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            print(f"   не скачался {book}: {e}", flush=True)
            return None

    doc = fitz.open(path)
    children = pdf_outline.split_oversized(
        pdf_outline.outline_tree(doc, t.text_quality), t.text_quality)
    if len(children) == 1 and children[0].get("children"):
        children = children[0]["children"]
    node: dict = {"number": pub["reference"].upper(),
                  "title": pub.get("title") or book,
                  "sourceRef": f"rulesexplorer-docs.bureauveritas.com/{key}"}
    if children:
        # NR396 reprints the HSC Code's parallel sets, so a chapter holds two
        # sections called "General"; without this the import merges them.
        node["children"] = t.make_unique(children)
    else:
        # NI409 is a 1995 scan with no text layer at all. It still belongs on
        # the shelf: the title is searchable and sourceRef points at the file,
        # so it can be read by the vision pass instead of vanishing here.
        text = pdf_pages.text_of(path, 1, doc.page_count)
        if text:
            node["contentText"] = text
            node["textQuality"] = t.text_quality(text)
            # A book with no outline at all is still a book: NI560 arrived as
            # one node of 73 000 characters.
            pdf_outline.split_oversized([node], t.text_quality)
    doc.close()
    return node


def build_book(pub: dict) -> dict | None:
    """One publication → its Part / Chapter / Section tree, sections with text."""
    book, edition = pub["reference"].lower(), bv.edition_of(pub)
    if not edition:
        return None
    try:
        nodes = bv.hierarchy(book, edition)
    except Exception as e:  # noqa: BLE001 — a book without a published tree
        print(f"   нет структуры {book}: {e}", flush=True)
        nodes = []
    if not nodes:
        return build_from_pdf(pub, book, edition)

    wanted = [n for n in nodes if n.get("type") in BRANCH]
    by_id = {n["id"]: {"number": cite(n["position"]), "title": n.get("name") or n["position"],
                       "_type": n["type"], "_pos": n["position"]} for n in wanted}
    roots: list[dict] = []
    for n in wanted:
        node = by_id[n["id"]]
        parent = by_id.get(n.get("parent") or "")
        (parent.setdefault("children", []) if parent else roots).append(node)

    # One call per section brings every requirement under it; each then goes to
    # the deepest node that owns it, so an article's text sits on the article.
    sections = [n for n in by_id.values() if n["_type"] == "sect"]
    at_position = {n["_pos"]: n for n in by_id.values()}
    with ThreadPoolExecutor(max_workers=8) as pool:
        hits = list(pool.map(
            lambda s: bv.articles(book, edition, s["_pos"]), sections))

    owned: dict[int, list[tuple[int, str]]] = {}
    for section, requirements in zip(sections, hits):
        for hit in requirements:
            body = bv.to_text(hit.get("text") or "")
            if not body:
                continue
            position = hit.get("position") or section["_pos"]
            owner = owner_of(position, at_position) or section
            label = position.split(", ")[-1]
            owned.setdefault(id(owner), []).append(
                (hit.get("position_value") or 0, f"[{label}] {body}"))

    for node in by_id.values():
        pieces = owned.get(id(node))
        if not pieces:
            continue
        text = "\n\n".join(body for _, body in sorted(pieces, key=lambda p: p[0]))
        node["contentText"] = text
        node["textQuality"] = t.text_quality(text)

    def strip(nodes: list[dict]) -> list[dict]:
        out = []
        for n in nodes:
            n.pop("_type", None)
            n.pop("_pos", None)
            if n.get("children"):
                n["children"] = strip(n["children"])
            if n.get("children") or n.get("contentText"):
                out.append(n)
        return out

    roots = pdf_outline.split_oversized(t.make_unique(strip(roots)), t.text_quality)
    if not roots:
        return None
    return {"number": pub["reference"].upper(), "title": pub.get("title") or book,
            "children": roots, "sourceRef": f"rulesexplorer.bureauveritas.com/{book}/{edition}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--only", help="load one reference, e.g. nr500")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pubs = bv.catalogue()
    kept = [p for p in pubs if keep(p) and p["rule_type"] in SHELVES]
    if args.only:
        kept = [p for p in kept if p["reference"].lower() == args.only.lower()]
    dropped = [p for p in pubs if not keep(p) and p["rule_type"] in SHELVES]
    print(f"каталог: {len(pubs)} публикаций · берём {len(kept)} · "
          f"отброшено по типу судна {len(dropped)}", flush=True)

    def count(nodes):
        return sum(1 + count(n.get("children") or []) for n in nodes)

    for shelf in SHELVES.values():
        books = [p for p in kept if SHELVES[p["rule_type"]] == shelf]
        print(f"\n════ {shelf}  ({len(books)} книг)", flush=True)
        ok = failed = 0
        t0 = time.time()
        for pub in books:
            tree = build_book(pub)
            if not tree:
                print(f"   пусто: {pub['reference'].upper()} {pub.get('title','')[:50]}", flush=True)
                continue
            n = count([tree])
            if args.dry_run:
                print(f"   [{tree['number']}] {tree['title'][:58]:58} {n:5} узлов")
                continue
            try:
                t.post_json(args.base, "documents/publications/tree/import", args.token, {
                    "category": PUBLICATION,
                    "nodeType": shelf,
                    "jurisdiction": "class:BV",
                    "nodes": [tree],
                })
                ok += 1
                print(f"   [{tree['number']}] {tree['title'][:52]:52} {n:5} узлов", flush=True)
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"   FAIL {tree['number']}: {e.code} {e.read()[:140]!r}", flush=True)
        if not args.dry_run:
            print(f"   DONE {ok} ok, {failed} fail ({time.time() - t0:.0f}s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
