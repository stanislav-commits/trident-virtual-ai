#!/usr/bin/env python3
"""Bureau Veritas Rules Explorer — the public API behind rulesexplorer.

Three endpoints carry everything:

    /api/explore_publication            the catalogue, one entry per edition
    /api/hierarchy?book=&edition=       the whole book as a flat parent list
    /api/getArticles?book=&edition=&position=   the requirements under a position

The last one is a search, so it is asked at section level: every requirement
under a section comes back in one call — checked against the hierarchy's own
count, 165 of 165 and 131 of 131 in the two largest sections of NR500.

Responses are gzipped and immutable for a published edition, so each one is
cached on disk; a second run of the loader touches the network only for what
it has not seen.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = "https://rulesexplorer.bureauveritas.com"
CACHE = Path(os.environ.get(
    "BV_CACHE",
    "/private/tmp/claude-501/-Users-stassandu/"
    "3e0a2807-eb63-4b28-8f37-1fe820ba1c8f/scratchpad/bvcache"))


def get(path: str, retries: int = 3):
    cache = CACHE / (hashlib.md5(path.encode()).hexdigest() + ".json")
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except Exception:  # noqa: BLE001 — a half-written cache entry
            cache.unlink(missing_ok=True)
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(BASE + path, headers={
                "Accept-Encoding": "gzip",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            })
            raw = urllib.request.urlopen(req, timeout=120).read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            data = json.loads(raw)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(data))
            return data
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]


def catalogue() -> list[dict]:
    """One entry per publication: the edition in force."""
    pubs = get("/api/explore_publication")["publications"]
    latest: dict[str, dict] = {}
    for p in pubs:
        key = p["reference"].lower()
        if key not in latest or p["date"] > latest[key]["date"]:
            latest[key] = p
    return sorted(latest.values(), key=lambda p: p["reference"])


def edition_of(pub: dict) -> str | None:
    """The edition slug the API wants — it is in the document key path."""
    for doc in pub.get("documents") or []:
        # "jul2025" but also "july2024" — BV writes the month either way.
        m = re.search(r"/([a-z]{3,5}\d{4})/", doc.get("key", ""))
        if m:
            return m.group(1)
    return None


def hierarchy(book: str, edition: str) -> list[dict]:
    return get(f"/api/hierarchy?book={book}&edition={edition}").get("nodes", [])


def articles(book: str, edition: str, position: str) -> list[dict]:
    q = urllib.parse.quote(position)
    hits = get(f"/api/getArticles?book={book}&edition={edition}&position={q}")
    return [h["_source"] for h in hits if isinstance(h, dict) and "_source" in h]


# ── the rule text ────────────────────────────────────────────────────────────
# BV writes requirements as XML: paragraphs, lists, cross-references, and CALS
# tables. The tables are the reason to read the XML at all rather than the PDF
# — a scantling table flattened into a stream of cells pairs the wrong number
# with the wrong parameter.

def _cell(entry: ET.Element) -> str:
    return re.sub(r"\s+", " ", _inline(entry)).strip().replace("|", "\\|")


def _rows(parent: ET.Element | None) -> list[list[str]]:
    if parent is None:
        return []
    return [[_cell(e) for e in row.findall("ENTRY")] for row in parent.iter("ROW")]


def _table(table: ET.Element) -> str:
    """A CALS table as markdown, with its own parts in their own places.

    Taking every ROW in document order puts the footnotes between the heading
    and the body — the file lists THEAD, then TFOOT, then TBODY — so the table
    of mechanical joints in NR500 opened with "Above free board deck only" and
    lost its real heading, "Systems | Kind of connections".
    """
    head = _rows(table.find(".//THEAD"))
    body = _rows(table.find(".//TBODY"))
    foot = _rows(table.find(".//TFOOT"))
    if not head and not body:
        body = _rows(table)
    if not head and not body:
        return ""

    width = max((len(r) for r in head + body), default=0)
    if not width:
        return ""
    pad = lambda r: r + [""] * (width - len(r))  # noqa: E731

    out = ["| " + " | ".join(pad(head[0] if head else [])) + " |",
           "|" + "|".join([" --- "] * width) + "|"]
    out += ["| " + " | ".join(pad(r)) + " |" for r in head[1:] + body]
    # Footnotes are notes, not rows: as rows they read like requirements.
    notes = [" ".join(c for c in r if c).strip() for r in foot]
    out += [f"({i}) {n}" for i, n in enumerate(filter(None, notes), 1)]
    return "\n".join(out)


BLOCK = {"P", "IL", "ILAL", "TBLFNOT", "TBLNOT", "SYD", "SYD1", "SYD2", "CLN", "TTAB"}
# A cross-reference is its own word: without the spaces the text reads
# "given inCh 1, Sec 5", and the reference stops being searchable.
SPACED = {"R", "REF", "XREF"}


def _inline(el: ET.Element) -> str:
    out = [el.text or ""]
    for child in el:
        if child.tag.upper() == "TABLE":
            continue
        body = _inline(child)
        out.append(f" {body} " if child.tag.upper() in SPACED else body)
        out.append(child.tail or "")
    return "".join(out)


def to_text(xml: str) -> str:
    """One requirement as plain text, its tables kept as markdown."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", xml)).strip()

    pieces: list[str] = []

    def walk(el: ET.Element) -> None:
        tag = el.tag.upper()
        if tag == "TABLE":
            md = _table(el)
            if md:
                pieces.append(md)
            return
        if tag in BLOCK:
            text = re.sub(r"[ \t]+", " ", _inline(el)).strip()
            text = re.sub(r"\s+([,.;:)\]])", r"\1", text)
            if text:
                pieces.append(("- " if tag in ("IL", "ILAL") else "") + text)
            for child in el:
                if child.tag.upper() == "TABLE":
                    walk(child)
            return
        for child in el:
            walk(child)

    walk(root)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(pieces)).strip()


def section_text(book: str, edition: str, position: str) -> str:
    """Every requirement under a section, in the book's own order."""
    hits = articles(book, edition, position)
    hits.sort(key=lambda s: s.get("position_value") or 0)
    out = []
    for h in hits:
        body = to_text(h.get("text") or "")
        if not body:
            continue
        label = (h.get("position") or "").split(", ")[-1]
        out.append(f"[{label}] {body}" if label else body)
    return "\n\n".join(out).strip()
