import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { fetchDocumentFile } from "../../api/documentsApi";
import type { ChatContextReferenceDto } from "../../types/chat";
import {
  getChatDocumentOpenTarget,
  openChatDocumentSource,
} from "./chatSourceReferences";

/**
 * A cited rulebook drawing, shown in the answer itself.
 *
 * The answer paraphrases the figure's vision-written description; the reader
 * should see the drawing being paraphrased where they are reading, not behind
 * a sources panel. Sits under the answer text like a chart block — the image
 * with its rule reference as the caption, click for full size.
 */
export function ChatFigureBlock({
  citation,
}: {
  citation: ChatContextReferenceDto;
}) {
  const { token } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const documentId = citation.documentId?.trim();
  const title = citation.sourceTitle?.trim() || "Figure";

  useEffect(() => {
    if (!token || !documentId) return;
    let alive = true;
    let objectUrl: string | null = null;
    fetchDocumentFile(token, documentId)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl);
      })
      .catch(() => {
        // No image, no block — the answer stands on its own.
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, documentId]);

  if (!url) return null;

  const handleOpen = () => {
    const target = getChatDocumentOpenTarget(citation);
    if (target) void openChatDocumentSource(target, token);
  };

  return (
    <figure className="chat-figure">
      <button
        type="button"
        className="chat-figure__frame"
        onClick={handleOpen}
        title="Open full size"
        aria-label={`Open figure: ${title}`}
      >
        <img className="chat-figure__image" src={url} alt={title} />
      </button>
      <figcaption className="chat-figure__caption">{title}</figcaption>
    </figure>
  );
}
