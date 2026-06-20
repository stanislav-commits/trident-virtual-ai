import { createPortal } from "react-dom";
import { useEffect, useState, type FormEvent } from "react";
import { createAsset, type CreateAssetInput } from "../../../api/assetsApi";
import { fetchSfiGroups, fetchSfiSubs, type SfiNode } from "../../../api/sfiApi";
import { AssetsIcon, XIcon } from "../AdminPanelIcons";

interface AssetFormModalProps {
  token: string;
  shipId: string;
  onClose: () => void;
  onCreated: (assetIdInternal: string) => void;
}

const LIFECYCLE_OPTIONS = [
  "in-service",
  "specified",
  "deprecated",
  "cross-ref",
] as const;

const EMPTY = {
  assetIdInternal: "",
  displayName: "",
  sfiGroup: "",
  sfiSub: "",
  sfiSubName: "",
  brand: "",
  model: "",
  serialNo: "",
  location: "",
  criticality: "",
  lifecycleStatus: "in-service",
  notes: "",
};

/**
 * Create a single asset. Required: asset_id_internal + display_name. All
 * other fields optional and only sent when filled. Styling matches the
 * admin-panel modals (see ShipFormModal).
 */
export function AssetFormModal({
  token,
  shipId,
  onClose,
  onCreated,
}: AssetFormModalProps) {
  const [form, setForm] = useState({ ...EMPTY });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SFI taxonomy — cascading group → sub-group pickers from the catalog.
  const [groups, setGroups] = useState<SfiNode[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [subs, setSubs] = useState<SfiNode[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setGroupsLoading(true);
    fetchSfiGroups(token)
      .then((g) => {
        if (alive) setGroups(g);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setGroupsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const onGroupChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const code = e.target.value;
    setForm((f) => ({ ...f, sfiGroup: code, sfiSub: "", sfiSubName: "" }));
    setSubs([]);
    if (!code) return;
    setSubsLoading(true);
    try {
      setSubs(await fetchSfiSubs(token, code));
    } catch {
      /* leave subs empty; the group is still recorded */
    } finally {
      setSubsLoading(false);
    }
  };

  const onSubChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const code = e.target.value;
    const sub = subs.find((s) => s.code === code);
    setForm((f) => ({ ...f, sfiSub: code, sfiSubName: sub?.name ?? "" }));
  };

  const set =
    (key: keyof typeof EMPTY) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const canSubmit =
    form.assetIdInternal.trim().length > 0 &&
    form.displayName.trim().length > 0 &&
    !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const payload: CreateAssetInput = {
      assetIdInternal: form.assetIdInternal.trim(),
      displayName: form.displayName.trim(),
      lifecycleStatus: form.lifecycleStatus,
    };
    const optional: Array<keyof CreateAssetInput> = [
      "sfiGroup",
      "sfiSub",
      "sfiSubName",
      "brand",
      "model",
      "serialNo",
      "location",
      "notes",
    ];
    for (const key of optional) {
      const v = (form[key as keyof typeof EMPTY] as string).trim();
      if (v) (payload as Record<string, unknown>)[key] = v;
    }
    if (form.criticality) payload.criticality = Number(form.criticality);

    try {
      await createAsset(token, shipId, payload);
      onCreated(payload.assetIdInternal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-asset-form-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div className="admin-panel__modal admin-panel__modal--wide">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <AssetsIcon />
          </div>
          <h2 id="ap-asset-form-title" className="admin-panel__modal-title">
            Add asset
          </h2>
          <p className="admin-panel__modal-desc">
            Create a single asset on this vessel. Only asset ID and name are
            required — fill the rest as needed.
          </p>
        </div>

        <form onSubmit={submit} className="admin-panel__modal-form">
          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Asset ID *</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.assetIdInternal}
                onChange={set("assetIdInternal")}
                placeholder="e.g. SWX.3.2.1.01-PS"
                required
                disabled={submitting}
                autoFocus
                autoComplete="off"
              />
            </div>
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Display name *</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.displayName}
                onChange={set("displayName")}
                placeholder="e.g. Port Alternator"
                required
                disabled={submitting}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">SFI group</label>
              <select
                className="admin-panel__input admin-panel__input--full"
                value={form.sfiGroup}
                onChange={(e) => void onGroupChange(e)}
                disabled={submitting || groupsLoading}
              >
                <option value="">
                  {groupsLoading ? "Loading…" : "Select group"}
                </option>
                {groups.map((g) => (
                  <option key={g.code} value={g.code}>
                    {g.code} — {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">SFI sub-group</label>
              <select
                className="admin-panel__input admin-panel__input--full"
                value={form.sfiSub}
                onChange={onSubChange}
                disabled={submitting || !form.sfiGroup || subsLoading}
              >
                <option value="">
                  {!form.sfiGroup
                    ? "Select group first"
                    : subsLoading
                      ? "Loading…"
                      : "Select sub-group"}
                </option>
                {subs.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {form.sfiSubName && (
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">
                SFI sub-group name
              </label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.sfiSubName}
                readOnly
                disabled
              />
            </div>
          )}

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Brand</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.brand}
                onChange={set("brand")}
                disabled={submitting}
              />
            </div>
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Model</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.model}
                onChange={set("model")}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Serial no.</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.serialNo}
                onChange={set("serialNo")}
                disabled={submitting}
              />
            </div>
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Location</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.location}
                onChange={set("location")}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Criticality</label>
              <select
                className="admin-panel__input admin-panel__input--full"
                value={form.criticality}
                onChange={set("criticality")}
                disabled={submitting}
              >
                <option value="">—</option>
                <option value="1">1 (highest)</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5 (lowest)</option>
              </select>
            </div>
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Lifecycle status</label>
              <select
                className="admin-panel__input admin-panel__input--full"
                value={form.lifecycleStatus}
                onChange={set("lifecycleStatus")}
                disabled={submitting}
              >
                {LIFECYCLE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("-", " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="admin-panel__modal-field">
            <label className="admin-panel__field-label">Notes</label>
            <textarea
              className="admin-panel__input admin-panel__input--full"
              value={form.notes}
              onChange={set("notes")}
              rows={2}
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="assets-section__banner assets-section__banner--err">
              {error}
            </div>
          )}

          <div className="admin-panel__modal-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-panel__btn admin-panel__btn--primary"
              disabled={!canSubmit}
            >
              {submitting ? "Creating…" : "Create asset"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
