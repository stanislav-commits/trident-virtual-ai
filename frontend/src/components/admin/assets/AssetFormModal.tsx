import { createPortal } from "react-dom";
import { useEffect, useState, type FormEvent } from "react";
import {
  createAsset,
  fetchNextAssetId,
  type CreateAssetInput,
} from "../../../api/assetsApi";
import { fetchSfiGroups, fetchSfiSubs, type SfiNode } from "../../../api/sfiApi";
import { AssetsIcon, XIcon } from "../AdminPanelIcons";

interface AssetFormModalProps {
  token: string;
  shipId: string;
  onClose: () => void;
  onCreated: (assetIdInternal: string) => void;
}

const EMPTY = {
  assetIdInternal: "",
  displayName: "",
  sfiGroup: "",
  sfiGroupName: "",
  sfiSub: "",
  sfiSubName: "",
  brand: "",
  model: "",
  serialNo: "",
  location: "",
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

  // Tracks whether the ID field still holds our auto-generated value — a
  // hand-edited ID is never overwritten by a later sub-group change.
  const [autoId, setAutoId] = useState(true);

  const onGroupChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const code = e.target.value;
    const group = groups.find((g) => g.code === code);
    setForm((f) => ({
      ...f,
      sfiGroup: code,
      sfiGroupName: group?.name ?? "",
      sfiSub: "",
      sfiSubName: "",
    }));
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

  const onSubChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const code = e.target.value;
    const sub = subs.find((s) => s.code === code);
    setForm((f) => ({ ...f, sfiSub: code, sfiSubName: sub?.name ?? "" }));
    if (!code || !autoId) return;
    // Auto-fill the next free id under this sub (still editable).
    const next = await fetchNextAssetId(token, shipId, code);
    if (next.assetIdInternal) {
      setForm((f) =>
        f.sfiSub === code ? { ...f, assetIdInternal: next.assetIdInternal! } : f,
      );
    }
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
    };
    const optional: Array<keyof CreateAssetInput> = [
      "sfiGroup",
      "sfiGroupName",
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
          {/* SFI first: pick group → sub, and the Asset ID auto-fills. */}
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
                onChange={(e) => void onSubChange(e)}
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

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Asset ID *</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.assetIdInternal}
                onChange={(e) => {
                  setAutoId(false); // hand-edited — stop auto-overwriting
                  set("assetIdInternal")(e);
                }}
                placeholder="pick group → sub to auto-fill"
                required
                disabled={submitting}
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
                autoFocus
                autoComplete="off"
              />
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
