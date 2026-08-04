import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  createShip,
  getOrganizations,
  updateShip,
  type ShipSummaryItem,
} from "../../api/shipsApi";
import { instantiateCompliance } from "../../api/complianceApi";
import {
  fetchPublicationJurisdictions,
  type PublicationJurisdiction,
} from "../../api/publicationTreeApi";
import { getUsers, updateUserShip, type UserListItem } from "../../api/usersApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAuth } from "../../context/AuthContext";
import { CrewAssignmentField } from "./ships/CrewAssignmentField";

const EMPTY_FORM = {
  name: "",
  organizationName: "",
  imoNumber: "",
  mmsi: "",
  callSign: "",
  flag: "",
  lengthM: "",
  beamM: "",
  depthM: "",
  buildYear: "",
  shipyard: "",
  classSociety: "",
  publicationFlag: "",
  publicationClass: "",
  homePort: "",
  grossTonnage: "",
  netTonnage: "",
  // Vessel master data — identity printed on statutory certificates; the
  // compliance record form reads these instead of asking per certificate.
  officialNumber: "",
  portOfRegistry: "",
  registeredOwner: "",
  companyName: "",
  companyImoNumber: "",
  operationType: "commercial",
  metricAnalysisHint: "",
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
    publicationFlag: ship.publicationFlag ?? "",
    publicationClass: ship.publicationClass ?? "",
    homePort: ship.homePort ?? "",
    grossTonnage: ship.grossTonnage != null ? String(ship.grossTonnage) : "",
    beamM: ship.beamM != null ? String(ship.beamM) : "",
    depthM: ship.depthM != null ? String(ship.depthM) : "",
    netTonnage: ship.netTonnage != null ? String(ship.netTonnage) : "",
    officialNumber: ship.officialNumber ?? "",
    portOfRegistry: ship.portOfRegistry ?? "",
    registeredOwner: ship.registeredOwner ?? "",
    companyName: ship.companyName ?? "",
    companyImoNumber: ship.companyImoNumber ?? "",
    operationType: ship.operationType ?? "commercial",
    metricAnalysisHint: ship.metricAnalysisHint ?? "",
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
  const { setSelectedShipId, refreshShips, availableShips } = useAdminShip();
  const isEdit = Boolean(editShip);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(
    editShip ? shipToForm(editShip) : EMPTY_FORM,
  );
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [jurisdictions, setJurisdictions] = useState<PublicationJurisdiction[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  // ── Crew assignment (edit mode only) ──────────────────────────────────
  const [crewUsers, setCrewUsers] = useState<UserListItem[]>([]);
  const [crewUsersLoading, setCrewUsersLoading] = useState(false);
  const [selectedCrewUserIds, setSelectedCrewUserIds] = useState<string[]>([]);
  const [movedCrewTargets, setMovedCrewTargets] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token || !editShip) return;
    let cancelled = false;
    setCrewUsersLoading(true);
    void getUsers(token)
      .then((users) => {
        if (cancelled) return;
        const regular = users.filter((u) => u.role === "user");
        setCrewUsers(regular);
        setSelectedCrewUserIds(
          regular.filter((u) => u.shipId === editShip.id).map((u) => u.id),
        );
      })
      .catch(() => {
        if (!cancelled) setCrewUsers([]);
      })
      .finally(() => {
        if (!cancelled) setCrewUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, editShip]);

  const toggleCrewUser = (userId: string) => {
    setSelectedCrewUserIds((cur) =>
      cur.includes(userId) ? cur.filter((id) => id !== userId) : [...cur, userId],
    );
    setMovedCrewTargets((cur) => {
      if (!(userId in cur)) return cur;
      const next = { ...cur };
      delete next[userId];
      return next;
    });
  };
  const setMovedCrewTarget = (userId: string, shipId: string) =>
    setMovedCrewTargets((cur) => ({ ...cur, [userId]: shipId }));

  const removedAssigned =
    isEdit && editShip
      ? crewUsers.filter(
          (u) => u.shipId === editShip.id && !selectedCrewUserIds.includes(u.id),
        )
      : [];
  const hasUnresolvedCrewMoves = removedAssigned.some((u) => !movedCrewTargets[u.id]);

  // Load the metrics organizations once per open (the modal mounts fresh).
  // The library's own list, so the two scope fields can only offer shelves
  // that exist.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchPublicationJurisdictions(token)
      .then((entries) => {
        if (!cancelled) setJurisdictions(entries);
      })
      .catch(() => {
        if (!cancelled) setJurisdictions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

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
      beamM: form.beamM ? Number(form.beamM) : null,
      depthM: form.depthM ? Number(form.depthM) : null,
      grossTonnage: form.grossTonnage ? Number(form.grossTonnage) : null,
      netTonnage: form.netTonnage ? Number(form.netTonnage) : null,
      officialNumber: form.officialNumber.trim() || null,
      portOfRegistry: form.portOfRegistry.trim() || null,
      registeredOwner: form.registeredOwner.trim() || null,
      companyName: form.companyName.trim() || null,
      companyImoNumber: form.companyImoNumber.trim() || null,
      shipyard: form.shipyard.trim() || null,
      classSociety: form.classSociety.trim() || null,
      publicationFlag: form.publicationFlag.trim() || null,
      publicationClass: form.publicationClass.trim() || null,
      homePort: form.homePort.trim() || null,
      operationType: form.operationType,
      metricAnalysisHint: form.metricAnalysisHint.trim() || null,
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

        // Crew reassignment: attach newly-selected users to this ship, and
        // move removed-assigned users to the destination ship chosen for them.
        const crewTasks: Promise<unknown>[] = [];
        for (const userId of selectedCrewUserIds) {
          const user = crewUsers.find((u) => u.id === userId);
          if (!user || user.shipId === editShip.id) continue;
          crewTasks.push(updateUserShip(userId, editShip.id, token));
        }
        for (const user of removedAssigned) {
          const target = movedCrewTargets[user.id];
          if (target) crewTasks.push(updateUserShip(user.id, target, token));
        }
        if (crewTasks.length > 0) await Promise.all(crewTasks);

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
            />
          )}
          <Field
            label="IMO"
            value={form.imoNumber}
            onChange={set("imoNumber")}
            numeric
          />
          <Field
            label="MMSI"
            value={form.mmsi}
            onChange={set("mmsi")}
            numeric
          />
          <Field
            label="Call sign"
            value={form.callSign}
            onChange={set("callSign")}
          />
          <Field
            label="Flag"
            value={form.flag}
            onChange={set("flag")}
          />
          <Field
            label="Length, m"
            value={form.lengthM}
            onChange={set("lengthM")}
            numeric
          />
          <Field
            label="Build year"
            value={form.buildYear}
            onChange={set("buildYear")}
            numeric
          />
          <Field
            label="Beam, m"
            value={form.beamM}
            onChange={set("beamM")}
            numeric
          />
          <Field
            label="Depth, m"
            value={form.depthM}
            onChange={set("depthM")}
            numeric
          />
          <Field
            label="Gross tonnage"
            value={form.grossTonnage}
            onChange={set("grossTonnage")}
            numeric
          />
          <Field
            label="Net tonnage"
            value={form.netTonnage}
            onChange={set("netTonnage")}
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
          />
          <Field
            label="Class society"
            value={form.classSociety}
            onChange={set("classSociety")}
          />
          {/* Which shelves of the publications library this vessel reads. The
              options are whatever the library actually holds, so a vessel can
              never be scoped to a flag or a society with nothing behind it. */}
          <label className="vessel-modal__field">
            <span className="vessel-modal__field-label">Flag rules</span>
            <select
              value={form.publicationFlag}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, publicationFlag: event.target.value }))
              }
            >
              <option value="">Whole library</option>
              {jurisdictions
                .filter((entry) => entry.kind === "flag")
                .map((entry) => (
                  <option
                    key={entry.jurisdiction}
                    value={entry.jurisdiction}
                    title={entry.publications.join(", ")}
                  >
                    {entry.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="vessel-modal__field">
            <span className="vessel-modal__field-label">Class register rules</span>
            <select
              value={form.publicationClass}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, publicationClass: event.target.value }))
              }
            >
              <option value="">Whole library</option>
              {jurisdictions
                .filter((entry) => entry.kind === "class")
                .map((entry) => (
                  <option
                    key={entry.jurisdiction}
                    value={entry.jurisdiction}
                    title={entry.publications.join(", ")}
                  >
                    {entry.label}
                  </option>
                ))}
            </select>
          </label>
          <Field
            label="Home port"
            value={form.homePort}
            onChange={set("homePort")}
          />
          {/* Vessel master data — printed on statutory certificates. Kept on
              the vessel so a certificate never asks for it twice. */}
          <div className="vessel-modal__section">Vessel master data</div>
          <Field
            label="Official number"
            value={form.officialNumber}
            onChange={set("officialNumber")}
          />
          <Field
            label="Port of registry"
            value={form.portOfRegistry}
            onChange={set("portOfRegistry")}
          />
          <Field
            label="Registered owner"
            value={form.registeredOwner}
            onChange={set("registeredOwner")}
          />
          <Field
            label="ISM company"
            value={form.companyName}
            onChange={set("companyName")}
          />
          <Field
            label="Company IMO"
            value={form.companyImoNumber}
            onChange={set("companyImoNumber")}
          />
          <label
            className="vessel-modal__field"
            style={{ gridColumn: "1 / -1" }}
          >
            <span className="vessel-modal__field-label">
              AI metric-analysis profile (optional)
            </span>
            <textarea
              value={form.metricAnalysisHint}
              onChange={(e) => set("metricAnalysisHint")(e.target.value)}
              rows={5}
              style={{
                width: "100%",
                fontFamily: "inherit",
                fontSize: "inherit",
                resize: "vertical",
                padding: "10px 12px",
              }}
            />
          </label>
        </div>

        {isEdit && editShip && (
          <CrewAssignmentField
            crewUsers={crewUsers}
            crewUsersLoading={crewUsersLoading}
            currentAssignedUsers={crewUsers.filter((u) => u.shipId === editShip.id)}
            editingShipId={editShip.id}
            selectedCrewUserIds={selectedCrewUserIds}
            movedCrewTargets={movedCrewTargets}
            shipOptions={availableShips.map((s) => ({ id: s.id, name: s.name }))}
            submitting={saving}
            onToggleCrewUser={toggleCrewUser}
            onMovedCrewTargetChange={setMovedCrewTarget}
          />
        )}

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
            disabled={saving || hasUnresolvedCrewMoves}
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
