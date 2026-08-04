#!/usr/bin/env python3
"""R4Y phase 1: inventory.jsonl → merge-plan.json.

Grouping: identity = series code or the first meaningful filename crumb
(numeric crumbs fall through to the next one); notice-like identities
collapse into series; oversized groups split recursively down
volume → part → annex → chapter, then into FIXED bands (number ÷ 100 or
alphabet A–C/D–G/H–M/N–R/S–Z) — band labels never shift, so next month's
new notice joins an EXISTING catalog slot.

Repairs on the way in:
- mis-filed sources move to the right category (reclassify-report.json);
- cross-category duplicates drop (dedupe-report.json);
- forms load as ORIGINAL files, one slot each (load_as="original");
- titles are cleaned of downloader damage ("10_25" → "10/25", ` → ').
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from pathlib import Path

OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
SPLIT_AT = 60

ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def roman_to_int(s: str) -> int | None:
    total, prev = 0, 0
    for ch in reversed(s.upper()):
        v = ROMAN.get(ch)
        if v is None:
            return None
        total = total - v if v < prev else total + v
        prev = max(prev, v)
    return total


def num_key(value: str | None) -> tuple:
    if not value:
        return (9e9,)
    parts = re.split(r"[-.]", value)
    key = []
    for p in parts:
        if p.isdigit():
            key.append(int(p))
        else:
            r = roman_to_int(p)
            key.append(r if r is not None else 5000 + sum(map(ord, p)))
    return tuple(key)


CATEGORY_JURISDICTION = {
    "Malta": "flag:MT", "Cayman Islands": "flag:KY", "Gibraltar": "flag:GI",
    "Isle of Man": "flag:IM", "Bermuda": "flag:BM", "Bahamas": "flag:BS",
    "Marshall Islands": "flag:MH", "United Kingdom": "uk",
    "Rules and Regulations": "class:LR", "Guidance Notes": "class:LR",
    "LR ShipRight": "class:LR", "LR MQPS": "class:LR", "LR TASTS": "class:LR",
    "LR Recommended Practices": "class:LR", "Instructions to Surveyors": "uk",
    "EU Legislation": "eu",
}

NUMERIC_CRUMB = re.compile(r"^[\d\s./()–-]+$")


def repair_title(s: str) -> str:
    """Undo the downloader's filename mangling for anything a human reads:
    "No. 10_25" was "No. 10/25", backticks were apostrophes, "_" between
    word chars was "/" or ":". Crumb-splitting on " - " can cut inside a
    parenthesis ("…(Chapter 012") — balance it."""
    s = s.replace("`", "'")
    s = re.sub(r"(\d)_(\d)", r"\1/\2", s)
    s = re.sub(r"(\d)_([A-Z])", r"\1/\2", s)  # 2009/18_EC → 2009/18/EC
    s = re.sub(r"([A-Za-z])_([A-Za-z])", r"\1/\2", s)  # His_Her → His/Her
    s = re.sub(r"(\w)_\s", r"\1: ", s)
    s = re.sub(r"\s_\s(?=\d)", " < ", s)  # "Yachts _ 24 m" was "< 24 m"
    s = re.sub(r"\s_\s", " / ", s)  # "VHF _ SRC" was "VHF / SRC"
    s = re.sub(r"\s_(\w)", r" \1", s)  # mangled opening quote: _STCW → STCW
    s = s.rstrip("_")  # truncation artefact: "etc_" / "o_"
    s = re.sub(r"\s+", " ", s).strip().rstrip(".")
    open_n, close_n = s.count("("), s.count(")")
    if open_n > close_n:
        s += ")" * (open_n - close_n)
    return s


def identity(entry: dict) -> str:
    if entry.get("code"):
        return entry["code"]
    crumbs = entry.get("crumbs") or [entry["rel"]]
    crumb = crumbs[0]
    if NUMERIC_CRUMB.match(crumb) and len(crumbs) > 1:
        crumb = crumbs[1]
    return repair_title(crumb)


SERIES_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^(M[SGI]N)\s+\d+.*$"), r"\1 notices"),
    (re.compile(r"^(MS Notice)\s+No\.?\s*\d+.*$", re.I), r"MS Notices"),
    (re.compile(r"^(Information Notice)\s+\d+.*$", re.I), r"Information Notices"),
    (re.compile(r"^(Technical Notice)\s+.*$", re.I), r"Technical Notices"),
    (re.compile(r"^(Shipping Guidance Notice)\s+\d+.*$", re.I), r"Shipping Guidance Notices"),
    (re.compile(r"^(Guidance Notice)\s+\d+.*$", re.I), r"Guidance Notices"),
    (re.compile(r"^(Port Notice)\s+No\.?\s*[\d/]+.*$", re.I), r"Port Notices"),
    (re.compile(r"^(MSD-[A-Z]{2,4})-\d+.*$"), r"\1 forms"),
    (re.compile(r"^(RA-\d{2}-[A-Z])\d+.*$"), r"\1 forms"),
    (re.compile(r"^(GYR)-.*$"), r"GYR forms"),
    (re.compile(r"^(2-\d{3})-\d+.*$"), r"\1 marine notices"),
    (re.compile(r"^(MI)-\d+.*$"), r"MI acts"),
    (re.compile(r"^(MSC-MEPC|MSC\.\d|MEPC\.\d|MEPC|MSC)[./]Circ\.?\s*\d+.*$"), r"\1 circulars"),
    (re.compile(r"^(FAL|LEG|SN|COMSAR|CCC|HTW|III|PPR|SDC|SSE|NCSR|STCW)[./]\S*Circ\.?\s*\d+.*$", re.I), r"\1 circulars"),
    (re.compile(r"^(Circular Letter)\s+No\.?\s*\d+.*$", re.I), r"Circular Letters"),
    (re.compile(r"^(MSC|MEPC|A|LEG)\.?\s?\d+\s?\(\d+\)$"), r"\1 resolutions"),
    (re.compile(r"^(C\d{1,3})\b.*$"), "ILO conventions"),
    (re.compile(r"^(MLC)\b.*$", re.I), "MLC instruments"),
    (re.compile(r"^(\d{4})_\d+\s+\((Regulation|Directive|Decision)\)$"), r"EU \2s \1"),
    (re.compile(r"^(Safety Alerts?)\b.*$", re.I), "Safety Alerts"),
    (re.compile(r"^(MIN|MSN|MGN)\s+\d+$"), r"\1 notices"),
]


def series_of(category: str, ident: str) -> str | None:
    for rx, repl in SERIES_RULES:
        m = rx.match(ident)
        if m:
            return rx.sub(repl, ident) if "\\" in repl else repl
    return None


def trailing_number(ident: str) -> int:
    m = re.search(r"(\d+)(?!.*\d)", ident)
    return int(m.group(1)) if m else 0


RECLASSIFY_RULES: list[tuple[re.Pattern, str, set[str]]] = [
    (
        re.compile(r"^\d{4}_\d+\s+\((Regulation|Directive|Decision)\)"),
        "EU Legislation",
        set(),
    ),
    (
        re.compile(r"^(?:MSC|MEPC|A|LEG)\.?\s?\d+\s?\(\d+\)"),
        "IMO Resolutions",
        {"IMO Performance Standards", "IMO Guidelines", "IMO Manuals",
         "IMO Miscellaneous", "STCW", "Codes", "Other Conventions"},
    ),
    (
        re.compile(r"^(?:MSC|MEPC|MSC-MEPC)[./]\d?/?Circ\."),
        "IMO Circulars",
        {"IMO Guidelines", "IMO Performance Standards", "IMO Miscellaneous",
         "STCW", "Codes", "Other Conventions"},
    ),
]


def reclassify(entry: dict) -> str | None:
    first = (entry.get("crumbs") or [""])[0]
    for rx, cat, keep in RECLASSIFY_RULES:
        if rx.match(first) and entry["category"] != cat and entry["category"] not in keep:
            return cat
    return None


FORM_SERIES_RX = re.compile(r"^(RA-\d{2}-[A-Z] forms|MSD-[A-Z]{2,4} forms|GYR forms)$")
FORM_LEAF_RX = re.compile(
    r"^(Form\b|Application (for|by)\b|.*\bReport Form\b|.*\bDeclaration Form\b)",
    re.I,
)
LR_CATEGORIES = {
    "Rules and Regulations", "Guidance Notes", "LR ShipRight", "LR MQPS",
    "LR TASTS", "LR Recommended Practices", "SOLAS", "MARPOL",
}


def is_form(entry: dict, series: str | None) -> bool:
    if series and FORM_SERIES_RX.match(series):
        return True
    first = (entry.get("crumbs") or [""])[0]
    return bool(FORM_LEAF_RX.match(first)) and entry["category"] not in LR_CATEGORIES


def readable(title: str, sources: list[dict]) -> str:
    """A title with fewer than 4 letters tells a human nothing — fall back to
    the leaf title or the document's own first text line."""
    if sum(c.isalpha() for c in title) >= 4:
        return title
    for e in sources:
        leaf = repair_title(e.get("leaf_title") or "")
        if sum(c.isalpha() for c in leaf) >= 4:
            return f"{title} — {leaf}" if title.strip() else leaf
    head = (sources[0].get("text_head") or "").split(" / ")[0]
    return f"{title} — {head[:80]}" if head else title


