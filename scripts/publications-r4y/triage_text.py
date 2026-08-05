#!/usr/bin/env python3
"""Triage the rows the quality score doubts, so a person only reads the doubtful.

The score that fills the review queue is a blunt one: it fails any text where
letters are under 45% of the characters. A markdown table is mostly pipes,
digits and dashes, so a perfectly extracted scantling table scores 0.3 and
lands in the queue beside genuine rubbish. Half of the queue's text rows are
tables.

So this re-measures each row on what it is made of rather than how it is
punctuated: the table scaffolding is stripped before the letters are counted,
and what remains is judged on whether it reads as language — real words, of
real length, in sentences.

    python3 triage_text.py --base … --token …            # report only
    python3 triage_text.py --base … --token … --accept   # accept the clean ones

Nothing is accepted without --accept, and accepting is reversible: the row goes
back by setting parse_state to 'needed'.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

REPORT = Path(__file__).with_name("triage-report.md")

TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$")
SEPARATOR = re.compile(r"^[\s|:\-—–_=+.]*$")


def strip_scaffolding(text: str) -> str:
    """The words a table holds, without the frame that holds them."""
    out = []
    for line in text.splitlines():
        if SEPARATOR.match(line):
            continue
        if TABLE_LINE.match(line):
            line = " ".join(cell.strip() for cell in line.strip().strip("|").split("|"))
        out.append(line)
    return "\n".join(out)


def measure(text: str) -> dict:
    body = strip_scaffolding(text)
    words = re.findall(r"[A-Za-z][A-Za-z'’-]{1,}", body)
    letters = sum(c.isalpha() for c in body)
    # Anything outside printable Latin, punctuation and the symbols a rulebook
    # actually uses (degrees, micro, arrows in cross-references).
    weird = len(re.findall(r"[^\x20-\x7E\n\r\t -ɏ‐-⇧€£°§±µ]", body))
    sentences = len(re.findall(r"[a-z]{3,}[.;:]\s", body))
    long_words = sum(1 for w in words if len(w) >= 4)
    return {
        "chars": len(body),
        "words": len(words),
        "letters_share": round(letters / max(len(body), 1), 2),
        "weird_share": round(weird / max(len(body), 1), 3),
        "avg_word": round(sum(map(len, words)) / max(len(words), 1), 1),
        "long_word_share": round(long_words / max(len(words), 1), 2),
        "sentences": sentences,
        "is_table": any(TABLE_LINE.match(l) for l in text.splitlines()),
        "cross_reference": bool(CROSS_REFERENCE.search(body)),
    }


# "[Article 1.3.1] See Part C, Chapter 1." is four words and complete. A rule
# that points at another rule is the shortest kind of rule there is, and
# nothing about it needs re-reading.
CROSS_REFERENCE = re.compile(
    r"\bsee\b|\bapplies?\b|\brefer\b|\bas (given|defined|specified)\b|"
    r"\bPt\s+[A-Z]|\bCh\s*\.?\s*\d|\bSec\s*\.?\s*\d|\bChapter\s+\d|"
    r"\bPart\s+[A-Z\d]|\bRegulation\s+\d|\bArticle\s+\d", re.I)


def classify(m: dict) -> tuple[str, str]:
    """(verdict, why) — clean is accepted, the rest stay for a person."""
    if m["words"] < 5:
        if m["cross_reference"] and m["weird_share"] <= 0.02:
            return "clean", "a cross-reference, and complete as it stands"
        return "vision", "almost no words — the page did not extract"
    if m["weird_share"] > 0.02:
        return "vision", "full of characters no rulebook uses"
    if m["avg_word"] < 2.6:
        return "vision", "words too short to be words"
    if m["long_word_share"] < 0.3:
        return "check", "mostly two- and three-letter fragments"
    if m["letters_share"] < 0.25:
        return "check", "letters are a quarter of it even without the table frame"
    if m["is_table"] and m["words"] >= 20:
        return "clean", "a table, and its cells hold real words"
    if m["words"] >= 40 or m["sentences"] >= 2:
        return "clean", "reads as prose"
    if m["words"] >= 15 and m["long_word_share"] >= 0.45:
        return "clean", "short but well-formed"
    return "check", "too little to judge either way"


def get(base: str, path: str, token: str | None):
    req = urllib.request.Request(f"{base.rstrip('/')}/{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def accept(base: str, node_id: str, token: str | None) -> None:
    req = urllib.request.Request(
        f"{base.rstrip('/')}/documents/publications/tree/nodes/{node_id}/accept-text",
        data=b"{}", method="POST", headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    urllib.request.urlopen(req, timeout=120).read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token")
    ap.add_argument("--accept", action="store_true")
    args = ap.parse_args()

    rows: list[dict] = []
    offset = 0
    while True:
        page = get(args.base,
                   f"documents/publications/tree/review?limit=100&offset={offset}",
                   args.token)
        nodes = [n for n in page["nodes"] if (n.get("text") or "").strip()]
        rows.extend(nodes)
        offset += 100
        if offset >= page["total"]:
            break
    print(f"строк с текстом в очереди: {len(rows)}", flush=True)

    verdicts = Counter()
    detail: list[tuple[str, str, dict, dict]] = []
    for node in rows:
        m = measure(node["text"])
        verdict, why = classify(m)
        verdicts[verdict] += 1
        detail.append((verdict, why, m, node))

    for verdict in ("clean", "check", "vision"):
        print(f"   {verdict:7} {verdicts[verdict]:4}", flush=True)

    lines = ["# Text triage", "",
             f"{len(rows)} rows in the queue carry text. Re-measured on what they",
             "are made of rather than how they are punctuated.", "",
             "| verdict | rows | what it means |", "|---|---|---|",
             f"| clean | {verdicts['clean']} | accepted — the text is usable as it stands |",
             f"| check | {verdicts['check']} | left in the queue for a person |",
             f"| vision | {verdicts['vision']} | left in the queue; only a re-read will fix it |",
             ""]
    for verdict in ("clean", "check", "vision"):
        lines += [f"## {verdict}", ""]
        shown = [d for d in detail if d[0] == verdict][:6]
        for _, why, m, node in shown:
            where = " › ".join(node.get("path") or [])
            lines += [f"**{where} › {node['title']}**  ",
                      f"_{why}_ — {m['words']} words, letters {m['letters_share']}, "
                      f"avg word {m['avg_word']}"
                      f"{', table' if m['is_table'] else ''}", "",
                      "```", (node["text"][:400] or "").rstrip(), "```", ""]
    REPORT.write_text("\n".join(lines))
    print(f"отчёт: {REPORT}", flush=True)

    if not args.accept:
        print("это разведка; чтобы принять чистые, добавьте --accept", flush=True)
        return 0

    done = failed = 0
    for verdict, _, _, node in detail:
        if verdict != "clean":
            continue
        try:
            accept(args.base, node["id"], args.token)
            done += 1
        except urllib.error.HTTPError as e:
            failed += 1
            print(f"   FAIL {node['title'][:40]}: {e.code}", flush=True)
    print(f"принято {done}, ошибок {failed}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
