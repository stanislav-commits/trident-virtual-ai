import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  attachPublicationNodeFile,
  createPublicationNode,
  createPublicationShelf,
  deletePublicationNode,
  removePublicationShelf,
  renamePublicationShelf,
  fetchPublicationShelfContents,
  fetchPublicationChildren,
  fetchPublicationNodeContent,
  fetchPublicationRail,
  fetchPublicationRoots,
  parsePublicationNode,
  collectParsedPublications,
  searchPublications,
  updatePublicationNode,
  type PublicationNode,
  type PublicationNodeContent,
  type PublicationRailCategory,
  type PublicationSearchHit,
} from "../../api/publicationTreeApi";
import { fetchDocumentFile } from "../../api/documentsApi";
import {
  CollapseIcon,
  DownloadIcon,
  ExpandIcon,
  PlusIcon,
  XIcon,
} from "./AdminPanelIcons";
import { useAdminEvents } from "../../hooks/admin/adminEvents";

const TYPE_LABEL: Record<string, string> = {
  law: "Laws and codes",
  notice_series: "Notices",
  form: "Forms",
  other: "Other",
};

/**
 * The browser's own PDF viewer, with its furniture turned off: no toolbar, no
 * thumbnail rail, fitted to the width. What is wanted here is to flick through
 * the pages and move on — zoom, rotate, print and download belong to the file,
 * and the file has its own download button in the header.
 */
const PDF_VIEW = "#toolbar=0&navpanes=0&scrollbar=0&view=FitH";

const UPLOAD_ACCEPT = ".pdf,.md,.txt,.doc,.docx";

interface AddDialog {
  parent: PublicationNode | null;
  category: string;
  nodeType: string;
  jurisdiction: string | null;
}

/**
 * The publications library: a two-level rail (jurisdiction → type) and a tree
 * of arbitrary depth beside it.
 *
 * The depth is the point. Regulatory material nests differently everywhere —
 * Lloyd's runs set → Part → Chapter → Section, a Malta act is one level of
 * articles, a notice series is a flat run, a form is a single file — so a node
 * is a node at every level and "add a section here" works anywhere rather than
 * only where a fixed schema allowed it.
 */
