import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createComplianceDoc,
  extractComplianceForType,
  fetchComplianceDocFileUrl,
  instantiateCompliance,
  deleteComplianceDoc,
  fetchComplianceOverview,
  fetchComplianceArchetypes,
  addComplianceDocLink,
  removeComplianceDocLink,
  previewComplianceDocs,
  commitComplianceDocs,
  openComplianceDocFile,
  updateComplianceDoc,
} from "../../api/complianceApi";
import type {
  ComplianceDocType,
  ComplianceOverview,
  ComplianceRecord,
  ArchetypeSchema,
  IngestProposal,
  CommitProposal,
} from "../../api/complianceApi";
import { ComplianceIngestModal } from "./ComplianceIngestModal";
import { ComplianceDocModal, type DocModalValues } from "./ComplianceDocModal";
import { uploadDocument } from "../../api/documentsApi";
import { listAssets } from "../../api/assetsApi";
import { type AssetOption } from "./AssetMultiSelect";
import { listCrew } from "../../api/crewApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { ComplianceTypeRow } from "./ComplianceTypeRow";

/**
 * Compliance Docs (Shaun, 11 Jun 2026) — V2-mock layout: section
 * categories in a left rail, the selected section's document types in the
 * main pane. Each type supports manual records and direct PDF upload
 * (stored via the documents pipeline with docClass=certificate, then
 * recorded here with the file attached).
 */
