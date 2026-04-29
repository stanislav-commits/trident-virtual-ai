import type {
  DocumentDocClass,
  DocumentParseProfile,
  DocumentParseStatus,
} from "../../../api/documentsApi";

export const DOCUMENT_CLASS_OPTIONS: Array<{
  value: DocumentDocClass;
  label: string;
}> = [
  { value: "manual", label: "Manuals" },
  { value: "historical_procedure", label: "Historical Procedures" },
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
  procedure_bunkering: "Historical procedure profile",
  safety_hard_parse: "Safety hard parse",
  regulation_baseline: "Regulation baseline",
};

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
