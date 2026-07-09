export enum DocumentDocClass {
  // ── Knowledge Base (per-ship) ──
  PROCEDURE = 'procedure', // SMS procedures, SOPs
  MANUAL = 'manual', // equipment manuals only
  FORM = 'form', // forms & checklists (templates)
  PLAN = 'plan', // vessel plans & drawings (file store, no deep parse)
  // ── Platform (fleet-wide) ──
  PUBLICATION = 'publication', // MARPOL / IMO / rules & regulations

  // ── Legacy — retired in Phase 1b; no new docs are created with these.
  // Kept so existing chat-retrieval code compiles until it's cleaned up.
  HISTORICAL_PROCEDURE = 'historical_procedure',
  CERTIFICATE = 'certificate',
  REGULATION = 'regulation',
}

/** Classes a user can pick today (legacy ones are hidden). */
export const ACTIVE_DOC_CLASSES: DocumentDocClass[] = [
  DocumentDocClass.PROCEDURE,
  DocumentDocClass.MANUAL,
  DocumentDocClass.FORM,
  DocumentDocClass.PLAN,
  DocumentDocClass.PUBLICATION,
];

/** Knowledge Base sections (per-ship). Publications live under Platform. */
export const KNOWLEDGE_BASE_CLASSES: DocumentDocClass[] = [
  DocumentDocClass.PROCEDURE,
  DocumentDocClass.MANUAL,
  DocumentDocClass.FORM,
  DocumentDocClass.PLAN,
];
