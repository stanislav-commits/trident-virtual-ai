import { fetchWithAuth } from "../../api/core";
import { fetchDocumentFile } from "../../api/documentsApi";
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
  if (citation.sourceType === "document" && documentId) {
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
  form: "Form",
  other: "Source",
};
