# Manual Resolution Context

## Problem

Our RAG pipeline often answers a technical question using a semantically similar manual instead of the correct manual for the exact equipment installed on the vessel.

Because of that, the answer may look careful and source-based, but the evidence is still wrong or too broad.

## Concrete Example

User asks about maintenance for the sewage treatment plant.

Expected source:

- `Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide (Ed.03_Rev.09_09.01.2023).pdf`

Actual wrong behavior:

- the system retrieved `Jets.614213.Instruction Manual.pdf`
- then, after the user clarified `Blue Sea Plus`
- then, after the user said `I see maintenance on page 71`
- the system still failed to stay locked to the correct manual and started mixing unrelated documents/pages

## Root Cause

The current pipeline behaves like this:

1. broad retrieval over the dataset
2. local filtering/reranking after retrieval
3. answer generation from whatever citations survived

That is too late.

If the correct manual does not make it into the first retrieval set, post-filtering cannot save the answer.

There is also no strong source-lock for follow-up queries like:

- `Blue Sea Plus`
- `this manual`
- `page 71`
- `in that guide`

## Idea

We should switch from:

- `broad retrieval first`

to:

- `manual resolution first`

## Target Behavior

For manual-related questions, the system should work like this:

1. Resolve which exact manual matches the user question.
2. If one manual is confidently resolved, search only inside that manual.
3. If the user mentions a page or section, search only inside that page/section of the resolved manual.
4. If there are multiple likely manuals, ask a clarification question instead of guessing.
5. If the answer is not found in the locked manual, say that clearly instead of widening to unrelated manuals.

## Scope of the Fix

### 1. Manual Resolution Layer

Before retrieval, extract from the query and recent history:

- equipment/system name
- vendor
- model
- explicit manual title
- page hint
- section hint

Output:

- `resolvedManualId`, or
- a short list of candidate manuals

### 2. Source Lock

If `resolvedManualId` is present:

- retrieval must run only against that manual
- the pipeline must not widen to the whole dataset
- unrelated manuals must not appear in citations

This must also apply to follow-ups when the user says things like:

- `Blue Sea Plus`
- `page 71`
- `this manual`

### 3. Page-Aware Retrieval

If the query contains a page reference such as `page 71`:

- search only inside that resolved manual
- prioritize page 71
- optionally include nearby pages such as 70 and 72

This should not rely on normal dataset-wide vector retrieval.

### 4. Follow-Up Carry Forward

After a successful answer, save in chat context:

- `resolvedManualId`
- `resolvedManualTitle`
- `sourceLock = true`
- `pageHint` if present

Then reuse that context for the next user turn.

## Expected Outcome

### Case 1

User asks:

- `maintenance for sewage treatment plant`

Expected behavior:

- system resolves the installed STP manual for that ship
- if that system is Blue Sea Plus, retrieval runs only on the Blue Sea Plus manual
- `Jets.614213.Instruction Manual.pdf` should not enter the candidate set

### Case 2

User asks:

- `Blue Sea Plus maintenance`

Expected behavior:

- explicit source lock on Blue Sea Plus
- answer built only from the Blue Sea Plus manual

### Case 3

User says:

- `I see maintenance on page 71`

Expected behavior:

- keep the same locked manual from the previous turn
- search only page 71 and nearby pages of that same manual
- do not mix in AP70, Jets, or other unrelated sources

## Acceptance Criteria

1. For Blue Sea Plus questions, the system cites the Blue Sea Plus manual instead of generic sewage treatment manuals.
2. Follow-up questions stay locked to the previously resolved manual.
3. Page-specific follow-ups stay inside the same manual and page area.
4. If multiple manuals match the same broad system name, the assistant asks for clarification instead of guessing.
5. If no answer exists in the locked manual, the assistant says so explicitly and does not widen to unrelated manuals.

## One-Line Summary

This fix is not just about improving search quality; it is about enforcing exact manual resolution and source lock so the answer comes from the correct manual for the user's specific question.
