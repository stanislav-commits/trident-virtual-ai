#!/usr/bin/env python3
"""Load the Regs4Ships library into the publications TREE.

Builds category → publication → (volume/part/annex/chapter) → article from the
parsed filenames in inventory.jsonl, then posts each publication as a subtree.
Text rides inline; originals are attached separately (forms first — for a form
the file IS the deliverable).

Reuses build_plan.py for identity/series/form/reclassify/dedupe so the tree and
the older merge share one set of rules.

  python3 load_tree.py --base http://localhost:3001/api --user admin --password …
  python3 load_tree.py … --categories Malta SOLAS      # a slice
  python3 load_tree.py … --dry-run                     # print the shape only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import re
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_plan as bp  # noqa: E402

OUT = Path(os.environ.get("R4Y_WORK", Path.home() / "Documents" / "r4y-publications-build"))
TXT = OUT / "text"
SRC = Path.home() / "Downloads" / "R4Y"

# Roughly how much text one import request carries. 15 MB is the server's JSON
# limit; stay well under it because one Lloyd's Part is ~3 MB of text.
MAX_REQUEST_CHARS = 4_000_000


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


# What a shelf holds when the name alone doesn't say. "SOLAS" contains none
# of the words "act / code / convention", yet everything on that shelf is
# binding regulation — the category knows what the title cannot.
CATEGORY_DEFAULT_TYPE = {
    "SOLAS": "law", "MARPOL": "law", "STCW": "law", "Codes": "law",
    "Other Conventions": "law", "ILO": "law", "EU Legislation": "law",
    "United Kingdom": "law", "Rules and Regulations": "law",
    "Guidance Notes": "law", "LR ShipRight": "law", "LR MQPS": "law",
    "LR TASTS": "law", "LR Recommended Practices": "law",
    "Instructions to Surveyors": "law", "IMO Resolutions": "law",
    "IMO Guidelines": "law", "IMO Performance Standards": "law",
    "Code of Safe Working Practices for Merchant Seafarers (CoSWP)": "law",
    "IMO Circulars": "notice_series", "IMO Circular Letters": "notice_series",
    "MCA M Notices": "notice_series", "Notices": "notice_series",
    "PSC": "notice_series",
}


def node_type_for(entry: dict, ident: str) -> str:
    series = bp.series_of(entry["category"], ident)
    if bp.is_form(entry, series):
        return "form"
    if series:
        return "notice_series"
    name = f"{ident} {entry.get('leaf_title') or ''}".lower()
    if any(w in name for w in ("act", "regulation", "code", "convention", "rules")):
        return "law"
    return CATEGORY_DEFAULT_TYPE.get(entry["category"], "other")


def read_text(rel: str) -> tuple[str | None, float | None]:
    p = TXT / Path(rel).with_suffix(".txt")
    if not p.exists():
        return None, None
    raw = p.read_text(errors="replace").replace("\f", "\n\n").strip()
    if not raw:
        return None, 0.0
    return raw, text_quality(raw)


def text_quality(text: str) -> float:
    import re
    sample = text[:20000]
    if len(sample.strip()) < 40:
        return 0.0
    words = re.findall(r"[A-Za-z]{2,}", sample)
    if not words:
        return 0.0
    letters = sum(c.isalpha() for c in sample)
    weird = len(re.findall(r"[^\x20-\x7E\n\r\t -ɏ‐-‧€£°§±µ]", sample))
    avg = sum(map(len, words)) / len(words)
    score = 1.0
    if letters / len(sample) < 0.45:
        score -= 0.4
    if weird / len(sample) > 0.02:
        score -= 0.4
    if avg < 3.2 or avg > 9:
        score -= 0.3
    return round(max(0.0, score), 2)


def leaf_of(entry: dict) -> dict:
    """A file becomes an article: its finest number + its own title."""
    number = (
        entry.get("regulation") and f"Reg. {entry['regulation']}"
        or entry.get("section") and f"Section {entry['section']}"
        or None
    )
    title = bp.repair_title(entry.get("leaf_title") or Path(entry["rel"]).stem)
    text, quality = (None, None) if entry["kind"] != "pdf" else read_text(entry["rel"])
    return {
        "number": number,
        "title": title,
        "contentText": text,
        "textQuality": 0.0 if entry["kind"] != "pdf" else quality,
        "sourceRef": entry["rel"],
    }


AXES = [
    ("volume", "Volume"),
    ("part", "Part"),
    ("annex", "Annex"),
    ("chapter", "Chapter"),
]


def nest(entries: list[dict], axes) -> list[dict]:
    """Group files into branches along whichever axes they actually carry."""
    if not axes:
        return [leaf_of(e) for e in sorted(entries, key=lambda e: (
            bp.num_key(e.get("regulation")), bp.num_key(e.get("section")),
            e.get("leaf_title") or ""))]
    (key, label), *rest = axes
    values = {}
    for e in entries:
        v = e.get(key)
        if key == "volume":
            import re
            v = None
            for crumb in e.get("crumbs") or []:
                m = re.search(r"\bVolume\s+(\d+)", crumb, re.I)
                if m:
                    v = m.group(1)
                    break
        values.setdefault(v, []).append(e)
    if len(values) == 1 and None in values:
        return nest(entries, rest)
    out = []
    for v in sorted(values, key=lambda x: bp.num_key(x) if x else (-1,)):
        group = values[v]
        if v is None:
            out.extend(nest(group, rest))
            continue
        out.append({
            "number": f"{label} {v}",
            "title": branch_title(group, key) or f"{label} {v}",
            "children": nest(group, rest),
        })
    return out


AXIS_CRUMB = re.compile(
    r"^(Volume|Part|Annex|Chapter|Section|Regulation)\s+[0-9IVXLC]", re.I
)


def branch_title(entries: list[dict], key: str) -> str:
    """
    Name a branch from the crumbs around its axis. The downloader split names
    on " - ", so "Chapter II-1 - Construction, subdivision…" arrives as TWO
    crumbs — the descriptive half is the one that follows.
    """
    rx = re.compile(rf"^{key}\s+[0-9IVXLC][A-Za-z0-9-]*\s*[-—:]?\s*(.*)$", re.I)
    for e in entries:
        crumbs = e.get("crumbs") or []
        for i, crumb in enumerate(crumbs):
            m = rx.match(crumb)
            if not m:
                continue
            tail = m.group(1).strip(" -—:").rstrip(".")
            if len(tail) > 2:
                return bp.repair_title(tail)
            nxt = crumbs[i + 1] if i + 1 < len(crumbs) else ""
            if nxt and not AXIS_CRUMB.match(nxt) and len(nxt) > 2:
                return bp.repair_title(nxt.rstrip("."))
    return ""


def build_tree(categories: set[str] | None):
    inv = [json.loads(l) for l in open(OUT / "inventory.jsonl")]

    moves = 0
    for e in inv:
        target = bp.reclassify(e)
        if target:
            e["category"] = target
            moves += 1

    cat_size = defaultdict(int)
    for e in inv:
        cat_size[e["category"]] += 1
    by_key = defaultdict(list)
    for e in inv:
        by_key[(e["rel"].rsplit("/", 1)[-1].lower(), e["bytes"])].append(e)
    inv = []
    for group in by_key.values():
        group.sort(key=lambda e: (cat_size[e["category"]], e["category"]))
        inv.append(group[0])
    print(f"reclassified {moves} · deduped to {len(inv)} files", flush=True)

    # Group by (category, publication) FIRST — the type is a property of the
    # publication, decided by majority once. Deciding it per file split SOLAS
    # into a "law" half and an "other" half.
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for e in inv:
        if categories and e["category"] not in categories:
            continue
        ident = bp.identity(e)
        root_name = bp.series_of(e["category"], ident) or ident
        grouped[(e["category"], root_name)].append(e)

    roots: dict[tuple, dict] = {}
    for (category, root_name), entries in grouped.items():
        votes = defaultdict(int)
        for e in entries:
            votes[node_type_for(e, bp.identity(e))] += 1
        ntype = max(votes.items(), key=lambda kv: (kv[1], kv[0] != "other"))[0]
        roots[(category, ntype, root_name)] = {
            "category": category,
            "nodeType": ntype,
            "jurisdiction": bp.CATEGORY_JURISDICTION.get(category, "international"),
            "title": bp.repair_title(root_name),
            "entries": entries,
        }

    trees = []
    for (category, ntype, _), root in sorted(roots.items()):
        entries = root["entries"]
        if ntype == "form":
            # every form is its own publication, no children
            for e in entries:
                leaf = leaf_of(e)
                trees.append({**root, "title": leaf["title"], "number": None,
                              "children": [], "leafSource": e["rel"],
                              "contentText": leaf["contentText"],
                              "textQuality": leaf["textQuality"]})
            continue
        children = nest(entries, AXES) if len(entries) > 1 else [leaf_of(entries[0])]
        if len(entries) == 1 and not children[0].get("children"):
            trees.append({**root, "number": None, "children": [],
                          "contentText": children[0]["contentText"],
                          "textQuality": children[0]["textQuality"],
                          "leafSource": entries[0]["rel"]})
            continue
        trees.append({**root, "number": None, "children": children})
    return trees


def count_nodes(nodes) -> int:
    return sum(1 + count_nodes(n.get("children") or []) for n in nodes)


def chars_of(nodes) -> int:
    return sum(len(n.get("contentText") or "") + chars_of(n.get("children") or [])
               for n in nodes)


MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".tif": "image/tiff"}


def multipart(filename: str, payload: bytes, mime: str):
    boundary = "----r4ytree"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def upload_missing_originals(base: str, token: str) -> None:
    """Attach the source PDF to every scan-flagged node that has none.

    Parse reads the ORIGINAL, and the tree import carries text only — without
    this step the button has nothing to work on."""
    pending = api(base, "documents/publications/tree/pending-originals?limit=2000", token)
    if not pending:
        return
    print(f"attaching originals to {len(pending)} scan node(s)", flush=True)
    ok = fail = 0
    for i, node in enumerate(pending, 1):
        ref = node.get("sourceRef")
        if not ref:
            fail += 1
            continue
        path = SRC / ref
        if not path.exists():
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
        if i % 25 == 0:
            print(f"  {i}/{len(pending)} ok={ok} fail={fail}", flush=True)
    print(f"originals attached: ok={ok} fail={fail}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--categories", nargs="*", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--originals-only", action="store_true",
                    help="skip the tree load; only attach missing scan originals")
    args = ap.parse_args()

    if args.originals_only:
        login = post_json(args.base, "auth/login", None,
                          {"userId": args.user, "password": args.password})
        upload_missing_originals(args.base, login["access_token"])
        return 0

    trees = build_tree(set(args.categories) if args.categories else None)
    total_nodes = sum(1 + count_nodes(t.get("children") or []) for t in trees)
    print(f"{len(trees)} publications · {total_nodes} nodes", flush=True)
    if args.dry_run:
        for t in trees[:15]:
            kids = count_nodes(t.get("children") or [])
            print(f"  [{t['nodeType']:13}] {t['category'][:18]:18} {t['title'][:60]:60} {kids:5} nodes")
        return 0

    login = post_json(args.base, "auth/login", None,
                      {"userId": args.user, "password": args.password})
    token = login["access_token"]

    created = failed = 0
    t0 = time.time()
    for i, tree in enumerate(trees, 1):
        try:
            root = post_json(args.base, "documents/publications/tree/import", token, {
                "category": tree["category"],
                "nodeType": tree["nodeType"],
                "jurisdiction": tree["jurisdiction"],
                "nodes": [{
                    "number": tree.get("number"),
                    "title": tree["title"],
                    "contentText": tree.get("contentText"),
                    "textQuality": tree.get("textQuality"),
                    "sourceRef": tree.get("leafSource"),
                }],
            })
            root_id = root["rootIds"][0]

            batch, batch_chars = [], 0
            for child in tree.get("children") or []:
                size = chars_of([child])
                if batch and batch_chars + size > MAX_REQUEST_CHARS:
                    post_json(args.base, "documents/publications/tree/import", token,
                              {"parentId": root_id, "nodes": batch})
                    batch, batch_chars = [], 0
                batch.append(child)
                batch_chars += size
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
        if i % 25 == 0:
            print(f"{i}/{len(trees)} ok={created} fail={failed} "
                  f"({i/(time.time()-t0):.1f}/s)", flush=True)

    upload_missing_originals(args.base, token)
    print(f"DONE publications={created} failed={failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
