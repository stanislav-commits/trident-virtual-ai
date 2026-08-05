#!/usr/bin/env python3
"""Page text with tables kept, extracted once and cached — by three engines.

No single extractor reads every page. MuPDF gives the best result where the
text layer is sound, and it is the only one here that walks a table cell by
cell. Poppler falls back to a font's built-in encoding, which recovers pages
MuPDF renders as rows of underscores. And where the font maps its glyphs to a
sequence of its own — "$ % & \' ( )" for what the page plainly shows as
"Revision of blade fatigue design criteria" — no text layer can be trusted at
all, and only reading the picture works.

So each page is taken by MuPDF, scored, and handed down only if it fails:
Poppler, then Tesseract on a rendered image. The engine that produced a page is
kept beside it, because text that was read off a picture is not the same claim
as text that was in the file: OCR turns a logo into "Vv TT" and will do the
same to a rule number.


Keeping tables as tables costs ~285 ms a page against ~5 ms for plain text —
in a class rulebook that is worth paying, but the RINA sections are 26 000
pages, which is two hours on one core. So the pages of a file are extracted
once, by a pool of workers, and written to a cache keyed by the file's path,
size and mtime; a second run of the loader reads them back in seconds.

    warm(paths)                     # fill the cache, in parallel
    text_of(path, first, last)      # 1-based inclusive page range
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from multiprocessing import Pool
from pathlib import Path

import fitz

from r4y_tree import text_quality

CACHE = Path(os.environ.get(
    "PDF_PAGE_CACHE",
    "/private/tmp/claude-501/-Users-stassandu/"
    "3e0a2807-eb63-4b28-8f37-1fe820ba1c8f/scratchpad/pdfcache"))
WORKERS = max(1, (os.cpu_count() or 4) - 1)


# Bumped when the extraction itself changes, so a cache written by the old
# single-engine pass is not read as if it were the cascade's work.
CACHE_VERSION = 3
# The floor the backend uses to decide a page needs re-reading; a page that
# clears it is left alone whichever engine produced it.
QUALITY_FLOOR = 0.7

# Table scaffolding, which is punctuation as far as any word count goes.
SCAFFOLD = re.compile(r"\|Col\d+\||<br>|\|---\||[|]")


def looks_broken(text: str) -> bool:
    """Is this page words, or a font's glyph numbers wearing letters?

    The quality score alone cannot tell: a page rendered as "$ % & \' ( )" with
    a markdown table around it scored exactly 0.7 and passed. What separates
    them is whether anything on the page is a word at all — the broken page
    carried three words of three letters and 569 loose single letters, against
    109 and 14 on the same document's first page.
    """
    if not text.strip():
        return False                       # empty is empty, not broken
    body = SCAFFOLD.sub(" ", text)
    words = re.findall(r"[A-Za-z]{3,}", body)
    singles = re.findall(r"(?<![A-Za-z])[A-Za-z](?![A-Za-z])", body)
    density = 1000 * len(words) / max(len(body), 1)
    loose = len(singles) / max(len(words) + len(singles), 1)
    return density < 20 or loose > 0.5


def _key(path: Path) -> Path:
    st = path.stat()
    h = hashlib.md5(
        f"v{CACHE_VERSION}|{path}|{st.st_size}|{int(st.st_mtime)}".encode()
    ).hexdigest()
    return CACHE / f"{h}.json"


# A subset font with a broken ToUnicode map returns its glyphs in Unicode's
# private use area: every character arrives shifted up by 0xF000, so
# "INTERNATIONAL" comes out as U+F049 U+F04E U+F054… Undoing the shift restores
# the text exactly — 323 rows of the review queue were this, not scans, and no
# amount of vision was going to improve on the letters already there.
PUA = {c: c - 0xF000 for c in range(0xF000, 0xF100)}


# Control characters below space are extraction noise — nothing in a rulebook
# is typed with them, and they push a clean page under the quality floor.
CONTROL = re.compile(r"[\x01-\x08\x0b\x0c\x0e-\x1f]")


def unshift(text: str) -> str:
    if any(0xF000 <= ord(c) <= 0xF0FF for c in text):
        text = text.translate(PUA)
    return CONTROL.sub("", text)


def _page_markdown(page) -> str:
    """One page as text, with its tables kept as tables.

    Plain extraction walks a table cell by cell and leaves a stream — "Symbol /
    Description / Units / L / rule length / m" — where nothing says which value
    belongs to which row. A scantling table read that way pairs the wrong
    number with the wrong parameter, and the answer looks confident either way.
    """
    tables = page.find_tables().tables
    boxes = [fitz.Rect(t.bbox) for t in tables]
    pieces: list[tuple[float, str]] = []
    for x0, y0, x1, y1, text, *_ in page.get_text("blocks"):
        middle = fitz.Point((x0 + x1) / 2, (y0 + y1) / 2)
        if any(box.contains(middle) for box in boxes):
            continue
        if text.strip():
            pieces.append((y0, text.strip()))
    for table, box in zip(tables, boxes):
        try:
            pieces.append((box.y0, table.to_markdown().strip()))
        except Exception:  # noqa: BLE001 — a malformed table is not worth a crash
            continue
    return unshift("\n\n".join(text for _, text in sorted(pieces, key=lambda x: x[0])))


def _poppler(path: Path, page: int) -> str:
    """Poppler reads a font's own encoding where MuPDF trusts a broken map."""
    try:
        out = subprocess.run(
            ["pdftotext", "-layout", "-f", str(page), "-l", str(page), str(path), "-"],
            capture_output=True, timeout=120)
        return unshift(out.stdout.decode("utf8", "replace").strip())
    except (OSError, subprocess.SubprocessError):
        return ""


