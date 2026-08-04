#!/usr/bin/env python3
"""Shared machinery for loading an R4Y folder into the publications tree.

The R4Y file names are already a path — `Act - Part VI - Prevention of
Pollution - 173 - Contributions by Importers of Oil` — so the tree is read off
the names rather than guessed from content:

  1. split the name on " - ";
  2. the document root is everything before the first axis crumb
     (Part / Chapter / Schedule / Annex / Appendix / Regulation);
  3. an axis crumb absorbs the crumb after it — "Part VI" + "Prevention of
     Pollution" is one branch, not two levels;
  4. a bare number is the section number and what follows is its title.

Then four clean-ups, each of which came from something the library actually
does wrong: truncated cross-headings collapse, a branch holding one leaf
dissolves into its parent, a root that is only an identifier borrows the name
below it, and numbered runs fold into one series branch.

A publication supplies its own vocabulary through `Spec`; everything else here
is the same for Malta, the UK and Lloyd's.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

SRC = Path.home() / "Downloads" / "R4Y"

# 15 MB is the server's JSON limit; stay well under it.
MAX_REQUEST_CHARS = 4_000_000

# Lloyd's numbers a rule set Part → Chapter → Section, so Section is an axis
# too. Everywhere else it simply never appears as its own crumb.
# Volume and Book belong here too: Lloyd's splits a rule set into Volumes and
# MQPS into Books, and without them each volume became a document of its own
# instead of a branch under one.
AXIS = re.compile(
    r"^(Part|Chapter|Schedules?|Annex|Appendix|Regulation|Section|Volume|Book)\b", re.I)
NUM = re.compile(r"^\d{1,3}[A-Z]?$")
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".gif": "image/gif", ".tif": "image/tiff"}
NEVER = re.compile(r"^$")


@dataclass
class Spec:
    """What makes one publication different from the next."""

    publication: str
    folder: str
    jurisdiction: str | None = None
    #: name → category; None drops the file (it belongs to another publication)
    category_of: object = None
    #: titles that are an identifier and nothing else — the name lives in the
    #: crumb after them, so the code becomes `number` and the name the title
    code_only: re.Pattern = NEVER
    #: (category, pattern, branch title) — numbered runs folded into a branch
    series: list = field(default_factory=list)
    #: (pattern with groups code+title, branch title) — a run whose members are
    #: single files that should hang under one named series root
    series_roots: list = field(default_factory=list)
    #: extra folders to pull files from when the main one is missing some
    also: list = field(default_factory=list)
    #: folder → pattern; a file from that folder is taken only if it matches.
    #: One publication borrowing a run out of another's folder — Cayman's CISR
    #: flyers filed under "Misc (International)" — must not swallow the rest.
    folder_filters: dict = field(default_factory=dict)
    #: folder → category, for a publication whose shelves ARE its folders. IMO
    #: numbers a guideline, a performance standard and a manual all as A.xxx,
    #: so only the folder says which shelf a file belongs on.
    folder_categories: dict = field(default_factory=dict)
    #: name → name, applied before parsing. A single-work publication puts its
    #: own divisions on the rail (SOLAS: Foreword / Part 1 / Part 2), so the
    #: crumbs naming the work and the part are stripped before the tree is read.
    rename: object = None


# ─────────────────────────── revisions ───────────────────────────

# Only "(Rev. …)" marks a revision. A bare "(2)" does NOT: where the export
# dropped a level, R4Y used it to tell apart sections that ended up with the
# same name — Lloyd's has five different "Section 1 Plans and particulars"
# under one truncated Part, and treating them as copies threw away 384 files
# of live regulation.
REV = re.compile(r"\s*\((Rev\.?\s*[^)]*)\)\s*$")


def revision_rank(name: str) -> tuple:
    """Sort key that puts the newest revision last.

    Revision marks come as a version (Rev. 2.1) or a date (Rev. 06_23), so
    compare the digits in order; a file with no mark is the original.
    """
    m = REV.search(Path(name).stem)
    if not m:
        return (0,)
    return (1, tuple(int(d) for d in re.findall(r"\d+", m.group(1))))


def newest_only(files: list[str]) -> tuple[list[str], list[str]]:
    """Keep one file per document; return (kept, superseded).

    Grouping runs on the stem — the revision mark sits before the extension
    ("… (Rev. 2.1).pdf"), so matching the whole file name never fires.
    """
    groups: dict[str, list[str]] = defaultdict(list)
    for f in files:
        groups[REV.sub("", Path(f).stem).strip()].append(f)
    kept, dropped = [], []
    for variants in groups.values():
        variants.sort(key=revision_rank)
        kept.append(variants[-1])
        dropped.extend(variants[:-1])
    return kept, dropped


# ─────────────────────────── the path parser ───────────────────────────

def split_crumbs(name: str) -> list[str]:
    """Split on " - ", but not inside a bracket pair that actually closes.

    "Arms Act (Chapter 480 - 2020 Edition)" is one name; splitting it blindly
    left a document called "Arms Act (Chapter 480". But the export also cuts
    names mid-bracket — "Marine and Coastal Access Act 2009 (Cha" — and an
    unclosed bracket must NOT protect the rest of the path, or the Act's Parts
    stop being crumbs at all.
    """
    covered = [False] * len(name)
    stack: list[int] = []
    for i, ch in enumerate(name):
        if ch in "([":
            stack.append(i)
        elif ch in ")]" and stack:
            for j in range(stack.pop(), i + 1):
                covered[j] = True

    out, start, i = [], 0, 0
    while i < len(name):
        if not covered[i] and name.startswith(" - ", i):
            out.append(name[start:i])
            i += 3
            start = i
            continue
        i += 1
    out.append(name[start:])
    return [c.strip() for c in out if c.strip()]


def parse(name: str) -> tuple[str, list[str], str | None, str]:
    """Name → (document, [branches], section number, leaf title)."""
    crumbs = split_crumbs(name)
    # From index 1 on: a document whose own name opens with "Regulations…" is
    # the root, not an axis.
    axes = [i for i, c in enumerate(crumbs) if i > 0 and AXIS.match(c)]
    if not axes:
        return crumbs[0], [], None, " - ".join(crumbs[1:]) or crumbs[0]

    head = axes[0]
    document = " — ".join(crumbs[:head]) or crumbs[0]
    rest = crumbs[head:]

    number, cut = None, len(rest)
    for i, c in enumerate(rest):
        if NUM.fullmatch(c):
            number, cut = c, i
            break
    if number is not None:
        raw, title = rest[:cut], " - ".join(rest[cut + 1:])
    else:
        raw, title = rest[:-1], rest[-1]

    branches, i = [], 0
    while i < len(raw):
        crumb = raw[i]
        # Never glue a truncated crumb onto an axis: "Chap..." says nothing and
        # would ride along inside the Part's own label instead of being dropped.
        if AXIS.match(crumb) and i + 1 < len(raw) and not AXIS.match(raw[i + 1]) \
                and not raw[i + 1].endswith("..."):
            branches.append(f"{crumb} — {raw[i + 1]}")
            i += 2
        else:
            branches.append(crumb)
            i += 1
    # Truncated cross-headings carry no meaning — drop the level, keep the leaf.
    # A Part keeps its level even when its own title was cut: "Part VII —
    # Liability of Shipowners and ..." still reads as Part VII, and dropping it
    # would spill that Part's sections into the root of the Act.
    branches = [b for b in branches if AXIS.match(b) or not b.endswith("...")]
    return document, branches, number, (title or document)


# ─────────────────────────── text ───────────────────────────

def extract_text(path: Path) -> tuple[str | None, float]:
    if path.suffix.lower() != ".pdf":
        return None, 0.0
    try:
        out = subprocess.run(["pdftotext", str(path), "-"],
                             capture_output=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return None, 0.0
    raw = out.stdout.decode("utf8", "replace").replace("\f", "\n\n").strip()
    return (raw, text_quality(raw)) if raw else (None, 0.0)


# The older notices are titled in capitals — "SOLAS REQUIREMENT PROHIBITION OF
# PFOS" — which is how the site prints them and how nothing else in the library
# reads. Case is normalised, but only the case: the acronyms a notice is about
# are exactly what a search is for, so they keep their own spelling.
CANON = {"MOU": "MoU", "NOX": "NOx", "SOX": "SOx", "CO2": "CO2", "PH": "pH",
         "RO-RO": "Ro-Ro", "E-NAVIGATION": "e-Navigation"}
ACRONYMS = {
    "IMO", "MSC", "MEPC", "SOLAS", "MARPOL", "STCW", "ISM", "ISPS", "PSC", "MOU",
    "EU", "UK", "US", "USA", "USCG", "EMSA", "EGCS", "PFOS", "PFAS", "BWM", "IOPP",
    "LSA", "FSS", "FAL", "IMDG", "IMSBC", "MLC", "ILO", "WHO", "GMDSS", "AIS",
    "LRIT", "ECDIS", "VDR", "SAR", "SART", "EPIRB", "DSC", "GPS", "DP", "HSC",
    "MODU", "CSR", "ESP", "IHM", "CIC", "ETS", "GHG", "EEDI", "EEXI", "CII",
    "SEEMP", "ISO", "IACS", "MED", "LNG", "LPG", "HFO", "VLSFO", "MGO", "ODS",
    "COLREG", "ILLC", "IGF", "IGC", "PSSA", "TMSA", "ITF", "NOX", "SOX", "CO2",
    "RINA", "DNV", "ABS", "BV", "LR", "CCS", "NK", "KR", "PRS", "IRS", "RO", "ROS",
    "SMC", "DOC", "ISSC", "MRV", "SEA", "II", "III", "IV", "VI", "VII", "VIII",
}
SMALL = {"a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "at", "by",
         "with", "from", "as", "is", "are", "its", "into", "under", "over"}


def pretty(title: str) -> str:
    """Shouting titles into ordinary case; mixed-case titles are left alone."""
    letters = [c for c in title if c.isalpha()]
    if not letters or sum(c.isupper() for c in letters) / len(letters) < 0.7:
        return title

    def word(w: str, first: bool) -> str:
        core = w.strip("()[]{}.,:;\"'").upper()
        if core in CANON:
            return w.upper().replace(core, CANON[core])
        if core in ACRONYMS or any(ch.isdigit() for ch in w):
            return w
        low = w.lower()
        if not first and low.strip("()[]{}.,:;\"'") in SMALL:
            return low
        low = "-".join(p[:1].upper() + p[1:] if p else p for p in low.split("-"))
        # After an apostrophe only a word, never a possessive: Dell'Ambiente
        # but Fireman's.
        for sep in ("'", "\u2019"):
            parts = low.split(sep)
            low = sep.join(parts[:1] + [p[:1].upper() + p[1:] if len(p) >= 3 else p
                                        for p in parts[1:]])
        return low

    return " ".join(word(w, i == 0) for i, w in enumerate(title.split()))


def text_quality(text: str) -> float:
    """Mirrors the backend heuristic so the Parse queue agrees with the loader."""
    sample = text[:20000]
    if len(sample.strip()) < 40:
        return 0.0
    words = re.findall(r"[A-Za-z]{2,}", sample)
    if not words:
        return 0.0
    letters = sum(c.isalpha() for c in sample)
    weird = len(re.findall(r"[^\x20-\x7E\n\r\t -ɏ‐-⇧€£°§±µ]", sample))
    avg = sum(map(len, words)) / len(words)
    score = 1.0
    if letters / len(sample) < 0.45:
        score -= 0.4
    if weird / len(sample) > 0.02:
        score -= 0.4
    if avg < 3.2 or avg > 9:
        score -= 0.3
    return round(max(0.0, score), 2)


# ─────────────────────────── ordering ───────────────────────────

def roman_value(token: str) -> int:
    value, prev = 0, 0
    for ch in reversed(token.upper()):
        cur = ROMAN.get(ch, 0)
        value += -cur if cur < prev else cur
        prev = max(prev, cur)
    return value


def node_order(node: dict) -> tuple:
    """Part II before Part III, section 9 before section 10, Schedules last.

    Ordering has to read the `number`, not just the title. Sections carry their
    number there and nothing else distinguishes them, so sorting on the title
    alone put regulation 174 above 159 — alphabetical order on a number.
    """
    title = (node.get("title") or "").strip()
    number = (node.get("number") or "").strip()

    if not number and re.match(r"^Schedules?\b", title, re.I):
        return (3, 0, (), "", "")

    # The suffix may be attached or hyphenated — "Part IIIA" and "Part IX-A"
    # both follow their plain number, and without catching it the two sort
    # equal and only Python's stable sort keeps them apart.
    axis = re.match(
        r"^(Part|Chapter|Annex|Appendix|Regulation|Schedule)\s+([IVXLCDM]+|\d+)-?([A-Za-z]?)\b",
        number or title, re.I)
    if axis:
        kind, token, suffix = axis.group(1).lower(), axis.group(2), axis.group(3)
        value = int(token) if token.isdigit() else roman_value(token)
        # The body of a text comes before what is attached to it: MARPOL Annex I
        # runs Regulation 1…39 and then its appendices, and sorting on the
        # number alone interleaved "Appendix 1" with "Regulation 1".
        rank = 1 if kind in ("appendix", "annex") else 0
        return (0, rank, (value,), suffix.upper(), "")

    # Any other identifier sorts on the numbers inside it, in order: that puts
    # MGN 689 before MGN 714 and SI …No. 0430 before …No. 0563.
    digits = re.findall(r"\d+", number)
    if digits:
        suffix = re.search(r"\d+\s*([A-Za-z])\b", number)
        return (1, 0, tuple(int(d) for d in digits),
                (suffix.group(1).upper() if suffix else ""), "")

    return (2, 0, (), "", title.lower())


def sort_tree(nodes: list[dict]) -> list[dict]:
    for n in nodes:
        if n.get("children"):
            n["children"] = sort_tree(n["children"])
    return sorted(nodes, key=node_order)


# ─────────────────────────── tree assembly ───────────────────────────

AXIS_LABEL = re.compile(
    r"^(Part|Chapter|Section|Annex|Appendix|Volume|Book|Regulation)\s+"
    r"([IVXLCDM]+|\d+)(-?[A-Za-z]?)\s*[—-]?\s*(.*)$", re.I)


def split_axis(crumb: str) -> dict:
    """"Part 5 Main and Auxiliary Machinery" → number "Part 5", title the rest.

    Lloyd's writes the number and the name in one breath, and the export then
    truncates the name — so the shelf read as a column of "Part 5 Main and
    Auxiliary Machinery, Sy...". With the number in its own field the row leads
    with what is certain and the cut name follows.
    """
    m = AXIS_LABEL.match(crumb)
    if not m or not m.group(4).strip():
        return {"title": crumb}
    return {"number": f"{m.group(1)} {m.group(2)}{m.group(3)}".strip(),
            "title": m.group(4).strip()}


def dissolve_single_leaf(nodes: list[dict]) -> list[dict]:
    """A branch holding exactly one leaf is noise — hand the leaf up."""
    out = []
    for n in nodes:
        kids = n.get("children") or []
        if kids:
            n["children"] = dissolve_single_leaf(kids)
            kids = n["children"]
        if kids and len(kids) == 1 and not (kids[0].get("children") or []) \
                and not n.get("contentText"):
            leaf = kids[0]
            # The label has to survive somewhere. MSIS 12 calls both Chapter 13
            # and Chapter 14 "Structural Fire Protection" — drop the branch
            # without keeping its name and the two leaves become identical, at
            # which point the idempotent import merges them and a chapter is
            # silently lost.
            label = (n.get("number") or n.get("title") or "").strip()
            # The label is often "Chapter I — <the leaf's own title>"; keeping
            # the whole thing as the number just repeats the title beside it.
            head, sep, tail = label.partition(" — ")
            if sep and tail.strip().lower() == (leaf.get("title") or "").strip().lower():
                label = head
            # The leaf may already carry its own number. Then the two combine
            # the way a rule is cited — "Chapter 2, Section 1" — because
            # dropping the branch made Chapter 2 and Chapter 5 both read
            # "Section 1 General" and one of them was merged away.
            if label and leaf.get("number") and len(f"{label}, {leaf['number']}") <= 60:
                leaf["number"] = f"{label}, {leaf['number']}"
            elif label and not leaf.get("number"):
                # `number` is varchar(60); a long label goes into the title
                # instead of overflowing the column and failing the import.
                if len(label) <= 60:
                    leaf["number"] = label
                else:
                    leaf["title"] = f"{label} — {leaf['title']}"[:400]
            out.append(leaf)
        else:
            out.append(n)
    return out


def flatten_single_file_document(root: dict, spec: Spec) -> dict:
    """A one-file document is a document, not a branch over itself.

    Most notices and statutory instruments are a single PDF, and wrapping them
    gave a twisty that opened onto exactly one child with the same name.
    """
    kids = root.get("children") or []
    if len(kids) == 1 and not (kids[0].get("children") or []):
        leaf = kids[0]
        root["number"] = leaf.get("number")
        root["contentText"] = leaf.get("contentText")
        root["textQuality"] = leaf.get("textQuality")
        root["sourceRef"] = leaf.get("sourceRef")
        leaf_title = (leaf.get("title") or "").strip()
        if spec.code_only.match(root["title"]) and leaf_title \
                and leaf_title.lower() != root["title"].lower():
            root["number"] = root["title"]
            root["title"] = leaf_title
        elif leaf_title and leaf_title.lower() != root["title"].lower() \
                and not root.get("number"):
            # Not a code — then the crumb was never a container, just the first
            # half of the name. "Commercial Yacht" + "Pleasure Yacht Changeover
            # Guidelines" is one document, and half a name on the shelf is
            # worse than a long one.
            root["title"] = f"{root['title']} — {leaf_title}"[:400]
        root.pop("children", None)
    return root


def code_key(title: str, spec: Spec) -> str | None:
    """The identifier a document is known by, or None if it has no code."""
    head = title.split(" — ")[0].strip()
    return head.lower() if spec.code_only.match(head) else None


def merge_code_roots(trees: list[dict], spec: Spec) -> list[dict]:
    """One code, one document.

    Files of the same instrument split into two roots whenever some of them
    carried an axis crumb and some did not — "MSIS 11" and "MSIS 11 —
    International Code of Safety…" are the same document.
    """
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    singles: list[dict] = []
    for t in trees:
        key = code_key(t["title"], spec)
        (groups[(t["category"], key)] if key else singles).append(t)

    merged = list(singles)
    for members in groups.values():
        if len(members) == 1:
            merged.append(members[0])
            continue
        members.sort(key=lambda t: (spec.code_only.match(t["title"]) is not None,
                                    -len(t["title"])))
        keeper, rest = members[0], members[1:]
        keeper.setdefault("children", [])
        for other in rest:
            if other.get("contentText") and not keeper.get("contentText"):
                keeper["children"].append({
                    "number": other.get("number"),
                    "title": other["title"],
                    "contentText": other.get("contentText"),
                    "textQuality": other.get("textQuality"),
                    "sourceRef": other.get("sourceRef"),
                })
            keeper["children"].extend(other.get("children") or [])
        keeper["children"] = sort_tree(keeper["children"])
        merged.append(keeper)
    return merged


def name_code_only_roots(trees: list[dict], spec: Spec) -> list[dict]:
    """A root still showing only its code borrows the fullest name below it."""
    for t in trees:
        if not spec.code_only.match(t["title"]):
            continue
        names = [c["title"] for c in (t.get("children") or [])
                 if c.get("title") and not spec.code_only.match(c["title"])]
        if names:
            t["number"] = t["title"]
            t["title"] = max(names, key=len)
    return trees


def group_series(trees: list[dict], spec: Spec) -> list[dict]:
    """Fold numbered runs into one branch — dozens of rows become one."""
    if not spec.series:
        return trees
    kept: list[dict] = []
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for t in trees:
        # Match the number and the title separately. Joining them put the
        # number first — "Section 2 LR-SR-ADP-001 …" — and every pattern is
        # anchored at the start, so a whole run of single-file documents
        # slipped past its own series.
        idents = [t.get("number") or "", t.get("title") or ""]
        for category, pattern, branch in spec.series:
            if t["category"] == category and any(pattern.match(i) for i in idents):
                buckets[(category, branch)].append(t)
                break
        else:
            kept.append(t)

    for (category, branch), members in buckets.items():
        # A branch over a single document is the same noise as a branch over a
        # single leaf — let it stand on the shelf by itself.
        if len(members) == 1:
            kept.append(members[0])
            continue
        kept.append({
            "category": category,
            "title": branch,
            "children": [{k: v for k, v in t.items() if k != "category"}
                         for t in sorted(members, key=node_order)],
        })
    return kept


def group_by_year(trees: list[dict], category: str, pattern: re.Pattern,
                  branch: str) -> list[dict]:
    """Twenty-odd years of statutory instruments, one row per year."""
    kept, years = [], defaultdict(list)
    for t in trees:
        m = None
        if t["category"] == category:
            for ident in (t.get("number") or "", t.get("title") or ""):
                m = pattern.match(ident)
                if m:
                    break
        if m:
            years[m.group(1)].append(t)
        else:
            kept.append(t)
    if years:
        kept.append({
            "category": category,
            "title": branch,
            "children": [
                {"title": year,
                 "children": [{k: v for k, v in t.items() if k != "category"}
                              for t in sorted(members, key=node_order)]}
                for year, members in sorted(years.items())
            ],
        })
    return kept


def build_documents(files: list[tuple[Path, str]], spec: Spec) -> list[dict]:
    """[(path, category)] → one subtree per document root."""
    docs: dict[tuple[str, str], dict] = {}
    for path, category in files:
        name = spec.rename(path.stem) if spec.rename else path.stem
        document, branches, number, title = parse(name)
        # A run of single-file notices: the series deserves the branch, not
        # each notice. Take the identifier from the front of the name — not
        # every notice carries a " - " to split on.
        for pattern, branch in spec.series_roots:
            m = pattern.match(name)
            if m:
                document, branches = branch, []
                number = m.group("code").strip()
                title = (m.groupdict().get("title") or "").strip(" -_") or number
                break
        key = (category, document)
        root = docs.setdefault(key, {"category": category, "title": document,
                                     "children": [], "_index": {}})
        cursor = root
        for b in branches:
            nxt = cursor["_index"].get(b)
            if nxt is None:
                nxt = {**split_axis(b), "children": [], "_index": {}}
                cursor["_index"][b] = nxt
                cursor["children"].append(nxt)
            cursor = nxt
        text, quality = extract_text(path)
        # "Section 1 Definitions" is a number and a name too, not one string.
        if not number:
            split = split_axis(title)
            number, title = split.get("number"), split["title"]
        # Two files can still land on the same (number, title) under one parent
        # — one carried a truncated chapter crumb that was dropped, the other
        # never had one. The import matches on that pair, so the second would
        # be merged into the first and vanish with the run still reporting
        # success. Number the clashes the way the export itself does.
        seen = cursor.setdefault("_seen", set())
        stamp = (number or "", title)
        if stamp in seen:
            n = 2
            while (stamp[0], f"{title} ({n})") in seen:
                n += 1
            title = f"{title} ({n})"
            stamp = (stamp[0], title)
        seen.add(stamp)
        cursor["children"].append({
            "number": number,
            "title": title,
            "contentText": text,
            "textQuality": quality,
            "sourceRef": str(path.relative_to(SRC)),
        })

    def strip(node):
        node.pop("_index", None)
        node.pop("_seen", None)
        for c in node.get("children") or []:
            strip(c)
        if not node.get("children"):
            node.pop("children", None)

    trees = []
    for root in docs.values():
        root["children"] = sort_tree(dissolve_single_leaf(root["children"]))
        strip(root)
        trees.append(flatten_single_file_document(root, spec))
    return group_series(name_code_only_roots(merge_code_roots(trees, spec), spec), spec)


def make_unique(nodes: list[dict], seen_refs: set | None = None) -> list[dict]:
    """Last pass before the import: no sibling repeats, no file appears twice.

    The transforms that run after the tree is built — dissolving a branch,
    merging two roots that turned out to be the same document — can put two
    nodes with the same (number, title) under one parent. The import matches on
    exactly that pair, so the second silently becomes the first and its file is
    lost while the run still reports success. This is the one place that
    guarantees it cannot happen, whatever the publication.
    """
    seen_refs = set() if seen_refs is None else seen_refs
    out, taken = [], set()
    for n in nodes:
        ref = n.get("sourceRef")
        if ref and ref in seen_refs:
            continue
        if ref:
            seen_refs.add(ref)
        number, title = n.get("number") or "", n.get("title") or ""
        if (number, title) in taken:
            i = 2
            while (number, f"{title} ({i})") in taken:
                i += 1
            title = f"{title} ({i})"
            n["title"] = title
        taken.add((number, title))
        if n.get("children"):
            n["children"] = make_unique(n["children"], seen_refs)
        out.append(n)
    return out


def count_nodes(nodes) -> int:
    return sum(1 + count_nodes(n.get("children") or []) for n in nodes)


def chars_of(nodes) -> int:
    return sum(len(n.get("contentText") or "") + 200 + chars_of(n.get("children") or [])
               for n in nodes)


# ─────────────────────────── api ───────────────────────────

def api(base, path, token=None, data=None, content_type=None, method=None):
    req = urllib.request.Request(f"{base}/{path}", data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def post_json(base, path, token, payload):
    return api(base, path, token, data=json.dumps(payload).encode(),
               content_type="application/json")


def multipart(filename: str, payload: bytes, mime: str):
    boundary = "----r4ytree"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def upload_missing_originals(base: str, token: str) -> None:
    """Parse reads the ORIGINAL file, and the import carries text only."""
    pending = api(base, "documents/publications/tree/pending-originals?limit=2000", token)
    if not pending:
        return
    print(f"attaching originals to {len(pending)} node(s)", flush=True)
    ok = fail = 0
    for node in pending:
        ref = node.get("sourceRef")
        path = SRC / ref if ref else None
        if not path or not path.exists():
            fail += 1
            continue
        try:
            body, ctype = multipart(path.name, path.read_bytes(),
                                    MIME.get(path.suffix.lower(), "application/octet-stream"))
            api(base, f"documents/publications/tree/nodes/{node['id']}/content",
                token, data=body, content_type=ctype)
            ok += 1
        except Exception as e:  # noqa: BLE001
            fail += 1
            print(f"  FAIL {node['title'][:60]}: {e}", flush=True)
    print(f"originals attached: ok={ok} fail={fail}", flush=True)


# ─────────────────────────── runner ───────────────────────────

def collect(spec: Spec) -> tuple[list[tuple[Path, str]], list[str], int]:
    sources = spec.folder_categories or {spec.folder: None}
    names: list[Path] = []
    have: set[str] = set()
    for folder in sources:
        keep = spec.folder_filters.get(folder)
        for f in (SRC / folder).iterdir():
            if f.is_file() and not f.name.startswith("."):
                if keep is not None and not keep.match(f.stem):
                    continue
                names.append(f)
                have.add(f.stem)
    for extra in spec.also:
        for f in (SRC / extra).iterdir():
            if f.is_file() and not f.name.startswith(".") and f.stem not in have:
                names.append(f)

    kept, dropped = newest_only([f.name for f in names])
    by_name = {f.name: f for f in names}
    skipped = 0
    files: list[tuple[Path, str]] = []
    for n in kept:
        path = by_name[n]
        category = sources.get(path.parent.name)
        if category is None:
            category = spec.category_of(path.stem) if spec.category_of else None
        if category is None:
            skipped += 1
            continue
        files.append((path, category))
    return files, dropped, skipped


def run(spec: Spec, build=None) -> int:
    """CLI shared by every publication loader."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--token", help="use an existing session token instead of logging in")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.dry_run and not args.token and not (args.user and args.password):
        ap.error("give --token, or --user with --password")

    files, superseded, skipped = collect(spec)
    print(f"{len(files)} files · {len(superseded)} superseded revisions skipped · "
          f"{skipped} left for another publication", flush=True)

    trees = (build or build_documents)(files, spec)
    by_cat: dict[str, int] = defaultdict(int)
    for t in trees:
        by_cat[t["category"]] += 1
    print(f"{len(trees)} documents · {count_nodes(trees)} nodes")
    for c, n in sorted(by_cat.items()):
        print(f"   {n:4} documents   {c}")

    if args.dry_run:
        for t in sorted(trees, key=lambda x: -count_nodes([x]))[:12]:
            print(f"  [{t['category'][:24]:24}] {t['title'][:56]:56} "
                  f"{count_nodes(t.get('children') or []):4} nodes")
        return 0

    token = args.token or post_json(
        args.base, "auth/login", None,
        {"userId": args.user, "password": args.password})["access_token"]

    created = failed = 0
    t0 = time.time()
    # The shelf keeps the order documents arrive in, so send them sorted.
    trees = make_unique(sorted(trees, key=lambda x: (x["category"], node_order(x))))
    for i, tree in enumerate(trees, 1):
        try:
            root = post_json(args.base, "documents/publications/tree/import", token, {
                "category": spec.publication,
                "nodeType": tree["category"],
                "jurisdiction": spec.jurisdiction,
                "nodes": [{
                    "number": tree.get("number"),
                    "title": tree["title"],
                    "contentText": tree.get("contentText"),
                    "textQuality": tree.get("textQuality"),
                    "sourceRef": tree.get("sourceRef"),
                }],
            })
            root_id = root["rootIds"][0]

            batch, size = [], 0
            for child in tree.get("children") or []:
                c = chars_of([child])
                if batch and size + c > MAX_REQUEST_CHARS:
                    post_json(args.base, "documents/publications/tree/import", token,
                              {"parentId": root_id, "nodes": batch})
                    batch, size = [], 0
                batch.append(child)
                size += c
            if batch:
                post_json(args.base, "documents/publications/tree/import", token,
                          {"parentId": root_id, "nodes": batch})

            post_json(args.base, f"documents/publications/tree/nodes/{root_id}/auto-mark",
                      token, {})
            created += 1
        except urllib.error.HTTPError as e:
            failed += 1
            print(f"FAIL {tree['title'][:60]}: {e.code} {e.read()[:200]!r}", flush=True)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {tree['title'][:60]}: {e}", flush=True)
        if i % 50 == 0:
            print(f"{i}/{len(trees)} ok={created} fail={failed} "
                  f"({i / (time.time() - t0):.1f}/s)", flush=True)

    upload_missing_originals(args.base, token)
    print(f"DONE documents={created} failed={failed}", flush=True)

    # Every file must be findable afterwards. Three went missing silently once,
    # merged away by the idempotent import while the run reported failed=0.
    expected = {str(p.relative_to(SRC)) for p, _ in files}
    got = set(api(args.base, "documents/publications/tree/source-refs?category="
                  + urllib.parse.quote(spec.publication), token) or [])
    missing = expected - got
    if missing:
        print(f"WARNING {len(missing)} file(s) did not reach the tree:", flush=True)
        for m in sorted(missing)[:10]:
            print(f"   {m}", flush=True)
    else:
        print(f"all {len(expected)} files accounted for", flush=True)
    return 1 if failed or missing else 0
