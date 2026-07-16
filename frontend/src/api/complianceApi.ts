import { fetchWithAuth } from "./core";

export type ComplianceStatus = "valid" | "expiring" | "expired" | "missing";

export interface ComplianceLink {
  id: string;
  assetId: string | null;
  assetName: string | null;
  crewMemberId: string | null;
  crewName: string | null;
  linkRole: string;
  verifyState: string;
}

export interface ComplianceRecord {
  id: string;
  certNo: string | null;
  issuer: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: ComplianceStatus;
  assetId: string | null;
  assetName: string | null;
  documentId: string | null;
  documentFileName: string | null;
  hasFile?: boolean;
  notes: string | null;
  fields?: Record<string, unknown> | null;
  verifyState?: string;
  links?: ComplianceLink[];
  identityFlags?: Array<{
    field: string;
    documentValue: string;
    registerValue: string;
    assetName: string;
  }> | null;
}

export interface ArchetypeField {
  field: string;
  datatype: string;
  required: boolean;
  hint: string;
  sotRole: string;
  sotTarget: string;
  auth: boolean;
}

export interface ArchetypeSchema {
  base: ArchetypeField[];
  archetypes: Record<string, ArchetypeField[]>;
}

export interface ComplianceDocType {
  id: string;
  sfiCode: string;
  name: string;
  scope: string;
  linkedSfi: string | null;
  applicability: string;
  renewalCycle: string | null;
  surveyWindow: string | null;
  updateTrigger: string | null;
  notes: string | null;
  // doc-control schema v9 tags
  archetype: string | null;
  linkCardinality: string | null;
  regBasis: string | null;
  basisNote: string | null;
  drivesPms: string | null;
  status: ComplianceStatus | null;
  records: ComplianceRecord[];
}

export interface ComplianceSection {
  sectionCode: string;
  sectionName: string;
  types: ComplianceDocType[];
  counts: Record<ComplianceStatus | "not_required", number>;
}

export interface ComplianceOverview {
  shipId: string;
  sections: ComplianceSection[];
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    const txt = await response.text();
    // Nest errors are JSON like {"message": "..."} — surface the human text,
    // not the raw payload (these strings show up in modals).
    let detail = txt;
    try {
      const parsed: unknown = JSON.parse(txt);
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        const m = (parsed as { message: unknown }).message;
        detail = Array.isArray(m) ? m.join("; ") : String(m);
      }
    } catch {
      // not JSON — keep the raw text
    }
    throw new Error(`${what} failed: ${detail.slice(0, 200)}`);
  }
}

export async function fetchComplianceOverview(
  token: string,
  shipId: string,
): Promise<ComplianceOverview> {
  const response = await fetchWithAuth(`ships/${shipId}/compliance/overview`, {
    token,
    method: "GET",
  });
  await ensureOk(response, "Compliance overview");
  return (await response.json()) as ComplianceOverview;
}

export interface UpsertComplianceDocInput {
  docTypeId: string;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  assetId?: string | null;
  /** Multiple asset links (M:N). Falls back to `assetId` when absent. */
  assetIds?: string[] | null;
  documentId?: string | null;
  notes?: string | null;
  fields?: Record<string, unknown> | null;
  verifyState?: string;
  crewMemberId?: string | null;
  extractedText?: string | null;
}

export async function addComplianceDocLink(
  token: string,
  shipId: string,
  docId: string,
  body: { assetId?: string | null; crewMemberId?: string | null },
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}/links`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await ensureOk(response, "Add link");
}

export async function removeComplianceDocLink(
  token: string,
  shipId: string,
  docId: string,
  linkId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}/links/${linkId}`,
    { token, method: "DELETE" },
  );
  await ensureOk(response, "Remove link");
}

export interface IngestProposal {
  filename: string;
  status: "matched" | "unmatched" | "error";
  typeId?: string | null;
  sfiCode?: string | null;
  typeName?: string | null;
  archetype?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown>;
  assetId?: string | null;
  assetName?: string | null;
  confidence?: number;
  message?: string;
  extractedText?: string;
}

export interface CommitProposal {
  typeId: string;
  /** Original upload filename — lets the server re-attach the file for preview. */
  filename?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown> | null;
  assetId?: string | null;
  /** Multiple asset links (M:N) chosen in the review window. */
  assetIds?: string[] | null;
  crewMemberId?: string | null;
  extractedText?: string | null;
}