def make_group(category: str, ident: str, label: str, entries: list[dict]) -> dict:
    # A single whole-file group titled by its bare identity crumb loses the
    # rest of its own name ("Commercial Yacht" for "Commercial Yacht -
    # Pleasure Yacht Changeover Guidelines") — use the full stem instead.
    if len(entries) == 1 and label == ident:
        stem = Path(entries[0]["rel"]).stem
        label = re.sub(r"\s*\(\d{1,2}\)$", "", stem)
    label = readable(repair_title(label), entries)
    return {
        "category": category,
        "identity": ident,
        "title": label,
        "jurisdiction": CATEGORY_JURISDICTION.get(category, "international"),
        "sources": [
            {
                "rel": e["rel"], "kind": e["kind"],
                "part": e.get("part"), "chapter": e.get("chapter"),
                "annex": e.get("annex"), "regulation": e.get("regulation"),
                "section": e.get("section"), "leaf_title": e.get("leaf_title"),
                "text_head": e.get("text_head"), "crumbs": e.get("crumbs"),
            }
            for e in entries
        ],
    }


def main() -> None:
    inv = [json.loads(l) for l in open(OUT / "inventory.jsonl")]

    # -1) repair mis-filed categories before anything keys off them
    moves = []
    for e in inv:
        target = reclassify(e)
        if target:
            moves.append({"rel": e["rel"], "from": e["category"], "to": target})
            e["category"] = target
    (OUT / "reclassify-report.json").write_text(json.dumps(moves, indent=1))
    print(f"reclassified: {len(moves)} files")

    # 0) drop cross-category duplicates (same filename + size); canonical
    #    copy lives in the SMALLER (more specific) category
    cat_size: dict[str, int] = defaultdict(int)
    for e in inv:
        cat_size[e["category"]] += 1
    by_key: dict[tuple, list[dict]] = defaultdict(list)
    for e in inv:
        by_key[(e["rel"].rsplit("/", 1)[-1].lower(), e["bytes"])].append(e)
    dropped: list[dict] = []
    kept: list[dict] = []
    for entries in by_key.values():
        entries.sort(key=lambda e: (cat_size[e["category"]], e["category"]))
        kept.append(entries[0])
        for e in entries[1:]:
            dropped.append({"kept": entries[0]["rel"], "dropped": e["rel"]})
    inv = kept
    (OUT / "dedupe-report.json").write_text(json.dumps(dropped, indent=1))
    print(f"deduped: {len(dropped)} duplicate files dropped, {len(inv)} remain")

    # 0.5) forms leave the merge pipeline: one slot per form, original file
    form_plan: dict[str, dict] = {}
    merged_inv: list[dict] = []
    for e in inv:
        ident0 = identity(e)
        if is_form(e, series_of(e["category"], ident0)):
            title = repair_title(re.sub(r"\s*\(\d{1,2}\)$", "", Path(e["rel"]).stem))
            g = make_group(e["category"], ident0, title, [e])
            g["load_as"] = "original"
            form_plan[f"{e['category']}::form::{title}"] = g
        else:
            merged_inv.append(e)
    print(f"forms kept as originals: {len(form_plan)}")
    inv = merged_inv

    # 1) identity groups
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for e in inv:
        groups[(e["category"], identity(e))].append(e)

    # 2) collapse notice-like identities into their series
    series_groups: dict[tuple, list[dict]] = defaultdict(list)
    for (category, ident), entries in groups.items():
        series = series_of(category, ident)
        key = (category, series) if series else (category, ident)
        series_groups[key].extend(entries)

    # 3) sweep per-category small strays into one Miscellaneous bundle;
    #    split() alpha-bands it when oversized (labels stay FIXED)
    plan_groups: dict[tuple, list[dict]] = {}
    strays: dict[str, list[dict]] = defaultdict(list)
    for (category, ident), entries in series_groups.items():
        if len(entries) == 1 and entries[0]["bytes"] < 400_000:
            strays[category].append(entries[0])
        else:
            plan_groups[(category, ident)] = entries
    for category, entries in strays.items():
        if len(entries) <= 3:
            for e in entries:
                plan_groups[(category, identity(e))] = [e]
            continue
        plan_groups[(category, "Miscellaneous")] = sorted(
            entries, key=lambda e: identity(e).lower()
        )

    # 4) recursive split down the axis chain, then FIXED bands
    VOLUME_RE = re.compile(r"\bVolume\s+(\d+)", re.IGNORECASE)

    def axis_value(e: dict, axis: str) -> str | None:
        if axis == "volume":
            for crumb in e.get("crumbs") or []:
                m = VOLUME_RE.search(crumb)
                if m:
                    return m.group(1)
            return None
        return e.get(axis)

    def split(ident: str, label: str, entries: list[dict], axes: list[str]) -> list[tuple[str, str, list[dict]]]:
        if len(entries) <= SPLIT_AT:
            return [("", label, entries)]
        for i, axis in enumerate(axes):
            values = [axis_value(e, axis) for e in entries]
            if sum(1 for v in values if v) < len(entries) // 2:
                continue
            sub: dict[str, list[dict]] = defaultdict(list)
            for e, v in zip(entries, values):
                sub[v or "general"].append(e)
            if len(sub) < 2:
                continue
            out: list[tuple[str, str, list[dict]]] = []
            for v in sorted(sub, key=num_key):
                sub_label = f"{label} — {axis.capitalize()} {v}" if v != "general" else label
                for suffix, lbl, es in split(ident, sub_label, sub[v], axes[i + 1 :]):
                    out.append((f":{axis}{v}{suffix}", lbl, es))
            return out
        numbered = [e for e in entries if trailing_number(identity(e)) > 0]
        out = []
        if len(numbered) >= len(entries) * 0.7:
            bands: dict[int, list[dict]] = defaultdict(list)
            for e in entries:
                bands[(trailing_number(identity(e)) // 100) * 100].append(e)
            for band in sorted(bands):
                chunk = sorted(bands[band], key=lambda e: trailing_number(identity(e)))
                lbl = f"{label} {band}–{band + 99}" if len(bands) > 1 else label
                out.append((f":band{band}", lbl, chunk))
        else:
            ALPHA_BANDS = [("A", "C"), ("D", "G"), ("H", "M"), ("N", "R"), ("S", "Z")]
            bands2: dict[str, list[dict]] = defaultdict(list)
            for e in entries:
                ch = (identity(e)[:1] or "S").upper()
                for lo_c, hi_c in ALPHA_BANDS:
                    if lo_c <= ch <= hi_c:
                        bands2[f"{lo_c}–{hi_c}"].append(e)
                        break
                else:
                    bands2["A–C" if ch < "A" else "S–Z"].append(e)
            for band_lbl in sorted(bands2):
                chunk = sorted(bands2[band_lbl], key=lambda e: identity(e).lower())
                lbl = f"{label} ({band_lbl})" if len(bands2) > 1 else label
                out.append((f":alpha{band_lbl}", lbl, chunk))
        return out

    plan: dict[str, dict] = {}
    for (category, ident), entries in plan_groups.items():
        for suffix, label, es in split(
            ident, ident, entries, ["volume", "part", "annex", "chapter"]
        ):
            plan[f"{category}::{ident}{suffix}"] = make_group(
                category, ident, label, es
            )
    plan.update(form_plan)

    for g in plan.values():
        g["sources"].sort(
            key=lambda e: (
                num_key(e.get("part")), num_key(e.get("chapter")),
                num_key(e.get("annex")), num_key(e.get("regulation")),
                num_key(e.get("section")), e.get("leaf_title") or "",
            )
        )

    with open(OUT / "merge-plan.json", "w") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)

    by_cat: dict[str, list] = defaultdict(list)
    for g in plan.values():
        by_cat[g["category"]].append(g)
    print(f"{'category':55} groups  files")
    total_g = total_f = 0
    for cat in sorted(by_cat, key=lambda c: -sum(len(g['sources']) for g in by_cat[c])):
        gs = by_cat[cat]
        files = sum(len(g["sources"]) for g in gs)
        total_g += len(gs)
        total_f += files
        print(f"{cat[:55]:55} {len(gs):6} {files:6}")
    print(f"{'TOTAL':55} {total_g:6} {total_f:6}")

    bad = [g["title"] for g in plan.values() if sum(c.isalpha() for c in g["title"]) < 4]
    print(f"unreadable titles remaining: {len(bad)} {bad[:5]}")


if __name__ == "__main__":
    main()
