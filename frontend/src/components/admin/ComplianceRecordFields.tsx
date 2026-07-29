import type { ComplianceRecord, ComplianceVessel } from "../../api/complianceApi";
import { prettyLabel, formatDateDMY } from "./compliance/complianceLabels";

/**
 * The record's fields, laid out in the register itself.
 *
 * v60's Certificate Field Matrix decides which fields a document shows (☑ per
 * document, "no optional values"), and the operator should be able to read them
 * without opening anything — the values used to live only inside the edit
 * window, so checking an expiry or a certificate number meant a click and a
 * modal per record.
 *
 * Three sources feed it, in the order the matrix lists them: the record's own
 * columns, its archetype block in `fields`, and — for the nine identity slugs —
 * Vessel Master Data, which is shown read-only because it belongs to the vessel
 * rather than to this certificate.
 */

const VESSEL_FIELDS = new Set([
  "vessel_gt",
  "vessel_nt",
  "vessel_imo",
  "official_number",
  "vessel_call_sign",
  "vessel_flag",
  "port_of_registry",
  "registered_owner",
  "principal_dimensions",
]);

/** Matrix slug → the record column that already holds it. */
const COLUMN_FIELDS: Record<string, keyof ComplianceRecord> = {
  document_number: "certNo",
  issuing_party: "issuer",
  issue_date: "issueDate",
  expiry_date: "expiryDate",
};

const DATE_FIELDS = new Set([
  "issue_date",
  "expiry_date",
  "anniversary_date",
  "last_endorsement_date",
]);

function displayValue(raw: unknown, slug: string): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (DATE_FIELDS.has(slug) || /_date$/.test(slug)) {
    return formatDateDMY(String(raw)) ?? String(raw);
  }
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  if (Array.isArray(raw)) return raw.length ? raw.join(", ") : null;
  return String(raw);
}

export function ComplianceRecordFields({
  record,
  profile,
  vessel,
}: {
  record: ComplianceRecord;
  /** Visible slugs for this document; null when v60 does not cover it. */
  profile: string[] | null | undefined;
  vessel: ComplianceVessel | undefined;
}) {
  // Without a v60 profile fall back to whatever the record actually stores, so
  // rows the workbook does not cover still show their values instead of nothing.
  const slugs =
    profile && profile.length
      ? profile
      : [
          ...Object.keys(COLUMN_FIELDS),
          ...Object.keys(record.fields ?? {}),
        ];

  const cells = slugs
    .filter((slug) => slug !== "linked_entity") // rendered as link chips already
    .map((slug) => {
      const fromVessel = VESSEL_FIELDS.has(slug);
      const raw = fromVessel
        ? vessel?.[slug]
        : COLUMN_FIELDS[slug]
          ? record[COLUMN_FIELDS[slug]]
          : (record.fields ?? {})[slug];
      return { slug, fromVessel, value: displayValue(raw, slug) };
    })
    .filter((c) => c.value !== null);

  if (!cells.length) return null;

  return (
    <dl className="compliance__fields">
      {cells.map((c) => (
        <div key={c.slug} className="compliance__field-cell">
          <dt>{prettyLabel(c.slug)}</dt>
          <dd className={c.fromVessel ? "compliance__field-vessel" : undefined}>
            {c.value}
            {c.fromVessel && (
              <span
                className="compliance__field-auto"
                title="From Vessel Master Data — edit it on the vessel, not here"
              >
                vessel
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
