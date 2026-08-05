# Publications library — twenty test questions

Run against the crew chat as **SeaWolf X**: Malta flag, RINA class, 42.7 m,
499 GT, commercial. That vessel profile is half the test — a third of these
questions are about what the answer must NOT reach for.

Each question names the source that holds the answer, so a run can be marked
without reading the whole library. "Wrong" here means one of four things:
the answer cites a publication this vessel does not sail under, it invents a
requirement, it flattens a table, or it says nothing when the library holds
the answer.

Ask them in English — the material is English, and `answerLanguage` decides
what comes back.

---

## Straight retrieval — the answer is on one shelf

**1. What are the survey intervals for a yacht classed with RINA after construction?**
RINA › Rules & Guides › RES › RES31. Must come from the yacht rules, not from
the ship rules and not from another society.

**2. Which mechanical joints may be used on a CO₂ system, and which on scuppers discharging overboard?**
Bureau Veritas › NR500 › Pt C, Ch 1, Sec 4 — Table 1 "Application of mechanical
joints". Correct: pipe unions and compression couplings for both, slip-on
joints for neither. This is the table-reading test: the answer has to pair each
system with its own row, and the legend "+ allowed / − not allowed" is a
footnote under the table, not a row of it.

**3. What has to be submitted before a yacht's piping systems are approved?**
BV NR500 › Pt C, Ch 1, Sec 4, [1.2] — the two "documents to be submitted"
tables. A list, not a paraphrase.

**4. Which requirements enter into force on 1 January 2027?**
RINA › IMO Conventions, Codes and Amendments › "In force from 1 January 2027".
The library holds one document organised by date; the answer should be that
date's list, not a search across every convention.

**5. What did RINA change with circular 3850/A, and from when?**
RINA › Technical circulars › Circular 3850/A — Rule Variation RV/2026/05, in
force 1 July 2026, amending GUI2, NAS10/11/19, NCC23/43/86, RES17/31 and the
Rules for Ships.

**6. What were the main decisions of MSC 111?**
RINA › Marine Notice (MNO) › MNO 248 (May 2026).

**7. Which form does Malta require for a Declaration of Maritime Labour Compliance?**
Malta › Forms. The answer must name the form — and hand over the file itself,
not only describe it.

**8. What does the Code of Safe Working Practices say about working aloft?**
CoSWP. It is published by the UK administration but marked international in
this library, because the crew uses it as general practice — a Malta-flagged
vessel must still get it.

---

## Cross-references — the citation has to resolve

**9. NR500 Pt C, Ch 1, Sec 4 says the requirements of Ch 1, Sec 5 to Ch 1, Sec 9 also apply. What are those sections about?**
The reference and the node it points at are the same string by construction.
A correct answer names them; a wrong one repeats the reference.

**10. A yacht rule defers to the ship rules for a subject. Which document is that, and does the library hold it?**
DNV › Yachts defers to DNV › Ships 359 times; BV NR500 defers to NR467. Both
sets are loaded for exactly this reason. The answer should follow the chain
rather than stop at "see the ship rules".

**11. What does RINA mean by "Pt A, Ch 1, Sec 1" and where does that land in this library?**
A structural question: the node numbers are the society's own citation form.

---

## Scoping — the vessel's flag and class decide

**12. What does the Bahamas require for a yacht's radio survey?**
The library holds the Bahamas shelf, but this vessel is Malta-flagged. Correct
behaviour: answer from Malta, or say the Bahamas rules do not apply to her —
never quote a Bahamian order as if it bound her.

**13. What do the Lloyd's Register rules require for hull surveys?**
Same test on the class side: she is RINA. Lloyd's is on the shelf for other
vessels, and must not answer for this one.

**14. Which EU regulations apply to this vessel?**
EU Legislation is scoped `eu`, and Malta is in the Union — these DO apply. The
mirror of question 12: scoping must not over-narrow either.

**15. What are the SOLAS requirements for life-saving appliance surveys?**
SOLAS is international and applies whatever the flag. Chapter III, Regulation 8.

---

## Judgement — where the library is deliberately thin

**16. What do the Common Structural Rules require for a bulk carrier's cargo hold?**
Deliberately not loaded — bulk carriers and oil tankers are out of scope by the
operator's rule. Correct: say the library does not cover it. Wrong: answer from
general ship rules as though it did.

**17. Which edition of the IMO entry-into-force table is current?**
Only the edition in force is loaded; sixteen yearly reprints were left out. The
answer should be "updated to December 2025" and should not offer an older one.

**18. What does NI409 say about coating seawater ballast tanks?**
Bureau Veritas › Guidance Notes › NI409, a 1995 scan with no text layer. Until
vision reads it, the honest answer is that the document is on the shelf but its
text has not been extracted — not a guess from the title.

**19. Does a 499 GT yacht need a stability booklet, and under whose rules?**
Three shelves can answer — RINA RES31, BV NR566 (ships under 500 GT), and the
flag. A good answer says which one it is using and why, rather than blending
them.

**20. What is the difference between what RINA and Bureau Veritas require for the same subject — say, mechanical joints in piping?**
Both societies are loaded, but only one classes this vessel. The answer should
lead with RINA and mark BV as comparison, not present them as equal authority.

---

## What to record per question

| Field | Why |
|---|---|
| Answered / refused / wrong | The three outcomes worth counting |
| Publications cited | Catches scoping failures directly |
| Citation resolves | Does "Pt C, Ch 1, Sec 4" exist as a node |
| Table intact | Questions 2 and 3 only |
| File offered | Question 7 only |
| Cost, tokens, latency | The usage tile already splits this by purpose |

A first pass is worth running twice: once with the vessel scoped to Malta and
RINA, once with the scope cleared. The difference between the two runs is the
measurement of whether scoping earns its keep.
