#!/usr/bin/env python3
"""Page text with tables kept, extracted once and cached.

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
from multiprocessing import Pool
from pathlib import Path

import fitz

CACHE = Path(os.environ.get(
    "PDF_PAGE_CACHE",
    "/private/tmp/claude-501/-Users-stassandu/"
    "3e0a2807-eb63-4b28-8f37-1fe820ba1c8f/scratchpad/pdfcache"))
WORKERS = max(1, (os.cpu_count() or 4) - 1)


def _key(path: Path) -> Path:
    st = path.stat()
    h = hashlib.md5(f"{path}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()
    return CACHE / f"{h}.json"


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
    return "\n\n".join(text for _, text in sorted(pieces, key=lambda x: x[0]))


def _extract(path_str: str) -> str:
    path = Path(path_str)
    cache = _key(path)
    if cache.exists():
        return path_str
    pages: list[str] = []
    try:
        doc = fitz.open(path)
        for page in doc:
            try:
                pages.append(_page_markdown(page))
            except Exception:  # noqa: BLE001 — one bad page, not one lost file
                pages.append(page.get_text().strip())
        doc.close()
    except Exception:  # noqa: BLE001
        pages = []
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(pages))
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


def pages_of(path: Path) -> list[str]:
    cache = _key(path)
    if not cache.exists():
        _extract(str(path))
    try:
        return json.loads(cache.read_text())
    except Exception:  # noqa: BLE001
        return []


def text_of(path: Path, first: int, last: int) -> str:
    pages = pages_of(path)
    out = pages[first - 1:last]
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip()