export async function previewComplianceDocs(
  token: string,
  shipId: string,
  files: File[],
): Promise<{ proposals: IngestProposal[] }> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/ingest/preview`,
    { token, method: "POST", body: form },
  );
  await ensureOk(response, "Read documents");
  return (await response.json()) as { proposals: IngestProposal[] };
}

export async function commitComplianceDocs(
  token: string,
  shipId: string,
  proposals: CommitProposal[],
  files: File[] = [],
): Promise<{ created: number }> {
  // Multipart so the original files are stored server-side for later preview;
  // each proposal's `filename` matches an uploaded file by name.
  const form = new FormData();
  form.append("proposals", JSON.stringify(proposals));
  files.forEach((f) => form.append("files", f));
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/ingest/commit`,
    { token, method: "POST", body: form },
  );
  await ensureOk(response, "Save documents");
  return (await response.json()) as { created: number };
}

/**
 * Fetch a compliance record's original file (authenticated) and open it in a
 * new browser tab as a blob URL. Works for both pipeline-stored and directly-
 * stored files.
 */
export async function openComplianceDocFile(
  token: string,
  shipId: string,
  docId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}/file`,
    { token, method: "GET" },
  );
  await ensureOk(response, "Open file");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  // Give the new tab time to load before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function fetchComplianceArchetypes(
  token: string,
  shipId: string,
): Promise<ArchetypeSchema> {
  const response = await fetchWithAuth(`ships/${shipId}/compliance/archetypes`, {
    token,
    method: "GET",
  });
  await ensureOk(response, "Compliance archetypes");
  return (await response.json()) as ArchetypeSchema;
}

export async function createComplianceDoc(
  token: string,
  shipId: string,
  input: UpsertComplianceDocInput,
): Promise<void> {
  const response = await fetchWithAuth(`ships/${shipId}/compliance/docs`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(response, "Create compliance doc");
}

/**
 * "Add document" on a compliance row — the type is known, so the server reads
 * the already-uploaded document and returns AI-extracted fields as a proposal
 * (nothing saved). The operator reviews it in the modal and confirms to save.
 */
export async function extractComplianceForType(
  token: string,
  shipId: string,
  typeId: string,
  documentId: string,
): Promise<IngestProposal> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/types/${typeId}/extract`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    },
  );
  await ensureOk(response, "Extract document");
  return (await response.json()) as IngestProposal;
}

/**
 * Fetch a compliance record's original file (authenticated) as a blob object
 * URL for inline preview. Caller must URL.revokeObjectURL when done.
 */
export async function fetchComplianceDocFileUrl(
  token: string,
  shipId: string,
  docId: string,
): Promise<{ url: string; isImage: boolean }> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}/file`,
    { token, method: "GET" },
  );
  await ensureOk(response, "Load file");
  const blob = await response.blob();
  return {
    url: URL.createObjectURL(blob),
    isImage: blob.type.startsWith("image/"),
  };
}

export async function updateComplianceDoc(
  token: string,
  shipId: string,
  docId: string,
  input: Partial<UpsertComplianceDocInput>,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}`,
    {
      token,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  await ensureOk(response, "Update compliance doc");
}

export async function deleteComplianceDoc(
  token: string,
  shipId: string,
  docId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/docs/${docId}`,
    { token, method: "DELETE" },
  );
  await ensureOk(response, "Delete compliance doc");
}

export interface AssetComplianceRecord {
  id: string;
  sfiCode: string | null;
  typeName: string | null;
  certNo: string | null;
  issuer: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: ComplianceStatus;
  documentId: string | null;
  documentFileName: string | null;
  /** Pipeline-stored or directly-stored file exists — "Open" is available. */
  hasFile: boolean;
}

export async function fetchAssetComplianceDocs(
  token: string,
  shipId: string,
  assetId: string,
): Promise<AssetComplianceRecord[]> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/assets/${assetId}/docs`,
    { token, method: "GET" },
  );
  await ensureOk(response, "Asset compliance docs");
  return (await response.json()) as AssetComplianceRecord[];
}

export async function instantiateCompliance(
  token: string,
  shipId: string,
  profile: {
    gtBucket?: string;
    grossTonnage?: number;
    lengthM?: number;
    operationType: string;
    flagRegistry?: string | null;
  },
): Promise<{ created: number; skipped: number }> {
  const response = await fetchWithAuth(
    `ships/${shipId}/compliance/instantiate`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    },
  );
  await ensureOk(response, "Generate rulebook");
  return (await response.json()) as { created: number; skipped: number };
}
