import { useCallback, useEffect, useState } from "react";
import {
  getAccessMatrix,
  getAccessSchema,
  setAccessCell,
  type AccessMatrix,
  type AccessSchema,
  type PermissionLevel,
} from "../../api/accessControlApi";

const POSITION_LABELS: Record<string, string> = {
  superintendent: "Superintendent",
  master: "Master",
  hod_engine: "HOD Engine",
  hod_deck: "HOD Deck",
  hod_interior: "HOD Interior",
  hod_galley: "HOD Galley",
  engine: "Engine",
  deck: "Deck",
  interior: "Interior",
  galley: "Galley",
  guest: "Guest",
};

const CATEGORY_LABELS: Record<string, string> = {
  kb_manuals: "Manuals",
  kb_forms: "Forms & Checklists",
  kb_plans: "Plans & Drawings",
  publications: "Publications",
  compliance_statutory: "Statutory Certs",
  compliance_equipment: "Equipment Service",
  compliance_personnel: "Personnel",
  compliance_insurance: "Insurance",
  compliance_legal: "Legal & Agreements",
  compliance_records: "Records",
  compliance_reports: "Reports",
  asset_register: "Asset Register",
  pms_tasks: "PMS / Tasks",
  metrics: "Metrics",
  alerts: "Alerts",
};

const humanize = (key: string, map: Record<string, string>) =>
  map[key] ??
  key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

const NEXT_LEVEL: Record<PermissionLevel, PermissionLevel> = {
  none: "read",
  read: "write",
  write: "none",
};

const CELL_TEXT: Record<PermissionLevel, string> = {
  none: "—",
  read: "R",
  write: "RW",
};

interface CrewAccessMatrixProps {
  token: string | null;
  shipId: string | null;
}

export function CrewAccessMatrix({ token, shipId }: CrewAccessMatrixProps) {
  const [schema, setSchema] = useState<AccessSchema | null>(null);
  const [matrix, setMatrix] = useState<AccessMatrix | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savingCell, setSavingCell] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !shipId) return;
    setLoading(true);
    setError("");
    try {
      const [sc, mx] = await Promise.all([
        getAccessSchema(token),
        getAccessMatrix(token, shipId),
      ]);
      setSchema(sc);
      setMatrix(mx);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load access matrix");
    } finally {
      setLoading(false);
    }
  }, [token, shipId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycle = async (position: string, category: string) => {
    if (!token || !shipId || !matrix) return;
    const current = matrix[position]?.[category] ?? "none";
    const next = NEXT_LEVEL[current];
    const key = `${position}:${category}`;
    setSavingCell(key);
    setError("");
    // optimistic
    setMatrix((prev) =>
      prev
        ? { ...prev, [position]: { ...prev[position], [category]: next } }
        : prev,
    );
    try {
      const updated = await setAccessCell(token, shipId, position, category, next);
      setMatrix(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update permission");
      await load(); // revert to server truth
    } finally {
      setSavingCell(null);
    }
  };

  if (!shipId) return null;

  return (
    <div className="access-matrix">
      <div className="access-matrix__head">
        <div>
          <h3 className="access-matrix__title">Access control</h3>
          <p className="access-matrix__sub">
            What each position can see and edit on this vessel. Click a cell to
            cycle <strong>none → read → read+write</strong>. Blank = platform
            default.
          </p>
        </div>
        {loading && <span className="admin-panel__muted">Loading…</span>}
      </div>

      {error && (
        <div className="admin-panel__error" role="alert">
          {error}
        </div>
      )}

      {schema && matrix && (
        <div className="access-matrix__scroll">
          <table className="access-matrix__table">
            <thead>
              <tr>
                <th className="access-matrix__corner">Category \ Position</th>
                {schema.positions.map((p) => (
                  <th key={p} className="access-matrix__col">
                    {humanize(p, POSITION_LABELS)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schema.resourceCategories.map((cat) => (
                <tr key={cat}>
                  <th className="access-matrix__rowhead">
                    {humanize(cat, CATEGORY_LABELS)}
                  </th>
                  {schema.positions.map((pos) => {
                    const level: PermissionLevel =
                      matrix[pos]?.[cat] ?? "none";
                    const key = `${pos}:${cat}`;
                    return (
                      <td key={pos} className="access-matrix__cell-td">
                        <button
                          type="button"
                          className={`access-matrix__cell access-matrix__cell--${level}`}
                          disabled={savingCell === key}
                          onClick={() => void cycle(pos, cat)}
                          title={`${humanize(pos, POSITION_LABELS)} · ${humanize(cat, CATEGORY_LABELS)}: ${level}`}
                        >
                          {CELL_TEXT[level]}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
