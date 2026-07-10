/**
 * Doc-control schema v9 — archetype field profiles (from the agreed
 * Extractor_Field_Map). The 362 compliance documents collapse into 11
 * archetypes; each archetype's capture fields = the BASE block + its own
 * block. Drives required-field validation, the AI extractor, and the UI
 * forms. Pure data — no DB.
 *
 * sotRole/sotTarget = where a captured value reconciles to:
 *   none      — informational only
 *   validates — checked against the register/crew; the OTHER side wins, we flag mismatch
 *   writes    — this record drives the target (compliance status / PMS schedule / asset attr)
 * auth = true  — the document is the source of truth for this validity field;
 *                its value flows into compliance_docs.expiry_date and the PMS follows.
 */
export type ArchetypeFieldType =
  | 'string'
  | 'text'
  | 'date'
  | 'enum'
  | 'int'
  | 'number'
  | 'bool'
  | 'fk'
  | 'array';

export interface ArchetypeField {
  field: string;
  datatype: ArchetypeFieldType;
  required: boolean;
  hint: string;
  sotRole: 'none' | 'validates' | 'writes';
  sotTarget: string;
  auth: boolean;
}

export const COMPLIANCE_ARCHETYPES = [
  'STAT_CERT',
  'EQUIP_SVC',
  'EQUIP_TYPE',
  'PERSONNEL',
  'INSURANCE',
  'PLAN',
  'PUBLICATION',
  'RECORD_BOOK',
  'REPORT',
  'AGREEMENT',
  'LEGAL',
] as const;

export type ComplianceArchetype = (typeof COMPLIANCE_ARCHETYPES)[number];

/** Extractor BASE block — captured on every document regardless of archetype. */
export const BASE_FIELDS: ArchetypeField[] = [
  { field: "doc_number", datatype: "string", required: false, hint: "Cert No / Document No / Ref", sotRole: "none", sotTarget: "none", auth: false },
  { field: "issuing_party", datatype: "string", required: true, hint: "Issued by / Authority / on behalf of / header logo", sotRole: "none", sotTarget: "none", auth: false },
  { field: "issue_date", datatype: "date", required: true, hint: "Date of issue / Issued / Dated", sotRole: "none", sotTarget: "none", auth: false },
  { field: "linked_entity_id", datatype: "fk", required: true, hint: "resolve vessel(name/IMO) | asset(serial/tag) | person(name+DoB)", sotRole: "validates", sotTarget: "varies", auth: false },
  { field: "status", datatype: "enum", required: true, hint: "derived from validity field below", sotRole: "writes", sotTarget: "compliance", auth: false },
];

