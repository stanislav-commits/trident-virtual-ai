import { useCallback, useEffect, useRef, useState } from "react";
import {
  uploadManual,
  deleteManual,
  updateManual,
  getManuals,
  getManualsStatus,
  fetchWithAuth,
  type ShipManualItem,
  type ManualStatusItem,
} from "../../api/client";
import { ShipIcon, XIcon } from "./AdminPanelIcons";

function ManualStatusBadge({
  run,
  progress,
  chunkCount,
}: {
  run: string | null;
  progress: number | null;
  chunkCount: number | null;
}) {
  if (run === null) {
    return (
      <span className="admin-panel__badge admin-panel__badge--manual-unknown">
        —
      </span>
    );
  }
  switch (run) {
    case "DONE":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-done">
          Done{chunkCount != null ? ` (${chunkCount} chunks)` : ""}
        </span>
      );
    case "RUNNING":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-running">
          Indexing{progress != null ? ` ${Math.round(progress * 100)}%` : "…"}
        </span>
      );
    case "UNSTART":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-pending">
          Pending
        </span>
      );
    case "FAIL":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-fail">
          Failed
        </span>
      );
    case "CANCEL":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-cancel">
          Cancelled
        </span>
      );
    default:
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-unknown">
          {run}
        </span>
      );
  }
}

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

  // Status polling
  const [statusMap, setStatusMap] = useState<
    Map<
      string,
      Pick<ManualStatusItem, "run" | "progress" | "progressMsg" | "chunkCount">
    >
  >(new Map());

  const hasNonTerminal = useCallback(
    (map: typeof statusMap) =>
      Array.from(map.values()).some(
        (s) =>
          s.run !== null &&
          s.run !== "DONE" &&
          s.run !== "FAIL" &&
          s.run !== "CANCEL",
      ),
    [],
  );

  const fetchStatus = useCallback(async () => {
    if (!token) return;
    try {
      const list = await getManualsStatus(shipId, token);
      const next = new Map(
        list.map((m) => [
          m.id,
          {
            run: m.run,
            progress: m.progress,
            progressMsg: m.progressMsg,
            chunkCount: m.chunkCount,
          },
        ]),
      );
      setStatusMap(next);
    } catch {
      // status polling is best-effort
    }
  }, [shipId, token]);

  // Initial status fetch when manuals are available
  useEffect(() => {
    if (manuals.length > 0) fetchStatus();
  }, [manuals, fetchStatus]);

  // Poll every 5s while there are non-terminal statuses
  useEffect(() => {
    if (!hasNonTerminal(statusMap)) return;
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [statusMap, hasNonTerminal, fetchStatus]);

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
        fetchStatus();
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
                  accept=".pdf,.doc,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.bmp,.svg"
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
                    <th className="admin-panel__th">Status</th>
                    <th className="admin-panel__th">Uploaded</th>
                    <th className="admin-panel__th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {manuals.map((m) => {
                    const st = statusMap.get(m.id);
                    return (
                      <tr key={m.id} className="admin-panel__row">
                        <td className="admin-panel__td">
                          {editingManualId === m.id ? (
                            <input
                              className="admin-panel__input"
                              value={editingFilename}
                              onChange={(e) =>
                                setEditingFilename(e.target.value)
                              }
                            />
                          ) : (
                            m.filename
                          )}
                        </td>
                        <td className="admin-panel__td">
                          <ManualStatusBadge
                            run={st?.run ?? null}
                            progress={st?.progress ?? null}
                            chunkCount={st?.chunkCount ?? null}
                          />
                        </td>
                        <td className="admin-panel__td admin-panel__td--muted">
                          {new Date(m.uploadedAt).toLocaleDateString()}
                        </td>
                        <td className="admin-panel__td">
                          <div className="admin-panel__actions">
                            <button
                              type="button"
                              className="admin-panel__btn admin-panel__btn--ghost"
                              onClick={async () => {
                                if (!token) return;
                                try {
                                  const res = await fetchWithAuth(
                                    `ships/${shipId}/manuals/${m.id}/download`,
                                    { token },
                                  );
                                  if (!res.ok)
                                    throw new Error("Download failed");
                                  const blob = await res.blob();
                                  const url = URL.createObjectURL(blob);
                                  window.open(url, "_blank");
                                  setTimeout(
                                    () => URL.revokeObjectURL(url),
                                    60000,
                                  );
                                } catch (err) {
                                  onError(
                                    err instanceof Error
                                      ? err.message
                                      : "Failed to view manual",
                                  );
                                }
                              }}
                            >
                              View
                            </button>
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
                    );
                  })}
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
