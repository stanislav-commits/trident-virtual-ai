import { useRef, useState } from "react";
import {
  uploadManual,
  deleteManual,
  updateManual,
  getManuals,
  getApiUrl,
  type ShipManualItem,
} from "../../api/client";
import { ShipIcon, XIcon } from "./AdminPanelIcons";

interface ManualsPromptModalProps {
  token: string | null;
  shipId: string;
  shipName: string;
  manuals: ShipManualItem[];
  loading: boolean;
  onClose: () => void;
  onError: (error: string) => void;
  onManualsChanged?: (list: ShipManualItem[]) => void;
}

export function ManualsPromptModal({
  token,
  shipId,
  shipName,
  manuals,
  loading,
  onClose,
  onError,
  onManualsChanged,
}: ManualsPromptModalProps) {
  const [uploading, setUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingManualId, setEditingManualId] = useState<string | null>(null);
  const [editingFilename, setEditingFilename] = useState("");
  const [deletingManualId, setDeletingManualId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleUploadManual = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) return;
    const files =
      selectedFiles.length > 0
        ? selectedFiles
        : fileInputRef.current?.files
          ? Array.from(fileInputRef.current.files)
          : [];
    if (files.length === 0) return;
    setUploading(true);
    onError("");
    try {
      for (const file of files) {
        await uploadManual(shipId, file, token);
      }
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // refresh manuals list
      try {
        const list = await getManuals(shipId, token);
        onManualsChanged?.(list);
      } catch {
        // ignore refresh error here; parent will show if needed
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to upload manual");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (manualId: string) => {
    if (!token) return;
    setDeletingManualId(manualId);
    onError("");
    try {
      await deleteManual(shipId, manualId, token);
      const list = await getManuals(shipId, token);
      onManualsChanged?.(list);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete manual");
    } finally {
      setDeletingManualId(null);
    }
  };

  const handleEditSave = async (manualId: string) => {
    if (!token) return;
    onError("");
    try {
      await updateManual(
        shipId,
        manualId,
        { filename: editingFilename },
        token,
      );
      const list = await getManuals(shipId, token);
      onManualsChanged?.(list);
      setEditingManualId(null);
      setEditingFilename("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update manual");
    }
  };

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-manuals-prompt-title"
    >
      <div
        className="admin-panel__modal admin-panel__modal--wide"
        style={{ maxWidth: 900 }}
      >
        <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
          <ShipIcon />
        </div>
        <h2 id="ap-manuals-prompt-title" className="admin-panel__modal-title">
          Manuals for "{shipName}"
        </h2>
        <p className="admin-panel__modal-desc">
          Add, rename or remove manuals attached to this ship. Files are used by
          RAG and the chat assistant.
        </p>
        <div style={{ maxHeight: "65vh", overflowY: "auto", paddingRight: 8 }}>
          <form
            onSubmit={handleUploadManual}
            className="admin-panel__ship-form"
            style={{ marginBottom: 16 }}
          >
            <div className="admin-panel__field">
              <span className="admin-panel__field-label">Upload manual(s)</span>
              <div className="admin-panel__file-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt"
                  className="admin-panel__file-input"
                  multiple
                  disabled={uploading}
                  onChange={(e) => {
                    const list = e.target.files
                      ? Array.from(e.target.files)
                      : [];
                    setSelectedFiles(list);
                  }}
                />
                <button
                  type="button"
                  className="admin-panel__file-trigger"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {selectedFiles.length > 0
                    ? `${selectedFiles.length} file(s) selected`
                    : "Select files"}
                </button>
                {selectedFiles.length > 0 && (
                  <div className="admin-panel__file-list">
                    {selectedFiles.map((f, i) => (
                      <span
                        key={`${f.name}-${i}`}
                        className="admin-panel__file-list-item"
                      >
                        {f.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="admin-panel__form-actions">
              <button
                type="submit"
                className="admin-panel__btn admin-panel__btn--primary"
                disabled={uploading || selectedFiles.length === 0}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </form>
          {loading ? (
            <div
              className="admin-panel__state-box"
              style={{ marginBottom: 16 }}
            >
              <div className="admin-panel__spinner" />
              <span className="admin-panel__muted">Loading…</span>
            </div>
          ) : manuals.length > 0 ? (
            <div style={{ marginBottom: 16 }}>
              <table className="admin-panel__table">
                <thead>
                  <tr>
                    <th className="admin-panel__th">Filename</th>
                    <th className="admin-panel__th">Uploaded</th>
                    <th className="admin-panel__th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {manuals.map((m) => (
                    <tr key={m.id} className="admin-panel__row">
                      <td className="admin-panel__td">
                        {editingManualId === m.id ? (
                          <input
                            className="admin-panel__input"
                            value={editingFilename}
                            onChange={(e) => setEditingFilename(e.target.value)}
                          />
                        ) : (
                          m.filename
                        )}
                      </td>
                      <td className="admin-panel__td admin-panel__td--muted">
                        {new Date(m.uploadedAt).toLocaleDateString()}
                      </td>
                      <td className="admin-panel__td">
                        <div className="admin-panel__actions">
                          <a
                            className="admin-panel__btn admin-panel__btn--ghost"
                            href={getApiUrl(`ships/${shipId}/manuals/${m.id}`)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                          {editingManualId === m.id ? (
                            <>
                              <button
                                type="button"
                                className="admin-panel__btn admin-panel__btn--primary"
                                onClick={() => handleEditSave(m.id)}
                                disabled={!editingFilename}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="admin-panel__btn admin-panel__btn--ghost"
                                onClick={() => {
                                  setEditingManualId(null);
                                  setEditingFilename("");
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="admin-panel__btn admin-panel__btn--ghost"
                                onClick={() => {
                                  setEditingManualId(m.id);
                                  setEditingFilename(m.filename);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="admin-panel__btn admin-panel__btn--danger"
                                onClick={() => setConfirmDeleteId(m.id)}
                                disabled={deletingManualId === m.id}
                              >
                                {deletingManualId === m.id ? "…" : "Delete"}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
      {confirmDeleteId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            zIndex: 60,
          }}
        >
          <div className="admin-panel__modal" style={{ maxWidth: 520 }}>
            <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
              <XIcon />
            </div>
            <h3 className="admin-panel__modal-title">Delete manual?</h3>
            <p className="admin-panel__modal-desc">
              This will permanently remove the manual file. This action cannot
              be undone.
            </p>
            <div className="admin-panel__modal-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--danger"
                onClick={async () => {
                  const id = confirmDeleteId;
                  setConfirmDeleteId(null);
                  if (!id) return;
                  await handleDelete(id);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
