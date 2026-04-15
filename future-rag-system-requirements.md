# Future RAG System Requirements

## Purpose

This document captures the target design principles and requirements for the future retrieval and answer-generation system.

The goal is not only to improve retrieval quality, but to build a system that:

- understands what the user actually means
- understands what each document actually contains
- retrieves the correct source with strong control
- stays stable across different phrasings and follow-up questions
- remains observable, testable, and safe

---

## Core Problem

The current system is too lexical.

It depends too much on:

- keywords
- regex-like intent triggers
- broad vector similarity
- late filtering after retrieval

Because of that, it can:

- select semantically similar but wrong manuals
- miss the correct procedure even when the document exists
- route a query into the wrong source category
- drift during follow-up questions
- answer from mixed or weak evidence

This becomes especially visible when:

- different users phrase the same question in different ways
- the right answer exists in a document that does not use the same wording
- multiple documents are topically similar
- the user refers to a specific manual, section, or page

---

## High-Level Goal

The future system should stop behaving like a plain chunk search engine and start behaving like a controlled knowledge system.

It must:

1. understand the user query semantically
2. understand documents semantically during ingest
3. combine those two layers through deterministic routing and retrieval controls
4. produce answers only from strong evidence

---

## System Principles

### 1. Fail Closed, Not Fail Open

If the system is not confident about:

- the correct document
- the correct source category
- the correct concept
- the correct page/section

it should:

- ask a clarification question, or
- say that the answer cannot be confirmed from the selected source

It should **not** widen to unrelated documents just to produce something.

### 2. Separate Understanding, Retrieval, and Generation

The system should have distinct stages:

1. understanding
2. routing
3. retrieval
4. evidence refinement
5. answer generation

The LLM should not be allowed to silently improvise source selection during final answer generation.

### 3. Exact Signals Must Beat Broad Similarity

Explicit signals must override fuzzy retrieval:

- exact manual title
- exact equipment/vendor/model
- explicit page reference
- explicit section name
- explicit regulation/certificate type

If the user says `Blue Sea Plus` or `page 71`, the system must not behave as if this is just a vague semantic query.

### 4. Metadata Guides Retrieval, Chunks Justify the Answer

Semantic metadata should not replace chunk retrieval.

Instead:

- metadata should decide **where to search**
- chunks/pages should decide **what evidence supports the answer**

Metadata is for routing and narrowing.
Chunks are for proof.

---

## Required Capability 1: AI Query Normalization

Before retrieval, each user query should be normalized into a structured representation.

This normalization should infer:

- `intent`
- `concepts`
- `equipment`
- `system`
- `vendor`
- `model`
- `source_preferences`
- `explicit_source`
- `page_hint`
- `section_hint`
- `answer_format`
- `needs_clarification`
- `confidence`

Example:

```json
{
  "intent": "operational_procedure",
  "concepts": ["bunkering_operation"],
  "equipment": [],
  "source_preferences": ["HISTORY_PROCEDURES", "REGULATION"],
  "explicit_source": null,
  "page_hint": null,
  "section_hint": null,
  "answer_format": "step_by_step",
  "needs_clarification": false,
  "confidence": 0.92
}
```

### Why this is necessary

Different users will ask the same thing in different ways:

- `I will have bunkering soon, describe me step by step procedure`
- `how do we do bunkering`
- `give me bunkering checklist`
- `what should I do before fuel transfer`

Those should converge to the same semantic intent and concept.

### Important rule

The normalizer must not depend on hardcoded wording lists as the primary strategy.

It should use AI to infer meaning, while deterministic code validates and routes the output.

---

## Required Capability 2: AI Document Normalization During Ingest

When documents are parsed and indexed, the system should also generate semantic metadata for them.

This should happen at:

- whole-document level
- major section level
- optionally chunk level for high-value sections

The goal is to know what each document is actually about before the user asks anything.

### Each document should have a semantic profile

For example:

- `document_type`
- `source_category`
- `primary_concepts`
- `secondary_concepts`
- `systems`
- `equipment`
- `vendor`
- `model`
- `operation_types`
- `compliance_topics`
- `revision`
- `effective_date`
- `aliases`
- `section map`
- `page-to-topic map`
- `procedure sections`
- `warning sections`
- `checklist sections`

Example:

```json
{
  "document_type": "operational_procedure",
  "primary_concepts": ["bunkering_operation"],
  "secondary_concepts": ["fuel_transfer", "spill_prevention"],
  "systems": ["fuel_system"],
  "equipment": [],
  "vendor": null,
  "model": null,
  "source_category": "HISTORY_PROCEDURES",
  "aliases": ["bunkering", "fuel transfer", "taking fuel onboard"],
  "sections": [
    {
      "title": "Pre-bunkering checklist",
      "page_start": 4,
      "concepts": ["bunkering_operation"]
    },
    {
      "title": "Bunkering procedure",
      "page_start": 7,
      "concepts": ["bunkering_operation"]
    }
  ]
}
```