def _ocr(doc, page: int) -> str:
    """Read the page as it is drawn. Slow (seconds) and never exact — the last
    resort, and the reason a page carries the engine that produced it."""
    try:
        pixmap = doc[page - 1].get_pixmap(dpi=200)
    except Exception:  # noqa: BLE001
        return ""
    with tempfile.NamedTemporaryFile(suffix=".png", dir=CACHE, delete=True) as tmp:
        try:
            pixmap.save(tmp.name)
            out = subprocess.run(["tesseract", tmp.name, "stdout", "-l", "eng"],
                                 capture_output=True, timeout=300)
            return out.stdout.decode("utf8", "replace").strip()
        except (OSError, subprocess.SubprocessError):
            return ""


def _blank(doc, page: int) -> bool:
    """A page with nothing drawn on it stays empty rather than being OCR'd:
    a rulebook is full of them between parts."""
    try:
        p = doc[page - 1]
        return not (p.get_images() or p.get_drawings() or p.get_text().strip())
    except Exception:  # noqa: BLE001
        return True


def _extract(path_str: str) -> str:
    path = Path(path_str)
    cache = _key(path)
    if cache.exists():
        return path_str
    pages: list[dict] = []
    try:
        doc = fitz.open(path)
        for number in range(1, doc.page_count + 1):
            try:
                text = _page_markdown(doc[number - 1])
            except Exception:  # noqa: BLE001 — one bad page, not one lost file
                text = unshift(doc[number - 1].get_text().strip())
            how = "mupdf"
            if (text_quality(text) < QUALITY_FLOOR or looks_broken(text)) and not _blank(
                doc, number
            ):
                better = _poppler(path, number)
                if not looks_broken(better) and text_quality(better) >= text_quality(text):
                    text, how = better, "poppler"
                if text_quality(text) < QUALITY_FLOOR or looks_broken(text):
                    read = _ocr(doc, number)
                    # OCR wins only if it actually reads: on a page of diagrams
                    # it returns a handful of stray letters, which is worse than
                    # the little the text layer had.
                    if read and not looks_broken(read):
                        text, how = read, "ocr"
            pages.append({"text": text, "how": how})
        doc.close()
    except Exception:  # noqa: BLE001
        pages = []
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"version": CACHE_VERSION, "pages": pages}))
    return path_str


def warm(paths, workers: int = WORKERS, label: str = "") -> None:
    todo = [str(p) for p in paths if not _key(Path(p)).exists()]
    if not todo:
        return
    print(f"   извлечение {len(todo)} файлов на {workers} ядрах{label}…", flush=True)
    with Pool(workers) as pool:
        for i, _ in enumerate(pool.imap_unordered(_extract, todo, chunksize=4), 1):
            if i % 50 == 0 or i == len(todo):
                print(f"      {i}/{len(todo)}", flush=True)


def _cached(path: Path) -> list[dict]:
    cache = _key(path)
    if not cache.exists():
        _extract(str(path))
    try:
        data = json.loads(cache.read_text())
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, list):                    # written before the cascade
        return [{"text": t, "how": "mupdf"} for t in data]
    return data.get("pages", [])


def pages_of(path: Path) -> list[str]:
    return [page["text"] for page in _cached(path)]


def engines_of(path: Path, first: int = 1, last: int = 10_000) -> set[str]:
    """Which engines produced this range — "ocr" in here means the text was
    read off a picture and should be quoted as such."""
    return {page["how"] for page in _cached(path)[first - 1:last] if page["text"]}


def text_of(path: Path, first: int, last: int) -> str:
    pages = pages_of(path)
    out = pages[first - 1:last]
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip()
