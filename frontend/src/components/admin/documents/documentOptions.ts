import type {
  DocumentDocClass,
  DocumentParseProfile,
  DocumentParseStatus,
  DocumentRole,
} from "../../../api/documentsApi";

export const DOCUMENT_CLASS_OPTIONS: Array<{
  value: DocumentDocClass;
  label: string;
}> = [
  { value: "manual", label: "Manuals" },
  { value: "historical_procedure", label: "Maintenance" },
  { value: "certificate", label: "Certificates" },
  { value: "regulation", label: "Regulations" },
];

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
  return (
    DOCUMENT_CLASS_OPTIONS.find((option) => option.value === docClass)?.label ??
    docClass
  );
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
