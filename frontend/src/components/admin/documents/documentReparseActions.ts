import type { DocumentListItem, DocumentParseStatus } from "../../../api/documentsApi";

interface DocumentReparseAction {
  ariaLabel: string;
  confirmLabel: string;
  modalBody: string;
  modalTitle: string;
  title: string;
}

const ACTIVE_PARSE_STATUSES = new Set<DocumentParseStatus>([
  "uploaded",
  "pending_config",
  "pending_parse",
  "parsing",
]);

export function getDocumentReparseAction(
  document: DocumentListItem,
): DocumentReparseAction | null {
  if (ACTIVE_PARSE_STATUSES.has(document.parseStatus)) {
    return null;
  }

  if (document.parseStatus === "failed") {
    return {
      ariaLabel: `Retry parsing ${document.originalFileName}`,
      confirmLabel: "Retry parsing",
      modalBody: "This document failed during parsing. Retry parsing now?",
      modalTitle: "Retry parsing?",
      title: "Retry parsing",
    };
  }

  if (document.parseStatus === "parsed") {
    return {
      ariaLabel: `Reparse ${document.originalFileName}`,
      confirmLabel: "Reparse document",
      modalBody:
        "This document is already parsed. Reparse will rebuild its indexed chunks. Continue?",
      modalTitle: "Reparse document?",
      title: "Reparse document",
    };
  }

  if (document.parseStatus === "reparse_required") {
    return {
      ariaLabel: `Start reparse for ${document.originalFileName}`,
      confirmLabel: "Start reparse",
      modalBody: "This document is marked for reparse. Start reparsing now?",
      modalTitle: "Start reparse?",
      title: "Start reparse",
    };
  }

  return null;
}
