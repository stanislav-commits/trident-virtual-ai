import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  createShip,
  getOrganizations,
  updateShip,
  type ShipSummaryItem,
} from "../../api/shipsApi";
import { instantiateCompliance } from "../../api/complianceApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAuth } from "../../context/AuthContext";

const EMPTY_FORM = {
  name: "",
  organizationName: "",
  imoNumber: "",
  mmsi: "",
  callSign: "",
  flag: "",
  lengthM: "",
  buildYear: "",
  shipyard: "",
  classSociety: "",
  homePort: "",
  grossTonnage: "",
  operationType: "commercial",
};

type FormState = typeof EMPTY_FORM;

/**
 * NOTE: declared OUTSIDE the component on purpose. Defining a field
 * component inside the render function recreates its type every render,
 * React unmounts/remounts the input, and focus is lost after every
 * keystroke (the "can't type more than one character" bug).
 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
}) {
  return (
    <label className="vessel-modal__field">
      <span className="vessel-modal__field-label">{label}</span>
      <input
        type="text"
        inputMode={numeric ? "decimal" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(
            numeric ? e.target.value.replace(/[^0-9.]/g, "") : e.target.value,
          )
        }
      />
    </label>
  );
}

function shipToForm(ship: ShipSummaryItem): FormState {
  return {
    name: ship.name ?? "",
    organizationName: ship.organizationName ?? "",
    imoNumber: ship.imoNumber ?? "",
    mmsi: ship.mmsi ?? "",
    callSign: ship.callSign ?? "",
    flag: ship.flag ?? "",
    lengthM: ship.lengthM != null ? String(ship.lengthM) : "",
    buildYear: ship.buildYear != null ? String(ship.buildYear) : "",
    shipyard: ship.shipyard ?? "",
    classSociety: ship.classSociety ?? "",
    homePort: ship.homePort ?? "",
    grossTonnage: ship.grossTonnage != null ? String(ship.grossTonnage) : "",
    operationType: ship.operationType ?? "commercial",
  };
}

/**
 * Centered vessel-workspace modal (portal to document.body). Two modes:
 * - ADD (`editShip` undefined): empty form, creates a vessel + compliance.
 * - EDIT (`editShip` set): pre-filled from the vessel, PATCHes it.
 * Mounted fresh each time the switcher opens it — no stale drafts.
 */
