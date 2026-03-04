import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  createUser,
  deleteUser,
  resetPassword,
  updateUserName,
  getShips,
  type UserListItem,
} from "../../api/client";
import { UsersIcon, CopyIcon, XIcon, PlusIcon } from "./AdminPanelIcons";

function EditableName({
  userId,
  currentName,
  token,
  onSaved,
  onError,
}: {
  userId: string;
  currentName: string;
  token: string | null;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!token) {
      setEditing(false);
      return;
    }
    if (!value.trim()) {
      onError("Name cannot be empty");
      return;
    }
    if (value.trim() === currentName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateUserName(userId, value, token);
      await onSaved();
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update name");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setValue(currentName);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        type="text"
        className="admin-panel__inline-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        autoFocus
      />
    );
  }

  return (
    <span
      className="admin-panel__editable-name"
      onClick={() => {
        setValue(currentName);
        setEditing(true);
      }}
      title="Click to edit name"
    >
      {currentName || <span className="admin-panel__muted">—</span>}
    </span>
  );
}

interface UsersSectionProps {
  token: string | null;
  users: UserListItem[];
  loading: boolean;
  error: string;
  onLoadUsers: () => Promise<void>;
  onError: (error: string) => void;
}

interface DeleteConfirm {
  id: string;
  userId: string;
}

interface ResetResult {
  userId: string;
  password: string;
}

