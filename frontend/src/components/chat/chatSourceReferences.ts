import { fetchWithAuth } from "../../api/core";
import { fetchDocumentFile } from "../../api/documentsApi";
import { fetchComplianceDocFileBlob } from "../../api/complianceApi";
import type { ChatContextReferenceDto } from "../../types/chat";

export type ChatDocumentOpenTarget =
  | {
      kind: "document";
      documentId: string;
    }
  | {
      kind: "legacy_manual";
      shipId: string;
      manualId: string;
    }
  | {
      /**
       * A certificate in the compliance register. Its file is served by the
       * compliance endpoint, not the documents one, which is why the chat
       * could show these as sources and open none of them.
       */
      kind: "compliance_doc";
      shipId: string;
      recordId: string;
    };


export function isHttpUrl(value?: string): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function normalizedField(
  citation: ChatContextReferenceDto,
  field: string,
): string {
  const value = (citation as unknown as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isMetricSourceReference(
  citation?: ChatContextReferenceDto,
): citation is ChatContextReferenceDto {
  if (!citation) {
    return false;
  }

  const sourceType = normalizedField(citation, "sourceType");
  const type = normalizedField(citation, "type");
  const kind = normalizedField(citation, "kind");
  if ([sourceType, type, kind].some((value) => value === "metric")) {
    return true;
  }

  // Metric references are emitted with id "metric-0", "metric-1", … — keep
  // them out of Sources even if the type tag is missing (older messages).
  const id = normalizedField(citation, "id");
  if (/^metric[-:]/.test(id)) {
    return true;
  }

  if (
    sourceType === "document" ||
    sourceType === "web" ||
    sourceType === "legacy_manual" ||
    citation.documentId ||
    citation.shipManualId ||
    isHttpUrl(citation.sourceUrl)
  ) {
    return false;
  }

  const classificationFields = [
    "category",
    "categoryKey",
    "source",
    "sourceCategory",
    "namespace",
  ];
  const hasTelemetryClassification = classificationFields.some((field) => {
    const value = normalizedField(citation, field);
    return (
      value === "metric" ||
      value === "telemetry" ||
      value === "trending" ||
      value.startsWith("metric:") ||
      value.startsWith("telemetry:") ||
      value.startsWith("trending:")
    );
  });
  if (hasTelemetryClassification) {
    return true;
  }

  const structuralFields = [
    "id",
    "sourceTitle",
    "sourceUrl",
    "snippet",
    "path",
    "text",
    "referenceText",
    "key",
  ];
  return structuralFields.some((field) =>
    normalizedField(citation, field).includes("trending::"),
  );
}

export function isDisplayableChatSourceReference(
  citation?: ChatContextReferenceDto,
): citation is ChatContextReferenceDto {
  return Boolean(citation) && !isMetricSourceReference(citation);
}

export function getChatDocumentOpenTarget(
  citation?: ChatContextReferenceDto,
): ChatDocumentOpenTarget | null {
  if (!citation) {
    return null;
  }

  const documentId = citation.documentId?.trim();
  if (
    (citation.sourceType === "document" || citation.sourceType === "figure") &&
    documentId
  ) {
    return {
      kind: "document",
      documentId,
    };
  }

  const shipId = citation.shipId?.trim();
  const manualId = citation.shipManualId?.trim();
  if (shipId && manualId) {
    return {
      kind: "legacy_manual",
      shipId,
      manualId,
    };
  }

  // A certificate is openable only when a paper is actually attached to the
  // record. hasFile comes from the responder; older messages predate it, and
  // for those the record id alone is enough to try.
  const record = citation.recordId?.trim();
  if (
    getChatSourceKind(citation) === "certificate" &&
    shipId &&
    record &&
    citation.hasFile !== false
  ) {
    return {
      kind: "compliance_doc",
      shipId,
      recordId: record,
    };
  }

  return null;
}

export function getChatSourceGroupKey(citation: ChatContextReferenceDto): string {
  const openTarget = getChatDocumentOpenTarget(citation);

  if (openTarget?.kind === "document") {
    return `document:${openTarget.documentId}`;
  }

  if (openTarget?.kind === "legacy_manual") {
    return `legacy_manual:${openTarget.shipId}:${openTarget.manualId}`;
  }

  return (
    citation.sourceUrl?.trim() || citation.sourceTitle?.trim() || "Unknown"
  );
}

/**
 * Save the cited file instead of viewing it.
 *
 * A form is not read, it is filled in and signed, so the answer that names one
 * has to be able to hand over the sheet itself. Same fetch as opening it — the
 * file endpoint wants the token — but delivered as a download.
 */
export async function downloadChatDocumentSource(
  target: ChatDocumentOpenTarget,
  token: string | null | undefined,
  fileName?: string,
): Promise<boolean> {
  if (!token || target.kind !== "document") {
    return false;
  }
  try {
    const blob = await fetchDocumentFile(token, target.documentId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName?.trim() || "document";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser the tick it needs to start the save before the blob goes.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function openChatDocumentSource(
  target: ChatDocumentOpenTarget,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) {
    return false;
  }

  const openedWindow = window.open("about:blank", "_blank");
  if (!openedWindow) {
    return false;
  }

  openedWindow.opener = null;

  try {
    const blob =
      target.kind === "document"
        ? await fetchDocumentFile(token, target.documentId)
        : target.kind === "compliance_doc"
          ? await fetchComplianceDocFileBlob(token, target.shipId, target.recordId)
          : await fetchLegacyManualFile(token, target.shipId, target.manualId);
    const url = URL.createObjectURL(blob);
    openedWindow.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    openedWindow.close();
    return false;
  }
}

async function fetchLegacyManualFile(
  token: string,
  shipId: string,
  manualId: string,
): Promise<Blob> {
  const response = await fetchWithAuth(
    `ships/${shipId}/manuals/${manualId}/download`,
    { token },
  );

  if (!response.ok) {
    throw new Error("Download failed");
  }

  return response.blob();
}

/**
 * What KIND of source this is, for the badge and for grouping.
 *
 * A crew member reading an answer wants to know whether it came from the
 * vessel's own paperwork or from the open web before they act on it — the
 * answer currently has to say so in prose, which the model sometimes forgets.
 */
export type ChatSourceKind =
  | "web"
  | "certificate"
  | "document"
  | "figure"
  | "form"
  | "other";

export function getChatSourceKind(
  citation: ChatContextReferenceDto,
): ChatSourceKind {
  const id = normalizedField(citation, "id");
  const sourceType = normalizedField(citation, "sourceType");

  if (sourceType === "compliance_doc" || id.startsWith("compliance-doc")) {
    return "certificate";
  }
  // A rulebook drawing: the answer used its description, the card shows the
  // image itself.
  if (sourceType === "figure" || id.startsWith("figure-")) return "figure";
  if (id.startsWith("form-")) return "form";
  if (isHttpUrl(citation.sourceUrl) || id.startsWith("web-")) return "web";
  if (citation.documentId || citation.shipManualId || sourceType === "document") {
    return "document";
  }
  return "other";
}

export const CHAT_SOURCE_KIND_LABEL: Record<ChatSourceKind, string> = {
  web: "Web",
  certificate: "Certificate",
  document: "Ship document",
  figure: "Figure",
  form: "Form",
  other: "Source",
};

/**
 * Find the source a [N] marker in the answer points at.
 *
 * The number is the evidence item's own index in the retrieval batch, carried
 * in its id — "document-7", "web-source-2". The panel list is a FILTERED view
 * of that batch, so position and number stop matching as soon as anything is
 * dropped: an answer citing [7] with four cards left had its marker resolve to
 * citations[6], find nothing, and vanish from the text mid-sentence
 * (2026-07-30). Match on the id first, fall back to position for older
 * messages whose ids carry no number.
 */
export function findCitationByMarker(
  citations: ChatContextReferenceDto[],
  marker: number,
): ChatContextReferenceDto | undefined {
  const byId = citations.find((citation) => {
    const id = typeof citation.id === "string" ? citation.id.trim() : "";
    return /-(\d+)$/.exec(id)?.[1] === String(marker);
  });
  return byId ?? citations[marker - 1];
}
