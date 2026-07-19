import { useEffect, useRef, useState } from "react";
import type { InventoryItem } from "../../../api/inventoryApi";

/**
 * Searchable linked-parts picker for a task (same UX as the asset picker):
 * chips for attached parts + a popup with a search box and checkmark results.
 * Filters the ship's inventory client-side (parts are bounded per vessel).
 */
export function TaskPartsPicker({
  all,
  value,
  onChange,
}: {
  all: InventoryItem[];
  value: InventoryItem[];
  onChange: (next: InventoryItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const selectedIds = new Set(value.map((p) => p.id));

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const q = query.trim().toLowerCase();
  const results = (
    q
      ? all.filter((p) =>
          [p.name, p.partNumber, p.manufacturer, p.category]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(q)),
        )
      : all
  ).slice(0, 40);

  const toggle = (p: InventoryItem) => {
    if (selectedIds.has(p.id)) onChange(value.filter((v) => v.id !== p.id));
    else onChange([...value, p]);
  };

  return (
    <div className="inv__picker" ref={boxRef}>
      {value.length > 0 && (
        <div className="inv__chips">
          {value.map((p) => (
            <span key={p.id} className="inv__chip">
              {p.name}
              {p.partNumber ? (
                <span className="inv__mono inv__muted"> {p.partNumber}</span>
              ) : null}
              <button
                type="button"
                className="inv__chip-x"
                onClick={() => onChange(value.filter((v) => v.id !== p.id))}
                aria-label={`Unlink ${p.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className="admin-panel__input inv__picker-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value.length ? "" : "inv__muted"}>
          {value.length
            ? `${value.length} part${value.length === 1 ? "" : "s"} linked`
            : "— none —"}
        </span>
        <span className="inv__picker-caret">＋</span>
      </button>
      {open && (
        <div className="inv__picker-pop">
          <input
            type="search"
            className="admin-panel__input admin-panel__input--full"
            placeholder="Search part by name or number…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="inv__picker-list">
            {results.length === 0 && (
              <div className="inv__picker-hint">No matching parts</div>
            )}
            {results.map((p) => {
              const on = selectedIds.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`inv__picker-opt${on ? " inv__picker-opt--active" : ""}`}
                  onClick={() => toggle(p)}
                >
                  <span>
                    <input type="checkbox" checked={on} readOnly /> {p.name}
                  </span>
                  {p.partNumber ? (
                    <span className="inv__mono inv__muted">{p.partNumber}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
