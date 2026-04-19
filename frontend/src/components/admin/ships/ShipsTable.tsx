import type { ShipSummaryItem } from "../../../api/shipsApi";
import { ShipIcon } from "../AdminPanelIcons";

interface ShipsTableProps {
  ships: ShipSummaryItem[];
  loading: boolean;
  onEdit: (ship: ShipSummaryItem) => void;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatDate(value: string): string {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime())
    ? "-"
    : dateFormatter.format(parsedDate);
}

export function ShipsTable({ ships, loading, onEdit }: ShipsTableProps) {
  if (loading) {
    return (
      <div className="admin-panel__state-box">
        <div className="admin-panel__spinner" />
        <span className="admin-panel__muted">Loading ships...</span>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="admin-panel__state-box">
        <ShipIcon />
        <span className="admin-panel__muted">No ships in the registry yet.</span>
      </div>
    );
  }

  return (
    <div className="admin-panel__card">
      <table className="admin-panel__table">
        <thead>
          <tr>
            <th className="admin-panel__th">Ship name</th>
            <th className="admin-panel__th">Organization</th>
            <th className="admin-panel__th">IMO number</th>
            <th className="admin-panel__th">Build year</th>
            <th className="admin-panel__th">Updated</th>
            <th className="admin-panel__th">Actions</th>
          </tr>
        </thead>
        <tbody>
          {ships.map((ship) => (
            <tr key={ship.id} className="admin-panel__row">
              <td className="admin-panel__td admin-panel__td--name">
                {ship.name}
              </td>
              <td className="admin-panel__td admin-panel__td--serial">
                {ship.organizationName ?? "-"}
              </td>
              <td className="admin-panel__td admin-panel__td--serial">
                {ship.imoNumber ?? "-"}
              </td>
              <td className="admin-panel__td admin-panel__td--serial">
                {ship.buildYear ?? "-"}
              </td>
              <td className="admin-panel__td admin-panel__td--serial">
                {formatDate(ship.updatedAt)}
              </td>
              <td className="admin-panel__td">
                <div className="admin-panel__actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost"
                    onClick={() => onEdit(ship)}
                  >
                    Edit
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