export function AddVesselModal({
  onClose,
  editShip,
}: {
  onClose: () => void;
  editShip?: ShipSummaryItem;
}) {
  const { token } = useAuth();
  const { setSelectedShipId, refreshShips } = useAdminShip();
  const isEdit = Boolean(editShip);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(
    editShip ? shipToForm(editShip) : EMPTY_FORM,
  );
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  // Load the metrics organizations once per open (the modal mounts fresh).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void getOrganizations(token)
      .then((orgs) => {
        if (!cancelled) setOrganizations(orgs);
      })
      .catch(() => {
        if (!cancelled) setOrganizations([]);
      })
      .finally(() => {
        if (!cancelled) setOrgsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submitAdd = async () => {
    if (!token || !form.name.trim() || !form.organizationName) {
      setError("Vessel name and organization are required");
      return;
    }
    setSaving(true);
    setError(null);
    const profile = {
      name: form.name.trim(),
      imoNumber: form.imoNumber.trim() || null,
      buildYear: form.buildYear ? Number(form.buildYear) : null,
      mmsi: form.mmsi.trim() || null,
      callSign: form.callSign.trim() || null,
      flag: form.flag.trim() || null,
      lengthM: form.lengthM ? Number(form.lengthM) : null,
      grossTonnage: form.grossTonnage ? Number(form.grossTonnage) : null,
      shipyard: form.shipyard.trim() || null,
      classSociety: form.classSociety.trim() || null,
      homePort: form.homePort.trim() || null,
      operationType: form.operationType,
    };
    try {
      if (isEdit && editShip) {
        // Org changes re-discover metrics on the backend; only send it
        // when it actually changed.
        await updateShip(
          editShip.id,
          {
            ...profile,
            ...(form.organizationName !== editShip.organizationName
              ? { organizationName: form.organizationName }
              : {}),
          },
          token,
        );
        await refreshShips();
        onClose();
        return;
      }
      const ship = await createShip(
        { ...profile, organizationName: form.organizationName },
        token,
      );
      try {
        await instantiateCompliance(token, ship.id, {
          operationType: form.operationType,
        });
      } catch {
        /* retryable from the Compliance tab */
      }
      await refreshShips();
      setSelectedShipId(ship.id);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : `Failed to ${isEdit ? "save" : "create"} vessel`,
      );
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="vessel-modal__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="vessel-modal" role="dialog" aria-modal="true">
        <div className="vessel-modal__head">
          <div className="vessel-modal__icon">⚓</div>
          <div>
            <div className="vessel-modal__title">
              {isEdit ? "Vessel details" : "Add vessel workspace"}
            </div>
            <div className="vessel-modal__sub">
              {isEdit
                ? "View and edit this vessel's profile."
                : "Create an empty yacht profile and connect it to the organization that stores live metrics."}
            </div>
          </div>
          <button
            type="button"
            className="vessel-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="vessel-modal__grid">
          <Field
            label="Vessel / Group name *"
            value={form.name}
            onChange={set("name")}
            placeholder="Project Atlas"
          />
          {organizations.length > 0 || !orgsLoaded ? (
            <label className="vessel-modal__field">
              <span className="vessel-modal__field-label">
                Organization *
              </span>
              <select
                value={form.organizationName}
                onChange={(e) => set("organizationName")(e.target.value)}
              >
                <option value="">
                  {orgsLoaded
                    ? "Select metrics organization"
                    : "Loading organizations…"}
                </option>
                {organizations.map((org) => (
                  <option key={org} value={org}>
                    {org}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            // Influx token lacks org-list permission → fall back to
            // free text; the backend still validates the org exists.
            <Field
              label="Organization *"
              value={form.organizationName}
              onChange={set("organizationName")}
              placeholder="metrics organization name"
            />
          )}
          <Field
            label="IMO"
            value={form.imoNumber}
            onChange={set("imoNumber")}
            placeholder="1234567"
            numeric
          />
          <Field
            label="MMSI"
            value={form.mmsi}
            onChange={set("mmsi")}
            placeholder="319000000"
            numeric
          />
          <Field
            label="Call sign"
            value={form.callSign}
            onChange={set("callSign")}
            placeholder="ZCXA7"
          />
          <Field
            label="Flag"
            value={form.flag}
            onChange={set("flag")}
            placeholder="Cayman Islands"
          />
          <Field
            label="Length, m"
            value={form.lengthM}
            onChange={set("lengthM")}
            placeholder="52.4"
            numeric
          />
          <Field
            label="Build year"
            value={form.buildYear}
            onChange={set("buildYear")}
            placeholder="2026"
            numeric
          />
          <Field
            label="Gross tonnage"
            value={form.grossTonnage}
            onChange={set("grossTonnage")}
            placeholder="499"
            numeric
          />
          <label className="vessel-modal__field">
            <span className="vessel-modal__field-label">Operation</span>
            <select
              value={form.operationType}
              onChange={(e) => set("operationType")(e.target.value)}
            >
              <option value="commercial">Commercial</option>
              <option value="private">Private</option>
            </select>
          </label>
          <Field
            label="Shipyard"
            value={form.shipyard}
            onChange={set("shipyard")}
            placeholder="Lurssen"
          />
          <Field
            label="Class society"
            value={form.classSociety}
            onChange={set("classSociety")}
            placeholder="Lloyd's Register"
          />
          <Field
            label="Home port"
            value={form.homePort}
            onChange={set("homePort")}
            placeholder="George Town"
          />
        </div>

        {error && <div className="vessel-switcher__error">{error}</div>}

        <div className="vessel-modal__footer">
          <button
            type="button"
            className="vessel-modal__cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vessel-modal__create"
            disabled={saving}
            onClick={() => void submitAdd()}
          >
            {saving
              ? isEdit
                ? "Saving…"
                : "Creating…"
              : isEdit
                ? "Save changes"
                : "+ Create vessel"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
