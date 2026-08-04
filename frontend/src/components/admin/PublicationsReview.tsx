import { useCallback, useEffect, useState } from "react";
import {
  acceptPublicationText,
  fetchPublicationReviewQueue,
  parsePublicationNode,
  type PublicationNodeContent,
} from "../../api/publicationTreeApi";
import { fetchDocumentFile } from "../../api/documentsApi";

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

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await fetchPublicationReviewQueue(token, 50, 0);
      setQueue(result.nodes);
      setTotal(result.total);
      setCurrent((previous) =>
        previous && result.nodes.some((n) => n.id === previous.id)
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

  /**
   * The queue refills itself. Accepting a row removes it, and a page of fifty
   * empties in a few minutes of real work; asking the operator to press
   * Refresh in the middle of that is asking them to remember the machinery.
   */
  useEffect(() => {
    if (loading || queue.length > 5 || queue.length >= total) return;
    void load();
  }, [queue.length, total, loading, load]);

  // The file endpoint wants the bearer token, so the frame reads a blob.
  useEffect(() => {
    if (!current?.documentId || !token) {
      setOriginalUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    void fetchDocumentFile(token, current.documentId)
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
  }, [current?.documentId, token]);

  const index = current ? queue.findIndex((node) => node.id === current.id) : -1;

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
            {index >= 0 ? `${index + 1} / ${queue.length}` : "—"}
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

      {/* Where this row lives, spelled out: at a third of the screen the pane
          head could only show its first few words, and half the queue is
          called "continued (3 of 4)". */}
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
              <span className="publib__count">{node.textQuality ?? 0}</span>
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
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  title="Read the file again with AI vision"
                  onClick={() => void reparse()}
                >
                  Re-parse
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={busy}
                  title="The text is good enough as it stands"
                  onClick={() => void accept()}
                >
                  Accept
                </button>
              </span>
            )}
          </div>
          <pre className="publib__preview-text">{current?.text ?? ""}</pre>
        </div>

        <aside className="publib__preview">
          <div className="publib__preview-head">
            <span className="publib__preview-title">
              {current?.fileName ?? "Original"}
            </span>
          </div>
          {originalUrl ? (
            <iframe
              className="publib__preview-frame"
              title="Original document"
              src={originalUrl}
            />
          ) : (
            <p className="publib__preview-note">
              {current?.sourceRef
                ? `No original uploaded. The import brought the text only; the source file is ${current.sourceRef}.`
                : "No original to compare against."}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