### Why this matters

Without semantic enrichment on ingest, retrieval must rediscover document meaning from raw chunks every time.

That leads to:

- noisy retrieval
- poor routing
- weak candidate document selection
- heavy dependence on query wording

---

## Required Capability 3: Canonical Concepts

The system should operate on canonical concepts, not raw words.

Not:

- `bunkering`
- `fuel transfer`
- `taking fuel onboard`
- `receiving fuel onboard`

But:

- `bunkering_operation`

Not:

- `sewage treatment plant`
- `stp`
- `blue sea plus`

But:

- one or more structured concepts plus entity links

### Concept Catalog

The system should maintain a concept catalog containing:

- concept id
- family
- label
- description
- aliases
- preferred source categories
- related equipment/systems
- optional linked document types

Example:

```json
{
  "id": "bunkering_operation",
  "family": "operational_procedure",
  "label": "Bunkering operation",
  "description": "Receiving fuel onboard, including preparation, transfer monitoring, completion, and spill prevention.",
  "aliases": ["bunkering", "fuel transfer", "taking fuel onboard"],
  "source_preferences": ["HISTORY_PROCEDURES", "REGULATION"]
}
```

### Important rule

Do not pass the entire concept universe into every LLM call.

Instead:

1. detect coarse intent/family
2. retrieve a short list of candidate concepts
3. let the LLM choose among those candidates

This avoids prompt bloat and concept confusion.

---

## Required Capability 4: Hierarchical Retrieval

Retrieval should be hierarchical, not flat.

Recommended order:

1. choose source category
2. shortlist documents
3. shortlist sections/pages
4. retrieve chunks
5. refine citations

This is safer and more precise than searching all chunks across the dataset from the start.

### Why this matters

Searching the full dataset first causes:

- wrong manuals to enter the candidate set
- similar but irrelevant documents to outrank the correct one
- late filters to become ineffective

Metadata should constrain search space before chunk retrieval begins.

---

## Required Capability 5: Source Lock

If the system resolves a specific document, it should lock to it.

Source lock should activate when the user provides:

- explicit manual name
- explicit equipment/vendor/model
- explicit source reference
- clear follow-up to a previously selected source

Examples:

- `Blue Sea Plus maintenance`
- `this manual`
- `page 71`
- `in that guide`

### Required behavior

Once source lock is active:

- retrieval should search only inside that source
- unrelated documents must not be added
- fallback widening must be disabled unless explicitly allowed

### Why this matters

Without source lock:

- follow-ups drift
- page references become meaningless
- the assistant can silently switch sources

---

## Required Capability 6: Page-Aware and Section-Aware Retrieval

If the user references:

- `page 71`
- `maintenance section`
- `checklist section`
- `chapter 4`

the system should not rely on broad vector retrieval.

It should:

- use the locked document
- identify the page/section
- retrieve only nearby pages or section chunks

### Why this matters

Page references are high-precision signals.
Treating them like general search terms weakens the answer.

---

## Required Capability 7: Structured Follow-Up Memory

Conversation memory must not rely only on raw previous text.

The system should carry forward structured state such as:

- active intent
- active concept
- locked source
- locked category
- page hint
- section hint
- vessel scope
- equipment/system scope

### Why this matters

Follow-up questions are often short and ambiguous:

- `what about this one`
- `page 71`
- `same for port side`
- `and for Blue Sea Plus`

Without structured carry-forward, retrieval drifts.

---

## Required Capability 8: Multi-Source Control

The assistant should not mix sources by default.

It should combine multiple sources only when:

- the user explicitly requests it
- the query genuinely requires it
- the sources are compatible and clearly attributable

Examples where multi-source may be valid:

- certificate expiry + regulation consequences
- manual procedure + telemetry status
- regulation + vessel-specific certificate

Examples where it should not happen automatically:

- equipment manual + unrelated manual
- regulation + generic certificate appendix
- page-specific question + broad semantic source expansion

### Important rule

Each fact in a multi-source answer must remain tied to a specific supporting source.

---

## Required Capability 9: Document Structure Preservation

The system must preserve document structure as much as possible during parsing.

Especially for maritime and operational documents, the parser should not flatten away:

- section headers
- numbered procedures
- checklists
- warnings/cautions/dangers
- tables
- page numbers
- annex labels
- revision markers

### Why this matters

Many of the most important answers depend on structure:

- step-by-step procedures
- checklists
- page references
- compliance tables
- warning blocks

Plain text similarity is not enough.

---

## Required Capability 10: Category-Aware Behavior

Different knowledge categories require different retrieval logic.

