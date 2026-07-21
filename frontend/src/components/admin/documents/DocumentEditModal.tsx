import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { DocumentListItem } from "../../../api/documentsApi";
import {
  fetchDocumentAssetLinks,
  fetchDocumentFormLinks,
  linkDocumentForm,
  listDocuments,
  renameDocument,
  unlinkDocumentForm,
  type DocumentAssetLink,
  type DocumentFormLinkItem,
  type DocumentFormLinksResponse,
} from "../../../api/documentsApi";
import {
  linkAssetDocument,
  unlinkAssetDocument,
} from "../../../api/assetsApi";
import { listAssets } from "../../../api/assetsApi";
import { AssetMultiSelect, type AssetOption } from "../AssetMultiSelect";
import { EditIcon, XIcon } from "../AdminPanelIcons";

/**
 * KB document editor: rename any class; manuals and plans additionally show
 * every asset the document is connected to (explicit pins + the same
 * auto-matching the asset drawer computes) with detach / attach controls.
 * Procedures/circulars and forms show each other (SMS↔forms) — the
 * automatic code-scan match plus manual add/remove, since the code scan
 * shouldn't be the final word on what's linked.
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
  } | null>(null);
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  const [attaching, setAttaching] = useState(false);

  // SMS↔forms: a procedure/circular's linked forms, or (from the other
  // side) the procedures/circulars that reference a form — same UI, merges
  // the automatic code-scan match with manual overrides so the operator can
  // add what the scan missed or remove a wrong match instead of trusting it.
  const isForm = doc.docClass === "form";
  const isProcedureLike = doc.docClass === "procedure" || doc.docClass === "circular";
  const showFormLinks = isForm || isProcedureLike;
  const [formLinks, setFormLinks] = useState<DocumentFormLinksResponse | null>(
    null,
  );
  const [formLinkCandidates, setFormLinkCandidates] = useState<
    { id: string; label: string }[]
  >([]);
  const [formLinkPick, setFormLinkPick] = useState("");
  const [formLinkBusy, setFormLinkBusy] = useState(false);
  const [formLinkError, setFormLinkError] = useState("");

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
            sfiGroup: a.sfiGroup,
            sfiGroupName: a.sfiGroupName,
            sfiSub: a.sfiSub,
            sfiSubName: a.sfiSubName,
          })),
        ),
      )
      .catch(() => setAssetOptions([]));
  }, [token, doc.shipId, showAssets]);

  const refreshFormLinks = useCallback(async () => {
    if (!token || !showFormLinks) return;
    try {
      setFormLinks(await fetchDocumentFormLinks(token, doc.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load form links");
    }
  }, [token, doc.id, showFormLinks]);

  useEffect(() => {
    void refreshFormLinks();
  }, [refreshFormLinks]);

  useEffect(() => {
    if (!token || !showFormLinks) return;
    let alive = true;
    (async () => {
      try {
        let candidates: DocumentListItem[];
        if (isForm) {
          const [proc, circ] = await Promise.all([
            listDocuments(token, {
              shipId: doc.shipId,
              docClass: "procedure",
              pageSize: 100,
            }),
            listDocuments(token, {
              shipId: doc.shipId,
              docClass: "circular",
              pageSize: 100,
            }),
          ]);
          candidates = [...proc.items, ...circ.items];
        } else {
          const forms = await listDocuments(token, {
            shipId: doc.shipId,
            docClass: "form",
            pageSize: 100,
          });
          candidates = forms.items;
        }
        if (!alive) return;
        setFormLinkCandidates(
          candidates.map((d) => ({
            id: d.id,
            label: d.docCode ? `${d.docCode} — ${d.originalFileName}` : d.originalFileName,
          })),
        );
      } catch {
        if (alive) setFormLinkCandidates([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, doc.id, doc.shipId, isForm, showFormLinks]);

  const availableFormLinkCandidates = useMemo(() => {
    const linked = new Set(formLinks?.items.map((i) => i.documentId) ?? []);
    return formLinkCandidates.filter((c) => !linked.has(c.id));
  }, [formLinkCandidates, formLinks]);

  const addFormLinkPick = async (targetId: string) => {
    if (!token) return;
    setFormLinkBusy(true);
    setFormLinkError("");
    try {
      await linkDocumentForm(token, doc.id, targetId);
      setFormLinkPick("");
      await refreshFormLinks();
    } catch (e) {
      setFormLinkError(e instanceof Error ? e.message : "Link failed");
    } finally {
      setFormLinkBusy(false);
    }
  };

  const commitFormLinkPick = () => {
    const typed = formLinkPick.trim();
    if (!typed) return;
    const match = availableFormLinkCandidates.find((c) => c.label === typed);
    if (match) void addFormLinkPick(match.id);
  };

  const removeFormLinkItem = async (targetId: string) => {
    if (!token) return;
    setFormLinkBusy(true);
    setFormLinkError("");
    try {
      await unlinkDocumentForm(token, doc.id, targetId);
      await refreshFormLinks();
    } catch (e) {
      setFormLinkError(e instanceof Error ? e.message : "Unlink failed");
    } finally {
      setFormLinkBusy(false);
    }
  };

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

  /** Reconcile the linked-asset set: link new picks, unlink removed ones. */
  const setDocAssets = async (nextIds: string[]) => {
    if (!token || !links) return;
    const current = new Set(links.pinned.map((l) => l.id));
    const next = new Set(nextIds);
    const toAdd = nextIds.filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !next.has(id));
    if (!toAdd.length && !toRemove.length) return;
    setAttaching(true);
    setError("");
    try {
      for (const id of toAdd) {
        await linkAssetDocument(token, doc.shipId, id, doc.id);
      }
      for (const id of toRemove) {
        await unlinkAssetDocument(token, doc.shipId, id, doc.id);
      }
      await refreshLinks();
      // Refresh the parent table so its Linked/Unlinked chip updates live.
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setAttaching(false);
    }
  };

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
              {!links ? (
                <div className="admin-panel__muted">Loading…</div>
              ) : (
                <AssetMultiSelect
                  assets={assetOptions}
                  value={links.pinned.map((l) => l.id)}
                  onChange={(ids) => void setDocAssets(ids)}
                  placeholder="Link asset(s)…"
                />
              )}
              {attaching && (
                <div className="admin-panel__muted">Updating…</div>
              )}
            </div>
          )}

          {showFormLinks && (
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">
                {isForm ? "Referenced by (procedures & circulars)" : "Linked forms"}
              </label>
              {!formLinks ? (
                <div className="admin-panel__muted">Loading…</div>
              ) : (
                <>
                  <div className="documents-edit__form-links">
                    {formLinks.items.length === 0 && (
                      <div className="admin-panel__muted">
                        {isForm
                          ? "No procedure or circular references this form yet."
                          : "No forms linked yet — the code scan found none either."}
                      </div>
                    )}
                    {formLinks.items.map((item: DocumentFormLinkItem) => (
                      <span
                        key={item.documentId}
                        className={`documents-edit__form-link-chip documents-edit__form-link-chip--${item.origin}`}
                      >
                        <span
                          className="documents-edit__form-link-origin"
                          title={
                            item.origin === "code"
                              ? "Found automatically by scanning the text for a controlled-document code — remove it if this match is wrong"
                              : "Linked manually"
                          }
                        >
                          {item.origin === "code" ? "by code" : "manual"}
                        </span>
                        {item.docCode ? `${item.docCode} — ${item.title}` : item.title}
                        <button
                          type="button"
                          className="documents-edit__form-link-remove"
                          disabled={formLinkBusy}
                          title={
                            item.origin === "code"
                              ? "Remove — this code match won't be suggested again"
                              : "Remove this link"
                          }
                          onClick={() => void removeFormLinkItem(item.documentId)}
                        >
                          <XIcon />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="documents-edit__attach-row">
                    <input
                      className="admin-panel__input admin-panel__input--full"
                      list={`formlink-candidates-${doc.id}`}
                      placeholder={isForm ? "Add a procedure or circular…" : "Add a form…"}
                      value={formLinkPick}
                      disabled={formLinkBusy}
                      onChange={(e) => setFormLinkPick(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitFormLinkPick();
                        }
                      }}
                    />
                    <datalist id={`formlink-candidates-${doc.id}`}>
                      {availableFormLinkCandidates.map((c) => (
                        <option key={c.id} value={c.label} />
                      ))}
                    </datalist>
                    <button
                      type="button"
                      className="admin-panel__btn"
                      disabled={formLinkBusy || !formLinkPick.trim()}
                      onClick={commitFormLinkPick}
                    >
                      + Link
                    </button>
                  </div>
                </>
              )}
              {formLinkError && (
                <div className="admin-panel__error" role="alert">
                  {formLinkError}
                </div>
              )}
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
