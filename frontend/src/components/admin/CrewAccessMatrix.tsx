import { useCallback, useEffect, useState } from "react";
import {
  getAccessMatrix,
  getAccessSchema,
  setAccessCell,
  type AccessMatrix,
  type AccessSchema,
  type PermissionLevel,
} from "../../api/accessControlApi";

// Labels come from the backend taxonomy (schema) — no hardcoded lists here.

// The matrix is a plain read-access toggle: ON grants the AI read access to that
// data for the position, OFF denies it. Crew can't write to the DB, so there's
// no read/write distinction. Any non-"none" level counts as ON.
const isOn = (level: PermissionLevel) => level !== "none";

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
    const next: PermissionLevel = isOn(current) ? "none" : "read";
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
            Toggle whether the AI can read each kind of data for a position on
            this vessel. Click a cell to switch it <strong>on / off</strong>.
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
                  <th key={p.value} className="access-matrix__col">
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schema.resourceCategories.map((cat) => (
                <tr key={cat.value}>
                  <th className="access-matrix__rowhead">{cat.label}</th>
                  {schema.positions.map((pos) => {
                    const level: PermissionLevel =
                      matrix[pos.value]?.[cat.value] ?? "none";
                    const on = isOn(level);
                    const key = `${pos.value}:${cat.value}`;
                    return (
                      <td key={pos.value} className="access-matrix__cell-td">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          className={`access-matrix__cell access-matrix__cell--${on ? "on" : "off"}`}
                          disabled={savingCell === key}
                          onClick={() => void cycle(pos.value, cat.value)}
                          title={`${pos.label} · ${cat.label}: ${on ? "read access on" : "off"}`}
                        >
                          {on ? "✓" : "—"}
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