### Manuals

Need:

- exact equipment/system matching
- vendor/model resolution
- page-aware retrieval
- source lock

### History Procedures / SMS / SOP

Need:

- operation-aware routing
- checklist/procedure structure
- section-focused retrieval

### Certificates

Need:

- subject matching
- date extraction
- current-date reasoning
- distinction between certificate text and compliance implications

### Regulations

Need:

- topic matching
- framework/jurisdiction awareness
- effective-date awareness
- precise text grounding

### Metrics / Telemetry

Need:

- entity resolution
- current vs historical distinction
- signal alias normalization

---

## Required Capability 11: Observability

The system must be debuggable.

For each query, internal logs should capture at least:

- raw query
- normalized query
- chosen intent
- selected concepts
- selected source categories
- shortlist of candidate documents
- final retrieved documents
- final cited chunks/pages
- whether source lock was active
- whether page lock was active
- whether fallback/widening was used

### Why this matters

Without retrieval trace logs, fixing quality issues becomes guesswork.

---

## Required Capability 12: Confidence and Clarification

The system must know when to stop and ask.

Clarification should trigger when:

- multiple documents fit equally well
- concept resolution is uncertain
- asset/system is missing
- source category is ambiguous
- the user likely refers to a family of documents rather than a specific source

### Clarification is better than bad retrieval

The assistant should prefer:

- `Which exact system or manual do you mean?`

over:

- a confident answer built on weak or wrong evidence

---

## Required Capability 13: Evaluation

The future system must be evaluated with real phrasing variation.

The evaluation set should include:

- multiple phrasings for the same question
- follow-up questions
- explicit page references
- explicit source references
- cross-category ambiguity cases

### Example evaluation groups

- bunkering procedure
- Blue Sea Plus maintenance
- certificate expiry
- MARPOL/compliance
- current vs historical telemetry
- procedures in SMS wording vs manual wording

### What should be evaluated

- routing correctness
- source category correctness
- document selection correctness
- source lock stability
- follow-up stability
- page-level retrieval accuracy
- citation relevance

---

## Required Capability 14: Versioning and Reprocessing

Document enrichment must be versioned.

If a document:

- changes revision
- is re-uploaded
- is re-parsed with a new parser
- gets re-enriched with a better schema

the system must know which version of metadata and chunks is active.

### Why this matters

Without version awareness:

- stale semantic profiles may remain active
- retrieval can use outdated structure
- answers may cite the wrong revision

---

## Required Capability 15: Safe Answer Behavior

The system must distinguish between:

- `not found in retrieved documents`
- `not documented in the locked source`
- `not available for this vessel`

These are different answer states and should not be collapsed into one generic fallback.

### Expected answer behavior

The assistant should be able to say:

- the selected source did not contain the requested procedure
- the question appears to belong to another document category
- the current vessel-specific data is missing

without inventing or broadening beyond safe limits.

---

## Recommended Architecture

Suggested future components:

- `QueryNormalizerService`
- `ConceptCatalog`
- `ConceptResolver`
- `DocumentEnrichmentService`
- `SourceRouter`
- `DocumentShortlistRetriever`
- `SectionShortlistRetriever`
- `ChunkRetriever`
- `SourceLockManager`
- `PageAwareRetriever`
- `CitationRefiner`
- `RetrievalTraceLogger`

---

## Recommended End-to-End Flow

1. User sends raw query.
2. AI query normalizer builds structured query JSON.
3. Deterministic validator checks the JSON fields.
4. Concept resolver maps the query into candidate concepts.
5. Source router selects source categories and retrieval strategy.
6. Semantic metadata is used to shortlist candidate documents.
7. If a source is resolved, source lock is activated.
8. If page/section hints exist, page-aware or section-aware retrieval is used.
9. Chunk retrieval runs only inside shortlisted documents/sections.
10. Citation refinement removes weak or off-topic evidence.
11. LLM generates final answer from the selected evidence.
12. Retrieval trace is logged.
13. Structured follow-up state is stored for the next turn.

---

## Rollout Plan

### Phase 1

- add AI query normalization
- keep existing chunk retrieval
- add logging

### Phase 2

- add semantic document enrichment during ingest
- use metadata for document shortlist

### Phase 3

- add source lock
- add follow-up structured memory
- add page-aware retrieval

### Phase 4

- add evaluation suite
- measure retrieval improvements
- tighten fallback behavior

---

## Final Summary

The future system should not be a larger keyword engine.

It should be a semantic, hierarchical, source-controlled knowledge system that:

- understands user intent
- understands documents during ingest
- routes safely
- retrieves narrowly
- cites exact evidence
- stays stable across different phrasings and follow-up questions
- remains observable and testable

That is the real path from unstable RAG behavior to a trustworthy operational knowledge assistant.