export function PublicationsLibrary({
  token,
  onOpenReview,
}: {
  token: string | null;
  onOpenReview?: () => void;
}) {
  const [rail, setRail] = useState<PublicationRailCategory[]>([]);
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ category: string; nodeType: string } | null>(
    null,
  );
  const [roots, setRoots] = useState<PublicationNode[]>([]);
  const [childrenByNode, setChildrenByNode] = useState<Record<string, PublicationNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingNode, setLoadingNode] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PublicationSearchHit[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addDialog, setAddDialog] = useState<AddDialog | null>(null);
  const [addNumber, setAddNumber] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addFile, setAddFile] = useState<File | null>(null);
  /**
   * The row menu renders in a portal at fixed coordinates rather than inside
   * the row: the tree pane scrolls (`overflow-y: auto`), which CLIPPED an
   * absolutely-positioned menu, and the next row's own hover layer painted
   * over it — the menu looked transparent and swallowed no clicks.
   */
  const [menu, setMenu] = useState<{
    node: PublicationNode;
    x: number;
    y: number;
  } | null>(null);
  const [renameFor, setRenameFor] = useState<PublicationNode | null>(null);
  /**
   * One "⋯" per row instead of a row of icons: a publication and a shelf each
   * have two actions, and two buttons crowding a rail row read as clutter.
   */
  const [shelfMenu, setShelfMenu] = useState<{
    publication: string;
    category: string | null;
    x: number;
    y: number;
  } | null>(null);
  /**
   * "Publication" on the rail means the shelf itself (Malta, SOLAS) — a level
   * above the documents. Creating one no longer needs a document to exist.
   */
  const [shelfDialog, setShelfDialog] = useState<
    { publication: string; fixed: boolean } | null
  >(null);
  const [shelfName, setShelfName] = useState("");
  const [shelfCategories, setShelfCategories] = useState<string[]>([""]);
  const [deleteFor, setDeleteFor] = useState<PublicationNode | null>(null);
  /**
   * Deleting a shelf is not the same as deleting a node: a category holds
   * whole documents, and a publication holds categories. The dialog says how
   * much goes with it before anything is removed.
   */
  /** Renaming a shelf — the publication itself, or one of its categories. */
  const [shelfRename, setShelfRename] = useState<{
    publication: string;
    category: string | null;
  } | null>(null);
  const [shelfRenameName, setShelfRenameName] = useState("");
  const [shelfDelete, setShelfDelete] = useState<{
    publication: string;
    category: string | null;
    documents: number;
    nodes: number;
  } | null>(null);
  const [preview, setPreview] = useState<PublicationNodeContent | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewTab, setPreviewTab] = useState<"text" | "original">("text");
  const uploadRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!shelfMenu) return;
    const close = () => setShelfMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [shelfMenu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  /**
   * The original renders in an iframe from a blob URL — the file endpoint
   * needs the bearer token, so a plain src= would 401.
   */
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  /** The preview takes the whole section — a form is unreadable in a 390px
   *  column, and the rail and the tree are not needed while reading one. */
  const [previewFull, setPreviewFull] = useState(false);

  const downloadOriginal = useCallback(async () => {
    if (!preview?.documentId || !token) return;
    try {
      const blob = await fetchDocumentFile(token, preview.documentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = preview.fileName ?? `${preview.title}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not download the original");
    }
  }, [preview, token]);
  useEffect(() => {
    if (previewTab !== "original" || !preview?.documentId || !token) return;
    let revoked: string | null = null;
    let cancelled = false;
    void fetchDocumentFile(token, preview.documentId)
      .then((blob) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setOriginalUrl(revoked);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not load the original"),
      );
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      setOriginalUrl(null);
    };
  }, [previewTab, preview?.documentId, token]);

  const onParse = async (node: PublicationNode) => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await parsePublicationNode(token, node.id);
      if (!result.queued) {
        setError(
          result.skipped[0] ??
            "Nothing to parse here — every article already has usable text.",
        );
      }
      await refreshBranch(node.parentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start parsing");
    } finally {
      setBusy(false);
    }
  };

  const submitShelf = async () => {
    if (!token || !shelfDialog) return;
    const publication = (shelfDialog.fixed ? shelfDialog.publication : shelfName).trim();
    if (!publication) return;
    const categories = shelfCategories.map((c) => c.trim()).filter(Boolean);
    setBusy(true);
    try {
      // One call per category — the shelf endpoint takes a single pair and is
      // idempotent, so creating a publication with three categories is three
      // safe writes rather than a special bulk path.
      let next = rail;
      for (const category of categories.length ? categories : [""]) {
        next = await createPublicationShelf(token, {
          publication,
          category: category || null,
        });
      }
      setRail(next);
      setOpenCategories((prev) => new Set(prev).add(publication));
      if (categories[0]) {
        setSelected({ category: publication, nodeType: categories[0] });
      }
      setShelfDialog(null);
      setShelfName("");
      setShelfCategories([""]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the publication");
    } finally {
      setBusy(false);
    }
  };

  const submitShelfRename = async () => {
    if (!token || !shelfRename) return;
    const name = shelfRenameName.trim();
    if (!name) return;
    setBusy(true);
    try {
      setRail(await renamePublicationShelf(token, { ...shelfRename, name }));
      if (selected?.category === shelfRename.publication) {
        setSelected(
          shelfRename.category
            ? { category: shelfRename.publication, nodeType: name }
            : { category: name, nodeType: selected.nodeType },
        );
      }
      setOpenCategories((prev) => {
        const next = new Set(prev);
        if (!shelfRename.category && next.delete(shelfRename.publication)) next.add(name);
        return next;
      });
      setShelfRename(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename");
    } finally {
      setBusy(false);
    }
  };

  const askRemoveShelf = async (publication: string, category: string | null) => {
    if (!token) return;
    try {
      const contents = await fetchPublicationShelfContents(token, publication, category);
      // Nothing to lose, nothing to confirm.
      if (!contents.nodes) {
        await removePublicationShelf(token, publication, category, true);
        if (selected?.category === publication) setSelected(null);
        void loadRail();
        return;
      }
      setShelfDelete({ publication, category, ...contents });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the shelf");
    }
  };

  const confirmRemoveShelf = async () => {
    if (!token || !shelfDelete) return;
    setBusy(true);
    try {
      await removePublicationShelf(
        token,
        shelfDelete.publication,
        shelfDelete.category,
        true,
      );
      if (selected?.category === shelfDelete.publication) setSelected(null);
      setShelfDelete(null);
      void loadRail();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the shelf");
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (node: PublicationNode) => {
    if (!token) return;
    setPreviewing(true);
    try {
      const content = await fetchPublicationNodeContent(token, node.id);
      // Original leads the tabs, so it opens active — but a branch node carries
      // no file of its own, and landing on an empty pane reads as broken.
      setPreviewTab(content.hasFile ? "original" : "text");
      setPreview(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the node");
    } finally {
      setPreviewing(false);
    }
  };

  const loadRail = useCallback(async () => {
    if (!token) return;
    try {
      const next = await fetchPublicationRail(token);
      setRail(next);
      setSelected((current) => {
        if (current) return current;
        const first = next[0];
        return first
          ? { category: first.category, nodeType: first.types[0]?.nodeType ?? "other" }
          : null;
      });
      if (next.length) {
        setOpenCategories((prev) =>
          prev.size ? prev : new Set([next[0].category]),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library");
    }
  }, [token]);

  /**
   * Two loads can be in flight at once (a click on the rail, plus the live
   * admin-event refresh), and the slower answer used to win — the header said
   * one shelf while the list showed another's documents. Only the newest
   * request is allowed to write.
   */
  const rootsRequestRef = useRef(0);
  const loadRoots = useCallback(async () => {
    if (!token || !selected) return;
    const requestId = ++rootsRequestRef.current;
    try {
      const next = await fetchPublicationRoots(
        token,
        selected.category,
        selected.nodeType,
      );
      if (rootsRequestRef.current !== requestId) return;
      setRoots(next);
      setChildrenByNode({});
      setExpanded(new Set());
    } catch (e) {
      if (rootsRequestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : "Could not load publications");
    }
  }, [token, selected]);

  useEffect(() => {
    void loadRail();
  }, [loadRail]);
  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);
  useAdminEvents("publications", () => {
    void loadRail();
    void loadRoots();
  });

  /**
   * Vision runs in a background queue, so the tree polls for finished pages
   * while anything is still parsing and stops the moment nothing is.
   */
  const [parsingCount, setParsingCount] = useState(0);
  useEffect(() => {
    if (!token || parsingCount === 0) return;
    const timer = window.setInterval(() => {
      void collectParsedPublications(token).then(({ collected }) => {
        if (collected) {
          void loadRoots();
          void loadRail();
        }
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [token, parsingCount, loadRoots, loadRail]);


  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    if (!token) return;
    const timer = window.setTimeout(() => {
      void searchPublications(token, term)
        .then(setHits)
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : "Search failed"),
        );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, token]);

  const toggleNode = async (node: PublicationNode) => {
    const next = new Set(expanded);
    if (next.has(node.id)) {
      next.delete(node.id);
      setExpanded(next);
      return;
    }
    next.add(node.id);
    setExpanded(next);
    if (!childrenByNode[node.id] && token) {
      setLoadingNode(node.id);
      try {
        const kids = await fetchPublicationChildren(token, node.id);
        setChildrenByNode((prev) => ({ ...prev, [node.id]: kids }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open the node");
      } finally {
        setLoadingNode(null);
      }
    }
  };

  const refreshBranch = async (parentId: string | null) => {
    if (!token) return;
    if (!parentId) {
      await loadRoots();
      return;
    }
    const kids = await fetchPublicationChildren(token, parentId);
    setChildrenByNode((prev) => ({ ...prev, [parentId]: kids }));
  };

  const submitAdd = async () => {
    if (!token || !addDialog || !addTitle.trim()) return;
    setBusy(true);
    try {
      const created = await createPublicationNode(token, {
        parentId: addDialog.parent?.id ?? null,
        category: addDialog.category,
        nodeType: addDialog.nodeType,
        jurisdiction: addDialog.jurisdiction,
        number: addNumber.trim() || null,
        title: addTitle.trim(),
      });
      // A file makes it an article; without one it is a section waiting to be
      // filled. Same record either way — the tree does not need two kinds.
      if (addFile) {
        await attachPublicationNodeFile(token, created.id, addFile);
      }
      setAddDialog(null);
      setAddNumber("");
      setAddTitle("");
      setAddFile(null);
      await refreshBranch(addDialog.parent?.id ?? null);
      if (addDialog.parent && !expanded.has(addDialog.parent.id)) {
        setExpanded((prev) => new Set(prev).add(addDialog.parent!.id));
      }
      void loadRail();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add");
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (node: PublicationNode, file: File | null) => {
    if (!token || !file) return;
    setBusy(true);
    try {
      await attachPublicationNodeFile(token, node.id, file);
      await refreshBranch(node.parentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Rename and delete run through real dialogs, not window.prompt/confirm —
   * those are blocked in the embedded browser, so both actions silently did
   * nothing when picked from the row menu.
   */
  const submitRename = async () => {
    if (!token || !renameFor || !addTitle.trim()) return;
    setBusy(true);
    try {
      await updatePublicationNode(token, renameFor.id, {
        title: addTitle.trim(),
        number: addNumber.trim() || null,
      });
      const parentId = renameFor.parentId;
      setRenameFor(null);
      await refreshBranch(parentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!token || !deleteFor) return;
    setBusy(true);
    try {
      const parentId = deleteFor.parentId;
      await deletePublicationNode(token, deleteFor.id);
      setDeleteFor(null);
      await refreshBranch(parentId);
      void loadRail();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const onOpen = async (node: PublicationNode) => {
    if (!token || !node.documentId) return;
    try {
      const blob = await fetchDocumentFile(token, node.documentId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the file");
    }
  };

  useEffect(() => {
    const shown = [...roots, ...Object.values(childrenByNode).flat()];
    setParsingCount(shown.filter((n) => n.parseState === "parsing").length);
  }, [roots, childrenByNode]);

  const selectedRail = useMemo(
    () => rail.find((r) => r.category === selected?.category) ?? null,
    [rail, selected],
  );

  const renderNode = (node: PublicationNode, depth: number) => {
    const isOpen = expanded.has(node.id);
    const kids = childrenByNode[node.id] ?? [];
    const isBranch = node.childCount > 0;
    return (
      <div key={node.id}>
        {/* The row itself is the control: a branch opens, an article previews.
            Nothing to aim at, and the two kinds of row behave as they look. */}
        <div
          className="publib__row"
          role="button"
          tabIndex={0}
          style={{ paddingLeft: 4 + depth * 18 }}
          onClick={() => void (isBranch ? toggleNode(node) : openPreview(node))}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            void (isBranch ? toggleNode(node) : openPreview(node));
          }}
        >
          <span className="publib__twisty" aria-hidden>
            {isBranch ? (isOpen ? "▾" : "▸") : "·"}
          </span>
          {node.number && <span className="publib__number">{node.number}</span>}
          <span className="publib__title">{node.title}</span>
          {isBranch && (
            <span className="publib__count">{node.childCount}</span>
          )}
          {node.parseState === "needed" && (
            <span
              className="publib__badge publib__badge--warn"
              title={`The text extracted from this file scores ${
                node.textQuality ?? 0
              } out of 1 — too garbled to be read or searched. Parse re-reads the page images with AI.`}
            >
              Poor text · {node.textQuality ?? 0}
            </span>
          )}
          {node.parseState === "parsing" && (
            <span className="publib__badge publib__badge--ai">Parsing…</span>
          )}
          {node.parseState === "failed" && (
            <span className="publib__badge publib__badge--warn">
              Parsing failed
            </span>
          )}
          {node.parseState === "parsed" && (
            <span className="publib__badge publib__badge--ai">Parsed</span>
          )}
          {node.needsParsingCount > 0 && isBranch && (
            <span className="publib__badge publib__badge--warn">
              {node.needsParsingCount} to parse
            </span>
          )}
          {/* Parse and the ⋯ menu sit inside the row, which is now clickable —
              keep their clicks from also opening the preview. */}
          <span
            className="publib__actions"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={(el) => {
                uploadRefs.current[node.id] = el;
              }}
              type="file"
              accept={UPLOAD_ACCEPT}
              style={{ display: "none" }}
              onChange={(event) => {
                void onUpload(node, event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
            {/* Any file can be re-read: the text-quality score is a heuristic,
                and a page it scored as fine can still have come out wrong. */}
            {(node.documentId || node.needsParsingCount > 0) && (
              <button
                type="button"
                disabled={busy}
                title={
                  node.parseState === "needed" || node.parseState === "failed"
                    ? "Read this scan with AI vision — its extracted text is unusable"
                    : "Read this file again with AI vision and replace its text"
                }
                onClick={() => void onParse(node)}
              >
                {node.documentId
                  ? node.parseState === "needed" || node.parseState === "failed"
                    ? "Parse"
                    : "Re-parse"
                  : `Parse ${node.needsParsingCount}`}
              </button>
            )}
            <button
              type="button"
              className="publib__menu-btn"
              aria-label="More actions"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu((current) =>
                  current?.node.id === node.id
                    ? null
                    : { node, x: rect.right, y: rect.bottom + 4 },
                );
              }}
            >
              ⋯
            </button>
          </span>
        </div>
        {isOpen && loadingNode === node.id && (
          <div className="publib__hint" style={{ paddingLeft: 26 + depth * 18 }}>
            Loading…
          </div>
        )}
        {isOpen && kids.map((kid) => renderNode(kid, depth + 1))}
      </div>
    );
  };

  return (
    <section className="admin-panel__section admin-panel__section--publib">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Publications library</h2>
          <p className="admin-panel__section-subtitle">
            Regulations, codes, notices and forms the fleet reads. Every level
            takes a new section or article.
          </p>
        </div>
        <div className="publib__head-actions">
          {onOpenReview && (
            <button
              type="button"
              className="admin-panel__btn"
              title="Rows whose extracted text scored below the floor"
              onClick={onOpenReview}
            >
              Text review
            </button>
          )}
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            disabled={!token}
            onClick={() => {
              setShelfName("");
              setShelfCategories([""]);
              setShelfDialog({ publication: "", fixed: false });
            }}
          >
            Add publication
          </button>
        </div>
      </div>

      {error && (
        <div className="admin-panel__error" role="alert">
          {error}
        </div>
      )}

      <input
        className="compliance__search"
        type="search"
        placeholder="Search the library — title or number…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div
        className={`publib${preview || previewing ? " publib--with-preview" : ""}${
          preview && previewFull ? " publib--preview-full" : ""
        }`}
      >
        <aside className="publib__rail">
          {rail.map((entry) => {
            const open = openCategories.has(entry.category);
            return (
              <div key={entry.category}>
                <div className="publib__rail-cat-row">
                  <button
                    type="button"
                    className="publib__rail-cat"
                    onClick={() =>
                      setOpenCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.category)) next.delete(entry.category);
                        else next.add(entry.category);
                        return next;
                      })
                    }
                  >
                    <span className="publib__twisty">{open ? "▾" : "▸"}</span>
                    {entry.category}
                    <span className="publib__count">{entry.total}</span>
                  </button>
                  <button
                    type="button"
                    className="publib__rail-add"
                    title={`${entry.category} — actions`}
                    aria-label={`${entry.category} — actions`}
                    onClick={(event) => {
                      // The window listener that closes the menu would receive
                      // this very click and shut it again on the way up.
                      event.stopPropagation();
                      const box = event.currentTarget.getBoundingClientRect();
                      setShelfMenu((current) =>
                        current?.publication === entry.category && !current.category
                          ? null
                          : {
                              publication: entry.category,
                              category: null,
                                    x: box.right,
                              y: box.bottom + 4,
                            },
                      );
                    }}
                  >
                    ⋯
                  </button>
                </div>
                {open &&
                  entry.types.map((type) => (
                    <div className="publib__rail-type-row" key={type.nodeType}>
                      <button
                        type="button"
                        className={`publib__rail-type${
                          selected?.category === entry.category &&
                          selected?.nodeType === type.nodeType
                            ? " publib__rail-type--active"
                            : ""
                        }`}
                        onClick={() => {
                          setQuery("");
                          setSelected({
                            category: entry.category,
                            nodeType: type.nodeType,
                          });
                        }}
                      >
                        {TYPE_LABEL[type.nodeType] ?? type.nodeType}
                        <span className="publib__count">{type.count}</span>
                      </button>

                    </div>
                  ))}
              </div>
            );
          })}
        </aside>

        <div className="publib__pane">
          {hits ? (
            <>
              <div className="publib__pane-head">
                {hits.length} result{hits.length === 1 ? "" : "s"}
              </div>
              {hits.map((hit) => (
                // A hit behaves like any other article row: click it and it
                // opens. Reaching a regulation through search and then having
                // to find it again in the tree to read it made search useless.
                <div
                  className="publib__row"
                  key={hit.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openPreview(hit as unknown as PublicationNode)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    void openPreview(hit as unknown as PublicationNode);
                  }}
                >
                  <span className="publib__twisty" aria-hidden>·</span>
                  {hit.number && (
                    <span className="publib__number">{hit.number}</span>
                  )}
                  <span className="publib__title">
                    {hit.title}
                    <span className="publib__path">
                      {[hit.category, ...hit.path].join(" › ")}
                    </span>
                  </span>
                  {hit.documentId && (
                    <span
                      className="publib__actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button type="button" onClick={() => void onOpen(hit)}>
                        Open
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="publib__pane-head">
                {selected
                  ? `${selected.category} › ${TYPE_LABEL[selected.nodeType] ?? selected.nodeType}`
                  : "Nothing selected"}
                <span className="publib__count">{roots.length}</span>
                {selected && (
                  <button
                    type="button"
                    className="publib__head-add"
                    title="Actions for this category"
                    aria-label="Actions for this category"
                    onClick={(event) => {
                      event.stopPropagation();
                      const box = event.currentTarget.getBoundingClientRect();
                      setShelfMenu((current) =>
                        current?.category === selected.nodeType
                          ? null
                          : {
                              publication: selected.category,
                              category: selected.nodeType,
                                    x: box.right,
                              y: box.bottom + 4,
                            },
                      );
                    }}
                  >
                    ⋯
                  </button>
                )}
              </div>
              {roots.length === 0 ? (
                <div className="publib__empty">
                  Nothing here yet. Add the first publication.
                </div>
              ) : (
                roots.map((node) => renderNode(node, 0))
              )}
            </>
          )}
        </div>

        {(preview || previewing) && (
          <aside className="publib__preview">
            <div className="publib__preview-head">
              <span className="publib__preview-title">
                {preview
                  ? [preview.number, preview.title].filter(Boolean).join(" ")
                  : "Loading…"}
              </span>
              {/* A form is filled in and signed, so the original has to be
                  takeable, not only viewable. */}
              {preview?.documentId && (
                <button
                  type="button"
                  className="admin-panel__icon-btn publib__preview-btn"
                  title="Download the original"
                  aria-label="Download the original"
                  onClick={() => void downloadOriginal()}
                >
                  <DownloadIcon />
                </button>
              )}
              <button
                type="button"
                className="admin-panel__icon-btn publib__preview-btn"
                title={previewFull ? "Back to the side panel" : "Full screen"}
                aria-label={previewFull ? "Back to the side panel" : "Full screen"}
                onClick={() => setPreviewFull((full) => !full)}
              >
                {previewFull ? <CollapseIcon /> : <ExpandIcon />}
              </button>
              <button
                type="button"
                className="admin-panel__icon-btn publib__preview-btn"
                aria-label="Close preview"
                onClick={() => {
                  setPreviewFull(false);
                  setPreview(null);
                }}
              >
                <XIcon />
              </button>
            </div>
            {preview && (
              <>
                <div className="publib__preview-tabs">
                  <button
                    type="button"
                    className={previewTab === "original" ? "is-active" : ""}
                    onClick={() => setPreviewTab("original")}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className={previewTab === "text" ? "is-active" : ""}
                    onClick={() => setPreviewTab("text")}
                  >
                    Text
                  </button>
                  {preview.hasFile && (
                    <button
                      type="button"
                      className="publib__preview-parse"
                      title="Re-read this file with AI vision and replace the text"
                      onClick={() => {
                        const node = [...roots, ...Object.values(childrenByNode).flat()]
                          .find((n) => n.id === preview.id);
                        if (node) void onParse(node);
                      }}
                    >
                      {preview.parseState === "parsing" ? "Parsing…" : "Parse"}
                    </button>
                  )}
                </div>
                {previewTab === "text" ? (
                  <>
                    <p className="publib__preview-note">
                      {preview.parseState === "needed"
                        ? `Scan or image-heavy page: the extracted text scores ${preview.textQuality ?? 0}/1 and is not trustworthy. Parse re-reads it with AI.`
                        : preview.hasFile
                          ? "Extracted from the original file."
                          : "Assembled from what is inside this node."}
                    </p>
                    <pre className="publib__preview-text">{preview.text}</pre>
                    {preview.truncated && (
                      <p className="publib__preview-note">
                        This is a digest of the sections inside — open one to
                        read it in full.
                      </p>
                    )}
                  </>
                ) : preview.documentId ? (
                  <>
                    <p className="publib__preview-note">
                      {preview.fileName ?? "Original file"}
                    </p>
                    <iframe
                      key={preview.documentId ?? "none"}
                      className="publib__preview-frame"
                      title="Original document"
                      src={originalUrl ? `${originalUrl}${PDF_VIEW}` : undefined}
                    />
                  </>
                ) : (
                  <p className="publib__preview-note">
                    No original uploaded. The library import brought the text
                    only; the source file is{" "}
                    <code>{preview.sourceRef ?? "not recorded"}</code>. Use
                    “Upload file…” on the row to attach it.
                  </p>
                )}
              </>
            )}
          </aside>
        )}
      </div>

      {shelfMenu &&
        createPortal(
          <div
            className="publib__menu"
            style={{ left: shelfMenu.x, top: shelfMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {shelfMenu.category ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    setAddDialog({
                      parent: null,
                      category: target.publication,
                      nodeType: target.category as string,
                      jurisdiction: selectedRail?.jurisdiction ?? null,
                    });
                  }}
                >
                  Add a branch…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    setShelfRenameName(target.category as string);
                    setShelfRename({
                      publication: target.publication,
                      category: target.category,
                    });
                  }}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  className="publib__menu-danger"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    void askRemoveShelf(target.publication, target.category);
                  }}
                >
                  Delete category
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    setShelfCategories([""]);
                    setShelfDialog({ publication: target.publication, fixed: true });
                  }}
                >
                  Add a category…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    setShelfRenameName(target.publication);
                    setShelfRename({ publication: target.publication, category: null });
                  }}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  className="publib__menu-danger"
                  onClick={() => {
                    const target = shelfMenu;
                    setShelfMenu(null);
                    void askRemoveShelf(target.publication, null);
                  }}
                >
                  Delete publication
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {menu &&
        createPortal(
          <div
            className="publib__menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                setAddDialog({
                  parent: menu.node,
                  category: menu.node.category,
                  nodeType: menu.node.nodeType,
                  jurisdiction: menu.node.jurisdiction,
                });
              }}
            >
              Add inside…
            </button>
            {menu.node.documentId && (
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  void onOpen(menu.node);
                }}
              >
                Open original
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const id = menu.node.id;
                setMenu(null);
                uploadRefs.current[id]?.click();
              }}
            >
              {menu.node.documentId ? "Replace file…" : "Upload file…"}
            </button>
            <button
              type="button"
              onClick={() => {
                const node = menu.node;
                setMenu(null);
                setAddNumber(node.number ?? "");
                setAddTitle(node.title);
                setRenameFor(node);
              }}
            >
              Rename…
            </button>
            <button
              type="button"
              className="publib__danger"
              onClick={() => {
                const node = menu.node;
                setMenu(null);
                setDeleteFor(node);
              }}
            >
              Delete
            </button>
          </div>,
          document.body,
        )}

      {shelfDialog &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setShelfDialog(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">
                {shelfDialog.fixed
                  ? `New category in ${shelfDialog.publication}`
                  : "New publication"}
              </h2>
              <div className="admin-panel__modal-form">
                {!shelfDialog.fixed && (
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Publication
                    </label>
                    <input
                      className="admin-panel__input admin-panel__input--full"
                      value={shelfName}
                      maxLength={80}
                      autoFocus
                      onChange={(event) => setShelfName(event.target.value)}
                    />
                  </div>
                )}
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    {shelfCategories.length > 1 ? "Categories" : "Category"}
                  </label>
                  {shelfCategories.map((value, index) => (
                    <div className="publib__category-row" key={index}>
                      <input
                        className="admin-panel__input admin-panel__input--full"
                        value={value}
                        maxLength={60}
                        autoFocus={shelfDialog.fixed && index === 0}
                        onChange={(event) =>
                          setShelfCategories((prev) =>
                            prev.map((item, i) =>
                              i === index ? event.target.value : item,
                            ),
                          )
                        }
                      />
                      {shelfCategories.length > 1 && (
                        <button
                          type="button"
                          className="publib__rail-add"
                          aria-label="Remove this category"
                          onClick={() =>
                            setShelfCategories((prev) =>
                              prev.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <XIcon />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="publib__category-add"
                    onClick={() => setShelfCategories((prev) => [...prev, ""])}
                  >
                    <PlusIcon />
                    <span>Another category</span>
                  </button>
                </div>
                <p className="admin-panel__muted">
                  {shelfDialog.fixed
                    ? "More categories can be added from the rail at any time."
                    : "A publication is a shelf on the rail. Add documents to its categories afterwards."}
                </p>
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setShelfDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={
                    busy ||
                    (shelfDialog.fixed
                      ? !shelfCategories.some((c) => c.trim())
                      : !shelfName.trim())
                  }
                  onClick={() => void submitShelf()}
                >
                  {busy ? "Saving…" : "Create"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {renameFor &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setRenameFor(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">Rename</h2>
              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Number (optional)
                  </label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addNumber}
                    maxLength={60}
                    onChange={(event) => setAddNumber(event.target.value)}
                  />
                </div>
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Title</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addTitle}
                    maxLength={400}
                    autoFocus
                    onChange={(event) => setAddTitle(event.target.value)}
                  />
                </div>
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setRenameFor(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={busy || !addTitle.trim()}
                  onClick={() => void submitRename()}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {shelfRename &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setShelfRename(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">
                {shelfRename.category ? "Rename category" : "Rename publication"}
              </h2>
              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Name</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    autoFocus
                    maxLength={80}
                    value={shelfRenameName}
                    onChange={(event) => setShelfRenameName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitShelfRename();
                    }}
                  />
                </div>
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setShelfRename(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={busy || !shelfRenameName.trim()}
                  onClick={() => void submitShelfRename()}
                >
                  {busy ? "Saving…" : "Rename"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {shelfDelete &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setShelfDelete(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">
                Delete {shelfDelete.category ?? shelfDelete.publication}
              </h2>
              <p className="admin-panel__muted">
                {shelfDelete.category
                  ? `The "${shelfDelete.category}" category of ${shelfDelete.publication}`
                  : `The whole ${shelfDelete.publication} publication`}
                {shelfDelete.documents
                  ? ` — ${shelfDelete.documents} document(s), ${shelfDelete.nodes} entries in all. This cannot be undone.`
                  : " — it is empty."}
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setShelfDelete(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  disabled={busy}
                  onClick={() => void confirmRemoveShelf()}
                >
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {deleteFor &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setDeleteFor(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">Delete</h2>
              <p className="admin-panel__muted">
                {[deleteFor.number, deleteFor.title].filter(Boolean).join(" ")}
                {deleteFor.childCount
                  ? ` — and the ${deleteFor.childCount} item(s) inside it.`
                  : "."}
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setDeleteFor(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}


      {addDialog &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !busy && setAddDialog(null)}
          >
            <div
              className="admin-panel__modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="admin-panel__modal-title">
                {addDialog.parent ? "Add inside" : "New document"}
              </h2>
              {/* The shelf is already chosen on the rail — repeating it as
                  editable fields here made two places disagree about where the
                  thing lands. */}
              <p className="admin-panel__muted">
                {[
                  addDialog.category,
                  TYPE_LABEL[addDialog.nodeType] ?? addDialog.nodeType,
                  addDialog.parent?.title,
                ]
                  .filter(Boolean)
                  .join(" › ")}
              </p>
              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Number (optional)
                  </label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addNumber}
                    maxLength={60}
                    onChange={(event) => setAddNumber(event.target.value)}
                  />
                </div>
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Title</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={addTitle}
                    maxLength={400}
                    autoFocus
                    onChange={(event) => setAddTitle(event.target.value)}
                  />
                </div>
                {(
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      File (optional — PDF, .md or .txt)
                    </label>
                    <input
                      type="file"
                      accept={UPLOAD_ACCEPT}
                      onChange={(event) =>
                        setAddFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <p className="admin-panel__muted">
                      {addFile
                        ? "With a file this is an article — its text goes to chat search."
                        : "Without a file this is a section: a container to put articles in."}
                    </p>
                  </div>
                )}
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn"
                  disabled={busy}
                  onClick={() => setAddDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={busy || !addTitle.trim()}
                  onClick={() => void submitAdd()}
                >
                  {busy ? "Saving…" : "Create"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
