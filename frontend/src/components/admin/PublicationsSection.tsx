import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicationCatalogItem } from "../../api/documentsApi";
import {
  appendPublicationCatalogSection,
  attachPublicationCatalogFile,
  createPublicationCatalogItem,
  detachPublicationCatalogFile,
  fetchDocumentFile,
  listPublicationCatalog,
} from "../../api/documentsApi";
import { Toast } from "../layout/Toast";
import { DocumentsIcon } from "./AdminPanelIcons";
import { useAdminEvents } from "../../hooks/admin/adminEvents";

const PUBLICATION_UPLOAD_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.md,.txt";
const EMPTY_CATALOG: PublicationCatalogItem[] = [];

interface PublicationsFeedback {
  message: string;
  type: "success" | "error" | "info";
}

interface PublicationsSectionProps {
  token: string | null;
}

export function PublicationsSection({ token }: PublicationsSectionProps) {
  const [catalog, setCatalog] = useState<PublicationCatalogItem[]>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<PublicationsFeedback | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addNote, setAddNote] = useState("");
  const [creating, setCreating] = useState(false);
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({});
  const [query, setQuery] = useState("");
  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set());
  // "Add article" modal — append a section to a merged markdown publication
  const [appendItem, setAppendItem] = useState<PublicationCatalogItem | null>(null);
  const [appendHeading, setAppendHeading] = useState("");
  const [appendFile, setAppendFile] = useState<File | null>(null);
  const [appending, setAppending] = useState(false);

  const submitAppend = async () => {
    if (!token || !appendItem || !appendFile || !appendHeading.trim()) return;
    setAppending(true);
    try {
      await appendPublicationCatalogSection(
        token,
        appendItem.id,
        appendHeading.trim(),
        appendFile,
      );
      setFeedback({
        message: `Article added to "${appendItem.title}" — re-parsing.`,
        type: "success",
      });
      setAppendItem(null);
      setAppendHeading("");
      setAppendFile(null);
      void loadCatalog();
    } catch (e) {
      setFeedback({
        message: e instanceof Error ? e.message : "Failed to append the article",
        type: "error",
      });
    } finally {
      setAppending(false);
    }
  };

  const loadCatalog = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const items = await listPublicationCatalog(token);
      setCatalog(items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load publications catalog.",
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Live-sync: publications are fleet-wide (no ship filter) — any admin's
  // change re-loads the catalog.
  useAdminEvents("publications", () => {
    void loadCatalog();
  });

  const handleView = async (item: PublicationCatalogItem) => {
    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    if (!item.documentId) {
      setFeedback({
        type: "error",
        message: "This publication has no file to view.",
      });
      return;
    }

    const openedWindow = window.open("about:blank", "_blank");

    if (!openedWindow) {
      setFeedback({
        type: "error",
        message: "The browser blocked the publication tab.",
      });
      return;
    }

    openedWindow.opener = null;
    setOpeningId(item.id);

    try {
      const fileBlob = await fetchDocumentFile(token, item.documentId);
      const fileUrl = URL.createObjectURL(fileBlob);
      openedWindow.location.href = fileUrl;
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 60000);
    } catch (viewError) {
      openedWindow.close();
      setFeedback({
        type: "error",
        message:
          viewError instanceof Error
            ? viewError.message
            : "Failed to open publication.",
      });
    } finally {
      setOpeningId(null);
    }
  };

  const handleFileSelected = async (
    item: PublicationCatalogItem,
    file: File | null,
  ) => {
    if (!file) {
      return;
    }

    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    setUploadingId(item.id);
    setFeedback(null);

    try {
      await attachPublicationCatalogFile(token, item.id, file);
      setFeedback({ type: "success", message: `Uploaded "${item.title}".` });
      await loadCatalog();
    } catch (uploadError) {
      setFeedback({
        type: "error",
        message:
          uploadError instanceof Error
            ? uploadError.message
            : "Failed to upload publication.",
      });
    } finally {
      setUploadingId(null);
      const input = fileInputsRef.current[item.id];
      if (input) {
        input.value = "";
      }
    }
  };

  const handleRemove = async (item: PublicationCatalogItem) => {
    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    if (
      !window.confirm(
        `Remove the file for "${item.title}"? This cannot be undone.`,
      )
    ) {
      return;
    }

    setRemovingId(item.id);
    setFeedback(null);
    // Optimistic: the row shows "no file" instantly; reconcile in the
    // background, roll back on failure.
    const prev = catalog;
    setCatalog((rows) =>
      rows.map((r) =>
        r.id === item.id
          ? { ...r, documentId: null, fileName: null, parseStatus: null }
          : r,
      ),
    );

    try {
      await detachPublicationCatalogFile(token, item.id);
      setFeedback({ type: "success", message: `Removed file from "${item.title}".` });
      void loadCatalog();
    } catch (removeError) {
      setCatalog(prev);
      setFeedback({
        type: "error",
        message:
          removeError instanceof Error
            ? removeError.message
            : "Failed to remove publication file.",
      });
    } finally {
      setRemovingId(null);
    }
  };

  const closeAddForm = () => {
    if (creating) {
      return;
    }
    setShowAddForm(false);
    setAddTitle("");
    setAddNote("");
  };

  const handleCreate = async () => {
    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    const title = addTitle.trim();
    if (!title) {
      setFeedback({ type: "error", message: "Publication title is required." });
      return;
    }

    setCreating(true);
    setFeedback(null);

    try {
      await createPublicationCatalogItem(token, {
        title,
        conditionalNote: addNote.trim() || null,
      });
      setFeedback({ type: "success", message: `Added "${title}".` });
      setShowAddForm(false);
      setAddTitle("");
      setAddNote("");
      await loadCatalog();
    } catch (createError) {
      setFeedback({
        type: "error",
        message:
          createError instanceof Error
            ? createError.message
            : "Failed to add publication.",
      });
    } finally {
      setCreating(false);
    }
  };

  const uploadedCount = catalog.filter((item) => Boolean(item.fileName)).length;

  // ── Category tree. The Regs4Ships load grows the catalog from 32 slots to
  //    ~1 100 documents — a flat table stops being scannable, so rows group
  //    by category (hand-made slots land in "General") behind a search box.
  //    Searching expands everything that matches; otherwise groups toggle. ──
  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = normalizedQuery
      ? catalog.filter((item) =>
          [item.title, item.series, item.category, item.fileName, item.contents]
            .filter(Boolean)
            .some((s) => (s as string).toLowerCase().includes(normalizedQuery)),
        )
      : catalog;
    const byCat = new Map<string, PublicationCatalogItem[]>();
    for (const item of filtered) {
      const cat = item.category ?? "General";
      const list = byCat.get(cat) ?? [];
      list.push(item);
      byCat.set(cat, list);
    }
    return [...byCat.entries()].sort(([a], [b]) =>
      a === "General" ? -1 : b === "General" ? 1 : a.localeCompare(b),
    );
  }, [catalog, normalizedQuery]);
  const singleGroup = groups.length === 1;

  const toggleCat = (cat: string) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  return (
    <section className="admin-panel__section">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Publications Library</h2>
          <p className="admin-panel__section-subtitle">
            Fleet-wide catalog of expected publications. Upload one file to each
            slot to make it available to every vessel.
          </p>
        </div>
        <button
          type="button"
          className="admin-panel__btn admin-panel__btn--primary"
          disabled={!token}
          onClick={() => setShowAddForm(true)}
        >
          Add publication
        </button>
      </div>

      {error && (
        <div className="admin-panel__error" role="alert">
          {error}
        </div>
      )}

      {loading && catalog.length === 0 ? (
        <div className="admin-panel__state-box">
          <div className="admin-panel__spinner" />
          <span className="admin-panel__muted">Loading publications...</span>
        </div>
      ) : catalog.length === 0 ? (
        <div className="admin-panel__state-box">
          <DocumentsIcon />
          <span className="admin-panel__muted">
            No publications in the catalog.
          </span>
        </div>
      ) : (
        <div className="admin-panel__card admin-panel__documents-card">
          <div className="admin-panel__metrics-toolbar-strip">
            <div className="admin-panel__metrics-toolbar-left">
              <span className="admin-panel__metrics-count">
                {uploadedCount} of {catalog.length} uploaded ·{" "}
                {groups.length} categor{groups.length === 1 ? "y" : "ies"}
              </span>
              {loading && (
                <span className="admin-panel__muted">Refreshing...</span>
              )}
            </div>
            <input
              className="admin-panel__input publications__search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, series or category…"
            />
          </div>

          <table className="admin-panel__table admin-panel__table--documents">
            <thead>
              <tr>
                <th className="admin-panel__th">Publication</th>
                <th className="admin-panel__th">Status</th>
                <th className="admin-panel__th admin-panel__th--actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(([cat, items]) => {
                const open =
                  Boolean(normalizedQuery) || singleGroup || openCats.has(cat);
                const done = items.filter((i) => Boolean(i.fileName)).length;
                const rows = [
                  <tr
                    className="admin-panel__row publications__cat-row"
                    key={`cat:${cat}`}
                    onClick={() => toggleCat(cat)}
                  >
                    <td className="admin-panel__td" colSpan={3}>
                      <span className="publications__cat-toggle">
                        {open ? "▾" : "▸"}
                      </span>{" "}
                      <strong>{cat}</strong>{" "}
                      <span className="admin-panel__muted">
                        {done}/{items.length}
                        {items[0]?.jurisdiction
                          ? ` · ${items[0].jurisdiction}`
                          : ""}
                      </span>
                    </td>
                  </tr>,
                ];
                if (!open) return rows;
                rows.push(
                  ...items.map((item) => {
                const hasFile = Boolean(item.fileName);
                const isOpening = openingId === item.id;
                const isUploading = uploadingId === item.id;
                const isRemoving = removingId === item.id;
                const busy = isUploading || isRemoving;

                return (
                  <tr className="admin-panel__row" key={item.id}>
                    <td className="admin-panel__td admin-panel__td--name">
                      <span className="admin-panel__publication-title">
                        {item.title}
                        {item.conditionalNote && (
                          <span className="admin-panel__badge admin-panel__badge--manual-cancel">
                            {item.conditionalNote}
                          </span>
                        )}
                      </span>
                      {hasFile && item.fileName && (
                        <span className="admin-panel__inline-meta">
                          {item.fileName}
                        </span>
                      )}
                    </td>
                    <td className="admin-panel__td">
                      <span
                        className={`admin-panel__badge ${
                          hasFile
                            ? "admin-panel__badge--manual-done"
                            : "admin-panel__badge--manual-cancel"
                        }`}
                      >
                        {hasFile ? "Uploaded" : "Missing"}
                      </span>
                    </td>
                    <td className="admin-panel__td admin-panel__td--actions">
                      <input
                        ref={(element) => {
                          fileInputsRef.current[item.id] = element;
                        }}
                        type="file"
                        className="admin-panel__file-input"
                        accept={PUBLICATION_UPLOAD_ACCEPT}
                        disabled={busy}
                        onChange={(event) => {
                          const nextFile = event.target.files?.[0] ?? null;
                          void handleFileSelected(item, nextFile);
                        }}
                      />
                      <div className="admin-panel__document-actions publications__actions">
                      {hasFile ? (
                        <>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                            disabled={isOpening || busy}
                            onClick={() => void handleView(item)}
                          >
                            {isOpening ? "Opening..." : "View"}
                          </button>
                          {item.fileName?.toLowerCase().endsWith(".md") && (
                            <button
                              type="button"
                              className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                              disabled={busy}
                              title="Append a new article/section to this publication (PDF, .md or .txt)"
                              onClick={() => {
                                setAppendItem(item);
                                setAppendHeading("");
                                setAppendFile(null);
                              }}
                            >
                              Add article
                            </button>
                          )}
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                            disabled={busy}
                            onClick={() =>
                              fileInputsRef.current[item.id]?.click()
                            }
                          >
                            {isUploading ? "Uploading..." : "Replace"}
                          </button>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                            disabled={busy}
                            onClick={() => void handleRemove(item)}
                          >
                            {isRemoving ? "Removing..." : "Remove"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--compact"
                          disabled={!token || busy}
                          onClick={() => fileInputsRef.current[item.id]?.click()}
                        >
                          {isUploading ? "Uploading..." : "Upload"}
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                );
                  }),
                );
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}

      {appendItem &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !appending && setAppendItem(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">
                Add article — {appendItem.title}
              </h2>
              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Article heading
                  </label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={appendHeading}
                    onChange={(event) => setAppendHeading(event.target.value)}
                    placeholder="e.g. MS Notice No. 197 — …"
                    maxLength={200}
                    autoFocus
                  />
                </div>
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Article file (PDF with text, .md or .txt)
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.md,.txt"
                    onChange={(event) =>
                      setAppendFile(event.target.files?.[0] ?? null)
                    }
                  />
                </div>
                <p className="admin-panel__muted">
                  The section is appended to the end of this publication and
                  the document re-parses — chat picks it up in a few minutes.
                </p>
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={appending}
                  onClick={() => setAppendItem(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={appending || !appendHeading.trim() || !appendFile}
                  onClick={() => void submitAppend()}
                >
                  {appending ? "Appending..." : "Append article"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {showAddForm &&
        createPortal(
          <div className="admin-panel__modal-overlay" onClick={closeAddForm}>
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">Add publication</h2>

              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Title</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addTitle}
                    onChange={(event) => setAddTitle(event.target.value)}
                    placeholder="e.g. SOLAS Consolidated Edition"
                    maxLength={300}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleCreate();
                      }
                    }}
                  />
                </div>
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Conditional note (optional)
                  </label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addNote}
                    onChange={(event) => setAddNote(event.target.value)}
                    placeholder="e.g. flag-specific, if operating polar"
                    maxLength={120}
                  />
                </div>
              </div>

              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={closeAddForm}
                  disabled={creating}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  onClick={() => void handleCreate()}
                  disabled={creating || !addTitle.trim()}
                >
                  {creating ? "Adding..." : "Add publication"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <Toast
        message={feedback?.message ?? ""}
        type={feedback?.type ?? "info"}
        duration={5000}
        onClose={() => setFeedback(null)}
      />
    </section>
  );
}