export function ComplianceSection({ token }: { token: string | null }) {
  // Same ship resolution as AssetsSection: explicit selection, else the
  // first available ship.
  const { selectedShipId, availableShips } = useAdminShip();
  const shipId = selectedShipId ?? availableShips[0]?.id ?? null;
  const [overview, setOverview] = useState<ComplianceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<
    "all" | "empty" | "filled" | "expired" | "expiring" | "valid"
  >("all");
  const [schema, setSchema] = useState<ArchetypeSchema | null>(null);
  const [savingDoc, setSavingDoc] = useState(false);
  // Single-doc save failure — shown INSIDE the doc modal, not behind it.
  const [docSaveError, setDocSaveError] = useState<string | null>(null);
  // Single-document review / edit window.
  const [docModal, setDocModal] = useState<{
    type: ComplianceDocType;
    mode: "create" | "edit";
    docId?: string;
    documentId: string | null;
    previewUrl: string | null;
    isImage: boolean;
    initial: DocModalValues;
    extractedText?: string;
  } | null>(null);
  const [profile, setProfile] = useState({
    grossTonnage: "",
    operationType: "commercial",
    flagRegistry: "",
  });
  const [generating, setGenerating] = useState(false);
  const [addingTypeId, setAddingTypeId] = useState<string | null>(null);
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  const [crewOptions, setCrewOptions] = useState<
    Array<{ id: string; label: string; rank: string }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<ComplianceDocType | null>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  // Any click outside the wrap closes the files/folder menu.
  useEffect(() => {
    if (!uploadMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".compliance__upload-wrap")) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [uploadMenuOpen]);
  const [ingesting, setIngesting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    proposals: IngestProposal[];
    files: File[];
  } | null>(null);

  // Flat list of all doc types (for the review window's category→type picker).
  const allTypes = useMemo(
    () =>
      (overview?.sections ?? []).flatMap((s) =>
        s.types.map((t) => ({
          id: t.id,
          sfiCode: t.sfiCode,
          name: t.name,
          sectionCode: s.sectionCode,
          sectionName: s.sectionName,
          archetype: t.archetype,
        })),
      ),
    [overview],
  );

  /** The ingest/preview endpoint accepts at most this many files per call. */
  const BATCH_LIMIT = 30;
  /** What the AI reader can ingest — everything else in a folder is skipped. */
  const isSupportedDoc = (f: File) =>
    !f.name.startsWith(".") && /\.(pdf|png|jpe?g|webp|tiff?|bmp)$/i.test(f.name);

  const onBatchUpload = async (fileList: FileList | null) => {
    if (!token || !shipId || !fileList?.length) return;
    // Folder picks arrive recursively and full of junk (.DS_Store, sidecars)
    // — keep only what the reader supports.
    const files = Array.from(fileList).filter(isSupportedDoc);
    if (files.length === 0) {
      setError("No PDFs or images found in the selection.");
      return;
    }
    if (files.length > BATCH_LIMIT) {
      setError(
        `${files.length} supported files selected — the batch limit is ${BATCH_LIMIT} per upload. Split the folder and upload in parts.`,
      );
      return;
    }
    setError(null);
    setIngesting(true);
    try {
      const { proposals } = await previewComplianceDocs(token, shipId, files);
      setReview({ proposals, files });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the documents");
    } finally {
      setIngesting(false);
    }
  };

  const commitReview = async (proposals: CommitProposal[]) => {
    if (!token || !shipId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const { created } = await commitComplianceDocs(
        token,
        shipId,
        proposals,
        review?.files ?? [],
      );
      // The server returns 200 even when some records fail validation server-
      // side. Surface a shortfall instead of closing as a silent "success".
      if (created < proposals.length) {
        setCommitError(
          `Saved ${created} of ${proposals.length}. ${
            proposals.length - created
          } could not be saved — check the required fields (marked *).`,
        );
        await reload();
      } else {
        setReview(null);
        await reload();
      }
    } catch (e) {
      // Shown INSIDE the review modal — a page-level banner would be hidden
      // behind the overlay.
      setCommitError(
        e instanceof Error ? e.message : "Could not save the documents",
      );
    } finally {
      setCommitting(false);
    }
  };

  const reload = useCallback(async () => {
    if (!token || !shipId) return;
    try {
      setOverview(await fetchComplianceOverview(token, shipId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load compliance");
    }
  }, [token, shipId]);

  useEffect(() => {
    setOverview(null);
    setActiveSection(null);
    void reload();
  }, [reload]);

  // Archetype field schema (static; drives the dynamic record form).
  useEffect(() => {
    if (!token || !shipId) return;
    let alive = true;
    void fetchComplianceArchetypes(token, shipId)
      .then((s) => alive && setSchema(s))
      .catch(() => alive && setSchema(null));
    return () => {
      alive = false;
    };
  }, [token, shipId]);

  // Asset options for record→asset linking (Shaun: per-unit certificates,
  // e.g. each liferaft has its own inspection cert).
  useEffect(() => {
    if (!token || !shipId) {
      setAssetOptions([]);
      return;
    }
    void listAssets(token, shipId, { limit: 2000 })
      .then((r) =>
        setAssetOptions(
          r.items.map((a) => ({
            id: a.id,
            label: `${a.assetIdInternal} — ${a.displayName}`,
            sfiGroup: a.sfiGroup,
            sfiGroupName: a.sfiGroupName,
            sfiSub: a.sfiSub,
            sfiSubName: a.sfiSubName,
          })),
        ),
      )
      .catch(() => setAssetOptions([]));
  }, [token, shipId]);

  // Crew options for person-links (PERSONNEL archetype: CoC, STCW, etc.).
  useEffect(() => {
    if (!token || !shipId) {
      setCrewOptions([]);
      return;
    }
    void listCrew(token, shipId)
      .then((rows) =>
        setCrewOptions(
          rows.map((c) => ({
            id: c.id,
            label: `${c.name} (${c.rank})`,
            rank: c.rank,
          })),
        ),
      )
      .catch(() => setCrewOptions([]));
  }, [token, shipId]);

  const addLink = async (
    docId: string,
    body: { assetId?: string; crewMemberId?: string },
  ) => {
    if (!token || !shipId) return;
    try {
      await addComplianceDocLink(token, shipId, docId, body);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add link");
    }
  };

  const removeLink = async (docId: string, linkId: string) => {
    if (!token || !shipId) return;
    try {
      await removeComplianceDocLink(token, shipId, docId, linkId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove link");
    }
  };

  const totals = useMemo(() => {
    const t = { valid: 0, expiring: 0, expired: 0, missing: 0 };
    for (const s of overview?.sections ?? []) {
      for (const k of Object.keys(t) as (keyof typeof t)[]) {
        t[k] += s.counts[k] ?? 0;
      }
    }
    return t;
  }, [overview]);

  const visibleSections = useMemo(
    () => (overview?.sections ?? []).filter((s) => s.types.length > 0),
    [overview],
  );

  const current =
    visibleSections.find((s) => s.sectionCode === activeSection) ??
    visibleSections[0] ??
    null;

  // Global type search (name or code) across every section; results are
  // grouped per section in the main panel while the query is non-empty.
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  // Status filter for the type list (All / Empty / Filled / Expired / …).
  const matchesFilter = (t: ComplianceDocType) => {
    switch (typeFilter) {
      case "empty":
        return t.records.length === 0;
      case "filled":
        return t.records.length > 0;
      case "expired":
        return t.status === "expired";
      case "expiring":
        return t.status === "expiring";
      case "valid":
        return t.status === "valid";
      default:
        return true;
    }
  };

  // A search query OR an active status filter switches the main panel to the
  // cross-section grouped view (matches from every section), the way search
  // has always worked. Only "all" filter + empty query shows one section.
  const filteredResults = useMemo(() => {
    if (!query && typeFilter === "all") return null;
    return visibleSections
      .map((s) => ({
        section: s,
        types: s.types.filter(
          (t) =>
            matchesFilter(t) &&
            (!query ||
              t.name.toLowerCase().includes(query) ||
              t.sfiCode.toLowerCase().includes(query)),
        ),
      }))
      .filter((g) => g.types.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSections, query, typeFilter]);

  // Extraction values (unknown-typed) → the modal's string form values.
  const toFormFields = (f: Record<string, unknown> | null | undefined) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(f ?? {})) {
      if (v == null) continue;
      out[k] = typeof v === "boolean" ? (v ? "true" : "") : String(v);
    }
    return out;
  };

  const closeDocModal = () => {
    setDocSaveError(null);
    setDocModal((m) => {
      if (m?.previewUrl) URL.revokeObjectURL(m.previewUrl);
      return null;
    });
  };

  // Single "Add document" flow: pick a file.
  const startAddDocument = (type: ComplianceDocType) => {
    uploadTargetRef.current = type;
    fileInputRef.current?.click();
  };

  // File chosen → store it, AI-extract fields for the known type, open the
  // review modal pre-filled (nothing saved until the operator confirms).
  const handleFilePicked = async (file: File | null) => {
    const type = uploadTargetRef.current;
    if (!file || !type || !token || !shipId) return;
    setAddingTypeId(type.id);
    try {
      const doc = await uploadDocument(token, file, {
        shipId,
        docClass: "certificate",
        documentPurpose: `${type.sfiCode} ${type.name}`,
      });
      const proposal = await extractComplianceForType(
        token,
        shipId,
        type.id,
        doc.id,
      );
      setDocModal({
        type,
        mode: "create",
        documentId: doc.id,
        previewUrl: URL.createObjectURL(file),
        isImage: file.type.startsWith("image/"),
        extractedText: proposal.extractedText,
        initial: {
          certNo: proposal.certNo ?? "",
          issuer: proposal.issuer ?? "",
          issueDate: proposal.issueDate ?? "",
          assetLabel: type.linkCardinality === "person" ? (proposal.assetName ?? "") : "",
          assetIds: proposal.assetId ? [proposal.assetId] : [],
          fields: toFormFields(proposal.fields),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setAddingTypeId(null);
      uploadTargetRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Click a record → open its fields in the same modal (edit mode).
  const startEditRecord = async (type: ComplianceDocType, rec: ComplianceRecord) => {
    if (!token || !shipId) return;
    setAddingTypeId(type.id);
    try {
      let previewUrl: string | null = null;
      let isImage = false;
      if (rec.hasFile) {
        const f = await fetchComplianceDocFileUrl(token, shipId, rec.id);
        previewUrl = f.url;
        isImage = f.isImage;
      }
      setDocModal({
        type,
        mode: "edit",
        docId: rec.id,
        documentId: rec.documentId,
        previewUrl,
        isImage,
        initial: {
          certNo: rec.certNo ?? "",
          issuer: rec.issuer ?? "",
          issueDate: rec.issueDate ?? "",
          assetLabel:
            type.linkCardinality === "person" ? (rec.assetName ?? "") : "",
          // Pre-fill every currently-linked asset (M:N); fall back to the mirror.
          assetIds: (() => {
            const fromLinks = (rec.links ?? [])
              .map((l) => l.assetId)
              .filter((x): x is string => Boolean(x));
            return fromLinks.length
              ? fromLinks
              : rec.assetId
                ? [rec.assetId]
                : [];
          })(),
          fields: toFormFields(rec.fields),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open record");
    } finally {
      setAddingTypeId(null);
    }
  };

  const saveDocModal = async (values: DocModalValues) => {
    if (!token || !shipId || !docModal) return;
    const { type, mode, docId, documentId } = docModal;
    setSavingDoc(true);
    setDocSaveError(null);
    try {
      const linksCrew = type.linkCardinality === "person";
      const crewMatch =
        linksCrew && values.assetLabel
          ? crewOptions.find((o) => o.label === values.assetLabel)
          : null;
      const fields = Object.fromEntries(
        Object.entries(values.fields).filter(([, v]) => v !== ""),
      );
      const body = {
        docTypeId: type.id,
        certNo: values.certNo || null,
        issuer: values.issuer || null,
        issueDate: values.issueDate || null,
        assetId: linksCrew ? null : (values.assetIds[0] ?? null),
        assetIds: linksCrew ? null : values.assetIds,
        crewMemberId: linksCrew ? (crewMatch?.id ?? null) : null,
        fields: Object.keys(fields).length ? fields : null,
        documentId: documentId ?? undefined,
        extractedText: docModal.extractedText,
        verifyState: "confirmed",
      };
      if (mode === "edit" && docId) {
        await updateComplianceDoc(token, shipId, docId, body);
      } else {
        await createComplianceDoc(token, shipId, body);
      }
      closeDocModal();
      await reload();
    } catch (e) {
      // Shown inside the doc modal (it stays open), not as a page banner behind it.
      setDocSaveError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSavingDoc(false);
    }
  };

  const removeRecord = async (docId: string) => {
    if (!token || !shipId) return;
    try {
      await deleteComplianceDoc(token, shipId, docId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete record");
    }
  };

  const openFile = async (docId: string) => {
    if (!token || !shipId) return;
    try {
      await openComplianceDocFile(token, shipId, docId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the file");
    }
  };

  const generateRulebook = async () => {
    if (!token || !shipId) return;
    setGenerating(true);
    try {
      await instantiateCompliance(token, shipId, {
        grossTonnage: profile.grossTonnage
          ? Number(profile.grossTonnage)
          : undefined,
        operationType: profile.operationType,
        flagRegistry: profile.flagRegistry || null,
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate rulebook");
    } finally {
      setGenerating(false);
    }
  };

  if (!shipId) {
    return (
      <div className="compliance">
        <div className="compliance__placeholder">
          Select a ship to view its compliance documents.
        </div>
      </div>
    );
  }

  return (
    <div className="compliance">
      <datalist id="compliance-assets">
        {assetOptions.map((a) => (
          <option key={a.id} value={a.label} />
        ))}
      </datalist>
      <datalist id="compliance-crew">
        {crewOptions.map((c) => (
          <option key={c.id} value={c.label} />
        ))}
      </datalist>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        style={{ display: "none" }}
        onChange={(e) => void handleFilePicked(e.target.files?.[0] ?? null)}
      />

      <div className="compliance__head">
        <div>
          <h2 className="compliance__title">Compliance Docs</h2>
          <div className="compliance__subtitle">
            {totals.missing} missing · {totals.expired} expired ·{" "}
            {totals.expiring} expiring · {totals.valid} valid
          </div>
        </div>
        <div className="compliance__head-controls">
          <div className="compliance__upload-wrap">
            <button
              type="button"
              className="compliance__action-btn compliance__action-btn--primary"
              onClick={() => setUploadMenuOpen((v) => !v)}
              disabled={ingesting}
              title="Upload several certificates — AI reads, classifies and fills them for you to review before saving."
            >
              {ingesting ? "Reading…" : "Batch upload"}
            </button>
            {uploadMenuOpen && (
              // One button, two pickers: a native dialog can't offer files AND
              // folders at once, so the button opens this two-item menu.
              <div className="compliance__upload-menu">
                <button
                  type="button"
                  onClick={() => {
                    setUploadMenuOpen(false);
                    batchInputRef.current?.click();
                  }}
                >
                  Select files…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUploadMenuOpen(false);
                    folderInputRef.current?.click();
                  }}
                  title="Every PDF/image inside the folder (subfolders included) goes into one review batch."
                >
                  Select folder…
                </button>
              </div>
            )}
          </div>
          <input
            ref={batchInputRef}
            type="file"
            accept=".pdf,application/pdf,image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void onBatchUpload(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            style={{ display: "none" }}
            // Non-standard but universal (Chrome/Edge/Safari/Firefox):
            // directory picker; files arrive recursively.
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(e) => {
              void onBatchUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {review && (
        <ComplianceIngestModal
          proposals={review.proposals}
          files={review.files}
          types={allTypes}
          schema={schema}
          assetOptions={assetOptions}
          busy={committing}
          error={commitError}
          onCancel={() => {
            setReview(null);
            setCommitError(null);
          }}
          onConfirm={commitReview}
        />
      )}

      {docModal && (
        <ComplianceDocModal
          typeName={docModal.type.name}
          typeCode={docModal.type.sfiCode}
          archetype={docModal.type.archetype}
          archetypeFields={
            (docModal.type.archetype &&
              schema?.archetypes[docModal.type.archetype]) ||
            []
          }
          linkCardinality={docModal.type.linkCardinality}
          assetOptions={assetOptions}
          crewOptions={crewOptions}
          initial={docModal.initial}
          previewUrl={docModal.previewUrl}
          isImage={docModal.isImage}
          mode={docModal.mode}
          saving={savingDoc}
          error={docSaveError}
          onSave={(values) => void saveDocModal(values)}
          onCancel={closeDocModal}
        />
      )}

      {error && <div className="compliance__error">{error}</div>}
      {!overview && !error && (
        <div className="compliance__placeholder">Loading…</div>
      )}

      {overview && overview.sections.length === 0 && (
        <div className="compliance__generate">
          <div className="compliance__generate-title">
            This vessel has no compliance rulebook yet.
          </div>
          <div className="compliance__generate-sub">
            Set the vessel profile and generate it from the master matrix
            (362 document types, SFI Master v14.6).
          </div>
          <div className="compliance__generate-form">
            <input
              type="text"
              inputMode="numeric"
              placeholder="Gross tonnage (exact)"
              value={profile.grossTonnage}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  grossTonnage: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
            />
            <select
              value={profile.operationType}
              onChange={(e) =>
                setProfile((p) => ({ ...p, operationType: e.target.value }))
              }
            >
              <option value="commercial">Commercial</option>
              <option value="private">Private</option>
            </select>
            <select
              value={profile.flagRegistry}
              onChange={(e) =>
                setProfile((p) => ({ ...p, flagRegistry: e.target.value }))
              }
            >
              <option value="">Flag: not factored</option>
              <option value="red_ensign">Red Ensign</option>
              <option value="eu">EU flag</option>
              <option value="other">Other flag</option>
            </select>
            <button
              type="button"
              disabled={generating}
              onClick={() => void generateRulebook()}
            >
              {generating ? "Generating…" : "Generate rulebook"}
            </button>
          </div>
        </div>
      )}

      {overview && overview.sections.length > 0 && (
        <input
          className="compliance__search"
          type="search"
          placeholder="Search document types — name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {overview && overview.sections.length > 0 && (
        <div className="compliance__filters">
          {(
            [
              ["all", "All"],
              ["empty", "Empty"],
              ["filled", "Filled"],
              ["expired", "Expired"],
              ["expiring", "Expiring"],
              ["valid", "Valid"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`compliance__filter${
                typeFilter === key ? " compliance__filter--on" : ""
              }`}
              onClick={() => setTypeFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {overview && overview.sections.length > 0 && (
        <div className="compliance__layout">
          <nav className="compliance__rail">
            {visibleSections.map((section) => {
              const issues =
                section.counts.missing +
                section.counts.expired +
                section.counts.expiring;
              const isActive = current?.sectionCode === section.sectionCode;
              return (
                <button
                  key={section.sectionCode}
                  type="button"
                  className={`compliance__rail-item${
                    isActive ? " compliance__rail-item--active" : ""
                  }`}
                  onClick={() => {
                    setActiveSection(section.sectionCode);
                    setSearch(""); // rail click leaves search mode
                  }}
                >
                  <span className="compliance__rail-name">
                    {section.sectionName}
                  </span>
                  <span
                    className={`compliance__rail-count${
                      section.counts.expired > 0
                        ? " compliance__rail-count--expired"
                        : issues > 0
                          ? " compliance__rail-count--issues"
                          : " compliance__rail-count--ok"
                    }`}
                  >
                    {section.counts.valid}/
                    {section.counts.valid + issues}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="compliance__main">
            {(() => {
              const renderTypeRow = (type: ComplianceDocType) => (
                <ComplianceTypeRow
                  key={type.id}
                  type={type}
                  assetOptions={assetOptions}
                  crewOptions={crewOptions}
                  onAddLink={addLink}
                  onRemoveLink={removeLink}
                  adding={addingTypeId === type.id}
                  onAddDocument={() => startAddDocument(type)}
                  onEditRecord={(docId) => {
                    const rec = type.records.find((r) => r.id === docId);
                    if (rec) void startEditRecord(type, rec);
                  }}
                  onDeleteRecord={(docId) => void removeRecord(docId)}
                  onOpenFile={(docId) => void openFile(docId)}
                />
              );

              if (filteredResults) {
                if (filteredResults.length === 0) {
                  return (
                    <div className="compliance__placeholder">
                      {query
                        ? `Nothing matches “${search.trim()}”.`
                        : "No documents match this filter."}
                    </div>
                  );
                }
                // Search / filter mode: matches from every section, grouped.
                return filteredResults.map(({ section, types }) => (
                  <div key={section.sectionCode}>
                    <div className="compliance__main-head">
                      {section.sectionCode} {section.sectionName}
                    </div>
                    {types.map(renderTypeRow)}
                  </div>
                ));
              }

              if (!current) return null;
              return (
                <>
                  <div className="compliance__main-head">
                    {current.sectionCode} {current.sectionName}
                  </div>
                  {current.types.map(renderTypeRow)}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
