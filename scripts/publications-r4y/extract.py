#!/usr/bin/env python3
"""R4Y publications build — phase 0: text extraction + inventory.

Walks ~/Downloads/R4Y (excluding "Not Relevant" and the categories the owner
rejected), extracts text from every PDF with pdftotext -layout into a
mirrored .txt tree under the WORK dir, and builds inventory.jsonl: one line
per source file with the parsed filename structure and a full-title candidate
from the first text lines (the downloader truncated long names mid-string).

Idempotent: existing non-empty .txt files are skipped, so it can resume.
Images are inventoried (the vision phase transcribes them) but not converted.

Run from anywhere:  python3 scripts/publications-r4y/extract.py
Work dir defaults to ~/Documents/r4y-publications-build (override R4Y_WORK).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SRC = Path.home() / "Downloads" / "R4Y"
OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
TXT = OUT / "text"
# "Anti-Piracy" excluded 2026-08-01: the owner reviewed the material and
# rejected it. Matched as a SUBSTRING — the owner marks rejected folders by
# renaming them (an emoji prefix survives an exact-match filter).
EXCLUDE_SUBSTRINGS = ("not relevant", "anti-piracy")


def excluded(top_folder: str) -> bool:
    low = top_folder.lower()
    return any(s in low for s in EXCLUDE_SUBSTRINGS)
WORKERS = 8

CODE_PATTERNS = [
    ("lr", re.compile(r"^(LR-[A-Z]{2,6}-\d{3})\b")),
    ("uk_notice", re.compile(r"^(M[SGI]N \d+)\s*\(")),
    ("malta_form", re.compile(r"^(MSD-[A-Z]{2,4}-\d{3})\b")),
    ("ms_notice", re.compile(r"^(MS Notice No\. ?\d+)\b")),
    ("info_notice", re.compile(r"^(Information Notice \d+)\b")),
    ("imo_res", re.compile(r"^((?:MSC|MEPC|A|LEG)\.?\s?\d+\s?\(\d+\))")),
    ("imo_circ", re.compile(r"^((?:MSC|MEPC|MSC-MEPC|FAL|LEG|STCW|SN|COMSAR|CCC|HTW|III|PPR|SDC|SSE|NCSR)[./][A-Za-z0-9./()-]+)")),
]
PART_RE = re.compile(r"\bPart\s+([0-9IVXLC]+[A-Za-z0-9-]*)", re.IGNORECASE)
CHAPTER_RE = re.compile(r"\bChapter\s+([0-9IVXLC]+[A-Za-z0-9-]*)", re.IGNORECASE)
SECTION_RE = re.compile(r"\bSection\s+(\d+[A-Za-z0-9-]*)", re.IGNORECASE)
REGULATION_RE = re.compile(r"\bRegulation\s+(\d+[A-Za-z0-9-]*)", re.IGNORECASE)
ANNEX_RE = re.compile(r"\bAnnex\s+([0-9IVXLC]+)", re.IGNORECASE)


def parse_name(category: str, stem: str) -> dict:
    crumbs = [c.strip() for c in stem.split(" - ")]
    info: dict = {
        "crumbs": crumbs,
        "truncated": "..." in stem,
        "code": None,
        "code_kind": None,
    }
    first = crumbs[0] if crumbs else ""
    for kind, rx in CODE_PATTERNS:
        m = rx.match(first) or rx.match(stem)
        if m:
            info["code"] = m.group(1)
            info["code_kind"] = kind
            break
    for key, rx in (
        ("part", PART_RE),
        ("chapter", CHAPTER_RE),
        ("section", SECTION_RE),
        ("regulation", REGULATION_RE),
        ("annex", ANNEX_RE),
    ):
        m = rx.search(stem)
        info[key] = m.group(1) if m else None
    info["leaf_title"] = crumbs[-1] if crumbs else stem
    return info


def first_lines_title(txt_path: Path) -> str | None:
    try:
        head = txt_path.read_text(errors="replace")[:2000]
    except OSError:
        return None
    lines = [ln.strip() for ln in head.splitlines() if ln.strip()]
    return " / ".join(lines[:3])[:300] if lines else None


def extract_one(pdf: Path, txt: Path) -> tuple[str, str | None]:
    txt.parent.mkdir(parents=True, exist_ok=True)
    if txt.exists() and txt.stat().st_size > 0:
        return "cached", None
    try:
        r = subprocess.run(
            ["pdftotext", "-layout", "-q", str(pdf), str(txt)],
            capture_output=True, timeout=120,
        )
        if r.returncode != 0:
            return "error", r.stderr.decode(errors="replace")[:200]
        if not txt.exists() or txt.stat().st_size == 0:
            txt.write_text("")
            return "empty", None
        return "ok", None
    except subprocess.TimeoutExpired:
        return "timeout", None
    except OSError as e:
        return "error", str(e)[:200]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = []
    for p in sorted(SRC.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(SRC)
        if excluded(rel.parts[0]):
            continue
        files.append(p)

    pdfs = [p for p in files if p.suffix.lower() == ".pdf"]
    images = [p for p in files if p.suffix.lower() != ".pdf"]
    print(f"total {len(files)} | pdf {len(pdfs)} | other {len(images)}", flush=True)

    stats = {"ok": 0, "cached": 0, "empty": 0, "error": 0, "timeout": 0}
    errors: list[dict] = []
    inventory: list[dict] = []

    def job(pdf: Path):
        rel = pdf.relative_to(SRC)
        txt = TXT / rel.with_suffix(".txt")
        status, err = extract_one(pdf, txt)
        return pdf, rel, txt, status, err

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(job, p) for p in pdfs]
        done = 0
        for fut in as_completed(futures):
            pdf, rel, txt, status, err = fut.result()
            stats[status] += 1
            if err:
                errors.append({"file": str(rel), "error": err})
            entry = {
                "rel": str(rel),
                "category": rel.parts[0],
                "kind": "pdf",
                "bytes": pdf.stat().st_size,
                "text_status": status if status != "cached" else "ok",
                **parse_name(rel.parts[0], pdf.stem),
            }
            if status in ("ok", "cached"):
                entry["text_head"] = first_lines_title(txt)
                entry["text_bytes"] = txt.stat().st_size
            inventory.append(entry)
            done += 1
            if done % 500 == 0:
                print(f"{done}/{len(pdfs)} {stats}", flush=True)

    for f in images:
        rel = f.relative_to(SRC)
        inventory.append({
            "rel": str(rel), "category": rel.parts[0],
            "kind": f.suffix.lower().lstrip("."),
            "bytes": f.stat().st_size, **parse_name(rel.parts[0], f.stem),
        })

    inventory.sort(key=lambda e: e["rel"])
    with open(OUT / "inventory.jsonl", "w") as fh:
        for e in inventory:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    (OUT / "extract-errors.json").write_text(json.dumps(errors, indent=2))
    print("DONE", stats, flush=True)


if __name__ == "__main__":
    sys.exit(main())
