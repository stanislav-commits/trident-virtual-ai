export enum DocumentDocClass {
  // ── Knowledge Base (per-ship) ──
  PROCEDURE = 'procedure', // SMS procedures, SOPs
  MANUAL = 'manual', // equipment manuals only
  FORM = 'form', // forms & checklists (templates)
  CIRCULAR = 'circular', // fleet circulars / management-company notices
  PLAN = 'plan', // vessel plans & drawings (file store, no deep parse)
  // ── Asset Documents ──
  /**
   * Manufacturer approval of an equipment TYPE — MED Module B/D, EC type
   * examination, ATEX, a declaration of conformity. It approves a model, not
   * the unit fitted aboard, so it belongs against the asset rather than in the
   * vessel's certificate register (v60: TYPE_APPROVAL "belongs primarily to the
   * equipment type, not the vessel certificate set"). Never expires.
   *
   * A file store like PLAN: nobody full-text searches a type approval, they
   * open it from the asset. See isFileStoreClass().
   */
  TYPE_APPROVAL = 'type_approval',
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
  DocumentDocClass.CIRCULAR,
  DocumentDocClass.PLAN,
  DocumentDocClass.TYPE_APPROVAL,
  DocumentDocClass.PUBLICATION,
];

/** Knowledge Base sections (per-ship). Publications live under Platform. */
export const KNOWLEDGE_BASE_CLASSES: DocumentDocClass[] = [
  DocumentDocClass.PROCEDURE,
  DocumentDocClass.MANUAL,
  DocumentDocClass.FORM,
  DocumentDocClass.CIRCULAR,
  DocumentDocClass.PLAN,
];

/**
 * Classes stored as files and never sent to RAGFlow or the vision extractor:
 * drawings are opened on demand and type approvals are opened from the asset,
 * so their OCR soup would only pollute retrieval.
 */
export function isFileStoreClass(
  docClass: string | null | undefined,
): boolean {
  return (
    docClass === DocumentDocClass.PLAN ||
    docClass === DocumentDocClass.TYPE_APPROVAL
  );
}

/** The file-store classes, for `Not(In(...))` filters. */
export const FILE_STORE_CLASSES: DocumentDocClass[] = [
  DocumentDocClass.PLAN,
  DocumentDocClass.TYPE_APPROVAL,
];
