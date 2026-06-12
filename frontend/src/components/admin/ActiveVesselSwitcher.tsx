import { useEffect, useRef, useState } from "react";
import { useAdminShip } from "../../context/AdminShipContext";
import { AddVesselModal } from "./AddVesselModal";

/**
 * Global "Active Vessel" switcher (sidebar). The ONLY vessel selector in
 * the admin panel — all tabs follow it through AdminShipContext. The
 * centered "Add vessel workspace" modal lives in <AddVesselModal>.
 */
export function ActiveVesselSwitcher() {
  const { availableShips, selectedShipId, setSelectedShipId } = useAdminShip();
  const active =
    availableShips.find((s) => s.id === selectedShipId) ??
    availableShips[0] ??
    null;

  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const meta = (ship: {
    imoNumber: string | null;
    buildYear: number | null;
    organizationName: string | null;
  }) =>
    [
      ship.imoNumber ? `IMO ${ship.imoNumber}` : null,
      ship.buildYear ? String(ship.buildYear) : null,
      ship.organizationName,
    ]
      .filter(Boolean)
      .join(" · ") || "—";

  return (
    <div className="vessel-switcher" ref={rootRef}>
      <div className="vessel-switcher__label">Active vessel</div>
      <button
        type="button"
        className="vessel-switcher__current"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="vessel-switcher__name">
          {active?.name ?? "No vessels"}
        </span>
        <span className="vessel-switcher__chevron">{open ? "▴" : "▾"}</span>
      </button>
      {active && <div className="vessel-switcher__meta">{meta(active)}</div>}

      {open && (
        <div className="vessel-switcher__panel">
          <div className="vessel-switcher__panel-label">Yachts</div>
          {availableShips.map((ship) => (
            <button
              key={ship.id}
              type="button"
              className={`vessel-switcher__item${
                ship.id === active?.id ? " vessel-switcher__item--active" : ""
              }`}
              onClick={() => {
                setSelectedShipId(ship.id);
                setOpen(false);
              }}
            >
              <span className="vessel-switcher__item-name">{ship.name}</span>
              <span className="vessel-switcher__item-meta">{meta(ship)}</span>
            </button>
          ))}
          <button
            type="button"
            className="vessel-switcher__add"
            onClick={() => {
              setOpen(false);
              setModalOpen(true);
            }}
          >
            + Add vessel
          </button>
        </div>
      )}

      {modalOpen && <AddVesselModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}
