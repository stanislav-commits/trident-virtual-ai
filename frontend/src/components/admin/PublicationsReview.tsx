import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptPublicationText,
  deletePublicationNode,
  fetchPublicationReviewQueue,
  parsePublicationNode,
  savePublicationText,
  type PublicationNodeContent,
} from "../../api/publicationTreeApi";
import { fetchDocumentFile } from "../../api/documentsApi";

/**
 * The browser's own PDF viewer, with its furniture turned off: no toolbar, no
 * thumbnail rail, fitted to the width. What is wanted here is to flick through
 * the pages and move on — zoom, rotate, print and download belong to the file,
 * and the file has its own download button in the header.
 */
const PDF_VIEW = "#toolbar=0&navpanes=0&scrollbar=0&view=FitH";

/**
 * The review queue: rows whose extracted text the quality score doubts, with
 * the text on the left and the original on the right.
 *
 * Checking 38 000 nodes by opening them one at a time is not a job anybody will
 * do, which is why the originals were being kept "just in case" — the case
 * never came. The score flags roughly six hundred rows; those are checkable in
 * an afternoon, and once a row leaves the queue its original has nothing left
 * to prove and can go.
 *
 * A row leaves by a decision, never by a timer: accepted as it stands, or sent
 * back to vision to be read again.
 */
