import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAlerts,
  listAlertRules,
  setAlertRuleBinding,
  acknowledgeAlert,
  severityColor,
  type Alert,
  type AlertRule,
  type AlertSeverity,
} from "../../api/alertsApi";
import { listAssets } from "../../api/assetsApi";
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
  const [tab, setTab] = useState<"alerts" | "rules">("alerts");
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

  // ── Rules tab: full Grafana rule list + manual asset binding + history ──
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [assetOptions, setAssetOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [ruleFilter, setRuleFilter] = useState("");
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [history, setHistory] = useState<Alert[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refreshRules = useCallback(async () => {
    if (!token || !shipId) {
      setRules([]);
      return;
    }
    setRulesLoading(true);
    try {
      setRules(await listAlertRules(token, shipId));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed to load rules");
    } finally {
      setRulesLoading(false);
    }
  }, [token, shipId]);

  useEffect(() => {
    if (tab === "rules") void refreshRules();
  }, [tab, refreshRules]);

  useEffect(() => {
    if (tab !== "rules" || !token || !shipId) return;
    void listAssets(token, shipId, { limit: 2000 })
      .then((r) =>
        setAssetOptions(
          r.items.map((a) => ({
            id: a.id,
            label: `${a.assetIdInternal} — ${a.displayName}`,
          })),
        ),
      )
      .catch(() => setAssetOptions([]));
  }, [tab, token, shipId]);

  const bindRule = async (ruleName: string, assetId: string | null) => {
    if (!token || !shipId) return;
    try {
      const r = await setAlertRuleBinding(token, shipId, ruleName, assetId);
      setNote(
        assetId
          ? `Bound "${ruleName}" — ${r.rebound} past alert(s) re-pointed.`
          : `Unbound "${ruleName}".`,
      );
      await refreshRules();
      await refresh(); // the Alerts tab shows the new asset names too
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Binding failed");
    }
  };

  const toggleHistory = async (ruleName: string) => {
    if (expandedRule === ruleName) {
      setExpandedRule(null);
      return;
    }
    setExpandedRule(ruleName);
    if (!token || !shipId) return;
    setHistoryLoading(true);
    try {
      setHistory(await listAlerts(token, shipId, undefined, ruleName));
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const filteredRules = useMemo(() => {
    const f = ruleFilter.trim().toLowerCase();
    return rules.filter(
      (r) =>
        !f ||
        r.ruleName.toLowerCase().includes(f) ||
        (r.folder ?? "").toLowerCase().includes(f) ||
        (r.assetName ?? "").toLowerCase().includes(f),
    );
  }, [rules, ruleFilter]);

  const ruleCounts = useMemo(
    () => ({
      total: rules.length,
      bound: rules.filter((r) => r.assetId).length,
      firing: rules.filter((r) => r.state === "firing").length,
    }),
    [rules],
  );

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
            {tab === "alerts"
              ? `${counts.firing} firing · ${counts.critical} critical · from Grafana`
              : `${ruleCounts.total} rules · ${ruleCounts.bound} bound to assets · ${ruleCounts.firing} firing`}
          </p>
        </div>
        <button
          type="button"
          className="pms__btn"
          onClick={() => void (tab === "alerts" ? refresh() : refreshRules())}
        >
          Refresh
        </button>
      </div>

      <div className="inv__toolbar alerts__toolbar">
        {tab === "alerts" ? (
          <>
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
          </>
        ) : (
          <input
            className="pms__cat-filter"
            placeholder="Filter rules / folders / assets…"
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value)}
          />
        )}

        {/* Alerts | Rules switcher — same row as the toolbar controls. */}
        <div className="pms__segmented alerts__tabs" role="group">
          {(["alerts", "rules"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`pms__seg${tab === t ? " pms__seg--on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "alerts" ? "Alerts" : "Rules"}
            </button>
          ))}
        </div>
      </div>

      {note && <div className="pms__import-note">{note}</div>}

      {tab === "rules" && (
        <div className="inv__table-wrap">
          <datalist id="alert-rule-assets">
            {assetOptions.map((a) => (
              <option key={a.id} value={a.label} />
            ))}
          </datalist>
          <table className="inv__table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Folder</th>
                <th>State</th>
                <th>Linked asset</th>
                <th>Last fired</th>
                <th>Episodes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRules.length === 0 && !rulesLoading && (
                <tr>
                  <td colSpan={7} className="inv__empty-cell">
                    {rules.length === 0
                      ? "No rules. Set GRAFANA_ALERTS_SA_TOKEN on the backend to sync the Grafana rule list; rules that fire into the webhook appear here regardless."
                      : "Nothing matches the filter."}
                  </td>
                </tr>
              )}
              {filteredRules.map((r) => (
                <RuleRow
                  key={r.ruleName}
                  rule={r}
                  assetOptions={assetOptions}
                  expanded={expandedRule === r.ruleName}
                  history={expandedRule === r.ruleName ? history : []}
                  historyLoading={
                    expandedRule === r.ruleName && historyLoading
                  }
                  onToggleHistory={() => void toggleHistory(r.ruleName)}
                  onBind={(assetId) => void bindRule(r.ruleName, assetId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "alerts" && (
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
      )}
    </div>
  );
}

/**
 * One rule row: state badge, editable asset binding (register datalist,
 * saved on pick/blur, ✕ unbinds) and an expandable firing history.
 */
function RuleRow({
  rule,
  assetOptions,
  expanded,
  history,
  historyLoading,
  onToggleHistory,
  onBind,
}: {
  rule: AlertRule;
  assetOptions: Array<{ id: string; label: string }>;
  expanded: boolean;
  history: Alert[];
  historyLoading: boolean;
  onToggleHistory: () => void;
  onBind: (assetId: string | null) => void;
}) {
  const boundLabel =
    assetOptions.find((a) => a.id === rule.assetId)?.label ??
    rule.assetName ??
    "";
  const [draft, setDraft] = useState(boundLabel);
  // Re-sync the input when the binding changes server-side (refresh).
  useEffect(() => setDraft(boundLabel), [boundLabel]);

  const commit = () => {
    const match = assetOptions.find((a) => a.label === draft)?.id ?? null;
    if (draft.trim() === "" && rule.assetId) {
      onBind(null);
    } else if (match && match !== rule.assetId) {
      onBind(match);
    } else {
      setDraft(boundLabel); // unknown text — revert
    }
  };

  return (
    <>
      <tr className="inv__row">
        <td className="inv__name">
          {rule.ruleName}
          {rule.paused && <span className="inv__muted"> · paused</span>}
          {!rule.inGrafana && (
            <span
              className="inv__muted"
              title="This rule fired in the past but is no longer in Grafana (renamed or deleted)."
            >
              {" "}
              · gone from Grafana
            </span>
          )}
        </td>
        <td className="inv__muted">{rule.folder ?? "—"}</td>
        <td>
          <span
            className={`alert__status alert__status--${rule.state === "firing" ? "firing" : "resolved"}`}
            style={
              rule.severity
                ? { color: severityColor(rule.severity) }
                : undefined
            }
          >
            {rule.state === "firing" ? "FIRING" : "OK"}
          </span>
        </td>
        <td>
          <input
            className="pms__cat-filter"
            list="alert-rule-assets"
            placeholder="unbound — type to search…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </td>
        <td className="inv__muted">
          {rule.lastFiredAt ? fmtWhen(rule.lastFiredAt) : "never"}
        </td>
        <td className="inv__mono">{rule.episodes}</td>
        <td>
          {rule.episodes > 0 && (
            <button type="button" className="pms__btn" onClick={onToggleHistory}>
              {expanded ? "Hide" : "History"}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            {historyLoading ? (
              <div className="inv__muted">Loading…</div>
            ) : (
              <table className="inv__table">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <span
                          className="alert__sev"
                          style={{ color: severityColor(h.severity) }}
                        >
                          ● {h.severity}
                        </span>
                      </td>
                      <td className="inv__muted">{fmtWhen(h.startedAt)}</td>
                      <td className="inv__mono">
                        {h.value != null ? h.value : "—"}
                      </td>
                      <td>
                        <span
                          className={`alert__status alert__status--${h.status}`}
                        >
                          {h.status}
                          {h.resolvedAt ? ` · ${fmtWhen(h.resolvedAt)}` : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
