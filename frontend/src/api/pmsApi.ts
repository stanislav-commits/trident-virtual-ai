import { fetchWithAuth } from "./core";

export type PmsStatus = "overdue" | "due-soon" | "ok";

export interface PmsTaskDto {
  id: string;
  task: string;
  category: string;
  planning: string;
  source?: string;
  description?: string;
  sfiGroup?: string;
  sfiGroupName?: string;
  assigneeId?: string;
  assigneeName?: string;
  responsibleRole?: string;
  department?: string;
  priority: string;
  dueDate: string | null;
  startDate: string | null;
  repeatDate: boolean;
  intervalValue: number | null;
  intervalUnit: string;
  intervalHours: number | null;
  startHours: number | null;
  currentHours: number | null;
  dueHours: number | null;
  lastDoneHours: number | null;
  lastDone: string | null;
  status: PmsStatus;
  due: string;
  completedAt: string | null;
  assets: { id: string; name: string }[];
}

export interface UpsertPmsTaskInput {
  task: string;
  category?: string;
  planning?: string;
  description?: string | null;
  sfiGroup?: string | null;
  assigneeUserId?: string | null;
  responsibleRole?: string | null;
  department?: string | null;
  priority?: string;
  dueDate?: string | null;
  startDate?: string | null;
  repeatDate?: boolean;
  intervalValue?: number | null;
  intervalUnit?: string;
  intervalHours?: number | null;
  startHours?: number | null;
  lastDoneHours?: number | null;
  dueHours?: number | null;
  lastDoneAt?: string | null;
  assetIds?: string[];
  source?: string;
  completedAt?: string | null;
}

// ── AI-mapped import ──

export interface PmsImportDraft {
  task: string;
  category?: string;
  planning?: string;
  description?: string | null;
  responsibleRole?: string | null;
  department?: string | null;
  sfiGroup?: string | null;
  intervalValue?: number | null;
  intervalUnit?: string | null;
  intervalHours?: number | null;
  dueDate?: string | null;
  lastDoneAt?: string | null;
  assetHint?: string | null;
  assetMatch?: { id: string; name: string; matchType: string } | null;
  confidence?: "high" | "low";
}

export interface PmsImportPreview {
  drafts: PmsImportDraft[];
  counts: { total: number; matchedAssets: number; lowConfidence: number };
  sourceChars: number;
  notes: string[];
}

export async function previewPmsImport(
  token: string,
  shipId: string,
  file: File,
): Promise<PmsImportPreview> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetchWithAuth(`ships/${shipId}/pms/import/preview`, {
    token,
    method: "POST",
    body: form,
  });
  await ok(r, "Parse import");
  return r.json();
}

export async function commitPmsImport(
  token: string,
  shipId: string,
  drafts: PmsImportDraft[],
): Promise<{ created: number }> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/import/commit`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drafts }),
  });
  await ok(r, "Import tasks");
  return r.json();
}

/** Propose PMS tasks for one asset from its manual's extracted text. */
export async function suggestPmsFromManual(
  token: string,
  shipId: string,
  assetId: string,
  text: string,
): Promise<PmsImportPreview> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/assets/${assetId}/suggest`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await ok(r, "Suggest PMS");
  return r.json();
}

async function ok(r: Response, what: string): Promise<void> {
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${what} failed (${r.status}): ${txt.slice(0, 200)}`);
  }
}

export async function listPmsTasks(
  token: string,
  shipId: string,
): Promise<PmsTaskDto[]> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/tasks`, { token });
  await ok(r, "Load tasks");
  return r.json();
}

export async function listAssetPmsTasks(
  token: string,
  shipId: string,
  assetId: string,
): Promise<PmsTaskDto[]> {
  const r = await fetchWithAuth(
    `ships/${shipId}/pms/assets/${assetId}/tasks`,
    { token },
  );
  await ok(r, "Load asset tasks");
  return r.json();
}

export async function createPmsTask(
  token: string,
  shipId: string,
  input: UpsertPmsTaskInput,
): Promise<PmsTaskDto> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/tasks`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Create task");
  return r.json();
}

export async function updatePmsTask(
  token: string,
  shipId: string,
  id: string,
  input: Partial<UpsertPmsTaskInput>,
): Promise<PmsTaskDto> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/tasks/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Update task");
  return r.json();
}

export async function completePmsTask(
  token: string,
  shipId: string,
  id: string,
  input?: { doneAtHours?: number | null; doneOn?: string | null },
): Promise<PmsTaskDto> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/tasks/${id}/complete`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  await ok(r, "Complete task");
  return r.json();
}

export async function deletePmsTask(
  token: string,
  shipId: string,
  id: string,
): Promise<void> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/tasks/${id}`, {
    token,
    method: "DELETE",
  });
  await ok(r, "Delete task");
}

// ── Asset running-hours ──────────────────────────────────────────────────

export interface AssetHoursConfig {
  source: "none" | "manual" | "metric_direct" | "metric_derived";
  metricCatalogId: string | null;
  baselineHours: number | null;
  baselineAt: string | null;
  runningThreshold: number;
  currentHours: number | null;
  readings: { id: string; hours: number; readOn: string; note: string | null }[];
}

export interface SetHoursConfigInput {
  source: string;
  metricCatalogId?: string | null;
  baselineHours?: number | null;
  baselineAt?: string | null;
  runningThreshold?: number | null;
}

export async function fetchAssetHours(
  token: string,
  shipId: string,
  assetId: string,
): Promise<AssetHoursConfig> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/assets/${assetId}/hours`, {
    token,
  });
  await ok(r, "Load hours");
  return r.json();
}

export async function setAssetHours(
  token: string,
  shipId: string,
  assetId: string,
  input: SetHoursConfigInput,
): Promise<AssetHoursConfig> {
  const r = await fetchWithAuth(`ships/${shipId}/pms/assets/${assetId}/hours`, {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Save hours config");
  return r.json();
}

export async function addAssetHoursReading(
  token: string,
  shipId: string,
  assetId: string,
  input: { hours: number; readOn?: string; note?: string | null },
): Promise<AssetHoursConfig> {
  const r = await fetchWithAuth(
    `ships/${shipId}/pms/assets/${assetId}/hours/readings`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  await ok(r, "Add reading");
  return r.json();
}