export function UsersSection({
  token,
  users,
  loading,
  error,
  onLoadUsers,
  onError,
}: UsersSectionProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    userId: string;
    password: string;
  } | null>(null);
  const [ships, setShips] = useState<{ id: string; name: string }[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [selectedShipId, setSelectedShipId] = useState<string | undefined>(
    undefined,
  );
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(
    null,
  );

  const openCreateModal = () => {
    setCreateName("");
    setCreateRole("user");
    setSelectedShipId(ships.length === 1 ? ships[0].id : undefined);
    onError("");
    setShowCreateModal(true);
  };

  const closeCreateModal = () => {
    if (creating) return;
    setShowCreateModal(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    onError("");
    setCreated(null);
    try {
      const shipArg = createRole === "user" ? selectedShipId : undefined;
      const result = await createUser(createRole, token, shipArg, createName);
      setCreated({ userId: result.userId, password: result.password });
      setCreateName("");
      setShowCreateModal(false);
      await onLoadUsers();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    setShipsLoading(true);
    getShips(token)
      .then((list) => {
        setShips(list.map((s) => ({ id: s.id, name: s.name })));
        if (list.length === 1) setSelectedShipId(list[0].id);
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : "Failed to load ships"),
      )
      .finally(() => setShipsLoading(false));
  }, [token]);

  const handleResetPassword = async (id: string) => {
    if (!token) return;
    setResettingId(id);
    onError("");
    setResetResult(null);
    try {
      const result = await resetPassword(id, token);
      setResetResult({ userId: result.userId, password: result.password });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to reset password");
    } finally {
      setResettingId(null);
    }
  };

  const handleDeleteClick = (id: string, userId: string) =>
    setDeleteConfirm({ id, userId });
  const handleDeleteCancel = () => setDeleteConfirm(null);

  const handleDeleteConfirm = async () => {
    if (!token || !deleteConfirm) return;
    setDeletingId(deleteConfirm.id);
    onError("");
    setDeleteConfirm(null);
    try {
      await deleteUser(deleteConfirm.id, token);
      setResetResult(null);
      await onLoadUsers();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  };

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div>
            <h2 className="admin-panel__section-title">Users</h2>
            <p className="admin-panel__section-subtitle">
              Manage user accounts and credentials.
            </p>
          </div>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={openCreateModal}
          >
            <PlusIcon /> Add user
          </button>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="admin-panel__state-box">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading users…</span>
          </div>
        ) : users.length === 0 ? (
          <div className="admin-panel__state-box">
            <UsersIcon />
            <span className="admin-panel__muted">No users yet.</span>
          </div>
        ) : (
          <div className="admin-panel__card">
            <table className="admin-panel__table">
              <thead>
                <tr>
                  <th className="admin-panel__th">User ID</th>
                  <th className="admin-panel__th">Name</th>
                  <th className="admin-panel__th">Role</th>
                  <th className="admin-panel__th">Ship</th>
                  <th className="admin-panel__th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="admin-panel__row">
                    <td className="admin-panel__td admin-panel__td--userid">
                      {u.userId}
                    </td>
                    <td className="admin-panel__td">
                      <EditableName
                        userId={u.id}
                        currentName={u.name ?? ""}
                        token={token}
                        onSaved={onLoadUsers}
                        onError={onError}
                      />
                    </td>
                    <td className="admin-panel__td">
                      <span
                        className={`admin-panel__badge admin-panel__badge--${u.role}`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="admin-panel__td">
                      {u.role === "user" ? (u.ship?.name ?? "—") : "—"}
                    </td>
                    <td className="admin-panel__td">
                      <div className="admin-panel__actions">
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => handleResetPassword(u.id)}
                          disabled={resettingId === u.id}
                        >
                          {resettingId === u.id ? "…" : "Reset password"}
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--danger"
                          onClick={() => handleDeleteClick(u.id, u.userId)}
                          disabled={deletingId === u.id}
                        >
                          {deletingId === u.id ? "…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Create user modal ── */}
      {showCreateModal &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-create-user-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeCreateModal();
            }}
          >
            <div className="admin-panel__modal admin-panel__modal--wide">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={closeCreateModal}
                aria-label="Close"
              >
                <XIcon />
              </button>
              <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                <UsersIcon />
              </div>
              <h2
                id="ap-create-user-title"
                className="admin-panel__modal-title"
              >
                Create new user
              </h2>
              <p className="admin-panel__modal-desc">
                Fill in the details below. Credentials will be generated
                automatically.
              </p>
              <form onSubmit={handleCreate} className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label" htmlFor="mu-name">
                    Full name
                  </label>
                  <input
                    id="mu-name"
                    type="text"
                    className="admin-panel__input admin-panel__input--full"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="e.g. John Smith"
                    required
                    disabled={creating}
                    autoFocus
                  />
                </div>
                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="mu-role"
                    >
                      Role
                    </label>
                    <select
                      id="mu-role"
                      className="admin-panel__select admin-panel__input--full"
                      value={createRole}
                      onChange={(e) =>
                        setCreateRole(e.target.value as "user" | "admin")
                      }
                      disabled={creating}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  {createRole === "user" && (
                    <div className="admin-panel__modal-field">
                      <label
                        className="admin-panel__field-label"
                        htmlFor="mu-ship"
                      >
                        Assign to ship
                      </label>
                      {shipsLoading ? (
                        <div className="admin-panel__input admin-panel__input--full admin-panel__input--disabled-placeholder">
                          Loading ships…
                        </div>
                      ) : ships.length === 0 ? (
                        <div className="admin-panel__input admin-panel__input--full admin-panel__input--disabled-placeholder">
                          Create a ship first
                        </div>
                      ) : (
                        <select
                          id="mu-ship"
                          className="admin-panel__select admin-panel__input--full"
                          value={selectedShipId ?? ""}
                          onChange={(e) => setSelectedShipId(e.target.value)}
                          disabled={creating}
                        >
                          <option value="">— select ship —</option>
                          {ships.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
                <div className="admin-panel__modal-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost"
                    onClick={closeCreateModal}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="admin-panel__btn admin-panel__btn--primary"
                    disabled={
                      creating ||
                      !createName.trim() ||
                      (createRole === "user" &&
                        (shipsLoading || ships.length === 0 || !selectedShipId))
                    }
                  >
                    {creating ? "Creating…" : "Create user"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {deleteConfirm &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-delete-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2 id="ap-delete-title" className="admin-panel__modal-title">
                Delete this user?
              </h2>
              <p className="admin-panel__modal-desc">
                User{" "}
                <code className="admin-panel__code">
                  {deleteConfirm.userId}
                </code>{" "}
                will be permanently removed. This cannot be undone.
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={handleDeleteCancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={handleDeleteConfirm}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {resetResult &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-reset-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h2 id="ap-reset-title" className="admin-panel__modal-title">
                Password reset
              </h2>
              <p className="admin-panel__modal-desc">
                New password for{" "}
                <code className="admin-panel__code">{resetResult.userId}</code>.
                Save it — it won't be shown again.
              </p>
              <div className="admin-panel__cred-row">
                <span className="admin-panel__cred-label">New password</span>
                <code className="admin-panel__code admin-panel__code--block">
                  {resetResult.password}
                </code>
                <button
                  type="button"
                  className="admin-panel__copy-btn"
                  onClick={() => copyToClipboard(resetResult.password)}
                >
                  <CopyIcon /> Copy
                </button>
              </div>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full"
                onClick={() => setResetResult(null)}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}

      {created &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-created-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                <UsersIcon />
              </div>
              <h2 id="ap-created-title" className="admin-panel__modal-title">
                User created
              </h2>
              <p className="admin-panel__modal-desc">
                Save these credentials — they won't be shown again.
              </p>
              <div className="admin-panel__cred-row">
                <span className="admin-panel__cred-label">User ID</span>
                <code className="admin-panel__code admin-panel__code--block">
                  {created.userId}
                </code>
                <button
                  type="button"
                  className="admin-panel__copy-btn"
                  onClick={() => copyToClipboard(created.userId)}
                >
                  <CopyIcon /> Copy
                </button>
              </div>
              <div className="admin-panel__cred-row">
                <span className="admin-panel__cred-label">Password</span>
                <code className="admin-panel__code admin-panel__code--block">
                  {created.password}
                </code>
                <button
                  type="button"
                  className="admin-panel__copy-btn"
                  onClick={() => copyToClipboard(created.password)}
                >
                  <CopyIcon /> Copy
                </button>
              </div>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full"
                onClick={() => setCreated(null)}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
