#!/usr/bin/env python3
"""R4Y phase 1b: merge-plan.json → merged markdown under WORK/md/ +
update-manifest.json (source → md, title, section anchor).

Forms (load_as="original") produce no markdown — the manifest records them
with `original` set so the loader uploads the source file itself.

Every PDF section gets a text-quality score; sections under 0.7 are flagged
in-line and reported in scan-quality-report.json — those are the vision
re-transcription queue, together with the image placeholders.
"""
from __future__ import annotations

import json
import os
import re
from datetime import date
from pathlib import Path

OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
SRC = Path.home() / "Downloads" / "R4Y"
TXT = OUT / "text"
MD = OUT / "md"
TODAY = date.today().isoformat()
MAX_MD_BYTES = 1_400_000


def safe_name(s: str) -> str:
    s = re.sub(r"[^\w\s().–—'-]+", "_", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:120]


def heading_for(src: dict) -> str:
    bits = []
    for label, key in (
        ("Part", "part"), ("Annex", "annex"), ("Chapter", "chapter"),
        ("Regulation", "regulation"), ("Section", "section"),
    ):
        if src.get(key):
            bits.append(f"{label} {src[key]}")
    leaf = (src.get("leaf_title") or "").strip()
    leaf = re.sub(r"\s*\(\d{1,2}\)$", "", leaf)
    if leaf and (not bits or leaf.lower() not in " ".join(bits).lower()):
        bits.append(leaf)
    return " — ".join(bits) if bits else (src.get("rel") or "").rsplit("/", 1)[-1]


def clean_text(raw: str) -> str:
    raw = raw.replace("\f", "\n\n")
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def text_quality(txt: str) -> float:
    sample = txt[:20000]
    if len(sample.strip()) < 40:
        return 0.0
    words = re.findall(r"[A-Za-z]{2,}", sample)
    if not words:
        return 0.0
    letters = sum(c.isalpha() for c in sample)
    weird = len(re.findall(r"[^\x20-\x7E\n\r\t -ɏ‐-‧€£°§±µ]", sample))
    avg_wl = sum(map(len, words)) / len(words)
    score = 1.0
    if letters / len(sample) < 0.45:
        score -= 0.4
    if weird / len(sample) > 0.02:
        score -= 0.4
    if avg_wl < 3.2 or avg_wl > 9:
        score -= 0.3
    return max(0.0, score)


def main() -> None:
    plan = json.load(open(OUT / "merge-plan.json"))
    MD.mkdir(exist_ok=True)
    manifest: dict[str, dict] = {}
    written = 0
    total_bytes = 0
    image_placeholders = 0
    low_quality: list[dict] = []

    for key, group in plan.items():
        if group.get("load_as") == "original":
            src = group["sources"][0]
            manifest[src["rel"]] = {
                "group": key,
                "md": None,
                "original": src["rel"],
                "title": group["title"],
                "anchor": group["title"],
                "kind": src["kind"],
            }
            continue

        cat_dir = MD / safe_name(group["category"])
        cat_dir.mkdir(exist_ok=True)

        sections: list[tuple[dict, str, str]] = []
        for src in group["sources"]:
            anchor = heading_for(src)
            if src["kind"] == "pdf":
                txt_path = TXT / Path(src["rel"]).with_suffix(".txt")
                try:
                    body = clean_text(txt_path.read_text(errors="replace"))
                except OSError:
                    body = "*[source text missing]*"
                if not body:
                    body = "*[empty text layer]*"
                q = text_quality(body)
                if q < 0.7:
                    low_quality.append(
                        {"rel": src["rel"], "quality": round(q, 2), "group": key}
                    )
                    body = (
                        f"*[low-quality OCR (score {q:.1f}) — source "
                        f"`{src['rel']}`, re-transcription pending]*\n\n" + body
                    )
            else:
                image_placeholders += 1
                body = f"*[table/figure — image source `{src['rel']}`, transcription pending]*"
            sections.append((src, anchor, body))

        volumes: list[list[tuple[dict, str, str]]] = [[]]
        vol_bytes = 0
        for sec in sections:
            sec_bytes = len(sec[2].encode()) + len(sec[1].encode()) + 8
            if volumes[-1] and vol_bytes + sec_bytes > MAX_MD_BYTES:
                volumes.append([])
                vol_bytes = 0
            volumes[-1].append(sec)
            vol_bytes += sec_bytes

        for vol_no, vol in enumerate(volumes, start=1):
            if len(volumes) == 1:
                title = group["title"]
            elif len(vol) == 1:
                title = f"{group['title']} — {vol[0][1][:90]}"
            else:
                title = f"{group['title']} (vol. {vol_no}/{len(volumes)})"
            md_rel = f"{safe_name(group['category'])}/{safe_name(title)}.md"
            lines = [
                f"# {title}",
                "",
                f"*Category: {group['category']} · Jurisdiction: {group['jurisdiction']} · "
                f"{len(vol)} source document(s) · assembled {TODAY} from the Regs4Ships library.*",
                "",
            ]
            for src, anchor, body in vol:
                lines.extend([f"## {anchor}", "", body, ""])
                manifest[src["rel"]] = {
                    "group": key,
                    "md": md_rel,
                    "title": title,
                    "anchor": anchor,
                    "kind": src["kind"],
                }
            content = "\n".join(lines)
            (MD / md_rel).write_text(content)
            written += 1
            total_bytes += len(content.encode())

    (OUT / "update-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=0))
    (OUT / "scan-quality-report.json").write_text(json.dumps(low_quality, indent=1))
    print(
        f"written {written} md files | {total_bytes/1e6:.1f} MB | "
        f"image placeholders {image_placeholders} | low-quality OCR {len(low_quality)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
