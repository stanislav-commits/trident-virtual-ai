import type {
  DocumentDocClass,
  DocumentParseProfile,
  DocumentParseStatus,
  DocumentRole,
} from "../../../api/documentsApi";

/**
 * User-facing Knowledge Base classes. Only the active KB sections are offered
 * in pickers — legacy (historical_procedure, certificate, regulation) and the
 * fleet-wide `publication` class are deliberately excluded.
 */
export const DOCUMENT_CLASS_OPTIONS: Array<{
  value: DocumentDocClass;
  label: string;
}> = [
  { value: "procedure", label: "Procedures" },
  { value: "manual", label: "Manuals" },
  { value: "form", label: "Forms & Checklists" },
  { value: "circular", label: "Fleet Circulars" },
  { value: "plan", label: "Vessel Plans & Drawings" },
];

/**
 * Labels for ALL enum values, including legacy/publication ones — old data may
 * still carry these classes even though we no longer offer them in pickers.
 */
const DOCUMENT_CLASS_LABELS: Record<DocumentDocClass, string> = {
  procedure: "Procedures",
  manual: "Manuals",
  form: "Forms & Checklists",
  circular: "Fleet Circulars",
  plan: "Vessel Plans & Drawings",
  publication: "Publications",
  historical_procedure: "Maintenance",
  certificate: "Certificates",
  regulation: "Regulations",
};

export const DOCUMENT_PARSE_STATUS_OPTIONS: Array<{
  value: DocumentParseStatus;
  label: string;
}> = [
  { value: "uploaded", label: "Uploaded" },
  { value: "pending_config", label: "Pending config" },
  { value: "pending_parse", label: "Pending parse" },
  { value: "parsing", label: "Parsing" },
  { value: "parsed", label: "Parsed" },
  { value: "failed", label: "Failed" },
  { value: "reparse_required", label: "Reparse required" },
];

export const DOCUMENT_PARSE_PROFILE_LABELS: Record<
  DocumentParseProfile,
  string
> = {
  manual_long: "Manual long",
  procedure_bunkering: "Maintenance profile",
  safety_hard_parse: "Certificate parse profile",
  regulation_baseline: "Regulation baseline",
};

export const DOCUMENT_ROLE_OPTIONS: Array<{
  value: DocumentRole;
  label: string;
}> = [
  { value: "manual", label: "Manual" },
  { value: "equipment_register", label: "Equipment register" },
  { value: "asset_register", label: "Asset register" },
  { value: "pms_record", label: "PMS record" },
  { value: "specification", label: "Specification" },
  { value: "certificate", label: "Certificate" },
  { value: "regulation", label: "Regulation" },
  { value: "other", label: "Other" },
];

export function getDocumentClassLabel(docClass: DocumentDocClass): string {
  return DOCUMENT_CLASS_LABELS[docClass] ?? docClass;
}

export function getDocumentParseStatusLabel(
  parseStatus: DocumentParseStatus,
): string {
  return (
    DOCUMENT_PARSE_STATUS_OPTIONS.find((option) => option.value === parseStatus)
      ?.label ?? parseStatus
  );
}

export function getDocumentParseProfileLabel(
  parseProfile: DocumentParseProfile,
): string {
  return DOCUMENT_PARSE_PROFILE_LABELS[parseProfile] ?? parseProfile;
}

export function getDocumentRoleLabel(documentRole: DocumentRole): string {
  return (
    DOCUMENT_ROLE_OPTIONS.find((option) => option.value === documentRole)
      ?.label ?? documentRole
  );
}

/** Classes that can be linked to assets (manuals, vessel plans/drawings).
 * Procedures/forms/publications are general knowledge — never asset-bound,
 * so they must not show an "Unlinked" chip. */
const ASSET_LINKABLE_CLASSES: DocumentDocClass[] = ["manual", "plan"];

export function isAssetLinkableClass(docClass: DocumentDocClass): boolean {
  return ASSET_LINKABLE_CLASSES.includes(docClass);
}
