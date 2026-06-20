import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createComplianceDoc,
  instantiateCompliance,
  deleteComplianceDoc,
  fetchComplianceOverview,
  fetchComplianceArchetypes,
  addComplianceDocLink,
  removeComplianceDocLink,
  previewComplianceDocs,
  commitComplianceDocs,
  updateComplianceDoc,
} from "../../api/complianceApi";
import type {
  ComplianceDocType,
  ComplianceOverview,
  ArchetypeSchema,
  IngestProposal,
  CommitProposal,
} from "../../api/complianceApi";
import { ComplianceIngestModal } from "./ComplianceIngestModal";
import { uploadDocument } from "../../api/documentsApi";
import { listAssets } from "../../api/assetsApi";
import { listCrew } from "../../api/crewApi";
import { useAdminShip } from "../../context/AdminShipContext";
import {
  ComplianceTypeRow,
  type ComplianceRecordFormState,
} from "./ComplianceTypeRow";

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
  const [hideNotRequired, setHideNotRequired] = useState(true);
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [schema, setSchema] = useState<ArchetypeSchema | null>(null);
  const [form, setForm] = useState<ComplianceRecordFormState>({
    certNo: "",
    issuer: "",
    issueDate: "",
    expiryDate: "",
    assetLabel: "",
    fields: {},
  });
  const [savingDoc, setSavingDoc] = useState(false);
  const [profile, setProfile] = useState({
    grossTonnage: "",
    operationType: "commercial",
    flagRegistry: "",
  });
  const [generating, setGenerating] = useState(false);
  const [uploadingTypeId, setUploadingTypeId] = useState<string | null>(null);
  const [assetOptions, setAssetOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [crewOptions, setCrewOptions] = useState<
    Array<{ id: string; label: string; rank: string }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<ComplianceDocType | null>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const [ingesting, setIngesting] = useState(false);
  const [committing, setCommitting] = useState(false);
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
        })),
      ),
    [overview],
  );

  const onBatchUpload = async (fileList: FileList | null) => {
    if (!token || !shipId || !fileList?.length) return;
    const files = Array.from(fileList);
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
    try {
      await commitComplianceDocs(token, shipId, proposals);
      setReview(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the documents");
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
    const t = { valid: 0, expiring: 0, expired: 0, missing: 0, not_required: 0 };
    for (const s of overview?.sections ?? []) {
      for (const k of Object.keys(t) as (keyof typeof t)[]) {
        t[k] += s.counts[k] ?? 0;
      }
    }
    return t;
  }, [overview]);

  const visibleSections = useMemo(
    () =>
      (overview?.sections ?? []).filter((s) =>
        hideNotRequired
          ? s.types.some((t) => t.status !== null)
          : s.types.length > 0,
      ),
    [overview, hideNotRequired],
  );

  const current =
    visibleSections.find((s) => s.sectionCode === activeSection) ??
    visibleSections[0] ??
    null;

  const startAddRecord = (type: ComplianceDocType) => {
    setEditingTypeId(type.id);
    setForm({
      certNo: "",
      issuer: "",
      issueDate: "",
      expiryDate: "",
      assetLabel: "",
      fields: {},
    });
  };

  const submitRecord = async (type: ComplianceDocType) => {
    if (!token || !shipId) return;
    setSavingDoc(true);
    try {
      // The primary link target follows the type's cardinality (schema v9).
      const linksCrew = type.linkCardinality === "person";
      const matched = form.assetLabel
        ? (linksCrew ? crewOptions : assetOptions).find(
            (o) => o.label === form.assetLabel,
          )
        : null;
      await createComplianceDoc(token, shipId, {
        docTypeId: type.id,
        certNo: form.certNo || null,
        issuer: form.issuer || null,
        issueDate: form.issueDate || null,
        expiryDate: form.expiryDate || null,
        assetId: linksCrew ? null : (matched?.id ?? null),
        crewMemberId: linksCrew ? (matched?.id ?? null) : null,
        fields: Object.keys(form.fields).length ? form.fields : null,
      });
      setEditingTypeId(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSavingDoc(false);
    }
  };

  const startUpload = (type: ComplianceDocType) => {
    uploadTargetRef.current = type;
    fileInputRef.current?.click();
  };

  const handleFilePicked = async (file: File | null) => {
    const type = uploadTargetRef.current;
    if (!file || !type || !token || !shipId) return;
    setUploadingTypeId(type.id);
    try {
      // 1. Store the PDF through the normal documents pipeline so it lands
      //    in RAGFlow (AI can read it) and the documents library.
      const doc = await uploadDocument(token, file, {
        shipId,
        docClass: "certificate",
        documentPurpose: `${type.sfiCode} ${type.name}`,
      });
      // 2. Record it against this compliance type. Dates stay empty until
      //    filled manually (AI extraction is the next milestone).
      await createComplianceDoc(token, shipId, {
        docTypeId: type.id,
        certNo: file.name.replace(/\.[^.]+$/, ""),
        documentId: doc.id,
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingTypeId(null);
      uploadTargetRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  const updateExpiry = async (docId: string, expiryDate: string) => {
    if (!token || !shipId) return;
    try {
      await updateComplianceDoc(token, shipId, docId, {
        expiryDate: expiryDate || null,
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update record");
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
          <label className="compliance__toggle">
            <input
              type="checkbox"
              checked={hideNotRequired}
              onChange={(e) => setHideNotRequired(e.target.checked)}
            />
            Hide not required
          </label>
          <button
            type="button"
            className="compliance__action-btn compliance__action-btn--primary"
            onClick={() => batchInputRef.current?.click()}
            disabled={ingesting}
            title="Upload several certificates — AI reads, classifies and fills them for you to review before saving."
          >
            {ingesting ? "Reading…" : "Batch upload"}
          </button>
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
        </div>
      </div>

      {review && (
        <ComplianceIngestModal
          proposals={review.proposals}
          files={review.files}
          types={allTypes}
          assetOptions={assetOptions}
          busy={committing}
          onCancel={() => setReview(null)}
          onConfirm={commitReview}
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
                  onClick={() => setActiveSection(section.sectionCode)}
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
                    {/* denominator tracks the visible list: required-only when
                        "Hide not required" is on, otherwise all types */}
                    {section.counts.valid +
                      issues +
                      (hideNotRequired ? 0 : section.counts.not_required)}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="compliance__main">
            {current && (
              <>
                <div className="compliance__main-head">
                  {current.sectionCode} {current.sectionName}
                </div>
                {(hideNotRequired
                  ? current.types.filter((t) => t.status !== null)
                  : current.types
                ).map((type) => (
                  <ComplianceTypeRow
                    key={type.id}
                    type={type}
                    editing={editingTypeId === type.id}
                    form={form}
                    onFormChange={(patch) =>
                      setForm((f) => ({ ...f, ...patch }))
                    }
                    archetypeFields={
                      (type.archetype && schema?.archetypes[type.archetype]) || []
                    }
                    assetOptions={assetOptions}
                    crewOptions={crewOptions}
                    onAddLink={addLink}
                    onRemoveLink={removeLink}
                    saving={savingDoc}
                    uploading={uploadingTypeId === type.id}
                    onStartUpload={() => startUpload(type)}
                    onStartAdd={() => startAddRecord(type)}
                    onSubmit={() => void submitRecord(type)}
                    onCancelEdit={() => setEditingTypeId(null)}
                    onDeleteRecord={(docId) => void removeRecord(docId)}
                    onUpdateExpiry={(docId, expiryDate) =>
                      void updateExpiry(docId, expiryDate)
                    }
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
