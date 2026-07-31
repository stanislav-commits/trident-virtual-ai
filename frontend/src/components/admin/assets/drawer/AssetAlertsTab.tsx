import { severityColor, type Alert } from "../../../../api/alertsApi";

/** Grafana alerts that resolved to this asset. */
export function AssetAlertsTab({ alerts }: { alerts: Alert[] }) {
  return (
  <div className="assets-section__drawer-section">
    {alerts.length === 0 ? (
      <div className="assets-section__placeholder">
        No alerts for this asset. Metric alerts from Grafana that resolve to
        this asset appear here.
      </div>
    ) : (
      <div className="inv__table-wrap inv__table-wrap--asset">
        <table className="inv__table inv__table--asset">
          <thead>
            <tr>
              <th>Sev.</th>
              <th>Alert</th>
              <th>Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id} className="inv__row">
                <td>
                  <span style={{ color: severityColor(a.severity) }}>
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
                <td className="inv__mono">{a.value != null ? a.value : "—"}</td>
                <td>
                  <span className={`alert__status alert__status--${a.status}`}>
                    {a.status}
                  </span>
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