/** Archetype-specific capture fields, appended on top of BASE. */
export const ARCHETYPE_FIELDS: Record<string, ArchetypeField[]> = {
  "STAT_CERT": [
    { field: "expiry_date", datatype: "date", required: true, hint: "Valid until / Date of expiry / Until", sotRole: "writes", sotTarget: "compliance", auth: true },
    { field: "anniversary_date", datatype: "date", required: false, hint: "Anniversary date / each year by", sotRole: "writes", sotTarget: "pms(survey)", auth: false },
    { field: "survey_window_from/to", datatype: "date", required: false, hint: "to be endorsed between \u2026 window", sotRole: "writes", sotTarget: "pms", auth: false },
    { field: "next_survey_type", datatype: "enum", required: false, hint: "endorsement table: Annual/Intermediate/Renewal", sotRole: "writes", sotTarget: "pms", auth: false },
    { field: "last_endorsement_date", datatype: "date", required: false, hint: "survey/endorsement signature block", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "survey_regime", datatype: "enum", required: false, hint: "\"Harmonized System of Survey\"", sotRole: "none", sotTarget: "none", auth: false },
    { field: "conditions_ref", datatype: "text", required: false, hint: "subject to / conditions / exemption no", sotRole: "none", sotTarget: "none", auth: false },
    { field: "vessel_gt", datatype: "string", required: false, hint: "Gross Tonnage printed on cert", sotRole: "validates", sotTarget: "vessel record", auth: false },
    { field: "vessel_imo", datatype: "string", required: false, hint: "IMO number printed on cert", sotRole: "validates", sotTarget: "vessel record", auth: false },
    { field: "vessel_callsign", datatype: "string", required: false, hint: "Call sign printed on cert", sotRole: "validates", sotTarget: "vessel record", auth: false },
    { field: "vessel_flag", datatype: "string", required: false, hint: "Flag / registry printed on cert", sotRole: "validates", sotTarget: "vessel record", auth: false },
  ],
  "EQUIP_SVC": [
    { field: "applies_to_asset_id", datatype: "fk", required: true, hint: "serial/maker/position on cert -> asset", sotRole: "validates", sotTarget: "asset_register", auth: false },
    { field: "service_date", datatype: "date", required: true, hint: "Date of service / inspected on / test date", sotRole: "writes", sotTarget: "pms(last_done)", auth: false },
    { field: "next_due_date", datatype: "date", required: true, hint: "Next service due / re-test by / valid until", sotRole: "writes", sotTarget: "pms(due)", auth: true },
    { field: "interval", datatype: "string", required: false, hint: "annual / 5-yearly / 12 months", sotRole: "validates", sotTarget: "pms(interval)", auth: false },
    { field: "service_company", datatype: "string", required: true, hint: "servicing station name / header", sotRole: "none", sotTarget: "none", auth: false },
    { field: "station_approval_ref", datatype: "string", required: false, hint: "approved service station no", sotRole: "none", sotTarget: "none", auth: false },
    { field: "result", datatype: "enum", required: true, hint: "Pass/Fail/Satisfactory/Defects", sotRole: "writes", sotTarget: "pms(defect if fail)", auth: false },
    { field: "battery_expiry", datatype: "date", required: false, hint: "battery exp / replace by", sotRole: "writes", sotTarget: "asset_register", auth: false },
    { field: "hru_expiry", datatype: "date", required: false, hint: "HRU / hydrostatic release exp", sotRole: "writes", sotTarget: "asset_register", auth: false },
    { field: "cylinder_weight_vs_charge", datatype: "number", required: false, hint: "gross/tare/charge weight kg", sotRole: "validates", sotTarget: "asset_register", auth: false },
    { field: "quantity_covered", datatype: "int", required: false, hint: "qty / number of units", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "EQUIP_TYPE": [
    { field: "applies_to_asset_id", datatype: "fk", required: true, hint: "serial -> asset", sotRole: "validates", sotTarget: "asset_register", auth: false },
    { field: "equipment_serial", datatype: "string", required: true, hint: "Serial No / Engine No", sotRole: "validates", sotTarget: "asset_register(serial_no)", auth: false },
    { field: "model", datatype: "string", required: true, hint: "Type / Model", sotRole: "validates", sotTarget: "asset_register(model)", auth: false },
    { field: "maker", datatype: "string", required: true, hint: "Manufacturer / Maker", sotRole: "validates", sotTarget: "asset_register(brand)", auth: false },
    { field: "approval_standard", datatype: "string", required: false, hint: "in accordance with / NOx Technical Code / Reg", sotRole: "none", sotTarget: "none", auth: false },
    { field: "approval_body", datatype: "string", required: true, hint: "issuing class/body", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "PERSONNEL": [
    { field: "person_id", datatype: "fk", required: true, hint: "name + DoB -> crew record", sotRole: "validates", sotTarget: "crew", auth: false },
    { field: "rank", datatype: "string", required: true, hint: "position / title on doc", sotRole: "validates", sotTarget: "crew vs MSMD", auth: false },
    { field: "subcert.type", datatype: "enum", required: true, hint: "CoC|flag_endorsement|ENG1|STCW|GMDSS|ECDIS|SEA", sotRole: "none", sotTarget: "none", auth: false },
    { field: "subcert.number", datatype: "string", required: true, hint: "per sub-cert number", sotRole: "none", sotTarget: "none", auth: false },
    { field: "subcert.expiry", datatype: "date", required: true, hint: "per sub-cert expiry", sotRole: "writes", sotTarget: "crew", auth: false },
    { field: "coc_capacity_limit", datatype: "string", required: false, hint: "capacity / tonnage / area limitation", sotRole: "validates", sotTarget: "MSMD", auth: false },
    { field: "earliest_expiry", datatype: "date", required: true, hint: "min(sub-cert expiries)", sotRole: "writes", sotTarget: "compliance", auth: false },
  ],
  "INSURANCE": [
    { field: "policy_no", datatype: "string", required: true, hint: "Policy No / Certificate No", sotRole: "none", sotTarget: "none", auth: false },
    { field: "underwriter", datatype: "string", required: true, hint: "Underwriter / Club / Insurer", sotRole: "none", sotTarget: "none", auth: false },
    { field: "cover_from", datatype: "date", required: true, hint: "Period of insurance from", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "cover_to", datatype: "date", required: true, hint: "to / expiry", sotRole: "writes", sotTarget: "compliance", auth: true },
    { field: "limit_sum_insured", datatype: "string", required: false, hint: "Sum insured / Limit / SDR", sotRole: "none", sotTarget: "none", auth: false },
    { field: "blue_card_link", datatype: "fk", required: false, hint: "pair J07a->J07, J08a->J08", sotRole: "validates", sotTarget: "compliance", auth: false },
    { field: "named_vessel", datatype: "string", required: true, hint: "vessel/IMO on policy", sotRole: "validates", sotTarget: "vessel record", auth: false },
  ],
  "PLAN": [
    { field: "drawing_no", datatype: "string", required: true, hint: "Drawing No / Dwg / Doc No", sotRole: "validates", sotTarget: "drawing_register", auth: false },
    { field: "revision", datatype: "string", required: true, hint: "Rev / Issue / Version", sotRole: "writes", sotTarget: "drawing_register [reconcile asset.drawing_ref]", auth: false },
    { field: "revision_date", datatype: "date", required: true, hint: "Rev date", sotRole: "writes", sotTarget: "drawing_register", auth: false },
    { field: "approval_status", datatype: "enum", required: false, hint: "Approved/For construction/As-built/Info only", sotRole: "none", sotTarget: "none", auth: false },
    { field: "approving_authority", datatype: "string", required: false, hint: "class stamp", sotRole: "none", sotTarget: "none", auth: false },
    { field: "supersedes_rev", datatype: "string", required: false, hint: "supersedes / replaces", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "PUBLICATION": [
    { field: "edition", datatype: "string", required: true, hint: "Edition / Year / consolidated 20xx", sotRole: "writes", sotTarget: "compliance(currency)", auth: false },
    { field: "latest_edition", datatype: "bool", required: true, hint: "compare vs known-current list", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "corrected_to", datatype: "string", required: false, hint: "Corrected to NM week xx/yyyy", sotRole: "writes", sotTarget: "pms(corrections)", auth: false },
    { field: "hardcopy_required", datatype: "bool", required: false, hint: "from matrix note (HARD COPY MANDATORY)", sotRole: "none", sotTarget: "none", auth: false },
    { field: "volume_region", datatype: "string", required: false, hint: "vol / area", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "RECORD_BOOK": [
    { field: "status", datatype: "enum", required: true, hint: "open / closed", sotRole: "none", sotTarget: "none", auth: false },
    { field: "last_entry_date", datatype: "date", required: true, hint: "most recent entry", sotRole: "writes", sotTarget: "pms(recency)", auth: false },
    { field: "retention_period", datatype: "string", required: false, hint: "from reg basis (3yr/2yr)", sotRole: "none", sotTarget: "none", auth: false },
    { field: "retention_until", datatype: "date", required: false, hint: "last_entry + retention", sotRole: "writes", sotTarget: "pms(archival)", auth: false },
    { field: "reg_basis", datatype: "string", required: false, hint: "MARPOL/SOLAS ref", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "REPORT": [
    { field: "report_date", datatype: "date", required: true, hint: "Date of survey / report date", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "attending_body", datatype: "string", required: true, hint: "surveyor / PSC MOU / auditor", sotRole: "none", sotTarget: "none", auth: false },
    { field: "report_type", datatype: "enum", required: true, hint: "class/flag/PSC/ISM-int/ISM-ext/ISPS/MLC", sotRole: "none", sotTarget: "none", auth: false },
    { field: "non_conformities", datatype: "array", required: true, hint: "findings/deficiencies section -> 1 PMS task per NC", sotRole: "writes", sotTarget: "pms(1 task per NC)", auth: false },
    { field: "nc.ref", datatype: "string", required: false, hint: "NC number / finding ref", sotRole: "none", sotTarget: "none", auth: false },
    { field: "nc.severity", datatype: "enum", required: true, hint: "Major / Minor / Observation", sotRole: "writes", sotTarget: "pms(criticality: maj=1, min=2/3, obs=3)", auth: false },
    { field: "nc.description", datatype: "text", required: true, hint: "finding text", sotRole: "writes", sotTarget: "pms(task body)", auth: false },
    { field: "nc.due_date", datatype: "date", required: true, hint: "rectify by / corrective action by", sotRole: "writes", sotTarget: "pms(task due)", auth: false },
    { field: "nc.closed_date", datatype: "date", required: false, hint: "closed / verified on", sotRole: "writes", sotTarget: "pms(task close)", auth: false },
    { field: "nc.status", datatype: "enum", required: false, hint: "open / closed / overdue", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "open_NC_count", datatype: "int", required: false, hint: "count(nc.status != closed)", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "outcome", datatype: "enum", required: true, hint: "clean/observations/detention", sotRole: "writes", sotTarget: "compliance", auth: false },
  ],
  "AGREEMENT": [
    { field: "provider", datatype: "string", required: true, hint: "supplier name", sotRole: "none", sotTarget: "none", auth: false },
    { field: "contract_no", datatype: "string", required: false, hint: "account / contract ref", sotRole: "none", sotTarget: "none", auth: false },
    { field: "term_from", datatype: "date", required: false, hint: "start", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "term_to", datatype: "date", required: true, hint: "end", sotRole: "writes", sotTarget: "compliance", auth: true },
    { field: "renewal_date", datatype: "date", required: false, hint: "notice / renewal date", sotRole: "writes", sotTarget: "pms(renewal)", auth: false },
    { field: "auto_renew", datatype: "bool", required: false, hint: "auto-renew flag", sotRole: "none", sotTarget: "none", auth: false },
  ],
  "LEGAL": [
    { field: "doc_subtype", datatype: "enum", required: true, hint: "bill_of_sale/VAT/POA/incorp/KYC/trust/mgmt_agt/charter", sotRole: "none", sotTarget: "none", auth: false },
    { field: "party", datatype: "string", required: true, hint: "entity / owner name", sotRole: "validates", sotTarget: "ownership record", auth: false },
    { field: "effective_date", datatype: "date", required: false, hint: "effective / dated", sotRole: "none", sotTarget: "none", auth: false },
    { field: "valid_until", datatype: "date", required: false, hint: "good-standing / POA expiry if any", sotRole: "writes", sotTarget: "compliance", auth: false },
    { field: "reference_no", datatype: "string", required: false, hint: "reference", sotRole: "none", sotTarget: "none", auth: false },
  ],
};

/** All capture fields for an archetype (BASE + its block) — for the UI/schema. */
export function fieldsForArchetype(archetype: string | null): ArchetypeField[] {
  if (!archetype) return BASE_FIELDS;
  return [...BASE_FIELDS, ...(ARCHETYPE_FIELDS[archetype] ?? [])];
}

/**
 * The archetype-specific block ONLY (the variable fields stored in the
 * compliance_docs.fields JSONB). BASE fields map to dedicated columns
 * (doc_number→certNo, issuing_party→issuer, issue_date→issueDate,
 * linked_entity_id→link, status→derived), so they're excluded here.
 */
export function archetypeBlock(archetype: string | null): ArchetypeField[] {
  if (!archetype) return [];
  return ARCHETYPE_FIELDS[archetype] ?? [];
}

/**
 * The archetype block fields stored as JSONB values — excludes `fk` fields
 * (asset/person/document links), which are handled by the link model, not
 * free-text values.
 */
export function storedBlock(archetype: string | null): ArchetypeField[] {
  return archetypeBlock(archetype).filter((f) => f.datatype !== 'fk');
}

/** Required JSONB field names within the archetype block (excludes links). */
export function requiredFields(archetype: string | null): string[] {
  return storedBlock(archetype)
    .filter((f) => f.required)
    .map((f) => f.field);
}

/**
 * The validity date field whose value drives compliance_docs.expiry_date and
 * the compliance status. Prefers the [AUTH] field; otherwise the block's
 * date field that writes to compliance (e.g. PERSONNEL.earliest_expiry,
 * LEGAL.valid_until). Null when the archetype has no expiry concept.
 */
export function validityField(archetype: string | null): string | null {
  const block = archetypeBlock(archetype);
  const auth = block.find((f) => f.auth);
  if (auth) return auth.field;
  const comp = block.find(
    (f) => f.datatype === 'date' && f.sotTarget.startsWith('compliance'),
  );
  return comp ? comp.field : null;
}

/**
 * Maps a type's drives_pms behaviour to the PMS task it should drive (D4).
 * Returns null for behaviours that aren't a single date-driven task
 * (no | corrections | NC close-out — handled separately / not yet).
 */
export function complianceTaskSpec(
  drivesPms: string | null,
): { verb: string; category: string } | null {
  switch (drivesPms) {
    case 'survey':
      return { verb: 'Survey due', category: 'Survey' };
    case 'renewal':
      return { verb: 'Renew', category: 'Service' };
    case 'reval':
      return { verb: 'Revalidate', category: 'Inspection' };
    case 'retention':
      return { verb: 'Retain until', category: 'Inspection' };
    case 'YES':
      return { verb: 'Service due', category: 'Service' };
    default:
      return null;
  }
}

/**
 * Identity fields that reconcile against the asset register (register wins,
 * doc flags a mismatch). Maps the archetype field → the AssetEntity property
 * to compare. Parsed from sotTarget = "asset_register(<col>)".
 */
const ASSET_IDENTITY_COLUMN: Record<string, 'serialNo' | 'model' | 'brand'> = {
  serial_no: 'serialNo',
  model: 'model',
  brand: 'brand',
};

export function identityChecks(
  archetype: string | null,
): Array<{ field: string; column: 'serialNo' | 'model' | 'brand' }> {
  const out: Array<{ field: string; column: 'serialNo' | 'model' | 'brand' }> =
    [];
  for (const f of archetypeBlock(archetype)) {
    if (f.sotRole !== 'validates') continue;
    const m = /^asset_register\(([^)]+)\)/.exec(f.sotTarget);
    const col = m ? ASSET_IDENTITY_COLUMN[m[1].trim()] : undefined;
    if (col) out.push({ field: f.field, column: col });
  }
  return out;
}

/** The link role implied by an archetype (doc_asset_links.link_role). */
export function linkRoleForArchetype(archetype: string | null): string {
  switch (archetype) {
    case 'STAT_CERT':
    case 'PERSONNEL':
      return 'certifies';
    case 'EQUIP_SVC':
      return 'services';
    case 'EQUIP_TYPE':
      return 'type_approves';
    case 'INSURANCE':
    case 'AGREEMENT':
      return 'covers';
    default:
      return 'documents';
  }
}
