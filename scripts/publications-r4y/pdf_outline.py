#!/usr/bin/env python3
"""A PDF's bookmark outline as a tree, at whatever depth the file uses.

Reading an outline as a fixed shape — "level 2 is a chapter, level 3 is a
section" — loses every document built differently, and it loses them silently:
the headings that do not fit collapse onto a same-named sibling and the import,
which matches a node by (number, title) under its parent, merges them. RINA's
RES27 and NAS13 lost 43 sections that way in a run reporting no failures.

So the levels are taken as they come, and each node keeps the pages between
itself and the next heading at its own level or above. A branch keeps only what
stands before its first child, so no page is stored twice.
"""
from __future__ import annotations

import re
from pathlib import Path

import pdf_pages

CHAPTER = re.compile(r"^CHAPTER\s+(\d+)\s*[-–]\s*(.*)$", re.I)
# "1 Field of application", "3.1 Navigation Notations"
NUMBERED = re.compile(r"^(\d+(?:\.\d+)*)\s+(.*)$")
# A table or figure caption belongs to the section around it, not beside it.
CAPTION = re.compile(r"^(Table|Tab\.|Figure|Fig\.)\b", re.I)


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def split_number(title: str) -> dict:
    """"CHAPTER 2 - Hull" → Ch 2 / Hull;  "3.1 Navigation" → 3.1 / Navigation."""
    m = CHAPTER.match(title)
    if m:
        return {"number": f"Ch {m.group(1)}", "title": m.group(2).strip().title()}
    m = NUMBERED.match(title)
    if m and m.group(2).strip():
        return {"number": m.group(1), "title": m.group(2).strip()}
    return {"number": None, "title": title}


def outline_tree(doc, quality, citation: re.Pattern | None = None,
                 max_level: int = 4) -> list[dict]:
    """The outline as nested nodes, each with the text of its own pages.

    `quality` scores extracted text — the loaders share one heuristic with the
    backend. `citation`, when given, is looked for in the first lines of a
    node's first page and becomes its number, so a node and the references
    pointing at it read as the same string.
    """
    toc = [(lvl, clean(ttl), pg) for lvl, ttl, pg in doc.get_toc() if lvl <= max_level]
    toc = [x for x in toc if not CAPTION.match(x[1])]
    path = Path(doc.name)

    roots: list[dict] = []
    stack: list[tuple[int, dict]] = []
    furthest = 0
    for i, (lvl, title, page) in enumerate(toc):
        # A bookmark pointing back into pages already covered is a dead link,
        # not a section: NI638 ends with "3.7 Prescriptive approach" aimed at
        # page 1, and as the last entry it claimed the whole 65-page book —
        # the front matter and the general conditions read as a rule.
        broken = page < furthest
        furthest = max(furthest, page)
        end = doc.page_count
        for nlvl, _, npage in toc[i + 1:]:
            if nlvl <= lvl and npage >= page:
                end = max(page, npage - 1)
                break
        node = {**split_number(title), "_page": page, "_end": end,
                "_broken": broken}
        while stack and stack[-1][0] >= lvl:
            stack.pop()
        (stack[-1][1].setdefault("children", []) if stack else roots).append(node)
        stack.append((lvl, node))

    def fill(nodes: list[dict]) -> None:
        for n in nodes:
            first, last = n.pop("_page"), n.pop("_end")
            broken = n.pop("_broken", False)
            kids = n.get("children")
            if kids:
                last = min(last, kids[0]["_page"] - 1)
                fill(kids)
            if last >= first and not broken:
                text = pdf_pages.text_of(path, first, last)
                if text and (not kids or len(text) > 200):
                    n["contentText"] = text
                    n["textQuality"] = quality(text)
            if citation and not n.get("number"):
                for line in doc[first - 1].get_text().splitlines()[:6]:
                    m = citation.match(line)
                    if m:
                        n["number"] = clean(m.group(1))
                        break

    fill(roots)
    name_the_numbered(roots)
    return [n for n in roots if n.get("children") or n.get("contentText")]


BARE = re.compile(r"^[0-9]+(\.[0-9]+)*[A-Za-z]?$")


def name_the_numbered(nodes: list[dict]) -> None:
    """A bookmark that is only "4" leaves a row with a number and no subject.

    The heading it stands for is the first line of its own pages, so that is
    what the row is called; the number moves to where numbers belong.
    """
    for n in nodes:
        if BARE.match(n["title"]):
            heading = first_line(n.get("contentText") or "")
            if heading:
                n["number"] = n.get("number") or n["title"]
                n["title"] = heading
        if n.get("children"):
            name_the_numbered(n["children"])


def by_running_head(path: Path, pattern: re.Pattern, quality) -> list[dict]:
    """Sections read off the running head, for a file with no bookmarks at all.

    RES31 Part C is 585 pages and carries no outline, so it arrived as one node
    of 1.8 MB. But every body page is headed with the citation it belongs to —
    "Pt C, Ch 1, Sec 5" — which is the same structure the bookmarked rulebooks
    give, and the same string their cross-references use.
    """
    pages = pdf_pages.pages_of(path)
    marks: list[tuple[int, str]] = []
    for i, text in enumerate(pages, 1):
        for line in [l for l in text.splitlines() if l.strip()][:2]:
            m = pattern.match(clean(line))
            if m:
                citation = clean(m.group(1))
                if not marks or marks[-1][1] != citation:
                    marks.append((i, citation))
                break
    if len(marks) < 3:
        return []

    out: list[dict] = []
    front = pdf_pages.text_of(path, 1, marks[0][0] - 1) if marks[0][0] > 1 else ""
    if front:
        out.append({"number": None, "title": "Contents",
                    "contentText": front, "textQuality": quality(front)})
    for i, (page, citation) in enumerate(marks):
        end = marks[i + 1][0] - 1 if i + 1 < len(marks) else len(pages)
        text = pdf_pages.text_of(path, page, end)
        if not text:
            continue
        out.append({"number": citation,
                    "title": section_name(text, citation) or citation,
                    "contentText": text, "textQuality": quality(text)})
    return out


