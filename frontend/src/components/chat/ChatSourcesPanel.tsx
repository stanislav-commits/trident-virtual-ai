import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { fetchDocumentFile } from "../../api/documentsApi";
import { fetchComplianceDocFileBlob } from "../../api/complianceApi";
import type { ChatContextReferenceDto } from "../../types/chat";
import {
  getChatDocumentOpenTarget,
  isDisplayableChatSourceReference,
} from "./chatSourceReferences";
import { SourceCitations } from "./SourceCitations";

interface ChatSourcesPanelProps {
  citations: ChatContextReferenceDto[];
  onClose: () => void;
}

interface OpenDocument {
  title: string;
  page: number | null;
  objectUrl: string;
  src: string;
}

export function ChatSourcesPanel({
  citations,
  onClose,
}: ChatSourcesPanelProps) {
  const { token } = useAuth();
  const displayableCitations = citations.filter(isDisplayableChatSourceReference);
  const groupedSourceCount = new Set(
    displayableCitations.map(
      (citation) =>
        citation.sourceUrl?.trim() || citation.sourceTitle?.trim() || "Unknown",
    ),
  ).size;

  /**
   * The cited document, read inside the panel instead of in a new browser tab.
   *
   * The panel already knows which file the answer came from and which page, so
   * sending someone to a blank tab to find page 23 themselves was work the app
   * could do for them. The browser's own PDF viewer honours #page=N, which is
   * why the blob URL carries the fragment.
   */
  const [openDoc, setOpenDoc] = useState<OpenDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Revoked when the viewer closes or the panel unmounts — not per render.
  // A tab opened from this URL keeps working while the panel is open, which is
  // what "open in a new tab" is for: printing, saving, reading it full-width.
  useEffect(
    () => () => {
      if (openDoc) URL.revokeObjectURL(openDoc.objectUrl);
    },
    [openDoc],
  );

  const handleOpenDocument = useCallback(
    async (citation: ChatContextReferenceDto): Promise<boolean> => {
      const target = getChatDocumentOpenTarget(citation);
      // Legacy manuals still open in a tab: they are served by a different
      // endpoint and are rare enough not to be worth a second code path here.
      if (
        !target ||
        (target.kind !== "document" && target.kind !== "compliance_doc") ||
        !token
      ) {
        return false;
      }

      setLoading(true);
      setLoadError(null);
      try {
        const blob =
          target.kind === "document"
            ? await fetchDocumentFile(token, target.documentId)
            : await fetchComplianceDocFileBlob(
                token,
                target.shipId,
                target.recordId,
              );
        // Force the pdf type: a generic blob type makes the viewer offer a
        // download instead of rendering the file.
        const typed = /\.pdf$/i.test(citation.sourceTitle ?? "")
          ? new Blob([blob], { type: "application/pdf" })
          : blob;
        const objectUrl = URL.createObjectURL(typed);
        const page = citation.pageNumber ?? null;
        setOpenDoc({
          title: citation.sourceTitle?.trim() || "Document",
          page,
          objectUrl,
          src: page ? `${objectUrl}#page=${page}` : objectUrl,
        });
        return true;
      } catch {
        setLoadError("Could not open this document.");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  const closeViewer = useCallback(() => {
    setOpenDoc(null);
    setLoadError(null);
  }, []);

  return (
    <aside className="chat-sources-panel" aria-label="All sources">
      <div className="chat-sources-panel__header">
        <div className="chat-sources-panel__titles">
          <div className="chat-sources-panel__eyebrow">Sources</div>
          <h2 className="chat-sources-panel__title">
            {openDoc ? openDoc.title : "All References"}
          </h2>
          <p className="chat-sources-panel__subtitle">
            {openDoc
              ? openDoc.page
                ? `Page ${openDoc.page}`
                : "Full document"
              : `${groupedSourceCount} source${groupedSourceCount === 1 ? "" : "s"} for this answer`}
          </p>
        </div>
        <div className="chat-sources-panel__header-actions">
          {openDoc && (
            <button
              type="button"
              className="chat-sources-panel__close"
              onClick={() => window.open(openDoc.src, "_blank", "noopener")}
              aria-label="Open in a new tab"
              title="Open in a new tab — to print or save it"
            >
              ↗
            </button>
          )}
          <button
            type="button"
            className="chat-sources-panel__close"
            onClick={openDoc ? closeViewer : onClose}
            aria-label={openDoc ? "Back to sources" : "Close sources panel"}
            title={openDoc ? "Back to sources" : undefined}
          >
            {openDoc ? "‹" : "×"}
          </button>
        </div>
      </div>

      <div className="chat-sources-panel__body">
        {openDoc ? (
          <iframe
            className="chat-sources-panel__viewer"
            src={openDoc.src}
            title={openDoc.title}
          />
        ) : (
          <>
            {loading && (
              <p className="chat-sources-panel__note">Opening document…</p>
            )}
            {loadError && (
              <p className="chat-sources-panel__note chat-sources-panel__note--error">
                {loadError}
              </p>
            )}
            <SourceCitations
              citations={displayableCitations}
              mode="panel"
              onOpenDocument={handleOpenDocument}
            />
          </>
        )}
      </div>
    </aside>
  );
}
