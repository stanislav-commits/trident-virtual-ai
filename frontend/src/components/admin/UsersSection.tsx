import { useState, useEffect } from "react";
import {
  createUser,
  deleteUser,
  resetPassword,
  getShips,
  type UserListItem,
} from "../../api/client";
import { UsersIcon, CopyIcon, XIcon } from "./AdminPanelIcons";

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
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    onError("");
    setCreated(null);
    try {
      const shipArg = createRole === "user" ? selectedShipId : undefined;
      const result = await createUser(createRole, token, shipArg);
      setCreated({ userId: result.userId, password: result.password });
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
              Create users and reset passwords.
            </p>
          </div>
          <form onSubmit={handleCreate} className="admin-panel__create-bar">
            <div className="admin-panel__field-inline">
              <label
                htmlFor="ap-create-role"
                className="admin-panel__field-label"
              >
                Role
              </label>
              <select
                id="ap-create-role"
                value={createRole}
                onChange={(e) =>
                  setCreateRole(e.target.value as "user" | "admin")
                }
                className="admin-panel__select"
                disabled={creating}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            {createRole === "user" && (
              <div className="admin-panel__field-inline">
                <label
                  htmlFor="ap-create-ship"
                  className="admin-panel__field-label"
                >
                  Ship
                </label>
                {shipsLoading ? (
                  <div className="admin-panel__muted">Loading ships…</div>
                ) : ships.length === 0 ? (
                  <div className="admin-panel__muted">Add a ship first</div>
                ) : (
                  <select
                    id="ap-create-ship"
                    value={selectedShipId ?? ""}
                    onChange={(e) => setSelectedShipId(e.target.value)}
                    className="admin-panel__select"
                    disabled={creating}
                  >
                    <option value="">— select —</option>
                    {ships.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <button
              type="submit"
              className="admin-panel__btn admin-panel__btn--primary"
              disabled={
                creating ||
                (createRole === "user" &&
                  (shipsLoading || ships.length === 0 || !selectedShipId))
              }
            >
              {creating ? "Creating…" : "Add user"}
            </button>
          </form>
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
                        {resetResult?.userId === u.userId && (
                          <div className="admin-panel__password-reveal">
                            <span className="admin-panel__password-label">
                              New password:
                            </span>
                            <code className="admin-panel__code">
                              {resetResult.password}
                            </code>
                            <button
                              type="button"
                              className="admin-panel__copy-btn"
                              onClick={() =>
                                copyToClipboard(resetResult.password)
                              }
                            >
                              <CopyIcon /> Copy
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleteConfirm && (
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
              <code className="admin-panel__code">{deleteConfirm.userId}</code>{" "}
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
        </div>
      )}

      {created && (
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
        </div>
      )}
    </>
  );
}