def section_name(text: str, citation: str) -> str:
    """The subject printed under the running head, when there is one."""
    for line in text.splitlines()[:8]:
        line = clean(line)
        if not line or line == citation or BARE.match(line):
            continue
        words = [w for w in line.split() if w.isalpha()]
        if len(words) >= 2 and len(line) < 90:
            return line[:160]
    return ""


HEADINGS = [
    re.compile(r"^#{2,4}\s+(?P<title>.+?)\s*$"),                       # from the extractor
    re.compile(r"^(?P<number>\d+(?:\.\d+){0,3})\.?\s+(?P<title>[A-Z][^|]{3,90})$"),
    re.compile(r"^(?P<number>[A-Z]\d+(?:\.\d+)*)\s+(?P<title>[A-Z][^|]{3,90})$"),
]


def split_oversized(nodes: list[dict], quality, limit: int = 40_000) -> list[dict]:
    """Cut a node too large to be one answer along the headings inside it.

    Some documents carry no outline below the chapter, so a single node holds
    sixty pages. What is indexed is the markdown assembled from the subtree,
    split on its headings — a node this size becomes one heading over sixty
    pages, and a chunk taken from the middle says nothing about what it is.
    """
    for n in nodes:
        if n.get("children"):
            split_oversized(n["children"], quality, limit)
            continue
        text = n.get("contentText") or ""
        if len(text) <= limit:
            continue
        pieces = split_by_headings(text) or split_by_size(text, limit // 3)
        if len(pieces) < 3:
            continue
        # What stands before the first heading can itself be most of the node:
        # in NI691 the sea-state scatter diagram fills 125 000 characters and
        # every heading comes after it.
        if len(pieces[0][2]) > limit:
            spill = split_by_size(pieces[0][2], limit // 3)
            if spill:
                pieces = spill + pieces[1:]
        head, rest = pieces[0], pieces[1:]
        n["contentText"] = head[2] or None
        if not n["contentText"]:
            n.pop("contentText", None)
            n.pop("textQuality", None)
        else:
            n["textQuality"] = quality(n["contentText"])
        n["children"] = [{"number": number, "title": title,
                          "contentText": body, "textQuality": quality(body)}
                         for number, title, body in rest if body.strip()]
    return nodes


def looks_like_heading(m: re.Match) -> bool:
    """A heading names something; a formula line only looks like one.

    "12 Ei Ii ⋅ ⋅ ---------- Fi ri --- di" opens with a number and a capital,
    which is enough to fool the pattern and to cut a rule in half.
    """
    title = m.groupdict().get("title") or ""
    if re.search(r"[⋅=∑√·]|--{2,}|\.{4,}", title):
        return False
    words = [w for w in re.split(r"\s+", title) if len(w) > 2 and w.isalpha()]
    return len(words) >= 2


def split_by_headings(text: str) -> list[tuple[str | None, str, str]]:
    """[(number, title, body)] — the first piece is whatever precedes them."""
    lines = text.splitlines()
    for pattern in HEADINGS:
        marks = [(i, m) for i, line in enumerate(lines)
                 if (m := pattern.match(line.strip()))
                 and not line.startswith("|") and looks_like_heading(m)]
        # Numbered headings must climb: a run that jumps 12 → 104 → 7 is a
        # column of figures, not a table of contents.
        numbers = [m.groupdict().get("number") for _, m in marks]
        if all(numbers) and len(numbers) > 2:
            def rank(x):
                return tuple(int(p) for p in re.findall(r"\d+", x))
            if any(rank(b) <= rank(a) for a, b in zip(numbers, numbers[1:])):
                continue
        if len(marks) < 3:
            continue
        out: list[tuple[str | None, str, str]] = [
            (None, "", "\n".join(lines[:marks[0][0]]).strip())]
        for j, (i, m) in enumerate(marks):
            end = marks[j + 1][0] if j + 1 < len(marks) else len(lines)
            body = "\n".join(lines[i + 1:end]).strip()
            groups = m.groupdict()
            out.append((groups.get("number"), clean(groups["title"])[:200], body))
        return out
    return []


def split_by_size(text: str, target: int) -> list[tuple[str | None, str, str]]:
    """Last resort: cut on blank lines, never inside a table.

    A scatter diagram of sea states is one table of 125 000 characters; cutting
    it anywhere loses the header row that says what the columns are, so a run
    of table lines is carried whole into whichever piece it starts in.
    """
    blocks, current, in_table = [], [], False
    for line in text.split("\n"):
        row = line.lstrip().startswith("|")
        if not line.strip() and not row and not in_table and current:
            blocks.append("\n".join(current))
            current = []
            continue
        in_table = row
        current.append(line)
    if current:
        blocks.append("\n".join(current))

    pieces, buf = [], []
    for block in blocks:
        buf.append(block)
        if sum(len(b) for b in buf) >= target:
            pieces.append("\n\n".join(buf))
            buf = []
    if buf:
        pieces.append("\n\n".join(buf))
    if len(pieces) < 3:
        return []
    total = len(pieces)
    return [(None, "", pieces[0])] + [
        (None, f"continued ({i} of {total - 1})", body)
        for i, body in enumerate(pieces[1:], 1)]


def first_line(text: str, limit: int = 160) -> str:
    for line in text.splitlines():
        line = clean(line)
        if len(line) < 12 or line.startswith("|") or line.startswith("#"):
            continue
        return line[:limit].rstrip(" .,;:-–")
    return ""
