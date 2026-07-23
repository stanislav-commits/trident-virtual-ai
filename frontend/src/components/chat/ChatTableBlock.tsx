import { useMemo, useState } from "react";
import type { ChatTableDto } from "../../types/chat";

/**
 * Draws a structured, sortable table the metric analyzer produced (via the
 * render_table tool) — the model already computed every cell; this only
 * displays and sorts the rows client-side.
 */

type SortDir = "asc" | "desc";
type CellValue = string | number | boolean | null;

function formatCell(value: CellValue, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "number") {
    const n = Number.isInteger(value) ? value.toString() : value.toFixed(2);
    return unit ? `${n} ${unit}` : n;
  }
  return value;
}

function compareValues(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export default function ChatTableBlock({ table }: { table: ChatTableDto }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows = useMemo(() => {
    if (!sortKey) return table.rows;
    const sorted = [...table.rows].sort((a, b) =>
      compareValues(a[sortKey] ?? null, b[sortKey] ?? null),
    );
    return sortDir === "asc" ? sorted : sorted.reverse();
  }, [table.rows, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  };

  if (table.columns.length === 0 || table.rows.length === 0) {
    return (
      <div className="chat-table chat-table--empty">
        <div className="chat-table__empty">No data for this table.</div>
      </div>
    );
  }

  return (
    <div className="chat-table">
      <div className="chat-table__header">
        <span className="chat-table__title">{table.title}</span>
      </div>
      <div className="chat-table__scroll">
        <table className="chat-table__grid">
          <thead>
            <tr>
              {table.columns.map((col) => (
                <th
                  key={col.key}
                  className={`chat-table__th chat-table__th--${col.align ?? "left"}`}
                  onClick={() => toggleSort(col.key)}
                >
                  <span className="chat-table__th-label">
                    {col.label}
                    {sortKey === col.key && (
                      <span className="chat-table__sort-arrow">
                        {sortDir === "asc" ? " ▲" : " ▼"}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((col) => (
                  <td
                    key={col.key}
                    className={`chat-table__td chat-table__td--${col.align ?? "left"}`}
                  >
                    {formatCell(row[col.key] ?? null, col.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
