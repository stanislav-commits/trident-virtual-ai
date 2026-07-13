import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DocumentListItem } from "../../../api/documentsApi";
import {
  fetchDocumentAssetLinks,
  renameDocument,
  type DocumentAssetLink,
} from "../../../api/documentsApi";
import {
  linkAssetDocument,
  unlinkAssetDocument,
} from "../../../api/assetsApi";
import { listAssets } from "../../../api/assetsApi";
import { EditIcon, XIcon } from "../AdminPanelIcons";

/**
 * KB document editor: rename any class; manuals and plans additionally show
 * every asset the document is connected to (explicit pins + the same
 * auto-matching the asset drawer computes) with detach / attach controls.
 */
export function DocumentEditModal({
  token,
  document: doc,
  onClose,
  onSaved,
}: {
  token: string | null;
  document: DocumentListItem;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(doc.originalFileName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const showAssets = doc.docClass === "manual" || doc.docClass === "plan";
  const [links, setLinks] = useState<{
    pinned: DocumentAssetLink[];
    auto: DocumentAssetLink[];
  } | null>(null);
  const [linksBusyId, setLinksBusyId] = useState<string | null>(null);
  const [assetOptions, setAssetOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [attachDraft, setAttachDraft] = useState("");
  const [attaching, setAttaching] = useState(false);

  const refreshLinks = useCallback(async () => {
    if (!token || !showAssets) return;
    try {
      setLinks(await fetchDocumentAssetLinks(token, doc.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load asset links");
    }
  }, [token, doc.id, showAssets]);

  useEffect(() => {
    void refreshLinks();
  }, [refreshLinks]);

  useEffect(() => {
    if (!token || !showAssets) return;
    void listAssets(token, doc.shipId, { limit: 2000 })
      .then((r) =>
        setAssetOptions(
          r.items.map((a) => ({
            id: a.id,
            label: `${a.assetIdInternal} — ${a.displayName}`,
          })),
        ),
      )
      .catch(() => setAssetOptions([]));
  }, [token, doc.shipId, showAssets]);

  const saveName = async () => {
    if (!token) return;
    const next = name.trim();
    if (!next || next === doc.originalFileName) return;
    setSaving(true);
    setError("");
    try {
      await renameDocument(token, doc.id, next);
      setNotice("Renamed.");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  const detach = async (assetId: string) => {
    if (!token) return;
    setLinksBusyId(assetId);
    setError("");
    try {
      await unlinkAssetDocument(token, doc.shipId, assetId, doc.id);
      await refreshLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detach failed");
    } finally {
      setLinksBusyId(null);
    }
  };

  const attach = async () => {
    if (!token) return;
    const match = assetOptions.find((a) => a.label === attachDraft);
    if (!match) {
      setError("Pick an asset from the list to attach.");
      return;
    }
    setAttaching(true);
    setError("");
    try {
      await linkAssetDocument(token, doc.shipId, match.id, doc.id);
      setAttachDraft("");
      await refreshLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attach failed");
    } finally {
      setAttaching(false);
    }
  };

  const renderRow = (a: DocumentAssetLink, kind: "pinned" | "auto") => (
    <div key={a.id} className="assets-section__doc-row">
      <span className="assets-section__doc-row-main">
        <span className="assets-section__doc-name">
          {a.assetIdInternal} — {a.displayName}
          {kind === "auto" && (
            <span className="assets-section__doc-badge">
              suggested · drawing code
            </span>
          )}
        </span>
      </span>
      <button
        type="button"
        className="assets-section__metric-unbind"
        disabled={linksBusyId === a.id}
        onClick={() => void detach(a.id)}
        title={
          kind === "pinned"
            ? "Remove this link"
            : "Wrong match — hide this asset for this document permanently"
        }
        aria-label={`Detach ${a.displayName}`}
      >
        {linksBusyId === a.id ? "…" : "×"}
      </button>
    </div>
  );

  return createPortal(
    <div className="admin-panel__modal-overlay">
      <div className="admin-panel__modal admin-panel__modal--wide">
        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <EditIcon />
          </div>
          <h2 className="admin-panel__modal-title">Edit document</h2>
          <p className="admin-panel__modal-desc">{doc.originalFileName}</p>
        </div>

        <div className="admin-panel__modal-form">
          <div className="admin-panel__modal-field">
            <label className="admin-panel__field-label" htmlFor="doc-edit-name">
              Name
            </label>
            <div className="documents-edit__name-row">
              <input
                id="doc-edit-name"
                className="admin-panel__input admin-panel__input--full"
                value={name}
                disabled={saving}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                }}
              />
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary"
                disabled={saving || !name.trim() || name.trim() === doc.originalFileName}
                onClick={() => void saveName()}
              >
                {saving ? "Saving…" : "Rename"}
              </button>
            </div>
          </div>

          {showAssets && (
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">
                Connected assets
              </label>
              {!links && (
                <div className="admin-panel__muted">Loading…</div>
              )}
              {links && links.pinned.length === 0 && links.auto.length === 0 && (
                <div className="admin-panel__muted">
                  Not linked to any asset. Search below to attach one.
                </div>
              )}
              {(links?.pinned.length || links?.auto.length) ? (
                <div className="documents-edit__asset-list">
                  {links?.pinned.map((a) => renderRow(a, "pinned"))}
                  {links?.auto.map((a) => renderRow(a, "auto"))}
                </div>
              ) : null}

              <div className="documents-edit__attach-row">
                <input
                  className="admin-panel__input admin-panel__input--full"
                  list="doc-edit-assets"
                  placeholder="Type to search the asset register…"
                  value={attachDraft}
                  onChange={(e) => setAttachDraft(e.target.value)}
                />
                <datalist id="doc-edit-assets">
                  {assetOptions.map((a) => (
                    <option key={a.id} value={a.label} />
                  ))}
                </datalist>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  disabled={attaching || !attachDraft.trim()}
                  onClick={() => void attach()}
                >
                  {attaching ? "Attaching…" : "Attach"}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="admin-panel__error" role="alert">
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="admin-panel__muted" role="status">
              {notice}
            </div>
          )}

          <div className="admin-panel__modal-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={onClose}
            >
              <XIcon /> Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
