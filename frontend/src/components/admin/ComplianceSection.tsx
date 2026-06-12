import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createComplianceDoc,
  instantiateCompliance,
  deleteComplianceDoc,
  fetchComplianceOverview,
  updateComplianceDoc,
} from "../../api/complianceApi";
import type {
  ComplianceDocType,
  ComplianceOverview,
} from "../../api/complianceApi";
import { uploadDocument } from "../../api/documentsApi";
import { listAssets } from "../../api/assetsApi";
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
  const [form, setForm] = useState<ComplianceRecordFormState>({
    certNo: "",
    issuer: "",
    issueDate: "",
    expiryDate: "",
    assetLabel: "",
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<ComplianceDocType | null>(null);

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
    setForm({ certNo: "", issuer: "", issueDate: "", expiryDate: "", assetLabel: "" });
  };

  const submitRecord = async (type: ComplianceDocType) => {
    if (!token || !shipId) return;
    setSavingDoc(true);
    try {
      const matchedAsset = form.assetLabel
        ? assetOptions.find((a) => a.label === form.assetLabel)
        : null;
      await createComplianceDoc(token, shipId, {
        docTypeId: type.id,
        certNo: form.certNo || null,
        issuer: form.issuer || null,
        issueDate: form.issueDate || null,
        expiryDate: form.expiryDate || null,
        assetId: matchedAsset?.id ?? null,
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
        </div>
      </div>

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
                    {section.counts.valid + issues}
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
