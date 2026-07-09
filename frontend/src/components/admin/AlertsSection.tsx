import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAlerts,
  acknowledgeAlert,
  severityColor,
  type Alert,
  type AlertSeverity,
} from "../../api/alertsApi";
import { useAdminShip } from "../../context/AdminShipContext";

interface AlertsSectionProps {
  token: string | null;
}

const SEV_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AlertsSection({ token }: AlertsSectionProps) {
  const { selectedShipId: shipId } = useAdminShip();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [view, setView] = useState<"firing" | "resolved" | "all">("firing");
  const [sevFilter, setSevFilter] = useState<string>("all");

  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setAlerts([]);
      return;
    }
    setLoading(true);
    try {
      setAlerts(await listAlerts(token, shipId));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, [token, shipId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    return alerts
      .filter((a) => (view === "all" ? true : a.status === view))
      .filter((a) => (sevFilter === "all" ? true : a.severity === sevFilter))
      .sort((a, b) => {
        const r = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
        if (r !== 0) return r;
        return b.startedAt.localeCompare(a.startedAt);
      });
  }, [alerts, view, sevFilter]);

  const counts = useMemo(() => {
    const c = { firing: 0, critical: 0 };
    for (const a of alerts) {
      if (a.status === "firing") {
        c.firing++;
        if (a.severity === "critical") c.critical++;
      }
    }
    return c;
  }, [alerts]);

  const ack = async (a: Alert) => {
    if (!token || !shipId) return;
    try {
      await acknowledgeAlert(token, shipId, a.id);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Acknowledge failed");
    }
  };

  if (!shipId) {
    return (
      <div className="inv">
        <p className="inv__empty">Select a vessel to see its alerts.</p>
      </div>
    );
  }

  return (
    <div className="inv">
      <div className="inv__head">
        <div>
          <h2 className="inv__title">Alerts</h2>
          <p className="inv__sub">
            {counts.firing} firing · {counts.critical} critical · from Grafana
          </p>
        </div>
        <button type="button" className="pms__btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="inv__toolbar">
        <div className="pms__segmented" role="group">
          {(["firing", "resolved", "all"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`pms__seg${view === v ? " pms__seg--on" : ""}`}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <select
          className="pms__cat-filter"
          value={sevFilter}
          onChange={(e) => setSevFilter(e.target.value)}
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>

      {note && <div className="pms__import-note">{note}</div>}

      <div className="inv__table-wrap">
        <table className="inv__table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Alert</th>
              <th>Asset</th>
              <th>Value</th>
              <th>Started</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="inv__empty-cell">
                  No alerts. Wire a Grafana webhook to{" "}
                  <code>/api/alerts/grafana</code> to start receiving them.
                </td>
              </tr>
            )}
            {filtered.map((a) => (
              <tr key={a.id} className="inv__row">
                <td>
                  <span
                    className="alert__sev"
                    style={{ color: severityColor(a.severity) }}
                  >
                    ● {a.severity}
                  </span>
                </td>
                <td className="inv__name">
                  {a.title}
                  {a.message && (
                    <div className="alert__msg" title={a.message}>
                      {a.message.split("\n")[0]}
                    </div>
                  )}
                </td>
                <td>{a.assetName ?? (a.assetId ? "—" : "unbound")}</td>
                <td className="inv__mono">{a.value != null ? a.value : "—"}</td>
                <td className="inv__muted">{fmtWhen(a.startedAt)}</td>
                <td>
                  <span
                    className={`alert__status alert__status--${a.status}`}
                  >
                    {a.status}
                    {a.ackedAt ? " · ack" : ""}
                  </span>
                </td>
                <td>
                  {a.status === "firing" && !a.ackedAt && (
                    <button
                      type="button"
                      className="pms__btn"
                      onClick={() => void ack(a)}
                    >
                      Ack
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
