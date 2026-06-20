import { useEffect, useMemo, useRef, useState } from "react";

export interface CascadeItem {
  id: string;
  label: string;
  sub?: string;
}
export interface CascadeGroup {
  key: string;
  label: string;
  items: CascadeItem[];
}

/**
 * A single-field cascading + searchable picker (Grafana-style): click to
 * open, drill into a category (›) to its items, or type to search across
 * everything. Replaces a long flat dropdown.
 */
export function CascadingSelect({
  value,
  groups,
  placeholder = "Choose",
  onChange,
}: {
  value: string | null;
  groups: CascadeGroup[];
  placeholder?: string;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => {
    for (const g of groups) {
      const it = g.items.find((i) => i.id === value);
      if (it) return it;
    }
    return null;
  }, [groups, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveGroup(null);
  };
  const pick = (id: string) => {
    onChange(id);
    close();
  };

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Array<CascadeItem & { group: string }> = [];
    for (const g of groups)
      for (const it of g.items)
        if (
          it.label.toLowerCase().includes(q) ||
          (it.sub ?? "").toLowerCase().includes(q)
        )
          out.push({ ...it, group: g.label });
    return out.slice(0, 60);
  }, [groups, query]);

  const group = groups.find((g) => g.key === activeGroup);

  return (
    <div className="cascade" ref={ref}>
      <button
        type="button"
        className={`cascade__trigger${selected ? "" : " cascade__trigger--empty"}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="cascade__value">
          {selected ? selected.label : placeholder}
        </span>
        {selected && (
          <span
            className="cascade__clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          >
            ×
          </span>
        )}
        <span className="cascade__chevron">▾</span>
      </button>

      {open && (
        <div className="cascade__panel">
          <input
            className="cascade__search"
            autoFocus
            value={query}
            placeholder="Search…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cascade__list">
            {query.trim() ? (
              searchResults.length ? (
                searchResults.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className="cascade__item"
                    onClick={() => pick(it.id)}
                  >
                    <span>{it.label}</span>
                    <span className="cascade__item-group">{it.group}</span>
                  </button>
                ))
              ) : (
                <div className="cascade__empty">No matches</div>
              )
            ) : activeGroup && group ? (
              <>
                <button
                  type="button"
                  className="cascade__back"
                  onClick={() => setActiveGroup(null)}
                >
                  ‹ {group.label}
                </button>
                {group.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className="cascade__item"
                    onClick={() => pick(it.id)}
                  >
                    {it.label}
                  </button>
                ))}
              </>
            ) : (
              groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className="cascade__group"
                  onClick={() => setActiveGroup(g.key)}
                >
                  <span>{g.label}</span>
                  <span className="cascade__group-arrow">›</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
