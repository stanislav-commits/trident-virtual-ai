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
