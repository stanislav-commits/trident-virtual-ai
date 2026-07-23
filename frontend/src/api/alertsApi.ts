import { fetchWithAuth, ok } from "./core";

export type AlertSeverity = "critical" | "high" | "warning" | "info";
export type AlertStatus = "firing" | "resolved";

export interface Alert {
  id: string;
  shipId: string | null;
  assetId: string | null;
  assetName: string | null;
  metricKey: string | null;
  /** 'metric' (telemetry alarm) | 'certificate' (compliance-expiry reminder). */
  source: string;
  ruleName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  value: number | null;
  title: string;
  message: string | null;
  department: string | null;
  labels: Record<string, unknown> | null;
  fingerprint: string;
  startedAt: string;
  resolvedAt: string | null;
  lastSeenAt: string;
  pmsTaskId: string | null;
  /** AI root-cause analysis auto-run for critical/high alarms (markdown-ish text). */
  aiAnalysis?: string | null;
  aiAnalyzedAt?: string | null;
  ackedAt: string | null;
  ackedByUserId: string | null;
}

export function severityColor(s: string): string {
  if (s === "critical") return "var(--status-danger, #d9534f)";
  if (s === "high") return "var(--status-warn, #e0a800)";
  if (s === "warning") return "var(--status-warn, #e0a800)";
  return "var(--chat-text-muted)";
}

export async function listAlerts(
  token: string,
  shipId: string,
  status?: AlertStatus,
  ruleName?: string,
): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (ruleName) params.set("ruleName", ruleName);
  const qs = params.toString();
  const q = qs ? `?${qs}` : "";
  const r = await fetchWithAuth(`ships/${shipId}/alerts${q}`, { token });
  await ok(r, "Load alerts");
  return r.json();
}

/** One row of the admin Rules panel (rule + binding + firing stats). */
export interface AlertRule {
  ruleName: string;
  folder: string | null;
  group: string | null;
  severity: AlertSeverity | null;
  paused: boolean;
  /** false = rule fired historically but is gone/renamed in Grafana. */
  inGrafana: boolean;
  state: "firing" | "ok";
  lastFiredAt: string | null;
  episodes: number;
  assetId: string | null;
  assetName: string | null;
  bindingNote: string | null;
}

export async function listAlertRules(
  token: string,
  shipId: string,
): Promise<AlertRule[]> {
  const r = await fetchWithAuth(`ships/${shipId}/alerts/rules`, { token });
  await ok(r, "Load alert rules");
  return r.json();
}

export async function setAlertRuleBinding(
  token: string,
  shipId: string,
  ruleName: string,
  assetId: string | null,
): Promise<{ ruleName: string; assetId: string | null; rebound: number }> {
  const r = await fetchWithAuth(`ships/${shipId}/alerts/rules/binding`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleName, assetId }),
  });
  await ok(r, "Save rule binding");
  return r.json();
}

export async function listAssetAlerts(
  token: string,
  shipId: string,
  assetId: string,
): Promise<Alert[]> {
  const r = await fetchWithAuth(`ships/${shipId}/alerts/asset/${assetId}`, {
    token,
  });
  await ok(r, "Load asset alerts");
  return r.json();
}

export async function acknowledgeAlert(
  token: string,
  shipId: string,
  id: string,
): Promise<Alert> {
  const r = await fetchWithAuth(`ships/${shipId}/alerts/${id}/ack`, {
    token,
    method: "POST",
  });
  await ok(r, "Acknowledge alert");
  return r.json();
}
