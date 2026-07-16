import { useEffect, useMemo, useRef, useState } from "react";

export interface AssetOption {
  id: string;
  /** e.g. "SWX.10.3.03 — Jet Ski Crane" */
  label: string;
  sfiGroup: string | null;
  sfiGroupName: string | null;
  sfiSub: string | null;
  sfiSubName: string | null;
}

/** Natural sort for dotted SFI keys so "10" sorts after "2", not before. */
const sortKey = (k: string) =>
  k
    .split(".")
    .map((n) => n.padStart(5, "0"))
    .join(".");

/**
 * Multi-asset picker that mirrors the certificate type picker: drill
 * group → sub-group → assets and tick as many as you like, or type to search
 * across everything. Selected assets show as removable chips. A compliance
 * document can link to several assets (M:N).
 */
export function AssetMultiSelect({
  assets,
  value,
  onChange,
  placeholder = "Link asset(s)…",
  single = false,
}: {
  assets: AssetOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  /** Single-select mode: picking replaces the value and closes the panel. */
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const selectedSet = useMemo(() => new Set(value), [value]);

  // Build group → sub-group → assets, sorted by SFI code.
  const groups = useMemo(() => {
    const gmap = new Map<
      string,
      {
        key: string;
        label: string;
        subs: Map<string, { key: string; label: string; items: AssetOption[] }>;
      }
    >();
    for (const a of assets) {
      const gk = a.sfiGroup ?? "—";
      const gl = a.sfiGroupName
        ? `${gk} · ${a.sfiGroupName}`
        : gk === "—"
          ? "Ungrouped"
          : gk;
      let g = gmap.get(gk);
      if (!g) {
        g = { key: gk, label: gl, subs: new Map() };
        gmap.set(gk, g);
      }
      const sk = a.sfiSub ?? "—";
      const sl = a.sfiSubName ? `${sk} · ${a.sfiSubName}` : sk;
      let s = g.subs.get(sk);
      if (!s) {
        s = { key: sk, label: sl, items: [] };
        g.subs.set(sk, s);
      }
      s.items.push(a);
    }
    return [...gmap.values()]
      .sort((a, b) => sortKey(a.key).localeCompare(sortKey(b.key)))
      .map((g) => ({
        ...g,
        subs: [...g.subs.values()].sort((a, b) =>
          sortKey(a.key).localeCompare(sortKey(b.key)),
        ),
      }));
  }, [assets]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    if (single) {
      onChange(selectedSet.has(id) ? [] : [id]);
      setOpen(false);
      return;
    }
    onChange(selectedSet.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return assets.filter((a) => a.label.toLowerCase().includes(q)).slice(0, 80);
  }, [assets, query]);

  const group = groups.find((g) => g.key === activeGroup) ?? null;
  const sub = group?.subs.find((s) => s.key === activeSub) ?? null;

  const optionRow = (a: AssetOption) => (
    <label key={a.id} className="amselect__opt">
      <input
        type="checkbox"
        checked={selectedSet.has(a.id)}
        onChange={() => toggle(a.id)}
      />
      <span>{a.label}</span>
    </label>
  );

  return (
    <div className="amselect" ref={ref}>
      <button
        type="button"
        className={`amselect__trigger${value.length ? "" : " amselect__trigger--empty"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          {value.length === 0
            ? placeholder
            : single
              ? (byId.get(value[0])?.label ?? value[0])
              : `${value.length} asset${value.length === 1 ? "" : "s"} linked`}
        </span>
        {single && value.length > 0 && (
          <span
            className="amselect__clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            ×
          </span>
        )}
        <span className="amselect__chevron">▾</span>
      </button>

      {!single && value.length > 0 && (
        <div className="amselect__chips">
          {value.map((id) => (
            <span key={id} className="amselect__chip">
              {byId.get(id)?.label ?? id}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label="Remove asset"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="amselect__panel">
          <input
            className="amselect__search"
            autoFocus
            value={query}
            placeholder="Search assets…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="amselect__list">
            {query.trim() ? (
              searchResults.length ? (
                searchResults.map(optionRow)
              ) : (
                <div className="amselect__empty">No matches</div>
              )
            ) : sub && group ? (
              <>
                <button
                  type="button"
                  className="amselect__back"
                  onClick={() => setActiveSub(null)}
                >
                  ‹ {sub.label}
                </button>
                {sub.items.map(optionRow)}
              </>
            ) : group ? (
              <>
                <button
                  type="button"
                  className="amselect__back"
                  onClick={() => setActiveGroup(null)}
                >
                  ‹ {group.label}
                </button>
                {group.subs.map((s) => {
                  const n = s.items.filter((i) => selectedSet.has(i.id)).length;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className="amselect__node"
                      onClick={() => setActiveSub(s.key)}
                    >
                      <span>{s.label}</span>
                      <span className="amselect__node-right">
                        {n > 0 && <span className="amselect__count">{n}</span>}
                        <span className="amselect__arrow">›</span>
                      </span>
                    </button>
                  );
                })}
              </>
            ) : (
              groups.map((g) => {
                const n = g.subs.reduce(
                  (acc, s) =>
                    acc + s.items.filter((i) => selectedSet.has(i.id)).length,
                  0,
                );
                return (
                  <button
                    key={g.key}
                    type="button"
                    className="amselect__node"
                    onClick={() => setActiveGroup(g.key)}
                  >
                    <span>{g.label}</span>
                    <span className="amselect__node-right">
                      {n > 0 && <span className="amselect__count">{n}</span>}
                      <span className="amselect__arrow">›</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Single-asset variant with a `string | null` value (thin wrapper). */
export function AssetSelect({
  assets,
  value,
  onChange,
  placeholder = "Link asset…",
}: {
  assets: AssetOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
}) {
  return (
    <AssetMultiSelect
      assets={assets}
      value={value ? [value] : []}
      onChange={(ids) => onChange(ids[0] ?? null)}
      placeholder={placeholder}
      single
    />
  );
}
