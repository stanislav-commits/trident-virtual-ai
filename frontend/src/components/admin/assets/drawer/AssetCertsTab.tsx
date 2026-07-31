import type { RefObject } from "react";
import { fetchDocumentFile } from "../../../../api/documentsApi";
import {
  openComplianceDocFile,
  type AssetComplianceRecord,
} from "../../../../api/complianceApi";
import type { RelatedAssetResult } from "../../../../api/assetsApi";
import { formatDateDMY } from "../../compliance/complianceLabels";
import { StatusBadge } from "../../StatusBadge";

type LinkedDocument = RelatedAssetResult["documents"][number];

/**
 * Two different things that both read as "certificates".
 *
 * Type approvals approve the MODEL — MED Module B/D, EC type examination,
 * declarations of conformity. They never expire and belong to the asset.
 * Compliance records certify THIS vessel and live in the certificate register;
 * they show here only because they name this asset.
 */
export function AssetCertsTab({
  token,
  shipId,
  typeApprovals,
  assetCerts,
  uploadInputRef,
  uploading,
  onUploadPicked,
}: {
  token: string | null;
  shipId: string;
  typeApprovals: LinkedDocument[];
  assetCerts: AssetComplianceRecord[] | null;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  uploading: boolean;
  onUploadPicked: (file: File | null) => void;
}) {
  return (
  <div className="assets-section__drawer-section">
    {/* Manufacturer approvals of this equipment TYPE. They approve a model
        rather than the unit fitted here and never expire, so they live on
        the asset instead of the vessel's certificate register. One file can
        cover every unit of the model — link it to each. */}
    <div className="assets-section__certs-head">
      <span>Type approvals</span>
      <button
        type="button"
        className="compliance__record-open"
        onClick={() => uploadInputRef.current?.click()}
        disabled={uploading || !token}
        title="Upload a MED Module B/D, EC type examination or declaration of conformity for this equipment"
      >
        {uploading ? "Uploading…" : "+ Upload"}
      </button>
    </div>
    <input
      ref={uploadInputRef}
      type="file"
      accept=".pdf,image/*"
      style={{ display: "none" }}
      onChange={(e) => {
        const picked = e.target.files?.[0] ?? null;
        e.target.value = "";
        onUploadPicked(picked);
      }}
    />
    {typeApprovals.length === 0 ? (
      <div className="assets-section__placeholder">
        No type approvals on this asset yet.
      </div>
    ) : (
      typeApprovals.map((doc) => (
        <div key={doc.id} className="compliance__record">
          <span className="compliance__badge compliance__badge--conditional">
            TYPE
          </span>
          <span className="compliance__record-main">
            {doc.originalFileName}
          </span>
          <button
            type="button"
            className="compliance__record-open"
            onClick={() => {
              if (token) void fetchDocumentFile(token, doc.id);
            }}
            title="Open / preview file"
          >
            Open
          </button>
        </div>
      ))
    )}

    <div className="assets-section__certs-head">
      <span>Compliance records</span>
    </div>
    {assetCerts === null && (
      <div className="assets-section__placeholder">Loading…</div>
    )}
    {assetCerts !== null && assetCerts.length === 0 && (
      <div className="assets-section__placeholder">
        No compliance documents linked to this asset yet. Link
        records to assets in the Compliance Docs section.
      </div>
    )}
    {assetCerts?.map((rec) => (
      <div key={rec.id} className="compliance__record">
        <StatusBadge base="compliance__badge" variant={rec.status}>
          {rec.status.toUpperCase()}
        </StatusBadge>
        <span className="compliance__record-main">
          {rec.sfiCode} {rec.typeName ?? "—"}
          {rec.certNo ? ` · ${rec.certNo}` : ""}
        </span>
        <span className="compliance__record-dates">
          {formatDateDMY(rec.issueDate) ?? "?"} →{" "}
          {formatDateDMY(rec.expiryDate) ?? "—"}
        </span>
        {rec.hasFile && (
          <button
            type="button"
            className="compliance__record-open"
            onClick={() => {
              if (token) void openComplianceDocFile(token, shipId, rec.id);
            }}
            title="Open / preview file"
          >
            Open
          </button>
        )}
      </div>
    ))}
  </div>
  );
}
