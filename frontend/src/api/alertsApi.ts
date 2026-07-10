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
): Promise<Alert[]> {
  const q = status ? `?status=${status}` : "";
  const r = await fetchWithAuth(`ships/${shipId}/alerts${q}`, { token });
  await ok(r, "Load alerts");
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