export function PublicationsReview({
  token,
  onBack,
}: {
  token: string | null;
  onBack?: () => void;
}) {
  const [queue, setQueue] = useState<PublicationNodeContent[]>([]);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState<PublicationNodeContent | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Deleting is armed by the first press and done by the second. A dialog in
   *  the middle of a queue read with the arrow keys costs more than it saves,
   *  and a row removed by accident cannot be brought back. */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  /** The text as it is being corrected; null while it is only being read. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The loader reads the current length without depending on it — a dependency
   *  there would rebuild the callback on every row that leaves the queue. */
  const queueRef = useRef<PublicationNodeContent[]>([]);
  queueRef.current = queue;

  const load = useCallback(async (append = false) => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await fetchPublicationReviewQueue(
        token,
        50,
        append ? queueRef.current.length : 0,
      );
      setQueue((rows) => {
        if (!append) return result.nodes;
        const known = new Set(rows.map((r) => r.id));
        return [...rows, ...result.nodes.filter((n) => !known.has(n.id))];
      });
      setTotal(result.total);
      setCurrent((previous) =>
        previous && (append || result.nodes.some((n) => n.id === previous.id))
          ? previous
          : (result.nodes[0] ?? null),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The file endpoint wants the bearer token, so the frame reads a blob.
  const originalId = current?.originalDocumentId ?? current?.documentId ?? null;
  useEffect(() => {
    if (!originalId || !token) {
      setOriginalUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    void fetchDocumentFile(token, originalId)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setOriginalUrl(url);
      })
      .catch(() => setOriginalUrl(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [originalId, token]);

  const index = current ? queue.findIndex((node) => node.id === current.id) : -1;

  useEffect(() => {
    setArmedDelete(null);
    setDraft(null);
  }, [current?.id]);

  /**
   * The window grows as it is walked. Fifty rows out of fourteen hundred read
   * as "there are only fifty", and stopping at the end of a page to press
   * something is the interruption this screen exists to avoid.
   */
  useEffect(() => {
    if (loading || queue.length >= total) return;
    const nearEnd = index >= 0 && index >= queue.length - 10;
    if (nearEnd || queue.length <= 5) void load(true);
  }, [index, queue.length, total, loading, load]);

  /**
   * Arrow keys walk the queue. Six hundred rows are checked by reading and
   * pressing a key, not by aiming at a list with a mouse; the keys are ignored
   * while typing so a search box elsewhere still works.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
      if (!back && !forward) return;
      event.preventDefault();
      setCurrent((node) => {
        const at = node ? queue.findIndex((row) => row.id === node.id) : -1;
        const next = at + (forward ? 1 : -1);
        return queue[next] ?? node;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue]);

  const step = useCallback(
    (id: string) => {
      const index = queue.findIndex((node) => node.id === id);
      const next = queue[index + 1] ?? queue[index - 1] ?? null;
      setQueue((rows) => rows.filter((row) => row.id !== id));
      setTotal((count) => Math.max(0, count - 1));
      setCurrent(next);
    },
    [queue],
  );

  const accept = async () => {
    if (!token || !current) return;
    setBusy(true);
    try {
      await acceptPublicationText(token, current.id);
      step(current.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not accept the text");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!token || !current || draft === null) return;
    setBusy(true);
    try {
      await savePublicationText(token, current.id, draft);
      setDraft(null);
      step(current.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the text");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!token || !current) return;
    if (armedDelete !== current.id) {
      setArmedDelete(current.id);
      return;
    }
    setBusy(true);
    try {
      await deletePublicationNode(token, current.id);
      setArmedDelete(null);
      step(current.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not delete the row");
    } finally {
      setBusy(false);
    }
  };

  const reparse = async () => {
    if (!token || !current) return;
    setBusy(true);
    try {
      const result = await parsePublicationNode(token, current.id);
      if (!result.queued) {
        setError(result.skipped.join("; ") || "Nothing to read here");
      } else {
        step(current.id);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not queue the parse");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel__section admin-panel__section--publib">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Text review</h2>
          <p className="admin-panel__section-subtitle">
            {total} row{total === 1 ? "" : "s"} whose extracted text scored below
            the floor. Read the text against the original, then accept it or
            send it back to vision.
          </p>
        </div>
        <div className="publib__head-actions">
          <span className="publib__review-position">
            {index >= 0 ? `${index + 1} / ${total}` : "—"}
          </span>
          {onBack && (
            <button
              type="button"
              className="admin-panel__btn publib__preview-btn"
              title="Back to the library"
              aria-label="Back to the library"
              onClick={onBack}
            >
              {"\u2192"}
            </button>
          )}
        </div>
      </div>
      {error && <div className="admin-panel__error">{error}</div>}

      {/* Where this row lives, spelled out in full: half the queue is called
          "continued (3 of 4)" or "Section 1 General", and the collapsed middle
          of the trail turned out to be the part that told them apart. The row
          wraps to as many lines as the path needs. */}
      {current && (
        <nav className="publib__review-where" aria-label="Location">
          {[...(current.path ?? []), current.title].map((crumb, i, all) => (
            <span key={`${crumb}-${i}`}>
              <span
                className={
                  i === all.length - 1
                    ? "publib__review-crumb publib__review-crumb--last"
                    : "publib__review-crumb"
                }
              >
                {crumb}
              </span>
              {i < all.length - 1 && (
                <span className="publib__review-sep">{"\u203a"}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="publib publib--review">
        <aside className="publib__rail">
          {queue.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`publib__review-row${
                current?.id === node.id ? " is-active" : ""
              }`}
              onClick={() => setCurrent(node)}
            >
              <span className="publib__review-row-title">
                {[node.number, node.title].filter(Boolean).join(" ")}
              </span>
              <span className="publib__count">
                {node.text?.trim() ? (node.textQuality ?? 0) : "photo"}
              </span>
            </button>
          ))}
          {!queue.length && !loading && (
            <p className="publib__hint">Nothing left to check.</p>
          )}
        </aside>

        <div className="publib__pane">
          <div className="publib__pane-head">
            <span>{current ? "Extracted text" : "Pick a row"}</span>
            {current && (
              <span className="publib__review-actions">
                {/* Vision reads a file, and a section imported as text has
                    none of its own — it borrows the book's. Re-reading that
                    book would replace this row with the whole document, so the
                    button says why it is closed rather than failing on press. */}
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy || !current.documentId}
                  title={
                    current.documentId
                      ? "Read the file again with AI vision"
                      : current.originalFileName
                        ? `No file of its own — the text came from ${current.originalFileName}, ` +
                          "and vision reads whole documents. Accept it or delete it."
                        : "No file to read: this row was imported as text."
                  }
                  onClick={() => void reparse()}
                >
                  Re-parse
                </button>
                <button
                  type="button"
                  className={`admin-panel__btn${
                    armedDelete === current.id ? " admin-panel__btn--danger" : ""
                  }`}
                  disabled={busy}
                  title={
                    armedDelete === current.id
                      ? "Press again to remove this row from the library"
                      : "Remove this row from the library"
                  }
                  onClick={() => void remove()}
                >
                  {armedDelete === current.id ? "Delete — sure?" : "Delete"}
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={busy}
                  title={
                    draft === null
                      ? "The text is good enough as it stands"
                      : "Save the corrected text and move on"
                  }
                  onClick={() => void (draft === null ? accept() : save())}
                >
                  {draft === null ? "Accept" : "Save"}
                </button>
              </span>
            )}
          </div>
          {current && !current.text?.trim() && draft === null ? (
            <p className="publib__hint">
              No text at all — this row is a photograph or a scan. Vision has to
              read it before there is anything to check.
            </p>
          ) : (
            /* Editable in place: a row whose file cannot be re-read, but whose
               rule is needed, is fixed by hand or not at all. */
            <textarea
              className="publib__review-text"
              spellCheck={false}
              /* The stored text often opens with a run of blank lines from the
                 page's own margin; showing them puts the content below the
                 fold of a pane that looks empty until you scroll. */
              value={draft ?? (current?.text ?? "").replace(/^\s*\n/, "")}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>

        <aside className="publib__preview">
          <div className="publib__preview-head">
            <span className="publib__preview-title">
              {current?.originalFileName ?? current?.fileName ?? "Original"}
              {current?.originalIsInherited ? " · the whole document" : ""}
            </span>
          </div>
          {originalUrl ? (
            /* Keyed on the document: the browser's PDF viewer holds the file
               it opened and ignores a new src, so switching rows left the
               previous document on screen. A new key is a new element. */
            <iframe
              key={originalId ?? "none"}
              className="publib__preview-frame"
              title="Original document"
              src={`${originalUrl}${PDF_VIEW}`}
            />
          ) : (
            <p className="publib__preview-note">
              {current?.sourceRef
                ? `No original on the platform. The import brought the text only; it came from ${current.sourceRef}.`
                : "No original to compare against."}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
